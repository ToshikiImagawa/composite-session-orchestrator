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
  type Actor,
  activePurgeHold,
  type EventBody,
  type Failure,
  type OperationMap,
  type OrchEvent,
  planPurge,
  type Result,
} from "@cso/core";
import { purgeNoticeItems } from "../../auto-purge.js";
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
    /** 記録（`node.lastCommit`）があるときだけ。 */
    readonly lastCommit?: string;
  };
  /** 人間が、有効な保留を無視して消す（T13f-h）。標識に残る（墓標を残さないときも）。 */
  readonly holdIgnored?: { readonly until?: string };
}

export interface PurgeHandlerDeps {
  readonly log: Pick<LogPort, "state"> &
    Required<Pick<LogPort, "purgeTree" | "checkPurge" | "appendAll">>;
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
  /** 最終削除に成功したあとに、消えた木のノードを渡す（保管している、破棄した成果の掃除に使う。T13f-r）。例外・失敗は、最終削除の成否に影響しない。 */
  readonly onPurged?: (nodeIds: readonly string[]) => void;
  /** 最終削除で一緒に消える、保管している破棄した成果の数（事前確認に出す。T13f-r）。なければ、事前確認に出さない。失敗は、出さないだけ。 */
  readonly discardedFor?: (nodeIds: readonly string[]) => Promise<number>;
}

/** 標識のイベント（core の `node.purged`）。 */
export const purgeMarker = (info: PurgeMarkerInfo): EventBody => ({
  type: "node.purged",
  payload: {
    rootId: info.rootId,
    nodeIds: [...info.nodeIds],
    archivedAt: info.archivedAt,
    ...(info.tombstone === undefined ? {} : { tombstone: info.tombstone }),
    ...(info.holdIgnored === undefined
      ? {}
      : {
          holdIgnored: true as const,
          ...(info.holdIgnored.until === undefined ? {} : { holdUntil: info.holdIgnored.until }),
        }),
  },
});

const firstLine = (text: string): string => (text.split("\n")[0] ?? "").trim().slice(0, 200);

/** 最終削除の共通の経路（人間のコマンドと自動の最終削除が呼ぶ）。 */
export function createPurger(deps: PurgeHandlerDeps) {
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
  /**
   * 最終削除の実行（人間のコマンドと、自動の最終削除〔`autoPurge`〕が、同じ経路・同じ検査を通る）。
   * `actor` と `requestId` は、呼び出し側が決める（人間: 要求の requestId、自動: 木ごとに決定的な requestId）。
   */
  function purgeTreeOf(args: {
    readonly nodeId: string;
    readonly requestId: string;
    readonly actor: Actor;
    readonly tombstone?: boolean;
    readonly origin: "human" | "auto";
  }): R<"node.purge"> {
    const { nodeId, requestId, actor, tombstone, origin } = args;
    const purgeRequest = (nodeIds: readonly string[], marker: EventBody) => ({
      requestId: derivedRequestId(actor, requestId, 0),
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
    if (alreadyApplied(log.state(), actor, requestId)) {
      const again = log.purgeTree(
        purgeRequest([], purgeMarker({ rootId: nodeId, nodeIds: [], archivedAt: "" })),
      );
      if (!again.ok) return again;
      // 同じ requestId を別の対象に使い回していないか（標識の木の根が違えば、別の内容）。
      const recorded = (again.value.event as OrchEvent & { payload?: { rootId?: unknown } }).payload
        ?.rootId;
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
    // 保留（T13f-h）は、自動の最終削除だけを止める（木の中のどのノードの保留でも）。人間の明示のコマンドは、保留を無視して消せる。
    // 無視したことは、監査と、標識（永続する記録）に残す。
    const held = activePurgeHold(state, nodeIds, deps.nowMs());
    if (held !== undefined && origin === "auto") {
      return fail(
        "purgeHeld",
        `木 ${nodeId} は、自動の最終削除が保留されている`,
        "保留を解除するか、期限が過ぎるのを待つ",
      );
    }
    const holdUntil = held?.purgeHold?.until;
    if (held !== undefined) {
      audit("purgeHoldIgnored", {
        nodeId,
        holder: held.id,
        origin,
        ...(holdUntil === undefined ? {} : { until: holdUntil }),
      });
    }
    const withTombstone = tombstone ?? deps.defaultTombstone;
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
              ...(target?.lastCommit === undefined ? {} : { lastCommit: target.lastCommit }),
            },
          }
        : {}),
      ...(held === undefined
        ? {}
        : { holdIgnored: holdUntil === undefined ? {} : { until: holdUntil } }),
    };
    audit("purgeStarting", {
      nodeId,
      origin,
      nodeIds,
      archivedAt,
      elapsedDays,
      tombstone: withTombstone,
    });
    const r = log.purgeTree(purgeRequest(nodeIds, purgeMarker(info)));
    if (!r.ok) {
      audit("purgeFailed", { nodeId, origin, code: r.error.code, cause: r.error.cause });
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
    audit("purged", { nodeId, origin, nodeIds, deleted: r.value.deleted, seq: r.value.event.seq });
    try {
      deps.onPurged?.(nodeIds);
    } catch (e) {
      deps.onFailure?.(nodeId, `最終削除のあとの後始末に失敗: ${String(e)}`);
    }
    return { ok: true, value: { purged: nodeIds } };
  }

  return { purgeTreeOf, retentionBlocker, audit };
}

