/**
 * 配下の要約（`digest`）の発行器（T24-d。FR_013）。中間統合ノード（根でない統合ノードで、動作中か待機中のもの）ごとに、配下の状況の要約を
 * 受信箱へ 1 件出す。**文面は、core の `digestOf` の結果だけ**を書く（子が影響できる文字列を、含めない。`docs/digest.md`）。
 *
 * - 契機: 周期（`intervalMs`。既定 30 秒）に、ログが前回の確認から進んでいたら（または、間隔のために見送った要約があれば）、全対象を調べる。
 * - 頻度の上限: ノードごとに、最短 `minIntervalMs`（既定 60 秒。単調時計）あけて出す。1 周期に出す件数は `maxPerRun`（既定 20）まで。
 * - 出し直さない: 前回の要約と事実（`fingerprint`）が同じなら出さない。項目の ID は、`(ノード, 指紋, そのノードの要約の通し番号)` から決まる
 *   （同じ状態で再実行しても、同じ ID・同じ要求 ID なので、重複しない。再起動しても、状態から同じ判断になる）。
 * - ノードごとに、未解決の要約は常に 1 件: 新しい要約を出せたら、前の要約を system が解決済みにする。
 * - 要約が要らなくなったとき（配下の未解決の項目がなくなった・ノードが完了・停止など、対象でなくなった）は、出ている要約を system が解決済みにする。
 * - 時計: 間隔は単調時計で測る（壁時計の飛びで、頻度の上限が外れない）。壁時計は、要約の経過分の文面にだけ使う。
 */

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

const digestIdOf = (nodeId: string, fingerprint: string, index: number): string =>
  deriveId("dg", "system", `${nodeId}:${fingerprint}:${index}`, "digest");
const digestRequestId = (nodeId: string, fingerprint: string, index: number): string =>
  deriveId("dgq", "system", `${nodeId}:${fingerprint}:${index}`, "digest-request");

export function createDigestIssuer(deps: DigestIssuerDeps): DigestIssuer {
  let running = false;
  let stopRequested = false;
  let started = false;
  let timer: { cancel(): void } | undefined;
  let current: Promise<unknown> | undefined;
  /** 前回の確認の時点のログの `lastSeq`。進んでいなければ、事実は変わっていない。 */
  let seenSeq = -1;
  /** 間隔のために見送った要約があるノード（次の周期に、ログが進んでいなくても調べる）。 */
  const throttled = new Set<string>();
  /** ノードごとに、最後に要約を出した単調時計の時刻。 */
  const lastIssuedMono = new Map<string, number>();

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
      if (state.lastSeq === seenSeq && throttled.size === 0)
        return { skipped: false, issued, resolved };
      const targets = new Set(digestTargets(state));
      const digestsOf = (nodeId: string) =>
        state.inbox.filter((i) => i.kind === "digest" && i.nodeId === nodeId);

      // (1) 対象でなくなったノード（完了・停止・根でない、など）の、出ている要約を解決する。
      const owners = new Set(state.inbox.filter((i) => i.kind === "digest").map((i) => i.nodeId));
      for (const nodeId of owners) {
        if (targets.has(nodeId)) continue;
        for (const d of digestsOf(nodeId)) {
          if (d.resolved === undefined && resolveItem(d.id, "対象でなくなった")) resolved += 1;
        }
      }

      // (2) 対象のノードごとに、要約を出す・出し直す・解決する。
      throttled.clear();
      let posted = 0;
      for (const nodeId of targets) {
        if (deps.isStopped() || stopRequested) break;
        const digest = digestOf(state, nodeId, deps.nowMs());
        const mine = digestsOf(nodeId);
        const open = mine.filter((d) => d.resolved === undefined);
        if (digest === undefined) {
          // 配下に未解決の項目がなくなった: 出ている要約を解決する。
          for (const d of open) if (resolveItem(d.id, "未解決の項目がなくなった")) resolved += 1;
          continue;
        }
        const index = mine.length;
        const latest = open.at(-1);
        // 前回の要約と、事実が同じなら、出さない（ID は、指紋と通し番号から決まる）。
        if (
          latest !== undefined &&
          open.length === 1 &&
          latest.id === digestIdOf(nodeId, digest.fingerprint, index - 1)
        ) {
          continue;
        }
        const mono = deps.monoMs();
        const last = lastIssuedMono.get(nodeId);
        if (last !== undefined && mono - last < deps.minIntervalMs) {
          throttled.add(nodeId); // 間隔のために見送る（次の周期に、また調べる）
          continue;
        }
        if (posted >= deps.maxPerRun) {
          throttled.add(nodeId);
          continue;
        }
        const id = digestIdOf(nodeId, digest.fingerprint, index);
        const r = deps.record(digestRequestId(nodeId, digest.fingerprint, index), {
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
          throttled.add(nodeId);
          continue;
        }
        posted += 1;
        lastIssuedMono.set(nodeId, mono);
        issued.push(id);
        deps.note("digest.issued", { nodeId, priority: digest.priority });
        // 新しい要約を出せたら、前の要約を解決する（ノードごとに、未解決の要約は常に 1 件）。
        for (const d of open) if (resolveItem(d.id, "新しい要約を出した")) resolved += 1;
      }
      seenSeq = state.lastSeq;
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
