/**
 * HTML 画面の表示モデル（T23。FR_021）。I/O を持たない純粋関数。
 *
 * - **含めるもの**: ノードの識別子・役割・親・状態・依存、未解決の受信箱の項目、未回答の判断、未判定の拡張要求。
 * - **含めないもの**: トークン・秘密・パス（作業ツリーの絶対パス・作業範囲の場所・最終コミットなど）。ただし、拡張要求の対象は、`uiTargetOf` の規則を満たすものだけ載せる（T23-b）。ブリーフ（目的・受け入れ基準）も含めない。
 * - 子が書いた文字列（要約・判断の質問・選択肢・拡張の理由）は、制御文字（タブ・改行は残す）と書式制御文字（U+202E など）を除いて、種類ごとの上限（コードポイント）に切る。
 *   切ったときは、末尾に `UI_CUT_MARK`（「…（省略）」）を付ける。画面は、これを `textContent` だけで描く。
 *   上限: 要約・理由 `UI_TEXT_MAX`（200）、判断の質問 `UI_QUESTION_MAX`（2,000）、選択肢 `UI_OPTION_MAX`（500。サーバーの選択肢の上限と同じ）。
 * - **選択肢は、回答の `choice` に、そのまま送る文字列**なので、切った・文字を除いたものは、そのままでは送れない（`UiOption.truncated`。画面は、ボタンを無効にして、自由入力を促す）。
 * - 件数には上限がある（`UI_LIMITS`）。切ったときは、`truncated` に種類を入れる。
 */

import type { OrchState } from "./events.js";
import { ID_PATTERN } from "./ids.js";
import { PRIORITIES, type Priority, priorityOf } from "./inbox-kinds.js";
import type { NodeRole, NodeState } from "./index.js";

export const UI_TEXT_MAX = 200;
/** 判断の質問の上限（コードポイント）。人間が、何を聞かれているかを読んで答えるので、ほかより長い。 */
export const UI_QUESTION_MAX = 2000;
/** 選択肢の上限（サーバーの `LIMITS.optionLength` と同じ）。これを超える・文字を除いたものは、`choice` に使えない。 */
export const UI_OPTION_MAX = 500;
/** 拡張要求の対象の上限（コードポイント）。超えたものは、切らずに隠す（切った値を承認させない）。 */
export const UI_TARGET_MAX = 200;
/** 上限で切ったときに、末尾に付ける印。 */
export const UI_CUT_MARK = "…（省略）";
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
  /** 破棄の判断（`node.reclaimInstruct`）が記録済みか。画面は、停止したノードで、指示済みなら、もう一度は出さない。 */
  readonly discarded: boolean;
  /**
   * daemon が直接止められず、停止を親に代行してもらうノード（能力表の `stopDelegated`。Desktop の子）か。真のときだけ付ける。
   * 画面は、停止未完了のこのノードに、停止の宣言（`node.confirmStopped`）を出す。
   */
  readonly stopDelegated?: true;
}

/** 表示モデルを作るときの、状態の外の情報（daemon が渡す）。 */
export interface UiViewOptions {
  /** そのノードの能力表の `stopDelegated`（アダプタの能力表から。省略すると、どのノードにも付けない）。 */
  readonly stopDelegated?: (nodeId: string) => boolean;
}

export interface UiInboxItem {
  readonly id: string;
  readonly kind: string;
  readonly nodeId: string;
  readonly at: string;
  readonly priority: Priority;
  readonly summary?: string;
}

export interface UiOption {
  readonly text: string;
  /** 切った・文字を除いた（`choice` に、そのままは送れない）。画面は、ボタンを無効にして、自由入力を促す。 */
  readonly truncated: boolean;
}

export interface UiDecision {
  readonly id: string;
  readonly nodeId: string;
  readonly question?: string;
  readonly options: readonly UiOption[];
  /** 選択肢が多くて、一部を載せていない（`UI_LIMITS.options` 件まで）。 */
  readonly optionsCut: boolean;
}

