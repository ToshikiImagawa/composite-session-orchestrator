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
  activePurgeHold,
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
  /** イベントログの最後の `at`（時計がログより前に戻っていないかの検知に使う）。ログが空なら `undefined`。 */
  readonly lastEventAt: () => string | undefined;
  /** 単調時計（ミリ秒。`process.hrtime` 由来）。壁時計との差で、時計が飛んだことを検知する。 */
  readonly monoMs: () => number;
  /** daemon の起動の時点（整合などでログに書く前）の、イベントログの最後の `at`。止まっていた時間の検知に使う。 */
  readonly lastEventAtAtStartup: string | undefined;
}

export interface AutoPurger {
  /**
   * 周期の実行を始める（最初の実行は 1 周期後）。始めるときに、止まっていた時間（`lastEventAtAtStartup` から現在まで）が
   * 1 日以上なら、有効な予告を出し直す（止まっていた時間は、予告の期間に数えない）。
   */
  start(): void;
  /** 周期を止め、実行中の 1 回が（木ごとに旗を確かめて）終わるのを待つ。 */
  stop(): Promise<void>;
  /** 1 回の実行。実行中なら `skipped`。 */
  runOnce(): Promise<{ readonly skipped: boolean; readonly purged: string[] }>;
}

const SYSTEM: Actor = { system: true };

const DAY_MS = 86_400_000;
const MAX_NOTICES_PER_RUN = 20;
const MAX_NOTICES_PER_TREE = 50;
const noticeId = (nodeId: string, archivedAt: string, index: number): string =>
  deriveId("apn", "system", `${nodeId}:${archivedAt}:${index}`, "notice");
/** 予告の requestId（ID と同じようにハッシュで短くする。長い nodeId でも、`isSafeId` の上限を超えない）。 */
/** 木の予告の項目の識別子（新しいものが後ろ。実在するものだけ）。保留（T13f-h）が、有効な予告を、その場で取り下げるのに使う。 */
export function purgeNoticeItems(
  state: OrchState,
  nodeId: string,
  archivedAt: string,
): { id: string; resolved: boolean }[] {
  const out: { id: string; resolved: boolean }[] = [];
  for (let i = 0; i < MAX_NOTICES_PER_TREE; i++) {
    const id = noticeId(nodeId, archivedAt, i);
    const item = state.inbox.find((x) => x.id === id);
    if (item === undefined) break;
    out.push({ id, resolved: item.resolved !== undefined });
  }
  return out;
}

