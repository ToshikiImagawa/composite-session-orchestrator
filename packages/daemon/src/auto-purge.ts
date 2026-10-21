/**
 * 自動の最終削除（T13f-a。FR_031）。取り返しがつかないので、daemon の設定 `autoPurge` を有効にしたときだけ動く（既定はオフ）。
 *
 * - 周期（`intervalMs`）で、最上位の木（`parentId` が null か、親がアーカイブ済みでない）でアーカイブ済みのものを、アーカイブが
 *   古い順に並べ、保持期間（`retentionDays`）が過ぎたものを、`maxTreesPerRun` 本まで削除する。最初の実行は 1 周期後（起動直後は消さない）。
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

import { type Actor, type OrchState, planPurge } from "@cso/core";
import type { createPurger } from "./api/handlers/purge-handlers.js";
import type { Timers } from "./sdk/runtime.js";

export interface AutoPurgeDeps {
  readonly state: () => OrchState;
  readonly nowMs: () => number;
  readonly retentionDays: number;
  readonly intervalMs: number;
  readonly maxTreesPerRun: number;
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
      const state = deps.state();
      const byId = new Map(state.nodes.map((n) => [n.id, n]));
      const due: { nodeId: string; archivedAt: string }[] = [];
      for (const n of state.nodes) {
        if (n.state !== "archived") continue;
        if (n.parentId === null) continue; // 根は、人間の node.purge でだけ消せる
        if (byId.get(n.parentId)?.state === "archived") continue;
        const plan = planPurge(state, n.id, deps.nowMs());
        if (!plan.ok) continue; // 木にアーカイブでないノードがある・別の木が依存している、など。人間のコマンドと同じ判定
        if (plan.value.elapsedDays < deps.retentionDays) continue;
        due.push({ nodeId: n.id, archivedAt: plan.value.archivedAt });
      }
      due.sort((a, b) => (a.archivedAt < b.archivedAt ? -1 : a.archivedAt > b.archivedAt ? 1 : 0));
      for (const { nodeId, archivedAt } of due.slice(0, deps.maxTreesPerRun)) {
        if (deps.isStopped()) break;
        const r = deps.purgeTreeOf({
          nodeId,
          requestId: `auto-purge:${nodeId}:${archivedAt}`,
          actor: SYSTEM,
          origin: "auto",
        });
        if (r.ok) {
          purged.push(...r.value.purged);
          deps.note("autoPurge.purged", { nodeId, nodeIds: r.value.purged });
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