export interface UiExtension {
  readonly id: string;
  readonly nodeId: string;
  readonly reason: string;
  /** 要求の対象の種類（write: 書き込みの場所、command: 実行するコマンド）。種類が分からなければ、なし。 */
  readonly kind?: "write" | "command";
  /** 要求の対象。表示してよいもの（`uiTargetOf`）だけ。隠したときは、なし。 */
  readonly target?: string;
  /** 対象を隠した（絶対パス・`..`・制御文字・長すぎる、など）。画面は、承認・切り出しをさせない。 */
  readonly targetHidden: boolean;
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

const isControl = (cp: number): boolean =>
  (cp < 0x20 && cp !== 0x09 && cp !== 0x0a) || (cp >= 0x7f && cp <= 0x9f);
const FORMAT_CHAR = /\p{Cf}/u;

/** 制御文字・書式制御文字を除き、`max` コードポイントに切る。`removed`: 文字を除いたか。`cut`: 切ったか（切ったら、末尾に `UI_CUT_MARK`）。 */
function sanitize(x: unknown, max: number): { text: string; removed: boolean; cut: boolean } {
  if (typeof x !== "string") return { text: "", removed: false, cut: false };
  const out: string[] = [];
  let removed = false;
  let cut = false;
  for (const ch of x) {
    if (isControl(ch.codePointAt(0) ?? 0) || FORMAT_CHAR.test(ch)) {
      removed = true;
      continue;
    }
    if (out.length >= max) {
      cut = true;
      break;
    }
    out.push(ch);
  }
  return { text: out.join("") + (cut ? UI_CUT_MARK : ""), removed, cut };
}

/** 制御文字・書式制御文字を除き、`max`（既定 `UI_TEXT_MAX`）コードポイントに切る。切ったら、末尾に `UI_CUT_MARK` を付ける。 */
export function uiText(x: unknown, max: number = UI_TEXT_MAX): string {
  return sanitize(x, max).text;
}

/** 選択肢。そのまま `choice` に送れるのは、切っても文字を除いてもいないものだけ。 */
function uiOption(x: unknown): UiOption {
  const r = sanitize(x, UI_OPTION_MAX);
  return { text: r.text, truncated: r.cut || r.removed };
}

const ABSOLUTE_PATH = /^(?:[/\\~]|[A-Za-z][A-Za-z0-9+.-]*:)/;
// command は許可リスト（これ以外の文字を含むものは隠す。`$`・バッククォート・`{}`・引用符・`~`・`\`・`;|&<>()` など）。
const COMMAND_ALLOWED = /^[A-Za-z0-9._:@%+=,/ -]+$/;
// 単語の先頭の `/`（先頭・空白・`=`・`,`・`:` の直後。絶対パス）と、`-I/usr/lib` のような、短いオプションに続く `/`
const COMMAND_ABSOLUTE_WORD = /(?:^|[\s=,:])\//;
const COMMAND_OPTION_SLASH = /(?:^|\s)-[A-Za-z]\//;
const PARENT_SEGMENT = /(?:^|[\s=,:/\\])\.\.(?:$|[\s,:/\\])/;

/**
 * 拡張要求の対象の表示（T23-b）。表示してよいのは、作業ツリー内の相対パス（write）と、絶対パス・`..` を含まないコマンド（command）だけ。
 * 絶対パス・`..`・制御文字（タブ・改行も）・書式制御文字・空・先頭か末尾に空白がある・長すぎる（`UI_TARGET_MAX` コードポイント超）ものは、**切らずに隠す**
 * （切った値を承認すると、別の対象を許可してしまう）。command は**許可リスト**（`COMMAND_ALLOWED`）に合うものだけを表示し、それ以外の文字を含むものは隠す。承認は、daemon が記録済みの対象をそのまま許可するので、画面の表示と実際の許可は一致する。
 */
export function uiTargetOf(t: unknown): Pick<UiExtension, "kind" | "target" | "targetHidden"> {
  if (typeof t !== "object" || t === null) return { targetHidden: true };
  const { kind, value } = t as { kind?: unknown; value?: unknown };
  if (kind !== "write" && kind !== "command") return { targetHidden: true };
  const hidden = { kind, targetHidden: true } as const;
  if (typeof value !== "string" || value.trim() === "" || value !== value.trim()) return hidden;
  let length = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f) || FORMAT_CHAR.test(ch)) return hidden;
    length++;
  }
  if (length > UI_TARGET_MAX) return hidden;
  const bad =
    kind === "write"
      ? ABSOLUTE_PATH.test(value) || PARENT_SEGMENT.test(value)
      : !COMMAND_ALLOWED.test(value) ||
        COMMAND_ABSOLUTE_WORD.test(value) ||
        COMMAND_OPTION_SLASH.test(value) ||
        PARENT_SEGMENT.test(value);
  return bad ? hidden : { kind, target: value, targetHidden: false };
}

/** 識別子の形でなければ、空にする（画面に、形の崩れた文字列を出さない）。 */
const idOf = (x: unknown): string => (typeof x === "string" && ID_PATTERN.test(x) ? x : "");

export function uiViewOf(state: OrchState, options: UiViewOptions = {}): UiView {
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
      discarded: n.discarded !== undefined,
      ...(options.stopDelegated?.(n.id) === true ? { stopDelegated: true as const } : {}),
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
    const question = uiText(d.question, UI_QUESTION_MAX);
    const options = d.options ?? [];
    return {
      id: idOf(d.decisionId),
      nodeId: idOf(d.nodeId),
      ...(question === "" ? {} : { question }),
      options: options.slice(0, UI_LIMITS.options).map((o) => uiOption(o)),
      optionsCut: options.length > UI_LIMITS.options,
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
      ...uiTargetOf(x.target),
    }),
  );

  return { lastSeq: state.lastSeq, nodes, inbox, decisions, extensions, truncated };
}
