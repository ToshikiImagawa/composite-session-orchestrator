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
  type NodeDeps,
  ok,
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
export type BriefEntry = Pick<InboxItem, "id" | "kind" | "nodeId" | "summary" | "ref"> & WithNext;
export type FullEntry = InboxItem & WithNext;

export interface InboxPage {
  readonly entries: readonly (BriefEntry | FullEntry)[];
  /** `asOfSeq` 以下の項目の総数。 */
  readonly total: number;
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

/** daemon から受け取った項目の形を検査する（境界での実行時検査。値の細かい検証は zod の導入時に拡張する）。 */
function itemProblem(x: unknown): string | undefined {
  if (!isRecord(x)) return "項目がオブジェクトでない";
  if (typeof x.id !== "string" || typeof x.nodeId !== "string") return "id・nodeId が文字列でない";
  if (!isNonNegInt(x.seq)) return `seq が不正: ${String(x.id)}`;
  if (typeof x.at !== "string") return `at が文字列でない: ${x.id}`;
  if (!(INBOX_KINDS as readonly unknown[]).includes(x.kind)) return `kind が不正: ${x.id}`;
  if (!Array.isArray(x.dependsOn) || !x.dependsOn.every((d) => typeof d === "string")) {
    return `dependsOn が文字列の配列でない: ${x.id}`;
  }
  if (x.summary !== undefined && typeof x.summary !== "string") return `summary が不正: ${x.id}`;
  if (x.ref !== undefined && typeof x.ref !== "string") return `ref が不正: ${x.id}`;
  return undefined;
}

export function renderInbox(
  items: readonly InboxItem[],
  opts: RenderOptions = {},
): Result<InboxPage> {
  if (!Array.isArray(items)) return invalid("items が配列でない");
  for (const it of items) {
    const problem = itemProblem(it);
    if (problem !== undefined) return invalid(`受信箱の項目が不正: ${problem}`);
  }
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

  const asOfSeq = opts.asOfSeq ?? items.reduce((m, it) => Math.max(m, it.seq), 0);
  const sorted = sortInbox(
    items.filter((it) => it.seq <= asOfSeq),
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
      nextActions,
    };
  });
  const end = offset + limit;
  return ok({
    entries,
    total: sorted.length,
    asOfSeq,
    ...(end < sorted.length ? { nextOffset: end } : {}),
  });
}
