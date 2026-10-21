/**
 * 最終削除の操作の実体: 事前確認（`node.purgePreview`）と実行（`node.purge`）。人間だけ（DC_003。認可でも拒否するが、
 * ハンドラでも `human` を確かめる）。PRD: FR_031 / spec 5.8
 *
 * - 対象は最上位の木（`planPurge`）: 木全体がアーカイブ済みで、木の外のノードが木に依存していない。保持期間
 *   （`retentionDays`。既定 90）が過ぎるまでは拒否する（`retentionNotElapsed`。早く消すときは設定を下げる）。
 * - 実行は `EventLog.purgeTree`: 木のイベントの行を物理削除し、同じトランザクションで標識（`node.purged`）を追記する。
 *   墓標（タイトル・結果・最終コミット・日付）は標識に載せる。`tombstone` を省略したときは設定の既定（`DEFAULT_PURGE_TOMBSTONE`）。
 *   標識は、墓標を残さないときも残す（監査 NFR_011 と、`seq` が戻らないことのため）。
 * - 前後に監査の記録（`audit`）を残す。木のノードのトークンは失効させる（冪等）。同じ requestId の再送は、何も消さずに
 *   最初の結果を返す。
 */

import {
  type EventBody,
  type Failure,
  type OperationMap,
  type OrchEvent,
  planPurge,
  type Result,
} from "@cso/core";
import type { PurgeOutcome } from "../../eventlog.js";
import type { HandlerRequest } from "../server.js";
import { alreadyApplied, derivedRequestId, fail, type LogPort } from "./context.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

/** 標識（`node.purged`）の内容。墓標は、残すときだけ付く。 */
export interface PurgeMarkerInfo {
  readonly rootId: string;
  readonly nodeIds: readonly string[];
  readonly archivedAt: string;
  readonly tombstone?: {
    readonly title: string;
    readonly outcome: "verified" | "discarded";
    /** 記録があるときだけ（回収のときに記録する経路は第 2 段階）。 */
    readonly lastCommit?: string;
  };
}

