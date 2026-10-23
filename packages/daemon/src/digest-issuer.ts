/**
 * 配下の要約（`digest`）の発行器（T24-d。FR_013）。中間統合ノード（根でない統合ノードで、動作中か待機中のもの）ごとに、配下の状況の要約を
 * 受信箱へ 1 件出す。**文面は、core の `digestOf` の結果だけ**を書く（子が影響できる文字列を、含めない。`docs/digest.md`）。
 *
 * - 契機: 周期（`intervalMs`。既定 30 秒）に、ログが前回の確認から進んでいたら（または、間隔のために見送った要約があれば）、全対象を調べる。
 * - 頻度の上限: ノードごとに、最短 `minIntervalMs`（既定 60 秒。単調時計）あけて出す。1 周期に出す件数は `maxPerRun`（既定 20）まで。
 * - 出し直さない: 前回の要約と事実（`fingerprint`）が同じなら出さない。項目の ID は、`(ノード, 指紋, そのノードの要約の通し番号)` から決まる
 *   （同じ状態で再実行しても、同じ ID なので、重複しない。再起動しても、状態から同じ判断になる）。要求 ID は、本文（要約の文面）も含めて決める
 *   （同じ要求 ID が、違う本文で再送されない）。
 * - 記録の増え方を抑える: 事実が変わっても、出し直すのは、**優先度が変わったとき・要判断の件数が変わったとき・前回から `reissueMs`（既定 10 分）以上たったとき**
 *   に限る（最上位の項目の ID や、状態別の件数が変わっただけでは、出し直さない）。
 * - ノードごとに、未解決の要約は常に 1 件: 新しい要約を出せたら、前の要約を system が解決済みにする。
 * - 要約が要らなくなったとき（配下の未解決の項目がなくなった・ノードが完了・停止など、対象でなくなった）は、出ている要約を system が解決済みにする。
 * - 時計: 間隔は単調時計で測る（壁時計の飛びで、頻度の上限が外れない）。壁時計は、要約の経過分の文面にだけ使う。
 */

import { createHash } from "node:crypto";
import {
  type Actor,
  digestOf,
  digestTargets,
  type EventBody,
  type Failure,
  type OrchState,
  type Result,
} from "@cso/core";
import { deriveId } from "./api/handlers/context.js";
import type { Timers } from "./sdk/runtime.js";

const SYSTEM: Actor = { system: true };

export interface DigestIssuerDeps {
  readonly state: () => OrchState;
  /** 壁時計（ミリ秒）。要約の経過分の文面にだけ使う。 */
  readonly nowMs: () => number;
  /** 単調時計（ミリ秒）。ノードごとの最短の間隔を測る。 */
  readonly monoMs: () => number;
  readonly intervalMs: number;
  readonly minIntervalMs: number;
  /** 優先度・要判断の件数が変わらないときに、事実が変わった要約を出し直す最短の間隔（ミリ秒。壁時計）。既定 10 分。 */
  readonly reissueMs?: number;
  readonly maxPerRun: number;
  /** system の操作として、イベントを 1 件追記する。同じ要求 ID の再送は、重複させない。 */
  readonly record: (requestId: string, body: EventBody) => Result<unknown, Failure>;
  readonly timers: Timers;
  readonly note: (event: string, data: Record<string, unknown>) => void;
  /** ログが壊れた（fail closed）後は、動かさない。 */
  readonly isStopped: () => boolean;
}

export interface DigestIssuer {
  start(): void;
  /** 周期を止め、実行中の 1 回が終わるのを待つ。 */
  stop(): Promise<void>;
  /** 1 回の実行（試験用にも使う）。実行中なら `skipped`。 */
  runOnce(): Promise<{
    readonly skipped: boolean;
    readonly issued: string[];
    readonly resolved: number;
  }>;
}

const DEFAULT_REISSUE_MS = 10 * 60_000;

const digestIdOf = (nodeId: string, fingerprint: string, index: number): string =>
  deriveId("dg", "system", `${nodeId}:${fingerprint}:${index}`, "digest");
/** 要求 ID: 本文（要約の文面）も含めて決める。同じ要求 ID が、違う本文で再送されない。 */
const digestRequestId = (
  nodeId: string,
  fingerprint: string,
  index: number,
  summary: string,
): string =>
  deriveId(
    "dgq",
    "system",
    `${nodeId}:${fingerprint}:${index}:${createHash("sha256").update(summary, "utf8").digest("hex")}`,
    "digest-request",
  );

interface Issued {
  readonly priority: string;
  readonly blocking: number;
  readonly mono: number;
  readonly wallMs: number;
}

