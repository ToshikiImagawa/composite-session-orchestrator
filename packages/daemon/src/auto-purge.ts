/**
 * 自動の最終削除（T13f-a・T13f-n。FR_031）。取り返しがつかないので、daemon の設定 `autoPurge` を有効にしたときだけ動く（既定はオフ）。
 *
 * - 周期（`intervalMs`）で、最上位の木（`parentId` が null か、親がアーカイブ済みでない）でアーカイブ済みのものを、アーカイブが
 *   古い順に並べ、保持期間（`retentionDays`）が過ぎたものを、`maxTreesPerRun` 本まで削除する。最初の実行は 1 周期後（起動直後は消さない）。
 * - **予告（T13f-n）**: 対象になった木ごとに、受信箱に `info` の項目を 1 件出す（持ち主は、木の根の親。木のノードに付けると、
 *   削除で一緒に消えるため）。**削除は、予告の項目が出てから `noticeDays` 日たったものだけ**（予告の `inbox.added` の `at` で判定。
 *   daemon が止まっていて、保持期間をだいぶ過ぎてから起動した場合も、予告を今出して、`noticeDays` 日後に削除する）。
 *   人間が予告を解決済みにしても、削除の条件は変わらない（判定に使うのは、予告が出たことと、その `at`）。
 *   予告は、木が対象から外れたとき（保持期間を延ばした、親がアーカイブされて最上位でなくなった、外から依存された、など）に、
 *   system が解決済みにする（取り下げ。取り下げた予告は無効で、また対象になれば出し直す）。削除の後も、予告を解決済みにする。
 *   削除の直前に、保持期間をもう一度判定する。
 * - 削除は、人間のコマンド（`node.purge`）と同じ関数（`createPurger().purgeTreeOf`）を通る: `planPurge`・保持期間・ドライラン・
 *   `purgeTree`（`secure_delete`・`wal_checkpoint`・標識の追記）・トークンの失効・監査。検査を二重に書かない。
 *   操作の主体は `{ system: true }`、requestId は木ごとに決定的（`auto-purge:<nodeId>:<archivedAt>`。再実行しても二重に消さない）。
 * - 1 回の実行が前の実行と重ならない（実行中なら飛ばす）。1 本が失敗しても止めず、記録（`note`）に残して、次の木へ進む。
 *   同じ木・同じ原因の失敗の記録は、1 日に 1 回まで。
 * - 根のノード（`parentId` が null）は、対象にしない（根は、人間の `node.purge` でだけ消せる）。
 * - 時計の異常への対策: 実行の前に、時計がイベントログの最後の `at` より前に戻っていないか、最後の `at` から保持期間の半分以上
 *   進んでいないかを確かめ、疑わしければその回の実行を止める（`autoPurge.skipped` に理由を付けて記録）。
 * - 木を 1 本処理するごとに、`setImmediate` でイベントループに譲る（`purgeTree` は同期で、大きなログでは応答が遅くなるため）。
 */

import {
  type Actor,
  type EventBody,
  type Failure,
  type OrchState,
  planPurge,
  type Result,
} from "@cso/core";
import { deriveId } from "./api/handlers/context.js";
import type { createPurger } from "./api/handlers/purge-handlers.js";
import type { Timers } from "./sdk/runtime.js";

export interface AutoPurgeDeps {
  readonly state: () => OrchState;
  readonly nowMs: () => number;
  readonly retentionDays: number;
  readonly intervalMs: number;
  readonly maxTreesPerRun: number;
  /** 予告を出してから削除するまでの日数（T13f-n）。 */
  readonly noticeDays: number;
  /** system の操作として、イベントを 1 件追記する（予告の項目・解決）。 */
  readonly record: (requestId: string, body: EventBody) => Result<unknown, Failure>;
  readonly purgeTreeOf: ReturnType<typeof createPurger>["purgeTreeOf"];
  readonly timers: Timers;
  readonly note: (event: string, data: Record<string, unknown>) => void;
  /** ログが壊れた（fail closed）後は、動かさない。 */
  readonly isStopped: () => boolean;
  /** イベントログの最後の `at`（時計の異常の検知に使う）。ログが空なら `undefined`。 */
  readonly lastEventAt: () => string | undefined;
}

export interface AutoPurger {
  /** 周期の実行を始める（最初の実行は 1 周期後）。 */
  start(): void;
  /** 周期を止める（実行中の 1 回は、終わるまで進む）。 */
  stop(): void;
  /** 1 回の実行。実行中なら `skipped`。 */
  runOnce(): Promise<{ readonly skipped: boolean; readonly purged: string[] }>;
}

const SYSTEM: Actor = { system: true };

