/**
 * 中間統合ノードを起こす（T24-w。FR_013）。配下（直接の子）に新しい項目が届いたとき、動作中の中間統合ノードへ、**固定の短い 1 行**の
 * 指示を送る（受信箱を見に行かせる）。送り方は、判断の回答の配送（#58）と同じ `InstructionDelivery`（`node.send` と同じ経路）。
 *
 * - **対象**: 根でない統合ノードで、状態が `running`、アダプタが管理している（`canDeliver`）もの。`waiting`（判断待ち。回答の配送で再開する）・
 *   完了・停止・停止の途中・アダプタが管理していないノード（根・daemon の外で動くノード）は、起こさない。
 * - **契機**: 対象 P の直接の子（`parentId === P`）の、未解決の項目で、種類が `WAKE_KINDS`（decision・violation・failure・stopIncomplete・done）、
 *   かつ `seq` が P の「最後に起こした seq」より大きいもの。progress・info・answer・digest では起こさない。深い枝の項目は、その枝の統合ノードがまず起き、
 *   そこから上へ要約（digest）が上がる。持ち主が `archived` の項目は数えない。
 * - **頻度**: ノードごとに、最短 `minIntervalMs`（単調時計）。1 周期に起こす数は `maxPerRun`。起動の直後の 1 周期目も、間隔を守る
 *   （起動の時刻を、前回とみなす。再起動の直後に、一斉に起こさない）。
 * - **冪等**: 指示の要求 ID は `wake-<P>-<根拠の最大の seq>`（決定的）。同じ要求は、重複して記録も配送もしない。「最後に起こした seq」は
 *   メモリだけに持つ（再起動のあとは、未解決の項目から作り直す）。
 * - **本文**: `WAKE_TEXT`（定数）。子の文字列・ID・件数を一切含めない。
 * - **配送の失敗**: 黙って捨てない。`wake.failed` に残し、「最後に起こした seq」を進めず、次の周期（間隔を守って）に再試行する。同じノードで
 *   3 回続けて失敗したら、新しい項目が届くまで再試行しない（`wake.gaveUp`。受信箱の項目は作らない。作ると、親を起こす連鎖になるため）。
 * - **まとめ**: 1 時間ごとに、ノードごとの起こした数・失敗・打ち切りを `wake.summary` に出す（何もなければ出さない）。ノードごとの 1 時間の起こした数が、
 *   上限（`minIntervalMs` で 1 時間に起こせる最大）の 8 割に近づいたら `wake.nearLimit`。
 */

import type { Actor, Failure, InboxItem, InboxKind, OrchState, Result } from "@cso/core";
import { appendAtomically, type LogPort } from "./api/handlers/context.js";
import { type InstructionDelivery, isDelivered } from "./api/handlers/instruction-delivery.js";
import type { Timers } from "./sdk/runtime.js";

const SYSTEM: Actor = { system: true };

/** 起こす指示の本文（定数）。子の文字列・ID・件数を含めない。 */
export const WAKE_TEXT =
  "受信箱に、配下の新しい項目が届いた。inbox_fetch で確かめて、必要な操作をしてください。";

/** 起こす項目の種類。 */
export const WAKE_KINDS: ReadonlySet<InboxKind> = new Set([
  "decision",
  "violation",
  "failure",
  "stopIncomplete",
  "done",
]);

const MAX_CONSECUTIVE_FAILURES = 3;
/** 起こしたあと、そのノードが何も操作しなくても、この時間（単調時計）たてば、また起こせる（起きたまま何もしないノードを、永久に起こさなくならないように）。 */
const BUNDLE_STALE_MS = 10 * 60_000;
export const DEFAULT_MAX_PER_HOUR = 120;
const HOUR_MS = 3_600_000;
const NEAR_LIMIT_RATIO = 0.8;

export interface WakerDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  /** 単調時計（ミリ秒）。ノードごとの最短の間隔・1 時間の窓を測る。 */
  readonly monoMs: () => number;
  /** 起動の時刻（単調時計）。省略すると、作った時刻。起動の直後の 1 周期目も、`minIntervalMs` を守るために、前回とみなす。 */
  readonly startMonoMs?: number;
  readonly intervalMs: number;
  readonly minIntervalMs: number;
  readonly maxPerRun: number;
  /** 全ノード合計で、1 時間（単調時計の窓）に起こす数の上限。既定 `DEFAULT_MAX_PER_HOUR`（120）。 */
  readonly maxPerHour?: number;
  /** 追加指示を、子へ届ける（`InstructionDelivery.deliver`）。 */
  readonly deliver: InstructionDelivery["deliver"];
  /** アダプタが、そのノードを管理しているか。 */
  readonly canDeliver: InstructionDelivery["available"];
  readonly timers: Timers;
  readonly note: (event: string, data: Record<string, unknown>) => void;
  /** ログが壊れた（fail closed）後は、動かさない。 */
  readonly isStopped: () => boolean;
}

export interface Waker {
  start(): void;
  /** 周期を止め、実行中の 1 回が終わるのを待つ。 */
  stop(): Promise<void>;
  /** 1 回の実行（試験用にも使う）。実行中なら `skipped`。 */
  runOnce(): Promise<{ readonly skipped: boolean; readonly woken: string[] }>;
}

