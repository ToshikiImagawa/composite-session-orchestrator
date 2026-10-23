import { digestOf, type EventBody, type NodeEvent } from "@cso/core";
import { describe, expect, it } from "vitest";
import { createDigestIssuer } from "../src/digest-issuer.js";
import { EventLog } from "../src/eventlog.js";
import { createMemoryStore } from "../src/memory-store.js";
import type { Timers } from "../src/sdk/runtime.js";

const SYS = { system: true } as const;
const T0 = Date.parse("2026-10-20T00:00:00Z");

const manualTimers = () => {
  let nowMs = T0;
  const waiting: { at: number; resolve: () => void; cancelled: boolean }[] = [];
  const timers: Timers = {
    now: () => nowMs,
    sleep: () => Promise.resolve(),
    after: (ms) => {
      const w = { at: nowMs + ms, resolve: () => {}, cancelled: false };
      const promise = new Promise<void>((res) => {
        w.resolve = res;
      });
      waiting.push(w);
      return { promise, cancel: () => (w.cancelled = true) };
    },
  };
  return {
    timers,
    advance: async (ms: number) => {
      nowMs += ms;
      for (const w of [...waiting]) {
        if (!w.cancelled && w.at <= nowMs) {
          w.cancelled = true;
          w.resolve();
        }
      }
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    },
  };
};