export function createDigestIssuer(deps: DigestIssuerDeps): DigestIssuer {
  const reissueMs = deps.reissueMs ?? DEFAULT_REISSUE_MS;
  let running = false;
  let stopRequested = false;
  let started = false;
  /** `start()` のたびに増やす。古い周期（`stop()` のあと、`start()` し直す前の）が、二重に動かない。 */
  let generation = 0;
  let timer: { cancel(): void } | undefined;
  let current: Promise<unknown> | undefined;
  /** 前回の確認の（追記のあとの）ログの `lastSeq`。進んでいなければ、事実は変わっていない。 */
  let seenSeq = -1;
  /** 次の周期に、ログが進んでいなくても、調べ直すノード（間隔・件数の上限で見送った・追記や解決に失敗した）。 */
  const retry = new Set<string>();
  /** ノードごとに、最後に要約を出したときの、優先度・要判断の件数・時刻。 */
  const lastIssued = new Map<string, Issued>();

  const resolveItem = (id: string, reason: string): boolean => {
    const r = deps.record(`digest-resolve:${id}`, {
      type: "inbox.resolved",
      payload: { itemId: id },
    });
    if (!r.ok) deps.note("digest.resolveFailed", { id, code: r.error.code, reason });
    return r.ok;
  };

  async function runOnce(): Promise<{ skipped: boolean; issued: string[]; resolved: number }> {
    if (running) {
      deps.note("digest.skipped", { reason: "前の実行が終わっていない" });
      return { skipped: true, issued: [], resolved: 0 };
    }
    running = true;
    const issued: string[] = [];
    let resolved = 0;
    try {
      const state = deps.state();
      if (state.lastSeq === seenSeq && retry.size === 0) {
        return { skipped: false, issued, resolved };
      }
      const targets = new Set(digestTargets(state));
      const digestsOf = (nodeId: string) =>
        state.inbox.filter((i) => i.kind === "digest" && i.nodeId === nodeId);
      retry.clear();
      /** 解決する。失敗したら、次の周期に、ログが進んでいなくても、やり直す。 */
      const resolveAll = (nodeId: string, ids: readonly string[], reason: string): void => {
        for (const id of ids) {
          if (resolveItem(id, reason)) resolved += 1;
          else retry.add(nodeId);
        }
      };

      // (1) 対象でなくなったノード（完了・停止・根でない、など）の、出ている要約を解決する。
      const owners = new Set(state.inbox.filter((i) => i.kind === "digest").map((i) => i.nodeId));
      for (const nodeId of owners) {
        if (targets.has(nodeId)) continue;
        resolveAll(
          nodeId,
          digestsOf(nodeId)
            .filter((d) => d.resolved === undefined)
            .map((d) => d.id),
          "対象でなくなった",
        );
      }

      // (2) 対象のノードごとに、要約を出す・出し直す・解決する。
      let posted = 0;
      for (const nodeId of targets) {
        if (deps.isStopped() || stopRequested) break;
        const nowWall = deps.nowMs();
        const digest = digestOf(state, nodeId, nowWall);
        const mine = digestsOf(nodeId);
        const open = mine.filter((d) => d.resolved === undefined);
        if (digest === undefined) {
          // 配下に未解決の項目がなくなった: 出ている要約を解決する。
          resolveAll(
            nodeId,
            open.map((d) => d.id),
            "未解決の項目がなくなった",
          );
          continue;
        }
        const latest = open.at(-1);
        const blocking = digest.unresolved.decision ?? 0;
        // 最新の未解決の要約が、今の事実のものなら、追記はしない。それ以外の未解決の要約だけを解決する（追記と解決を分ける）。
        const currentId = digestIdOf(nodeId, digest.fingerprint, mine.length - 1);
        if (latest !== undefined && latest.id === currentId) {
          resolveAll(
            nodeId,
            open.filter((d) => d.id !== latest.id).map((d) => d.id),
            "同じ事実の要約が、すでにある",
          );
          continue;
        }
        // 事実が変わった。出し直すのは、優先度が変わったとき・要判断の件数が変わったとき・前回から reissueMs 以上たったとき。
        const mono = deps.monoMs();
        const prev = lastIssued.get(nodeId);
        if (latest !== undefined) {
          const priorityChanged = (prev?.priority ?? latest.priority) !== digest.priority;
          const blockingChanged = prev !== undefined && prev.blocking !== blocking;
          const latestAt = Date.parse(latest.at);
          const lastWall = prev?.wallMs ?? (Number.isFinite(latestAt) ? latestAt : 0);
          const aged = nowWall - lastWall >= reissueMs;
          if (!priorityChanged && !blockingChanged && !aged) {
            retry.add(nodeId); // 時間がたつのを待つ（ログが進んでいなくても、調べ直す）
            continue;
          }
        }
        if (prev !== undefined && mono - prev.mono < deps.minIntervalMs) {
          retry.add(nodeId); // 間隔のために見送る
          continue;
        }
        if (posted >= deps.maxPerRun) {
          retry.add(nodeId);
          continue;
        }
        const index = mine.length;
        const id = digestIdOf(nodeId, digest.fingerprint, index);
        const r = deps.record(digestRequestId(nodeId, digest.fingerprint, index, digest.summary), {
          type: "inbox.added",
          payload: {
            id,
            kind: "digest",
            nodeId,
            summary: digest.summary,
            priority: digest.priority,
          },
        });
        if (!r.ok) {
          deps.note("digest.failed", { nodeId, code: r.error.code });
          retry.add(nodeId);
          continue;
        }
        posted += 1;
        lastIssued.set(nodeId, { priority: digest.priority, blocking, mono, wallMs: nowWall });
        issued.push(id);
        deps.note("digest.issued", { nodeId, priority: digest.priority });
        // 新しい要約を出せたら、前の要約を解決する（ノードごとに、未解決の要約は常に 1 件）。解決に失敗したら、次の周期にやり直す。
        resolveAll(
          nodeId,
          open.map((d) => d.id),
          "新しい要約を出した",
        );
      }
      // 追記したあとの `lastSeq` で更新する（自分の追記では、次の周期に、全対象を調べ直さない）。
      seenSeq = deps.state().lastSeq;
    } catch (e) {
      deps.note("digest.error", { cause: String(e) });
    } finally {
      running = false;
    }
    return { skipped: false, issued, resolved };
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
      started = true;
      stopRequested = false;
      generation += 1;
      schedule(generation);
    },
    async stop() {
      stopRequested = true;
      started = false;
      generation += 1; // 古い周期を無効にする（stop のあとに start し直しても、二重に動かない）
      timer?.cancel();
      timer = undefined;
      await current?.catch(() => undefined);
    },
    runOnce: track,
  };
}
