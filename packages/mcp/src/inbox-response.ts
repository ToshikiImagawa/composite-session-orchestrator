/**
 * 受信箱の応答（FR_012, NFR_009）。整列は core の `sortInbox`。ここでは各項目に
 * 次に取るべき操作の候補を添え、簡潔版・詳細版と分割取得を扱う。
 */
import {
  failure,
  type InboxItem,
  type InboxKind,
  type NodeDeps,
  ok,
  type Result,
  type RoleOperation,
  sortInbox,
} from "@cso/core";

type IntegratorOperation = RoleOperation<"integrator">;

/** 項目の種類ごとの、次に取るべき操作の候補（統合ロールの操作のみ）。 */
const NEXT_ACTIONS: Readonly<Record<InboxKind, readonly IntegratorOperation[]>> = {
  decision: ["decision.present", "node.send"],
  answer: ["node.send"],
  violation: ["scope.decide", "node.send", "node.stop"],
  failure: ["node.send", "node.split", "node.stop"],
  stopIncomplete: ["node.stop", "node.capabilities"],
  done: ["node.review"],
  progress: [],
  info: ["node.reclaimPreview"],
};

export const nextActionsFor = (kind: InboxKind): readonly IntegratorOperation[] =>
  NEXT_ACTIONS[kind];

export type Detail = "brief" | "full";

export interface RenderOptions {
  /** 既定は簡潔版（トークン消費の抑制）。 */
  readonly detail?: Detail;
  /** 1 回に返す件数。1〜MAX_LIMIT、既定は DEFAULT_LIMIT。 */
  readonly limit?: number;
  /** 整列後の先頭からの位置。前回の `nextOffset` を渡す。 */
  readonly offset?: number;
  readonly nodeDeps?: NodeDeps;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export type BriefEntry = Pick<InboxItem, "id" | "kind" | "nodeId"> & {
  readonly nextActions: readonly IntegratorOperation[];
};
export type FullEntry = InboxItem & { readonly nextActions: readonly IntegratorOperation[] };

export interface InboxPage {
  readonly entries: readonly (BriefEntry | FullEntry)[];
  readonly total: number;
  /** 続きがあるときだけ入る。次回の `offset` に渡す。 */
  readonly nextOffset?: number;
}

const invalid = (cause: string) =>
  failure(
    "invalid_argument",
    cause,
    `limit は 1〜${MAX_LIMIT} の整数、offset は 0 以上の整数で指定し直す`,
  );

export function renderInbox(
  items: readonly InboxItem[],
  opts: RenderOptions = {},
): Result<InboxPage> {
  const { detail = "brief", limit = DEFAULT_LIMIT, offset = 0 } = opts;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { ok: false, error: invalid(`limit が範囲外: ${limit}`) };
  }
  if (!Number.isInteger(offset) || offset < 0) {
    return { ok: false, error: invalid(`offset が不正: ${offset}`) };
  }
  const sorted = sortInbox(items, opts.nodeDeps);
  const entries = sorted.slice(offset, offset + limit).map((it) => {
    const nextActions = nextActionsFor(it.kind);
    return detail === "full"
      ? { ...it, nextActions }
      : { id: it.id, kind: it.kind, nodeId: it.nodeId, nextActions };
  });
  const end = offset + limit;
  return ok({
    entries,
    total: sorted.length,
    ...(end < sorted.length ? { nextOffset: end } : {}),
  });
}
