/**
 * 中間統合ノードの配下の要約（`digest`。T24・FR_013）。I/O を持たない純粋関数。
 *
 * - **子が書いた自由な文字列を、一切含めない**。中身は、件数・状態名・識別子（ノード ID・受信箱の項目の ID。どちらも `isId` を通ったもの）・経過分だけ。
 *   文面は、ここで組み立てる（決定的。同じ状態なら同じ文面。NFR_007）。
 * - 対象は、中間統合ノード（根でない統合ノード）で、動作中か待機中のもの。完了・停止したノードには出さない。
 * - 優先度は、配下（自分を含む）の**未解決の項目**の最高の優先度（要判断 > 失敗 > 完了 > 進捗 > 情報）。未解決の項目がなければ、要約はない。
 * - 数える項目は、要約以外（要約は、ほかの要約を数えない。再帰しない）。
 * - `fingerprint` は、時間に依存しない事実（件数・状態・最優先の項目）の指紋。同じなら、要約を出し直さない（最古の要判断の経過分は含めない）。
 */

import type { NodeRecord, OrchState } from "./events.js";
import type { InboxItem } from "./inbox.js";
import { INBOX_SUMMARY_MAX, PRIORITIES, type Priority, priorityOf } from "./inbox-kinds.js";
import type { NodeState } from "./index.js";
import { LIMITS } from "./limits.js";
import { descendantsOf } from "./tree.js";

/** ノードの状態の表示名。`Record<NodeState, string>` なので、状態が増えれば、型で漏れに気づく（網羅の試験もある）。 */
export const DIGEST_STATE_NAMES: Readonly<Record<NodeState, string>> = {
  pending: "未起動",
  running: "実行",
  waiting: "待機",
  done: "完了報告",
  verified: "受理",
  stopping: "停止中",
  stopIncomplete: "停止未完了",
  stopped: "停止",
  reclaimable: "回収可",
  archived: "アーカイブ",
};
const STATE_LABEL = Object.entries(DIGEST_STATE_NAMES) as readonly (readonly [NodeState, string])[];

export interface DigestFacts {
  readonly nodeId: string;
  /** 配下（自分を含まない）のノードの数。 */
  readonly descendants: number;
  /** 配下のノードの状態別の件数（0 の状態は含まない）。 */
  readonly byState: Readonly<Record<string, number>>;
  /** 未解決の項目の、グループ別の件数（0 のものは含まない）: 要判断・範囲違反・失敗・完了・進捗・情報。 */
  readonly unresolved: Readonly<Record<string, number>>;
  /** 未回答の判断要求・未判定の拡張要求の数（配下と自分）。 */
  readonly openDecisions: number;
  readonly openExtensions: number;
  /** 最優先の未解決の項目の ID（`LIMITS.digestTopItems` 件まで。優先度・時刻・ID の順）。 */
  readonly top: readonly string[];
  /** 最も古い、未解決の「要判断」の項目の経過分（なければ省略）。 */
  readonly oldestBlockingMinutes?: number;
}

export interface Digest extends DigestFacts {
  /** 配下の未解決の項目の最高の優先度。 */
  readonly priority: Priority;
  /** 受信箱の要約（`INBOX_SUMMARY_MAX` 文字以下）。 */
  readonly summary: string;
  /** 時間に依存しない事実の指紋。 */
  readonly fingerprint: string;
}

/** 要約を出す対象: 中間統合ノード（根でない統合ノード）で、動作中か待機中のもの。作成順。 */
export function digestTargets(state: OrchState): string[] {
  return state.nodes
    .filter(
      (n) =>
        n.role === "integrator" &&
        n.parentId !== null &&
        (n.state === "running" || n.state === "waiting"),
    )
    .map((n) => n.id);
}

const GROUP_LABEL: readonly (readonly [string, string])[] = [
  ["decision", "要判断"],
  ["violation", "範囲違反"],
  ["failure", "失敗"],
  ["done", "完了"],
  ["progress", "進捗"],
  ["info", "情報"],
];
const GROUP_OF: Readonly<Record<string, string>> = {
  decision: "decision",
  answer: "decision",
  violation: "violation",
  failure: "failure",
  stopIncomplete: "failure",
  done: "done",
  progress: "progress",
  info: "info",
};

const timeOf = (it: InboxItem): number => {
  const t = Date.parse(it.at);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
};