const noticeRequestId = (nodeId: string, archivedAt: string, index: number): string =>
  deriveId("apnq", "system", `${nodeId}:${archivedAt}:${index}`, "notice-request");

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
  const text = `木 ${nodeId} を ${date} 以降に自動で削除する${open}。止めるには cso purge-hold ${nodeId}（人間のコマンド。期限は --until）`;
  return text.length <= 200 ? text : `${text.slice(0, 197)}...`;
}
const FAILURE_NOTE_INTERVAL_MS = DAY_MS;
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export function createAutoPurger(deps: AutoPurgeDeps): AutoPurger {
  let running = false;
  /** `stop()` が呼ばれた。実行中の 1 回も、木ごとに確かめて、残りを処理しない。 */
  let stopRequested = false;
  let started = false;
  let timer: { cancel(): void } | undefined;
  let current: Promise<unknown> | undefined;
  /** 直前の確認の時点の、壁時計と単調時計（時計が飛んだことの検知）。 */
  let baseline: { wall: number; mono: number } | undefined;
  /** 同じ木・同じ原因の失敗を最後に記録した時刻（1 日に 1 回まで）。 */
  const failureNotedAt = new Map<string, number>();
  const retentionMs = deps.retentionDays * DAY_MS;
  const noticeMs = deps.noticeDays * DAY_MS;
  /** 時計の異常の閾値: 予告の期間の半分と 1 日の、短いほう。 */
  const driftLimitMs = Math.min(noticeMs / 2, DAY_MS);

  const eligibleOf = (
    state: OrchState,
    nodeId: string,
  ): { archivedAt: string; nodeIds: readonly string[] } | undefined => {
    const n = state.nodes.find((x) => x.id === nodeId);
    if (n === undefined || n.state !== "archived" || n.parentId === null) return undefined; // 根は対象外
    if (state.nodes.find((x) => x.id === n.parentId)?.state === "archived") return undefined;
    const plan = planPurge(state, nodeId, deps.nowMs());
    if (!plan.ok || plan.value.elapsedDays < deps.retentionDays) return undefined;
    // 保留（T13f-h）: 木の中のどのノードでも、有効な保留があれば、その木全体を対象から外す（期限つきなら、期限まで）。
    // 保留をかけた子の木が、親のアーカイブで外側の新しい木に吸収されても、すり抜けない。外側の根には、保留が有効なうちは予告も出さない。
    if (activePurgeHold(state, plan.value.nodeIds, deps.nowMs()) !== undefined) return undefined;
    return { archivedAt: plan.value.archivedAt, nodeIds: plan.value.nodeIds };
  };
  /** 木の予告（新しいものが後ろ）。 */
  const noticesOf = (state: OrchState, nodeId: string, archivedAt: string) => {
    const out: { id: string; at: string; resolved: boolean; resolvedBySystem: boolean }[] = [];
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
  /** 予告を 1 件出す（持ち主は、木の根の親）。出せたら true。 */
  const postNotice = (
    state: OrchState,
    nodeId: string,
    e: { archivedAt: string; nodeIds: readonly string[] },
    index: number,
  ): boolean => {
    const parentId = state.nodes.find((x) => x.id === nodeId)?.parentId;
    if (parentId === null || parentId === undefined) return false;
    const r = deps.record(noticeRequestId(nodeId, e.archivedAt, index), {
      type: "inbox.added",
      payload: {
        id: noticeId(nodeId, e.archivedAt, index),
        kind: "info",
        nodeId: parentId,
        summary: noticeSummary(state, nodeId, e.nodeIds, deps),
      },
    });
    if (r.ok) deps.note("autoPurge.noticePosted", { nodeId, index });
    else deps.note("autoPurge.noticeFailed", { nodeId, code: r.error.code });
    return r.ok;
  };
  /** 有効な予告（取り下げられておらず、保持期間が過ぎたあとに出したもの。人間の解決は影響しない）かどうか。 */
  const isValid = (
    latest: { at: string; resolvedBySystem: boolean } | undefined,
    archivedAt: string,
  ): boolean =>
    latest !== undefined &&
    !latest.resolvedBySystem &&
    Date.parse(latest.at) >= Date.parse(archivedAt) + retentionMs;

  /**
   * 有効な予告を、すべて出し直す（止まっていた時間・時計が飛んだ時間は、予告の期間に数えない）。古い予告は、system が解決済みにする
   * （人間が解決済みにしていても、新しい予告が後ろにつくので、古いほうは判定に使われない）。
   */
  function reissueNotices(reason: string): void {
    const state = deps.state();
    let n = 0;
    for (const node of state.nodes) {
      const e = eligibleOf(state, node.id);
      if (e === undefined) continue;
      const notices = noticesOf(state, node.id, e.archivedAt);
      const latest = notices.at(-1);
      if (!isValid(latest, e.archivedAt)) continue;
      if (notices.length < MAX_NOTICES_PER_TREE && postNotice(state, node.id, e, notices.length)) {
        for (const old of notices) if (!old.resolved) resolveNotice(old.id);
        n += 1;
      }
    }
    deps.note("autoPurge.noticesReissued", { reason, count: n });
  }

  /** 時計が疑わしければ、理由を返す（その回は止める）。前に飛んだとき（`forward`）は、予告も出し直す。 */
  function clockProblem(): { reason: string; forward: boolean } | undefined {
    const now = deps.nowMs();
    const mono = deps.monoMs();
    const base = baseline;
    baseline = { wall: now, mono };
    const lastAt = deps.lastEventAt();
    if (lastAt !== undefined) {
      const last = Date.parse(lastAt);
      if (!Number.isFinite(last)) {
        return { reason: `イベントログの最後の時刻を読めない（${lastAt}）`, forward: false };
      }
      if (now < last) {
        return {
          reason: `時計が、イベントログの最後の記録（${lastAt}）より前に戻っている`,
          forward: false,
        };
      }
    }
    if (base === undefined) return undefined;
    const drift = now - base.wall - (mono - base.mono); // 壁時計の経過 − 単調時計の経過
    if (drift > driftLimitMs) {
      return {
        reason: `時計が、直前の確認から、単調時計より ${Math.round(drift / 60_000)} 分多く進んだ（時計が前に飛んだ可能性）`,
        forward: true,
      };
    }
    if (drift < -driftLimitMs) {
      return {
        reason: `時計が、直前の確認から、単調時計より ${Math.round(-drift / 60_000)} 分少なくしか進んでいない（時計が前に戻った可能性）`,
        forward: false,
      };
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
        deps.note("autoPurge.skipped", { reason: problem.reason });
        if (problem.forward) reissueNotices(problem.reason);
        return { skipped: true, purged };
      }

      // (1) 対象から外れた木の予告を取り下げる（system が解決済みにする）。
      const state0 = deps.state();
      for (const n of state0.nodes) {
        if (n.state !== "archived" || n.parentId === null) continue;
        if (eligibleOf(state0, n.id) !== undefined) continue;
        // 予告の識別子は、`planPurge` の `archivedAt`（木の中で最大のもの）から作られる。根自身の `archivedAt` とは違いうるので、
        // 両方の鍵で探す（根が子孫より先にアーカイブされた木でも、取り下げ漏れを出さない）。
        const plan = planPurge(state0, n.id, deps.nowMs());
        const keys = new Set<string>();
        if (plan.ok) keys.add(plan.value.archivedAt);
        if (n.archivedAt !== undefined) keys.add(n.archivedAt);
        for (const archivedAt of keys) {
          for (const notice of noticesOf(state0, n.id, archivedAt)) {
            if (!notice.resolved) {
              resolveNotice(notice.id);
              deps.note("autoPurge.noticeWithdrawn", { nodeId: n.id, id: notice.id });
            }
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
        if (deps.isStopped() || stopRequested) break;
        const cur = deps.state();
        const e = eligibleOf(cur, nodeId); // 削除の直前に、保持期間を含めて、もう一度判定する
        if (e === undefined) continue;
        const notices = noticesOf(cur, nodeId, e.archivedAt);
        const latest = notices.at(-1);
        if (!isValid(latest, e.archivedAt)) {
          if (notices.length >= MAX_NOTICES_PER_TREE) {
            deps.note("autoPurge.noticeFailed", {
              nodeId,
              reason: `予告が上限（${MAX_NOTICES_PER_TREE} 件）に達した。この木の自動の削除を止める（人間のコマンドで消す）`,
            });
            continue;
          }
          if (posted >= MAX_NOTICES_PER_RUN) continue;
          if (postNotice(cur, nodeId, e, notices.length)) posted += 1;
          continue;
        }
        if (deleted >= deps.maxTreesPerRun) continue;
        // 予告から noticeDays 日たっていない（latest は、isValid で存在が確かめられている）。
        if (latest === undefined || deps.nowMs() - Date.parse(latest.at) < noticeMs) continue;
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

  /** 実行を 1 回にまとめて追跡する（`stop()` が終わりを待てるように）。 */
  function track(): Promise<{ skipped: boolean; purged: string[] }> {
    const p = runOnce();
    current = p;
    void p.finally(() => {
      if (current === p) current = undefined;
    });
    return p;
  }

  function schedule(): void {
    if (stopRequested || !started) return;
    const t = deps.timers.after(deps.intervalMs);
    timer = t;
    void t.promise.then(async () => {
      if (stopRequested || deps.isStopped()) return;
      await track();
      schedule();
    });
  }

  return {
    start() {
      if (started) return;
      started = true;
      stopRequested = false;
      baseline = { wall: deps.nowMs(), mono: deps.monoMs() };
      // 止まっていた時間は、予告の期間に数えない: 起動の時点で、ログの最後の記録から 1 日以上たっていたら、予告を出し直す。
      const startedAt = deps.lastEventAtAtStartup;
      if (startedAt !== undefined) {
        const last = Date.parse(startedAt);
        if (Number.isFinite(last) && deps.nowMs() - last >= DAY_MS) {
          reissueNotices(`daemon が止まっていた（最後の記録 ${startedAt} から 1 日以上）`);
        }
      }
      schedule();
    },
    async stop() {
      stopRequested = true;
      started = false;
      timer?.cancel();
      timer = undefined;
      await current?.catch(() => undefined);
    },
    runOnce: track,
  };
}
