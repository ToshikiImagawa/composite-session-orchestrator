/**
 * HTML 画面の表示モデル（T23。FR_021）。I/O を持たない純粋関数。
 *
 * - **含めるもの**: ノードの識別子・役割・親・状態・依存、未解決の受信箱の項目、未回答の判断、未判定の拡張要求。
 * - **含めないもの**: トークン・秘密・パス（作業ツリーの絶対パス・作業範囲の場所・最終コミットなど）。ブリーフ（目的・受け入れ基準）も含めない。
 * - 子が書いた文字列（要約・判断の質問・選択肢・拡張の理由）は、制御文字を除いて、`UI_TEXT_MAX` 文字（コードポイント）に切る。画面は、これを `textContent` だけで描く。
 * - 件数には上限がある（`UI_LIMITS`）。切ったときは、`truncated` に種類を入れる。
 */

import type { OrchState } from "./events.js";
import { ID_PATTERN } from "./ids.js";
import { PRIORITIES, type Priority, priorityOf } from "./inbox-kinds.js";
import type { NodeRole, NodeState } from "./index.js";

export const UI_TEXT_MAX = 200;
export const UI_LIMITS = {
  nodes: 500,
  inbox: 200,
  decisions: 100,
  extensions: 100,
  options: 10,
} as const;

export interface UiNode {
  readonly id: string;
  readonly role: NodeRole;
  readonly parentId: string | null;
  readonly state: NodeState;
  readonly dependsOn: readonly string[];
  /** そのノードの未解決の項目の数（要約を除く）。 */
  readonly openItems: number;
}

export interface UiInboxItem {
  readonly id: string;
  readonly kind: string;
  readonly nodeId: string;
  readonly at: string;
  readonly priority: Priority;
  readonly summary?: string;
}

export interface UiDecision {
  readonly id: string;
  readonly nodeId: string;
  readonly question?: string;
  readonly options: readonly string[];
}

export interface UiExtension {
  readonly id: string;
  readonly nodeId: string;
  readonly reason: string;
}

export interface UiView {
  readonly lastSeq: number;
  readonly nodes: readonly UiNode[];
  readonly inbox: readonly UiInboxItem[];
  readonly decisions: readonly UiDecision[];
  readonly extensions: readonly UiExtension[];
  /** 上限で切った種類（nodes・inbox・decisions・extensions）。 */
  readonly truncated: readonly string[];
}

const isControl = (cp: number): boolean => cp < 0x20 || (cp >= 0x7f && cp <= 0x9f);

/** 制御文字を除き、`UI_TEXT_MAX` コードポイントに切る。 */
export function uiText(x: unknown): string {
  if (typeof x !== "string") return "";
  const out: string[] = [];
  for (const ch of x) {
    if (isControl(ch.codePointAt(0) ?? 0)) continue;
    out.push(ch);
    if (out.length >= UI_TEXT_MAX) break;
  }
  return out.join("");
}

/** 識別子の形でなければ、空にする（画面に、形の崩れた文字列を出さない）。 */
const idOf = (x: unknown): string => (typeof x === "string" && ID_PATTERN.test(x) ? x : "");

export function uiViewOf(state: OrchState): UiView {
  const truncated: string[] = [];
  const cap = <T>(name: string, xs: readonly T[], max: number): readonly T[] => {
    if (xs.length <= max) return xs;
    truncated.push(name);
    return xs.slice(0, max);
  };

  const unresolved = state.inbox.filter((i) => i.resolved === undefined);
  const counts = new Map<string, number>();
  for (const i of unresolved) {
    if (i.kind === "digest") continue;
    counts.set(i.nodeId, (counts.get(i.nodeId) ?? 0) + 1);
  }
  const nodes = cap("nodes", state.nodes, UI_LIMITS.nodes).map(
    (n): UiNode => ({
      id: idOf(n.id),
      role: n.role,
      parentId: n.parentId === null ? null : idOf(n.parentId),
      state: n.state,
      dependsOn: n.dependsOn.map(idOf).filter((d) => d !== ""),
      openItems: counts.get(n.id) ?? 0,
    }),
  );

  const rank = (p: Priority): number => PRIORITIES.indexOf(p);
  const ranked = unresolved
    .map((i) => ({ i, p: priorityOf(i) }))
    .sort(
      (a, b) =>
        rank(a.p) - rank(b.p) || (a.i.at < b.i.at ? -1 : a.i.at > b.i.at ? 1 : a.i.seq - b.i.seq),
    );
  const inbox = cap("inbox", ranked, UI_LIMITS.inbox).map(({ i, p }): UiInboxItem => {
    const summary = uiText(i.summary);
    return {
      id: idOf(i.id),
      kind: i.kind,
      nodeId: idOf(i.nodeId),
      at: uiText(i.at),
      priority: p,
      ...(summary === "" ? {} : { summary }),
    };
  });

  const decisions = cap(
    "decisions",
    state.decisions.filter((d) => d.status === "open"),
    UI_LIMITS.decisions,
  ).map((d): UiDecision => {
    const question = uiText(d.question);
    return {
      id: idOf(d.decisionId),
      nodeId: idOf(d.nodeId),
      ...(question === "" ? {} : { question }),
      options: (d.options ?? []).slice(0, UI_LIMITS.options).map(uiText),
    };
  });

  const extensions = cap(
    "extensions",
    state.extensions.filter((x) => x.status === "open"),
    UI_LIMITS.extensions,
  ).map(
    (x): UiExtension => ({
      id: idOf(x.extensionId),
      nodeId: idOf(x.nodeId),
      reason: uiText(x.reason),
    }),
  );

  return { lastSeq: state.lastSeq, nodes, inbox, decisions, extensions, truncated };
}
