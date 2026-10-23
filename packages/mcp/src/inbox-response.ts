/**
 * 受信箱の応答（FR_012, NFR_009）。整列は core の `sortInbox`。ここでは各項目に
 * 次に取るべき操作の候補（ツール名）を添え、簡潔版・詳細版と分割取得を扱う。
 *
 * 型の区別:
 * - daemon → mcp の契約: core の `OperationMap["inbox.fetch"]`（`items: InboxItem[]`）
 * - mcp → エージェントの応答: ここの `InboxPage`（整列・分割・次の操作の候補を加えたもの）
 * - エージェント → mcp のツール入力: `InboxFetchInput`
 */
import {
  failure,
  INBOX_KINDS,
  type InboxItem,
  type InboxKind,
  isSafeId,
  type NodeDeps,
  ok,
  PRIORITIES,
  type Result,
  type RoleOperation,
  sortInbox,
} from "@cso/core";
import { toolName } from "./tools.js";

type IntegratorOperation = RoleOperation<"integrator">;

/** 項目の種類ごとの、次に取るべき操作の候補（統合ロールの操作のみ）。design 9.1 の表と同じ。 */
const NEXT_ACTIONS: Readonly<Record<InboxKind, readonly IntegratorOperation[]>> = {
  decision: ["decision.get", "decision.present", "node.send"],
  answer: ["decision.get", "node.send"],
  violation: ["scope.decide", "node.send", "node.stop"],
  failure: ["report.get", "node.send", "node.split", "node.stop"],
  stopIncomplete: ["node.stop", "node.capabilities", "decision.present"],
  done: ["report.get", "node.review"],
  progress: ["report.get"],
  info: [],
  // 配下の要約（T24）: 詳細は、受信箱の全体と木の一覧で読む。
  digest: ["inbox.fetch", "tree.list"],
};

/** 次に取るべき操作の候補を、MCP のツール名で返す。 */
export const nextActionsFor = (kind: InboxKind): readonly string[] =>
  NEXT_ACTIONS[kind].map(toolName);

export type Detail = "brief" | "full";

/** エージェントが `inbox_fetch` に渡す入力。 */
export interface InboxFetchInput {
  /** 前回の `asOfSeq` を渡すと、それより後の差分だけを取得する（daemon の `sinceSeq`）。 */
  readonly sinceSeq?: number;
  /** 既定は簡潔版（トークン消費の抑制）。 */
  readonly detail?: Detail;
  /** 1 回に返す件数。1〜MAX_LIMIT、既定は DEFAULT_LIMIT。 */
  readonly limit?: number;
  /** 整列後の先頭からの位置。前回の `nextOffset` を渡す。 */
  readonly offset?: number;
  /** 続きの取得で、前回の `asOfSeq` を渡す。これ以下の `seq` の項目だけで整列し、新着による重複・欠落を防ぐ。 */
  readonly asOfSeq?: number;
}