const DAY_MS = 86_400_000;
const MAX_NOTICES_PER_RUN = 20;
const MAX_NOTICES_PER_TREE = 50;
const noticeId = (nodeId: string, archivedAt: string, index: number): string =>
  deriveId("apn", "system", `${nodeId}:${archivedAt}:${index}`, "notice");

/** 予告の要約（`INBOX_SUMMARY_MAX` 文字以下）。 */
function noticeSummary(
  state: OrchState,
  nodeId: string,
  nodeIds: readonly string[],
  deps: Pick<AutoPurgeDeps, "nowMs" | "noticeDays">,
): string {
  const inTree = new Set(nodeIds);
  const decisions = state.decisions.filter(
    (d) => d.status === "open" && inTree.has(d.nodeId),
  ).length;
  const items = state.inbox.filter((i) => i.resolved === undefined && inTree.has(i.nodeId)).length;
  const date = new Date(deps.nowMs() + deps.noticeDays * DAY_MS).toISOString().slice(0, 10);
  const open =
    decisions + items === 0 ? "" : `（未回答の判断 ${decisions}・未解決の項目 ${items}）`;
  const text = `木 ${nodeId} を ${date} 以降に自動で削除する${open}。止めるには autoPurge を無効に、または retentionDays を延ばして daemon を再起動する`;
  return text.length <= 200 ? text : `${text.slice(0, 197)}...`;
}
const FAILURE_NOTE_INTERVAL_MS = DAY_MS;
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function createAutoPurger(deps: AutoPurgeDeps): AutoPurger {
  let running = false;
  let stopped = true;
  let timer: { cancel(): void } | undefined;
  /** 同じ木・同じ原因の失敗を最後に記録した時刻（1 日に 1 回まで）。 */
  const failureNotedAt = new Map<string, number>();

  /** 時計が疑わしければ、理由を返す。 */
  function clockProblem(): string | undefined {
    const lastAt = deps.lastEventAt();
    if (lastAt === undefined) return undefined;
    const last = Date.parse(lastAt);
    if (!Number.isFinite(last)) return `イベントログの最後の時刻を読めない（${lastAt}）`;
    const now = deps.nowMs();
    if (now < last) return `時計が、イベントログの最後の記録（${lastAt}）より前に戻っている`;
    if (now - last >= (deps.retentionDays * DAY_MS) / 2) {
      return `イベントログの最後の記録（${lastAt}）から、保持期間（${deps.retentionDays} 日）の半分以上進んでいる（時計が大きく進んだ可能性）`;
    }
    return undefined;
  }

  async function runOnce(): Promise<{ skipped: boolean; purged: string[] }> {
    if (running) {
      deps.note("autoPurge.skipped", { reason: "前の実行が終わっていない" });
      return { skipped: true, purged: [] };
    }
    running = true;
    const purged: string[] = [];
    try {
      const problem = clockProblem();
      if (problem !== undefined) {
        deps.note("autoPurge.skipped", { reason: problem });
        return { skipped: true, purged };
      }
      const state0 = deps.state();
      const retentionMs = deps.retentionDays * DAY_MS;
      const noticeMs = deps.noticeDays * DAY_MS;
      const eligibleOf = (
        state: OrchState,
        nodeId: string,
      ): { archivedAt: string; nodeIds: readonly string[] } | undefined => {
        const n = state.nodes.find((x) => x.id === nodeId);
        if (n === undefined || n.state !== "archived" || n.parentId === null) return undefined; // 根は対象外
        if (state.nodes.find((x) => x.id === n.parentId)?.state === "archived") return undefined;
        const plan = planPurge(state, nodeId, deps.nowMs());
        if (!plan.ok || plan.value.elapsedDays < deps.retentionDays) return undefined;
        return { archivedAt: plan.value.archivedAt, nodeIds: plan.value.nodeIds };
      };
      /** 木の予告（新しいものが後ろ）。 */
      const noticesOf = (state: OrchState, nodeId: string, archivedAt: string) => {
        const out: { id: string; at: string; resolvedBySystem: boolean; resolved: boolean }[] = [];
        for (let i = 0; i < MAX_NOTICES_PER_TREE; i++) {
          const id = noticeId(nodeId, archivedAt, i);
          const item = state.inbox.find((x) => x.id === id);
          if (item === undefined) break;
          out.push({
            id,
            at: item.at,
            resolved: item.resolved !== undefined,
            resolvedBySystem: item.resolved !== undefined && "system" in item.resolved.by,
          });
        }
        return out;
      };
      const resolveNotice = (id: string): void => {
        const r = deps.record(`auto-purge-resolve:${id}`, {
          type: "inbox.resolved",
          payload: { itemId: id },
        });
        if (!r.ok) deps.note("autoPurge.noticeResolveFailed", { id, code: r.error.code });
      };

      // (1) 対象から外れた木の予告を取り下げる（system が解決済みにする）。
      for (const n of state0.nodes) {
        if (n.state !== "archived" || n.parentId === null) continue;
        if (eligibleOf(state0, n.id) !== undefined) continue;
        const archivedAt = n.archivedAt;
        if (archivedAt === undefined) continue;
        for (const notice of noticesOf(state0, n.id, archivedAt)) {
          if (!notice.resolved) {
            resolveNotice(notice.id);
            deps.note("autoPurge.noticeWithdrawn", { nodeId: n.id, id: notice.id });
          }
        }
      }

      // (2) 対象の木を、アーカイブが古い順に並べ、予告がなければ出し、予告から noticeDays 日たったものを、上限まで削除する。
      const state = deps.state();
      const due: { nodeId: string; archivedAt: string }[] = [];
      for (const n of state.nodes) {
        const e = eligibleOf(state, n.id);
        if (e !== undefined) due.push({ nodeId: n.id, archivedAt: e.archivedAt });
      }
      due.sort((a, b) => (a.archivedAt < b.archivedAt ? -1 : a.archivedAt > b.archivedAt ? 1 : 0));
      let posted = 0;
      let deleted = 0;
      for (const { nodeId, archivedAt } of due) {
        if (deps.isStopped()) break;
        const cur = deps.state();
        const e = eligibleOf(cur, nodeId); // 削除の直前に、保持期間を含めて、もう一度判定する
        if (e === undefined) continue;
        const dueAtMs = Date.parse(e.archivedAt) + retentionMs;
        const notices = noticesOf(cur, nodeId, e.archivedAt);
        const latest = notices.at(-1);
        // 有効な予告: 取り下げられておらず、保持期間が過ぎたあとに出したもの（保持期間を延ばしたあとの古い予告は、無効）。
        // 人間が解決済みにしても、有効なまま（判定に使うのは、予告が出たことと、その `at`）。
        const valid =
          latest !== undefined && !latest.resolvedBySystem && Date.parse(latest.at) >= dueAtMs;
        if (!valid) {
          if (posted >= MAX_NOTICES_PER_RUN) continue;
          const parentId = cur.nodes.find((x) => x.id === nodeId)?.parentId;
          if (parentId === null || parentId === undefined) continue;
          const index = latest === undefined ? 0 : notices.length;
          const r = deps.record(`auto-purge-notice:${nodeId}:${e.archivedAt}:${index}`, {
            type: "inbox.added",
            payload: {
              id: noticeId(nodeId, e.archivedAt, index),
              kind: "info",
              nodeId: parentId,
              summary: noticeSummary(cur, nodeId, e.nodeIds, deps),
            },
          });
          if (r.ok) {
            posted += 1;
            deps.note("autoPurge.noticePosted", { nodeId, index });
          } else {
            deps.note("autoPurge.noticeFailed", { nodeId, code: r.error.code });
          }
          continue;
        }
        if (deleted >= deps.maxTreesPerRun) continue;
        if (deps.nowMs() - Date.parse(latest.at) < noticeMs) continue; // 予告から noticeDays 日たっていない
        const r = deps.purgeTreeOf({
          nodeId,
          requestId: `auto-purge:${nodeId}:${archivedAt}`,
          actor: SYSTEM,
          origin: "auto",
        });
        deleted += 1;
        if (r.ok) {
          purged.push(...r.value.purged);
          deps.note("autoPurge.purged", { nodeId, nodeIds: r.value.purged });
          for (const notice of notices) if (!notice.resolved) resolveNotice(notice.id);
        } else {
          const key = `${nodeId}:${r.error.code}`;
          const at = deps.nowMs();
          const before = failureNotedAt.get(key);
          if (before === undefined || at - before >= FAILURE_NOTE_INTERVAL_MS) {
            failureNotedAt.set(key, at);
            deps.note("autoPurge.failed", { nodeId, code: r.error.code, cause: r.error.cause });
          }
        }
        await yieldToEventLoop();
      }
    } catch (e) {
      deps.note("autoPurge.error", { cause: String(e) });
    } finally {
      running = false;
    }
    return { skipped: false, purged };
  }

  function schedule(): void {
    if (stopped) return;
    const t = deps.timers.after(deps.intervalMs);
    timer = t;
    void t.promise.then(async () => {
      if (stopped || deps.isStopped()) return;
      await runOnce();
      schedule();
    });
  }

  return {
    start() {
      if (!stopped) return;
      stopped = false;
      schedule();
    },
    stop() {
      stopped = true;
      timer?.cancel();
      timer = undefined;
    },
    runOnce,
  };
}