/** ノードの要約。対象でない・配下に未解決の項目がなければ `undefined`。`nowMs` は、経過分の計算に使う。 */
export function digestOf(state: OrchState, nodeId: string, nowMs: number): Digest | undefined {
  const node: NodeRecord | undefined = state.nodes.find((n) => n.id === nodeId);
  if (
    node === undefined ||
    node.role !== "integrator" ||
    node.parentId === null ||
    (node.state !== "running" && node.state !== "waiting")
  ) {
    return undefined;
  }
  const below = descendantsOf(state.nodes, nodeId);
  const scope = new Set<string>([nodeId, ...below.map((n) => n.id)]);

  const byState: Record<string, number> = {};
  const stateOf = new Map(state.nodes.map((n) => [n.id, n.state] as const));
  for (const n of below) {
    const st = stateOf.get(n.id);
    if (st !== undefined) byState[st] = (byState[st] ?? 0) + 1;
  }

  const items = state.inbox.filter(
    (i) => i.resolved === undefined && i.kind !== "digest" && scope.has(i.nodeId),
  );
  if (items.length === 0) return undefined;

  const unresolved: Record<string, number> = {};
  for (const i of items) {
    const g = GROUP_OF[i.kind] ?? "info";
    unresolved[g] = (unresolved[g] ?? 0) + 1;
  }
  const ranked = [...items].sort((a, b) => {
    const pa = PRIORITIES.indexOf(priorityOf(a));
    const pb = PRIORITIES.indexOf(priorityOf(b));
    if (pa !== pb) return pa - pb;
    const ta = timeOf(a);
    const tb = timeOf(b);
    if (ta !== tb) return ta < tb ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const top = ranked.slice(0, LIMITS.digestTopItems).map((i) => i.id);
  const priority = priorityOf(ranked[0] as InboxItem);

  const blocking = items.filter((i) => priorityOf(i) === "blocking").map(timeOf);
  const oldest = blocking.length === 0 ? undefined : Math.min(...blocking);
  const oldestBlockingMinutes =
    oldest === undefined || !Number.isFinite(oldest) || !Number.isFinite(nowMs)
      ? undefined
      : Math.max(Math.floor((nowMs - oldest) / 60_000), 0);

  const openDecisions = state.decisions.filter(
    (d) => d.status === "open" && scope.has(d.nodeId),
  ).length;
  const openExtensions = state.extensions.filter(
    (x) => x.status === "open" && scope.has(x.nodeId),
  ).length;

  const facts: DigestFacts = {
    nodeId,
    descendants: below.length,
    byState,
    unresolved,
    openDecisions,
    openExtensions,
    top,
    ...(oldestBlockingMinutes === undefined ? {} : { oldestBlockingMinutes }),
  };
  const fingerprint = [
    below.length,
    STATE_LABEL.map(([s]) => byState[s] ?? 0).join(","),
    GROUP_LABEL.map(([g]) => unresolved[g] ?? 0).join(","),
    openDecisions,
    openExtensions,
    priority,
    top.join(","),
  ].join("|");
  return { ...facts, priority, summary: digestSummary(facts), fingerprint };
}

/**
 * 要約の文面（`INBOX_SUMMARY_MAX` 文字以下）。自由な文字列を含まない。長くなるときは、最優先の項目の ID を減らし、最後に切る。
 * 事実（`DigestFacts`）から組み立てる純粋関数（`digestOf` が使う。極端な値の試験のために公開している）。
 */
export function digestSummary(f: DigestFacts): string {
  const states = STATE_LABEL.filter(([s]) => (f.byState[s] ?? 0) > 0)
    .map(([s, label]) => `${label} ${f.byState[s]}`)
    .join("・");
  const unresolved = GROUP_LABEL.filter(([g]) => (f.unresolved[g] ?? 0) > 0)
    .map(([g, label]) => `${label} ${f.unresolved[g]}`)
    .join("・");
  const head = `配下 ${f.descendants}${states === "" ? "" : `（${states}）`}。未解決: ${unresolved}`;
  const open =
    f.openDecisions + f.openExtensions === 0
      ? ""
      : `。未回答の判断 ${f.openDecisions}・未判定の拡張要求 ${f.openExtensions}`;
  const age =
    f.oldestBlockingMinutes === undefined ? "" : `。最古の要判断 ${f.oldestBlockingMinutes} 分`;
  for (let n = f.top.length; n >= 0; n--) {
    const topText = n === 0 ? "" : `。最優先: ${f.top.slice(0, n).join("、")}`;
    const text = `${head}${open}${age}${topText}`;
    if ([...text].length <= INBOX_SUMMARY_MAX) return text;
  }
  return [...`${head}${open}${age}`].slice(0, INBOX_SUMMARY_MAX).join("");
}