export interface RenderOptions {
  readonly detail?: Detail;
  readonly limit?: number;
  readonly offset?: number;
  readonly asOfSeq?: number;
  readonly nodeDeps?: NodeDeps;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

interface WithNext {
  readonly nextActions: readonly string[];
}
export type BriefEntry = Pick<
  InboxItem,
  "id" | "kind" | "nodeId" | "summary" | "ref" | "priority"
> &
  WithNext;
export type FullEntry = InboxItem & WithNext;

export interface InboxPage {
  readonly entries: readonly (BriefEntry | FullEntry)[];
  /** `asOfSeq` 以下の項目の総数（除外した項目は含まない）。 */
  readonly total: number;
  /** 形が不正で除外した項目の数。0 でなければ、保存データの不備として管理者に知らせる。 */
  readonly excluded: number;
  /** この応答が見ている最後の `seq`。続きの取得（`asOfSeq`）と次回の差分取得（`sinceSeq`）に渡す。 */
  readonly asOfSeq: number;
  /** 続きがあるときだけ入る。次回の `offset` に渡す。 */
  readonly nextOffset?: number;
}

const invalid = (cause: string) => ({
  ok: false as const,
  error: failure(
    "invalid_argument",
    cause,
    `limit は 1〜${MAX_LIMIT} の整数、offset・asOfSeq は 0 以上の整数、detail は brief か full で指定し直す`,
  ),
});

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isNonNegInt = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;

/**
 * daemon から受け取った項目の形を検査する（境界での実行時検査。値の細かい検証は zod の導入時に拡張する）。
 * `summary`・`at` は検査しない: `summary` は core が書き込み時に長さと文字を保証し、`at` は書き込み時に
 * ISO 8601 UTC を保証する（不正でも `sortInbox` が時刻の最後に置くので、整列は壊れない）。
 */
function itemProblem(x: unknown): string | undefined {
  if (!isRecord(x)) return "項目がオブジェクトでない";
  if (!isSafeId(x.id) || !isSafeId(x.nodeId)) return "id・nodeId が識別子の形式でない";
  if (!isNonNegInt(x.seq)) return `seq が不正: ${String(x.id)}`;
  if (!(INBOX_KINDS as readonly unknown[]).includes(x.kind)) return `kind が不正: ${x.id}`;
  if (!Array.isArray(x.dependsOn) || !x.dependsOn.every(isSafeId)) {
    return `dependsOn が識別子の配列でない: ${x.id}`;
  }
  if (x.ref !== undefined && !isSafeId(x.ref)) return `ref が識別子の形式でない: ${x.id}`;
  // 優先度は、要約（digest）だけが持ち、必ず持つ（PRIORITIES のどれか）。
  if ((x.kind === "digest") !== (x.priority !== undefined)) {
    return `priority は、digest だけが持ち、必ず持つ: ${x.id}`;
  }
  if (x.priority !== undefined && !(PRIORITIES as readonly unknown[]).includes(x.priority)) {
    return `priority が不正: ${x.id}`;
  }
  return undefined;
}

/** 保存データの不備（受信箱の項目が配列でない）。呼び出し側の誤りではないので `invalid_argument` にしない。 */
const internalData = (cause: string) => ({
  ok: false as const,
  error: failure(
    "internal_data",
    cause,
    "管理者（人間）にこの失敗を知らせる",
    "daemon のログとイベントログを確認する",
  ),
});

export function renderInbox(
  items: readonly InboxItem[],
  opts: RenderOptions = {},
): Result<InboxPage> {
  if (typeof opts !== "object" || opts === null || Array.isArray(opts)) {
    return invalid("opts がオブジェクトでない");
  }
  const { detail = "brief", limit = DEFAULT_LIMIT, offset = 0 } = opts;
  if (detail !== "brief" && detail !== "full") return invalid(`detail が不正: ${String(detail)}`);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return invalid(`limit が範囲外: ${String(limit)}`);
  }
  if (!isNonNegInt(offset)) return invalid(`offset が不正: ${String(offset)}`);
  if (opts.asOfSeq !== undefined && !isNonNegInt(opts.asOfSeq)) {
    return invalid(`asOfSeq が不正: ${String(opts.asOfSeq)}`);
  }
  if (!Array.isArray(items)) return internalData("daemon の受信箱の項目が配列でない");
  // 不正な項目だけを除外し、受信箱全体は失敗にしない。
  const valid = items.filter((it) => itemProblem(it) === undefined);
  const excluded = items.length - valid.length;

  const asOfSeq = opts.asOfSeq ?? valid.reduce((m, it) => Math.max(m, it.seq), 0);
  const sorted = sortInbox(
    valid.filter((it) => it.seq <= asOfSeq),
    opts.nodeDeps,
  );
  const entries = sorted.slice(offset, offset + limit).map((it) => {
    const nextActions = nextActionsFor(it.kind);
    if (detail === "full") return { ...it, nextActions };
    return {
      id: it.id,
      kind: it.kind,
      nodeId: it.nodeId,
      ...(it.summary !== undefined ? { summary: it.summary } : {}),
      ...(it.ref !== undefined ? { ref: it.ref } : {}),
      ...(it.priority !== undefined ? { priority: it.priority } : {}),
      nextActions,
    };
  });
  const end = offset + limit;
  return ok({
    entries,
    total: sorted.length,
    excluded,
    asOfSeq,
    ...(end < sorted.length ? { nextOffset: end } : {}),
  });
}