interface NodeStats {
  woken: number;
  failed: number;
  gaveUp: number;
}

export function createWaker(deps: WakerDeps): Waker {
  let startedMono = deps.startMonoMs ?? deps.monoMs();
  const maxPerHour = deps.maxPerHour ?? DEFAULT_MAX_PER_HOUR;
  let running = false;
  let stopRequested = false;
  let started = false;
  let generation = 0;
  let timer: { cancel(): void } | undefined;
  let current: Promise<unknown> | undefined;
  /** ノードごとの、最後に起こした（根拠の最大の）seq。メモリだけ。 */
  const wokenSeq = new Map<string, number>();
  /** ノードごとの、最後に試した（成功も失敗も）時刻（単調時計）。 */
  const lastAttempt = new Map<string, number>();
  const failures = new Map<string, number>();
  /** 打ち切ったときの、根拠の最大の seq。これより新しい項目が届くまで、再試行しない。 */
  const gaveUpAt = new Map<string, number>();
  /** ノードごとの、直近 1 時間に起こした時刻（単調時計）。 */
  const recent = new Map<string, number[]>();
  const stats = new Map<string, NodeStats>();
  /** 配送済みで、そのノード自身の操作を待っている起こす指示（束ねる）。メモリだけ。 */
  const pending = new Map<string, { seq: number; mono: number }>();
  /** 全ノード合計の、直近 1 時間に起こした時刻（単調時計）。 */
  let globalWakes: number[] = [];
  /** nearLimit・hourlyLimit を、最後に出した時刻（窓ごとに 1 回だけ出す）。 */
  const nearNotified = new Map<string, number>();
  let hourlyNotified: number | undefined;
  let summaryFrom = startedMono;
  const hourlyMax = Math.max(1, Math.floor(HOUR_MS / deps.minIntervalMs));

  const statOf = (nodeId: string): NodeStats => {
    let s = stats.get(nodeId);
    if (s === undefined) {
      s = { woken: 0, failed: 0, gaveUp: 0 };
      stats.set(nodeId, s);
    }
    return s;
  };

  /** 新しい項目の根拠: P の直接の子の、未解決の、起こす種類の項目（持ち主が archived のものを除く）。seq の昇順。 */
  const evidence = (state: OrchState, nodeId: string, after: number): InboxItem[] => {
    const children = new Set(
      state.nodes.filter((n) => n.parentId === nodeId && n.state !== "archived").map((n) => n.id),
    );
    return state.inbox
      .filter(
        (i) =>
          i.resolved === undefined &&
          WAKE_KINDS.has(i.kind) &&
          i.seq > after &&
          children.has(i.nodeId),
      )
      .sort((a, b) => a.seq - b.seq);
  };

  const note = (event: string, data: Record<string, unknown>): void => {
    try {
      deps.note(event, data);
    } catch {
      // 記録先の失敗は、動作を変えない
    }
  };

  async function wake(
    nodeId: string,
    maxSeq: number,
  ): Promise<{ result: "woken" | "already" | "failed"; seq?: number }> {
    const requestId = `wake-${nodeId}-${maxSeq}`;
    const recorded = appendAtomically(deps.log, deps.clock, requestId, SYSTEM, [
      { type: "node.instructed", payload: { nodeId, text: WAKE_TEXT } },
    ]);
    const seq = recorded.ok ? recorded.value.events[0]?.seq : undefined;
    if (!recorded.ok || seq === undefined) {
      const code = recorded.ok ? "noSeq" : recorded.error.code;
      note("wake.failed", { nodeId, code });
      return { result: "failed" };
    }
    if (isDelivered(deps.log.state(), seq)) return { result: "already", seq };
    const sent: Result<undefined, Failure> = await deps.deliver(nodeId, WAKE_TEXT, seq);
    if (!sent.ok) {
      note("wake.failed", { nodeId, code: sent.error.code });
      return { result: "failed" };
    }
    return { result: "woken", seq };
  }

  async function runOnce(): Promise<{ skipped: boolean; woken: string[] }> {
    if (running) {
      note("wake.skipped", { reason: "前の実行が終わっていない" });
      return { skipped: true, woken: [] };
    }
    running = true;
    const woken: string[] = [];
    try {
      if (deps.isStopped() || stopRequested) return { skipped: false, woken };
      const state = deps.log.state();
      const mono = deps.monoMs();
      // 起こす候補: 動作中の中間統合ノードで、アダプタが管理していて、新しい根拠があるもの。根拠の最小の seq の順（古い項目が先）。
      const candidates: { nodeId: string; maxSeq: number; firstSeq: number }[] = [];
      for (const n of state.nodes) {
        if (n.role !== "integrator" || n.parentId === null || n.state !== "running") continue;
        if (!deps.canDeliver(n.id)) continue;
        const items = evidence(state, n.id, wokenSeq.get(n.id) ?? 0);
        const last = items.at(-1);
        const first = items[0];
        if (last === undefined || first === undefined) continue;
        const gave = gaveUpAt.get(n.id);
        if (gave !== undefined && last.seq <= gave) continue; // 打ち切り。新しい項目が届くまで試さない
        candidates.push({ nodeId: n.id, maxSeq: last.seq, firstSeq: first.seq });
      }
      candidates.sort((a, b) => a.firstSeq - b.firstSeq || (a.nodeId < b.nodeId ? -1 : 1));
      let posted = 0;
      for (const c of candidates) {
        if (deps.isStopped() || stopRequested) break;
        if (posted >= deps.maxPerRun) break;
        const prev = lastAttempt.get(c.nodeId) ?? startedMono;
        if (mono - prev < deps.minIntervalMs) continue; // 間隔のために見送る（次の周期に、調べ直す）
        // 束ねる: 配送済みの起こす指示のあと、そのノード自身の操作が 1 つもない間は、新しく起こさない（ターンの間に積み上げない）。
        const waiting = pending.get(c.nodeId);
        if (waiting !== undefined) {
          const acted =
            mono - waiting.mono >= BUNDLE_STALE_MS ||
            (deps.log.actorsAfter?.(waiting.seq) ?? []).some(
              (e) => "nodeId" in e.actor && e.actor.nodeId === c.nodeId,
            ) ||
            deps.log.actorsAfter === undefined;
          if (!acted) continue;
          pending.delete(c.nodeId);
        }
        // 全体の上限（全ノード合計。1 時間の窓）。
        globalWakes = globalWakes.filter((t) => mono - t < HOUR_MS);
        if (globalWakes.length >= maxPerHour) {
          if (hourlyNotified === undefined || mono - hourlyNotified >= HOUR_MS) {
            hourlyNotified = mono;
            note("wake.hourlyLimit", { max: maxPerHour });
          }
          break;
        }
        posted += 1;
        lastAttempt.set(c.nodeId, mono);
        const woke = await wake(c.nodeId, c.maxSeq);
        const r = woke.result;
        if (r === "failed") {
          const f = (failures.get(c.nodeId) ?? 0) + 1;
          failures.set(c.nodeId, f);
          statOf(c.nodeId).failed += 1;
          if (f >= MAX_CONSECUTIVE_FAILURES) {
            gaveUpAt.set(c.nodeId, c.maxSeq);
            failures.set(c.nodeId, 0);
            statOf(c.nodeId).gaveUp += 1;
            note("wake.gaveUp", { nodeId: c.nodeId, failures: f });
          }
          continue;
        }
        failures.set(c.nodeId, 0);
        gaveUpAt.delete(c.nodeId);
        wokenSeq.set(c.nodeId, c.maxSeq);
        if (r === "already") continue; // 前の実行（再起動の前）で、配送済み。送り直さない
        woken.push(c.nodeId);
        statOf(c.nodeId).woken += 1;
        globalWakes.push(mono);
        if (woke.seq !== undefined) pending.set(c.nodeId, { seq: woke.seq, mono });
        const times = (recent.get(c.nodeId) ?? []).filter((t) => mono - t < HOUR_MS);
        times.push(mono);
        recent.set(c.nodeId, times);
        note("wake.woken", { nodeId: c.nodeId });
        const notified = nearNotified.get(c.nodeId);
        if (
          times.length >= Math.ceil(hourlyMax * NEAR_LIMIT_RATIO) &&
          (notified === undefined || mono - notified >= HOUR_MS)
        ) {
          nearNotified.set(c.nodeId, mono); // 窓（1 時間）ごとに 1 回だけ
          note("wake.nearLimit", { nodeId: c.nodeId, count: times.length, max: hourlyMax });
        }
      }
      // まとめ（1 時間ごと。何もなければ出さない）。
      if (mono - summaryFrom >= HOUR_MS) {
        if (stats.size > 0) {
          note("wake.summary", {
            windowSec: Math.round((mono - summaryFrom) / 1000),
            nodes: Object.fromEntries(stats),
          });
        }
        stats.clear();
        summaryFrom = mono;
      }
    } catch (e) {
      note("wake.error", { cause: String(e) });
    } finally {
      running = false;
    }
    return { skipped: false, woken };
  }

  function track() {
    const p = runOnce();
    current = p;
    void p.finally(() => {
      if (current === p) current = undefined;
    });
    return p;
  }

  function schedule(gen: number): void {
    if (stopRequested || !started || gen !== generation) return;
    const t = deps.timers.after(deps.intervalMs);
    timer = t;
    void t.promise.then(async () => {
      if (stopRequested || deps.isStopped() || gen !== generation) return;
      await track();
      schedule(gen);
    });
  }

  return {
    start() {
      if (started) return;
      // 起動の時刻を決め直す（作ってから start までの時間は、間隔に数えない）。
      if (deps.startMonoMs === undefined) startedMono = deps.monoMs();
      started = true;
      stopRequested = false;
      generation += 1;
      schedule(generation);
    },
    async stop() {
      stopRequested = true;
      started = false;
      generation += 1;
      timer?.cancel();
      timer = undefined;
      await current?.catch(() => undefined);
    },
    runOnce: track,
  };
}