export interface PurgeHandlerDeps {
  readonly log: Pick<LogPort, "state"> & Required<Pick<LogPort, "purgeTree" | "checkPurge">>;
  /** 現在時刻（ミリ秒）。 */
  readonly nowMs: () => number;
  /** 保持期間（日）。 */
  readonly retentionDays: number;
  /** `tombstone` を省略したときの既定。 */
  readonly defaultTombstone: boolean;
  /** 木のノードのトークンの失効（冪等）。 */
  readonly revokeNode: (nodeId: string) => void;
  /** 監査の記録（前後）。例外を外へ出さない扱いで呼ぶ。 */
  readonly audit?: (event: string, data: Record<string, unknown>) => void;
  /** 応答に出さない原因の記録先。 */
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

/** 標識のイベント（core の `node.purged`）。 */
export const purgeMarker = (info: PurgeMarkerInfo): EventBody => ({
  type: "node.purged",
  payload: {
    rootId: info.rootId,
    nodeIds: [...info.nodeIds],
    archivedAt: info.archivedAt,
    ...(info.tombstone === undefined ? {} : { tombstone: info.tombstone }),
  },
});

const firstLine = (text: string): string => (text.split("\n")[0] ?? "").trim().slice(0, 200);

export function createPurgeHandlers(deps: PurgeHandlerDeps) {
  const { log } = deps;
  const retentionBlocker = (elapsedDays: number): { code: string; cause: string } => ({
    code: "retentionNotElapsed",
    cause: `保持期間（${deps.retentionDays} 日）が過ぎていない（アーカイブから ${elapsedDays} 日。残り ${deps.retentionDays - elapsedDays} 日）。保持期間は、システムの時計に依存する`,
  });
  const audit = (event: string, data: Record<string, unknown>): void => {
    try {
      deps.audit?.(event, data);
    } catch {
      // 記録先の失敗は、処理を止めない
    }
  };
  const humanOnly = (role: string): Result<never, Failure> | undefined =>
    role === "human"
      ? undefined
      : fail(
          "forbidden",
          "最終削除は人間のコマンドだけが実行できる",
          "人間用のコマンド（cso purge）を使う",
        );

  return {
    "node.purgePreview": (req: HandlerRequest<"node.purgePreview">): R<"node.purgePreview"> => {
      const denied = humanOnly(req.role);
      if (denied) return denied;
      const state = log.state();
      const plan = planPurge(state, req.params.nodeId, deps.nowMs());
      if (!plan.ok) return plan;
      const { nodeIds, archivedAt, elapsedDays } = plan.value;
      const target = state.nodes.find((n) => n.id === req.params.nodeId);
      const title = firstLine(target?.objective ?? "") || req.params.nodeId;
      // 実行できない理由（構造化）。保持期間と、残りのログを畳み込めるか（ドライラン）。
      const blockers: { code: string; cause: string }[] = [];
      if (elapsedDays < deps.retentionDays) blockers.push(retentionBlocker(elapsedDays));
      const dry = log.checkPurge({
        requestId: "purge-preview",
        actor: { human: true },
        nodeIds,
        marker: purgeMarker({ rootId: req.params.nodeId, nodeIds, archivedAt }),
      });
      if (!dry.ok) blockers.push({ code: dry.error.code, cause: dry.error.cause });
      return {
        ok: true,
        value: {
          nodeIds,
          archivedAt,
          elapsedDays,
          retentionDays: deps.retentionDays,
          tombstoneTitle: title,
          purgeable: blockers.length === 0,
          blockers,
        },
      };
    },

    "node.purge": (req: HandlerRequest<"node.purge">): R<"node.purge"> => {
      const denied = humanOnly(req.role);
      if (denied) return denied;
      const actor = { human: true } as const;
      const { nodeId } = req.params;
      const purgeRequest = (nodeIds: readonly string[], marker: EventBody) => ({
        requestId: derivedRequestId(actor, req.requestId, 0),
        actor,
        nodeIds,
        marker,
      });
      const purgedOf = (outcome: PurgeOutcome): string[] => {
        const ids = (outcome.event as OrchEvent & { payload?: { nodeIds?: unknown } }).payload
          ?.nodeIds;
        return Array.isArray(ids) ? (ids as string[]) : [];
      };
      // 再送: 記録済みなら、何も消さずに最初の結果を返す（木はもう存在しないので、計画より先に判定する）。
      if (alreadyApplied(log.state(), actor, req.requestId)) {
        const again = log.purgeTree(
          purgeRequest([], purgeMarker({ rootId: nodeId, nodeIds: [], archivedAt: "" })),
        );
        if (!again.ok) return again;
        // 同じ requestId を別の対象に使い回していないか（標識の木の根が違えば、別の内容）。
        const recorded = (again.value.event as OrchEvent & { payload?: { rootId?: unknown } })
          .payload?.rootId;
        if (recorded !== nodeId) {
          return fail(
            "requestIdConflict",
            "同じ requestId が、別の対象の最終削除に使われている",
            "新しい requestId で要求する",
          );
        }
        return { ok: true, value: { purged: purgedOf(again.value) } };
      }
      const state = log.state();
      const plan = planPurge(state, nodeId, deps.nowMs());
      if (!plan.ok) return plan;
      const { nodeIds, archivedAt, elapsedDays } = plan.value;
      if (elapsedDays < deps.retentionDays) {
        const b = retentionBlocker(elapsedDays);
        return fail(
          b.code,
          b.cause,
          "期間が過ぎてから削除する",
          "早く消す必要があるときは、daemon の設定の retentionDays を下げて再起動する",
        );
      }
      const target = state.nodes.find((n) => n.id === nodeId);
      const withTombstone = req.params.tombstone ?? deps.defaultTombstone;
      const info: PurgeMarkerInfo = {
        rootId: nodeId,
        nodeIds,
        archivedAt,
        ...(withTombstone
          ? {
              tombstone: {
                title: firstLine(target?.objective ?? "") || nodeId,
                outcome:
                  target?.discarded !== undefined ? ("discarded" as const) : ("verified" as const),
              },
            }
          : {}),
      };
      audit("purgeStarting", {
        nodeId,
        nodeIds,
        archivedAt,
        elapsedDays,
        tombstone: withTombstone,
      });
      const r = log.purgeTree(purgeRequest(nodeIds, purgeMarker(info)));
      if (!r.ok) {
        audit("purgeFailed", { nodeId, code: r.error.code, cause: r.error.cause });
        deps.onFailure?.(nodeId, `最終削除に失敗: ${r.error.code}: ${r.error.cause}`);
        return r;
      }
      for (const id of nodeIds) {
        try {
          deps.revokeNode(id);
        } catch (e) {
          deps.onFailure?.(id, `トークンを失効できない: ${String(e)}`);
        }
      }
      audit("purged", { nodeId, nodeIds, deleted: r.value.deleted, seq: r.value.event.seq });
      return { ok: true, value: { purged: nodeIds } };
    },
  };
}