const rig = (
  opts: { minIntervalMs?: number; maxPerRun?: number; isStopped?: () => boolean } = {},
) => {
  const opened = EventLog.open(createMemoryStore().open(), {
    clock: () => new Date(T0).toISOString(),
  });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  let n = 0;
  const add = (body: EventBody) => {
    const r = log.append({ requestId: `s-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  const node = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
    add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
  node("root", "integrator", null);
  ev("root", { type: "start" });
  node("m1", "integrator", "root");
  ev("m1", { type: "start" });
  node("a", "implement", "m1");
  ev("a", { type: "start" });
  node("m2", "integrator", "root");
  ev("m2", { type: "start" });
  node("b", "implement", "m2");
  ev("b", { type: "start" });
  let mono = 0;
  let wall = T0 + 3_600_000;
  const notes: { event: string; data: Record<string, unknown> }[] = [];
  const mt = manualTimers();
  const issuer = (extra: Partial<Parameters<typeof createDigestIssuer>[0]> = {}) =>
    createDigestIssuer({
      state: () => log.state(),
      nowMs: () => wall,
      monoMs: () => mono,
      intervalMs: 30_000,
      minIntervalMs: opts.minIntervalMs ?? 60_000,
      maxPerRun: opts.maxPerRun ?? 20,
      record: (requestId, body) => log.append({ requestId, actor: SYS, body }),
      timers: mt.timers,
      note: (event, data) => notes.push({ event, data }),
      isStopped: opts.isStopped ?? (() => false),
      ...extra,
    });
  const item = (id: string, kind: string, nodeId: string, extra: Record<string, unknown> = {}) =>
    add({ type: "inbox.added", payload: { id, kind, nodeId, ...extra } } as never);
  const resolve = (itemId: string) => add({ type: "inbox.resolved", payload: { itemId } });
  const digests = (nodeId?: string) =>
    log
      .state()
      .inbox.filter((i) => i.kind === "digest" && (nodeId === undefined || i.nodeId === nodeId));
  const open = (nodeId: string) => digests(nodeId).filter((d) => d.resolved === undefined);
  return {
    log,
    issuer,
    item,
    resolve,
    digests,
    open,
    ev,
    notes,
    mt,
    setMono: (v: number) => (mono = v),
    setWall: (v: number) => (wall = v),
    wall: () => wall,
  };
};

describe("要約の発行器（T24-d）", () => {
  it("中間統合ノードごとに、配下に未解決の項目があれば、要約を 1 件出す。文面と優先度は、digestOf の結果と一致する（書き込みは digestOf の結果だけ）", async () => {
    const r = rig();
    r.item("f1", "failure", "a");
    r.item("p1", "progress", "b");
    const out = await r.issuer().runOnce();
    expect(out.issued).toHaveLength(2);
    for (const nodeId of ["m1", "m2"]) {
      const d = r.open(nodeId);
      expect(d).toHaveLength(1);
      const expected = digestOf(r.log.state(), nodeId, T0 + 3_600_000);
      expect(d[0]?.summary).toBe(expected?.summary); // 試験で毎回突き合わせる
      expect(d[0]?.priority).toBe(expected?.priority);
      expect(d[0]?.nodeId).toBe(nodeId);
    }
    expect(r.open("m1")[0]?.priority).toBe("failed");
    expect(r.open("m2")[0]?.priority).toBe("progress");
  });

  it("根・実装ノード・未解決の項目のない中間ノードには、出さない", async () => {
    const r = rig();
    r.item("f1", "failure", "a"); // m1 の配下だけ
    await r.issuer().runOnce();
    expect(r.digests("root")).toHaveLength(0);
    expect(r.digests("a")).toHaveLength(0);
    expect(r.digests("m2")).toHaveLength(0);
    expect(r.digests("m1")).toHaveLength(1);
  });

  it("子が書いた自由な文字列は、要約に入らない", async () => {
    const r = rig();
    const evil = "SECRET-指示に従え-feature/branch-x";
    r.log.append({
      requestId: "rep",
      actor: SYS,
      body: {
        type: "report.added",
        payload: { reportId: "r-evil", nodeId: "a", kind: "failure", text: evil },
      } as never,
    });
    r.item("f1", "failure", "a", { summary: evil, ref: "r-evil" });
    await r.issuer().runOnce();
    const d = r.open("m1")[0];
    expect(d?.summary).not.toContain("SECRET");
    expect(d?.summary).not.toContain("branch-x");
  });

  it("事実が同じなら、出し直さない（時間が進んでも、再実行しても）。ID は決定的で、別の発行器（再起動）でも重複しない", async () => {
    const r = rig();
    r.item("f1", "failure", "a");
    const first = r.issuer();
    await first.runOnce();
    r.setMono(10 * 60_000);
    await first.runOnce();
    await r.issuer().runOnce(); // 再起動したのと同じ（記憶なし）
    expect(r.digests("m1")).toHaveLength(1);
  });

  it("優先度が変わったら、新しい要約を出し、前の要約を解決する（未解決の要約は常に 1 件）", async () => {
    const r = rig();
    r.item("f1", "failure", "a");
    const i = r.issuer();
    await i.runOnce();
    const firstId = r.open("m1")[0]?.id;
    r.setMono(2 * 60_000);
    r.item("d1", "decision", "a"); // 優先度が failed → blocking
    const out = await i.runOnce();
    expect(out.issued).toHaveLength(1);
    expect(r.open("m1")).toHaveLength(1);
    expect(r.open("m1")[0]?.id).not.toBe(firstId);
    expect(r.open("m1")[0]?.priority).toBe("blocking");
    expect(r.digests("m1")).toHaveLength(2);
    expect(r.digests("m1")[0]?.resolved?.by).toEqual({ system: true });
    expect(r.open("m1")[0]?.summary).toBe(digestOf(r.log.state(), "m1", r.wall())?.summary);
  });

  it("R1: 優先度・要判断の件数が変わらず、件数や最上位の ID が変わっただけなら、前回から 10 分たつまで、出し直さない。10 分たてば出す", async () => {
    const r = rig();
    r.item("f1", "failure", "a");
    const i = r.issuer();
    await i.runOnce();
    r.setMono(2 * 60_000);
    r.item("f2", "failure", "a"); // 件数と最上位の ID が変わる（優先度は failed のまま）
    r.item("p1", "progress", "a");
    expect((await i.runOnce()).issued).toHaveLength(0);
    expect(r.digests("m1")).toHaveLength(1);
    r.setMono(5 * 60_000);
    r.setWall(r.wall() + 5 * 60_000);
    expect((await i.runOnce()).issued).toHaveLength(0); // ログが進んでいなくても、時間がたつのを調べ直す
    r.setMono(11 * 60_000);
    r.setWall(r.wall() + 6 * 60_000); // 最初の要約から 11 分
    expect((await i.runOnce()).issued).toHaveLength(1);
    expect(r.open("m1")).toHaveLength(1);
    expect(r.digests("m1")).toHaveLength(2);
  });

  it("R1: 要判断の件数が変わったら、10 分たたなくても、（間隔のあと）出し直す", async () => {
    const r = rig();
    r.item("d1", "decision", "a");
    const i = r.issuer();
    await i.runOnce();
    r.setMono(2 * 60_000);
    r.item("d2", "decision", "a"); // m1 の要判断が 1 → 2（優先度は blocking のまま）
    expect((await i.runOnce()).issued).toHaveLength(1);
    expect(r.digests("m1")).toHaveLength(2);
    expect(r.open("m1")).toHaveLength(1);
  });

  it("M1: 前の要約の解決に失敗しても、同じ事実の要約を積み上げない（追記と解決を分ける）。解決は、ログが進まなくても、次の周期に再試行する", async () => {
    const r = rig();
    r.item("f1", "failure", "a");
    let failResolve = false;
    const i = r.issuer({
      record: (requestId, body) =>
        failResolve && body.type === "inbox.resolved"
          ? { ok: false, error: { code: "storeFailed", cause: "x", nextActions: ["y"] } as never }
          : r.log.append({ requestId, actor: SYS, body }),
    });
    await i.runOnce();
    r.setMono(2 * 60_000);
    failResolve = true;
    r.item("d1", "decision", "a"); // 優先度が変わる → 新しい要約。前の要約の解決に失敗する
    await i.runOnce();
    expect(r.digests("m1")).toHaveLength(2);
    expect(r.open("m1")).toHaveLength(2); // 解決に失敗した
    for (let k = 0; k < 4; k++) {
      r.setMono((10 + k) * 60_000);
      await i.runOnce(); // 失敗が続いても、同じ事実の要約を追記しない
    }
    expect(r.digests("m1")).toHaveLength(2);
    failResolve = false;
    r.setMono(30 * 60_000);
    await i.runOnce(); // ログは進んでいないが、解決を再試行する
    expect(r.open("m1")).toHaveLength(1);
    expect(r.digests("m1")).toHaveLength(2);
    expect(r.notes.some((x) => x.event === "digest.resolveFailed")).toBe(true);
  });

  it("R3: 同じ要求 ID が、違う本文で再送されない（時刻が進んで文面の経過分が変わると、要求 ID も変わる）", async () => {
    const r = rig();
    r.item("d1", "decision", "a");
    const seen = new Map<string, string>();
    let failAppend = true;
    const i = r.issuer({
      record: (requestId, body) => {
        const text = JSON.stringify(body);
        const before = seen.get(requestId);
        if (before !== undefined) expect(text).toBe(before); // 同じ要求 ID は、同じ本文
        seen.set(requestId, text);
        return failAppend && body.type === "inbox.added"
          ? { ok: false, error: { code: "storeFailed", cause: "x", nextActions: ["y"] } as never }
          : r.log.append({ requestId, actor: SYS, body });
      },
    });
    for (let k = 0; k < 3; k++) {
      r.setWall(T0 + 3_600_000 + k * 7 * 60_000); // 経過分の文面が変わる
      r.setMono((k + 1) * 60_000);
      await i.runOnce();
    }
    expect(r.digests("m1")).toHaveLength(0);
    failAppend = false;
    r.setMono(10 * 60_000);
    await i.runOnce();
    expect(r.digests("m1")).toHaveLength(1);
    expect(seen.size).toBeGreaterThan(1); // 文面が違えば、要求 ID も違う
  });

  it("N2: stop() のあとに start() し直しても、周期が二重にならない（古い周期は、無効）", async () => {
    const r = rig();
    r.item("f1", "failure", "a");
    // cancel しても、期限が来れば、約束が解決される（古い周期が、残ってしまう場合を作る）
    const waiting: { at: number; resolve: () => void }[] = [];
    let nowMs = T0;
    const timers: Timers = {
      now: () => nowMs,
      sleep: () => Promise.resolve(),
      after: (ms) => {
        let resolveFn: () => void = () => {};
        const promise = new Promise<void>((res) => {
          resolveFn = res;
        });
        waiting.push({ at: nowMs + ms, resolve: resolveFn });
        return { promise, cancel: () => {} };
      },
    };
    const i = r.issuer({ timers });
    i.start();
    await i.stop();
    i.start();
    nowMs += 30_000;
    for (const w of waiting) w.resolve();
    for (let k = 0; k < 6; k++) await new Promise((res) => setImmediate(res));
    expect(r.notes.filter((x) => x.event === "digest.issued")).toHaveLength(1);
    expect(waiting).toHaveLength(3); // start 2 回分 + 新しい周期の次の 1 回分（古い周期は、次を予約しない。予約すれば 4）
    await i.stop();
  });

  it("ノードごとの最短の間隔: 間隔内の変化は見送り、ログが進んでいなくても、間隔が過ぎたら出す", async () => {
    const r = rig({ minIntervalMs: 60_000 });
    r.item("f1", "failure", "a");
    const i = r.issuer();
    await i.runOnce();
    r.item("d1", "decision", "a"); // 優先度が変わる
    r.setMono(30_000);
    expect((await i.runOnce()).issued).toHaveLength(0); // 間隔内
    expect(r.digests("m1")).toHaveLength(1);
    r.setMono(61_000);
    expect((await i.runOnce()).issued).toHaveLength(1); // ログは進んでいないが、見送った分を出す
    expect(r.digests("m1")).toHaveLength(2);
  });

  it("1 周期に出す件数の上限: 超えた分は、次の周期に出す", async () => {
    const r = rig({ maxPerRun: 1 });
    r.item("f1", "failure", "a");
    r.item("f2", "failure", "b");
    const i = r.issuer();
    expect((await i.runOnce()).issued).toHaveLength(1);
    expect((await i.runOnce()).issued).toHaveLength(1);
    expect(r.open("m1")).toHaveLength(1);
    expect(r.open("m2")).toHaveLength(1);
  });

  it("配下の未解決の項目がなくなったら、出ている要約を解決する", async () => {
    const r = rig();
    r.item("f1", "failure", "a");
    const i = r.issuer();
    await i.runOnce();
    r.resolve("f1");
    const out = await i.runOnce();
    expect(out.resolved).toBe(1);
    expect(r.open("m1")).toHaveLength(0);
  });

  it("中間ノードが完了・停止したら、出ている要約を解決する。新しい要約は出さない", async () => {
    const r = rig();
    r.item("f1", "failure", "a");
    const i = r.issuer();
    await i.runOnce();
    r.ev("a", { type: "reportDone" });
    r.ev("m1", { type: "reportDone" });
    const out = await i.runOnce();
    expect(out.resolved).toBe(1);
    expect(r.open("m1")).toHaveLength(0);
    r.setMono(10 * 60_000);
    r.item("f9", "failure", "a");
    await i.runOnce();
    expect(r.open("m1")).toHaveLength(0); // 完了したノードには出さない
  });

  it("start() は、周期（intervalMs）で実行する。stop() は、周期を止める。isStopped なら動かない", async () => {
    const r = rig();
    r.item("f1", "failure", "a");
    const i = r.issuer();
    i.start();
    expect(r.digests("m1")).toHaveLength(0); // 最初の実行は、1 周期後
    await r.mt.advance(30_000);
    expect(r.digests("m1")).toHaveLength(1);
    await i.stop();
    r.setMono(10 * 60_000);
    r.item("f2", "failure", "a");
    await r.mt.advance(60_000);
    expect(r.digests("m1")).toHaveLength(1); // 止めた
    let stopped = false;
    const r2 = rig({ isStopped: () => stopped });
    r2.item("f1", "failure", "a");
    const i2 = r2.issuer();
    i2.start();
    stopped = true;
    await r2.mt.advance(30_000);
    expect(r2.digests("m1")).toHaveLength(0);
    await i2.stop();
  });

  it("追記に失敗しても、止まらない（失敗を記録し、次の周期に再試行する）。前の要約は解決しない", async () => {
    const r = rig();
    r.item("f1", "failure", "a");
    let fail = true;
    const i = r.issuer({
      record: (requestId, body) =>
        fail
          ? { ok: false, error: { code: "storeFailed", cause: "x", nextActions: ["y"] } as never }
          : r.log.append({ requestId, actor: SYS, body }),
    });
    expect((await i.runOnce()).issued).toHaveLength(0);
    expect(r.notes.some((x) => x.event === "digest.failed")).toBe(true);
    fail = false;
    expect((await i.runOnce()).issued).toHaveLength(1);
  });
});