export function createPurgeHandlers(deps: PurgeHandlerDeps) {
  const { log } = deps;
  const { purgeTreeOf, retentionBlocker, audit } = createPurger(deps);
  const humanOnly = (role: string): Result<never, Failure> | undefined =>
    role === "human"
      ? undefined
      : fail(
          "forbidden",
          "最終削除は人間のコマンドだけが実行できる",
          "人間用のコマンド（cso purge）を使う",
        );

  return {
    "node.purgePreview": (
      req: HandlerRequest<"node.purgePreview">,
    ): R<"node.purgePreview"> | Promise<R<"node.purgePreview">> => {
      const denied = humanOnly(req.role);
      if (denied) return denied;
      const state = log.state();
      const plan = planPurge(state, req.params.nodeId, deps.nowMs());
      if (!plan.ok) return plan;
      const { nodeIds, archivedAt, elapsedDays } = plan.value;
      const target = state.nodes.find((n) => n.id === req.params.nodeId);
      const title = firstLine(target?.objective ?? "") || req.params.nodeId;
      const holder = activePurgeHold(state, nodeIds, deps.nowMs());
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
      const build = (discardedRefs: number | undefined): R<"node.purgePreview"> => ({
        ok: true,
        value: {
          nodeIds,
          archivedAt,
          elapsedDays,
          retentionDays: deps.retentionDays,
          tombstoneTitle: title,
          purgeable: blockers.length === 0,
          blockers,
          ...(discardedRefs === undefined ? {} : { discardedRefs }),
          ...(holder === undefined
            ? {}
            : {
                hold: {
                  nodeId: holder.id,
                  ...(holder.purgeHold?.until === undefined
                    ? {}
                    : { until: holder.purgeHold.until }),
                  ...(holder.purgeHold?.reason === undefined
                    ? {}
                    : { reason: holder.purgeHold.reason }),
                },
              }),
        },
      });
      // 保管している、破棄した成果の数（取得に失敗したら、出さないだけ）。保管の口がなければ、同期のまま返す。
      if (deps.discardedFor === undefined) return build(undefined);
      return deps.discardedFor(nodeIds).then(build, () => build(undefined));
    },

    // 自動の最終削除の保留（T13f-h）。有効な予告は、同じトランザクションで取り下げる（次の周期を待たない）。
    "node.purgeHold": (req: HandlerRequest<"node.purgeHold">): R<"node.purgeHold"> => {
      const denied = humanOnly(req.role);
      if (denied) return denied;
      const { nodeId, until, reason } = req.params;
      const state = log.state();
      const node = state.nodes.find((n) => n.id === nodeId);
      if (node === undefined) return fail("notFound", "ノードが見つからない", "ID を確認する");
      const human: Actor = { human: true };
      const system: Actor = { system: true };
      // 予告の識別子は、`planPurge` の `archivedAt`（木の中で最大のもの）から作られる。根自身の `archivedAt` とは違いうるので、両方の鍵で探す。
      const plan = planPurge(state, nodeId, deps.nowMs());
      const keys = new Set<string>();
      if (plan.ok) keys.add(plan.value.archivedAt);
      if (node.archivedAt !== undefined) keys.add(node.archivedAt);
      const withdraw = [...keys]
        .flatMap((k) => purgeNoticeItems(state, nodeId, k))
        .filter((n) => !n.resolved);
      const r = log.appendAll([
        {
          requestId: derivedRequestId(human, req.requestId, 0),
          actor: human,
          body: {
            type: "node.purgeHeld",
            payload: {
              nodeId,
              ...(until === undefined ? {} : { until }),
              ...(reason === undefined ? {} : { reason }),
            },
          },
        },
        ...withdraw.map((n, i) => ({
          requestId: derivedRequestId(system, `purge-hold:${req.requestId}`, i),
          actor: system,
          body: { type: "inbox.resolved" as const, payload: { itemId: n.id } },
        })),
      ]);
      if (!r.ok) return fail(r.error.code, r.error.cause, ...r.error.nextActions);
      audit("held", {
        nodeId,
        ...(until === undefined ? {} : { until }),
        withdrawn: withdraw.length,
      });
      return { ok: true, value: { held: true, ...(until === undefined ? {} : { until }) } };
    },

    "node.purgeRelease": (req: HandlerRequest<"node.purgeRelease">): R<"node.purgeRelease"> => {
      const denied = humanOnly(req.role);
      if (denied) return denied;
      const { nodeId } = req.params;
      const node = log.state().nodes.find((n) => n.id === nodeId);
      if (node === undefined) return fail("notFound", "ノードが見つからない", "ID を確認する");
      if (node.purgeHold === undefined) return { ok: true, value: { released: true } }; // 冪等
      const human: Actor = { human: true };
      const r = log.appendAll([
        {
          requestId: derivedRequestId(human, req.requestId, 0),
          actor: human,
          body: { type: "node.purgeHoldReleased", payload: { nodeId } },
        },
      ]);
      if (!r.ok) return fail(r.error.code, r.error.cause, ...r.error.nextActions);
      audit("released", { nodeId });
      return { ok: true, value: { released: true } };
    },

    "node.purge": (req: HandlerRequest<"node.purge">): R<"node.purge"> => {
      const denied = humanOnly(req.role);
      if (denied) return denied;
      // 事前確認で見せた木と、いまの木が違えば、何も消さない（見せたあとで、ノードが増えた・減った）。
      // 木がもうない（消えた）ときは、照合しない（同じ requestId の再送は、最初の結果を返す）。
      const expected = req.params.expectNodeIds;
      if (expected !== undefined) {
        const plan = planPurge(log.state(), req.params.nodeId, deps.nowMs());
        if (plan.ok) {
          const now = [...plan.value.nodeIds].sort();
          const shown = [...expected].sort();
          if (now.length !== shown.length || now.some((x, i) => x !== shown[i])) {
            return fail(
              "purgeStale",
              `事前確認で見せた木（${shown.length} ノード）と、いまの木（${now.length} ノード）が違う。何も消していない`,
              "もう一度、事前確認で、削除される木を確かめ直す",
            );
          }
        }
      }
      return purgeTreeOf({
        nodeId: req.params.nodeId,
        requestId: req.requestId,
        actor: { human: true },
        ...(req.params.tombstone === undefined ? {} : { tombstone: req.params.tombstone }),
        origin: "human",
      });
    },
  };
}
