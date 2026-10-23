import { type EventBody, type Failure, failure, type NodeEvent, ok, type Result } from "@cso/core";
import { describe, expect, it } from "vitest";
import { createInstructionDelivery } from "../src/api/handlers/instruction-delivery.js";
import { EventLog } from "../src/eventlog.js";
import { createMemoryStore } from "../src/memory-store.js";
import type { RuntimeAdapter, Timers } from "../src/sdk/runtime.js";
import { createWaker, WAKE_TEXT } from "../src/wake.js";

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

/** root ─ m1(統合。running) ─ a(実装)・x(統合。running) ─ y(実装)。m2(統合) ─ b。 */
const rig = (
  opts: {
    minIntervalMs?: number;
    maxPerRun?: number;
    maxPerHour?: number;
    managed?: (id: string) => boolean;
    /** true なら、`startMonoMs` を渡さない（`start()` で、起動の時刻を決める）。 */
    noStartMono?: boolean;
  } = {},
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
  node("x", "integrator", "m1");
  ev("x", { type: "start" });
  node("y", "implement", "x");
  ev("y", { type: "start" });
  node("m2", "integrator", "root");
  ev("m2", { type: "start" });
  node("b", "implement", "m2");
  ev("b", { type: "start" });

  const sent: { nodeId: string; text: string }[] = [];
  const flags = { sendFails: false };
  const adapter = {
    kind: "cli" as const,
    capabilities: () => ({ send: "ok" }),
    async send(nodeId: string, text: string): Promise<Result<{ status: "queued" }, Failure>> {
      if (flags.sendFails) return { ok: false, error: failure("sendFailed", "x", "y") };
      sent.push({ nodeId, text });
      return ok({ status: "queued" as const });
    },
  } as unknown as RuntimeAdapter;
  const delivery = createInstructionDelivery({
    log,
    clock: () => new Date(T0).toISOString(),
    adapterFor: () => adapter,
  });
  let mono = 0;
  const notes: { event: string; data: Record<string, unknown> }[] = [];
  const mt = manualTimers();
  const waker = (extra: Partial<Parameters<typeof createWaker>[0]> = {}) =>
    createWaker({
      log,
      clock: () => new Date(T0).toISOString(),
      monoMs: () => mono,
      ...(opts.noStartMono ? {} : { startMonoMs: 0 }),
      intervalMs: 15_000,
      ...(opts.maxPerHour === undefined ? {} : { maxPerHour: opts.maxPerHour }),
      minIntervalMs: opts.minIntervalMs ?? 60_000,
      maxPerRun: opts.maxPerRun ?? 10,
      deliver: delivery.deliver,
      canDeliver: opts.managed ?? (() => true),
      timers: mt.timers,
      note: (event, data) => notes.push({ event, data }),
      isStopped: () => false,
      ...extra,
    });
  const item = (id: string, kind: string, nodeId: string, extra: Record<string, unknown> = {}) =>
    add({ type: "inbox.added", payload: { id, kind, nodeId, ...extra } } as never);
  const instructions = (nodeId?: string) =>
    log.state().instructions.filter((i) => nodeId === undefined || i.nodeId === nodeId);
  return {
    log,
    waker,
    item,
    ev,
    add,
    sent,
    flags,
    notes,
    mt,
    instructions,
    setMono: (v: number) => (mono = v),
  };
};

describe("起こす（T24-w）", () => {
  it.each(["decision", "violation", "failure", "stopIncomplete", "done"])(
    "直接の子の未解決の項目（%s）で、running の中間統合ノードを起こす。本文は固定の 1 行。記録は node.instructed（system）→ 配送",
    async (kind) => {
      const r = rig();
      r.item("i1", kind, "a", kind === "done" ? { summary: "秘密の本文" } : {});
      r.setMono(60_000);
      const out = await r.waker().runOnce();
      expect(out.woken).toEqual(["m1"]);
      expect(r.sent).toEqual([{ nodeId: "m1", text: WAKE_TEXT }]);
      const ins = r.instructions("m1");
      expect(ins).toHaveLength(1);
      expect(ins[0]?.actor).toEqual({ system: true });
      expect(ins[0]?.text).toBe(WAKE_TEXT);
      expect(ins[0]?.deliveredSeq).toBeDefined();
    },
  );

  it("起こさない種類: progress・info・answer・digest。解決済みの項目。深い枝（孫）の項目。根・実装ノード", async () => {
    const r = rig();
    r.item("p1", "progress", "a");
    r.item("n1", "info", "a");
    r.item("ans", "answer", "a");
    r.item("f-resolved", "failure", "a");
    r.add({ type: "inbox.resolved", payload: { itemId: "f-resolved" } });
    r.item("deep", "failure", "y"); // y の親は x（x を起こす対象。m1 ではない）
    r.setMono(60_000);
    const out = await r.waker().runOnce();
    expect(out.woken).toEqual(["x"]); // m1 は、直接の子 a・x の項目だけ見る。deep は x の子 y のもの
    expect(r.sent.map((s) => s.nodeId)).toEqual(["x"]);
  });

  it("本文は固定で、子の文字列・ID・件数を含まない", async () => {
    const r = rig();
    r.item("secret-id-1", "failure", "a", { summary: "子が書いた秘密の文字列" });
    r.item("secret-id-2", "done", "a");
    r.setMono(60_000);
    await r.waker().runOnce();
    const text = r.sent[0]?.text ?? "";
    expect(text).toBe(WAKE_TEXT);
    expect(text).not.toContain("secret");
    expect(text).not.toContain("子が書いた");
    expect(text).not.toMatch(/\d/);
    expect(text.split("\n")).toHaveLength(1);
  });

  it.each([
    ["waiting", (r: ReturnType<typeof rig>) => r.ev("m1", { type: "requestDecision" })],
    ["stopping", (r: ReturnType<typeof rig>) => r.ev("m1", { type: "stop", mode: "graceful" })],
    [
      "stopped",
      (r: ReturnType<typeof rig>) => {
        r.ev("m1", { type: "stop", mode: "immediate" });
        r.ev("m1", { type: "confirmStopped" });
      },
    ],
  ])("running でないノード（%s）は起こさない", async (_n, change) => {
    const r = rig();
    change(r);
    r.item("f1", "failure", "a");
    r.setMono(60_000);
    const out = await r.waker().runOnce();
    expect(out.woken).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it("アダプタが管理していないノードは起こさない（根・daemon の外で動くノード）", async () => {
    const r = rig({ managed: (id) => id !== "m1" });
    r.item("f1", "failure", "a");
    r.item("f2", "failure", "m1"); // 根の直接の子 m1 自身の項目。起こす対象は root（根は対象外）
    r.setMono(60_000);
    const out = await r.waker().runOnce();
    expect(out.woken).toEqual([]);
    expect(r.sent).toEqual([]);
  });

  it("完了したノードは起こさない", async () => {
    const r = rig();
    r.ev("a", { type: "reportDone" });
    r.ev("x", { type: "reportDone" });
    r.item("f1", "failure", "a");
    r.ev("m1", { type: "reportDone" });
    r.setMono(60_000);
    const out = await r.waker().runOnce();
    expect(out.woken).toEqual([]);
  });

  it("ノードごとの最短の間隔を守る。起動した直後の 1 周期目も、間隔を守る（再起動の直後に一斉に起こさない）", async () => {
    const r = rig();
    r.item("f1", "failure", "a");
    const w = r.waker();
    r.setMono(30_000); // 起動から 30 秒: まだ間隔（60 秒）に達していない
    expect((await w.runOnce()).woken).toEqual([]);
    r.setMono(60_000);
    expect((await w.runOnce()).woken).toEqual(["m1"]);
    r.item("f2", "failure", "a");
    r.log.append({
      requestId: "m1-acts-interval",
      actor: { nodeId: "m1" },
      body: { type: "inbox.added", payload: { id: "m1-i", kind: "info", nodeId: "m1" } } as never,
    }); // m1 が操作した（束ねるを解く。ここでは、間隔だけを確かめる）
    r.setMono(90_000); // 前回から 30 秒
    expect((await w.runOnce()).woken).toEqual([]);
    r.setMono(120_000);
    expect((await w.runOnce()).woken).toEqual(["m1"]);
    expect(r.sent).toHaveLength(2);
  });

  it("起こした seq は、メモリだけに持つ。再起動（新しい waker）の後は、未解決の項目から作り直し、同じ要求は重複させない", async () => {
    const r = rig();
    r.item("f1", "failure", "a");
    r.setMono(60_000);
    await r.waker().runOnce();
    expect(r.sent).toHaveLength(1);
    // 再起動: 新しい waker。同じ未解決の項目（配送済みの同じ要求）は、もう一度送らない。
    const w2 = r.waker();
    r.setMono(200_000);
    expect((await w2.runOnce()).woken).toEqual([]);
    expect(r.sent).toHaveLength(1);
    // 新しい項目が届けば、また起こす
    r.item("f2", "failure", "a");
    r.setMono(260_000);
    expect((await w2.runOnce()).woken).toEqual(["m1"]);
    expect(r.sent).toHaveLength(2);
  });

  it("1 周期に起こす数は maxPerRun まで。残りは次の周期（間隔を守って）", async () => {
    const r = rig({ maxPerRun: 1 });
    r.item("f1", "failure", "a"); // m1
    r.item("f2", "failure", "b"); // m2
    r.setMono(60_000);
    const w = r.waker();
    expect((await w.runOnce()).woken).toHaveLength(1);
    expect((await w.runOnce()).woken).toHaveLength(1);
    expect(new Set(r.sent.map((s) => s.nodeId))).toEqual(new Set(["m1", "m2"]));
  });

  it("配送に失敗したら、起こした seq を進めず、次の周期（間隔を守って）に再試行する。成功したら、失敗の数を戻す", async () => {
    const r = rig();
    r.item("f1", "failure", "a");
    r.flags.sendFails = true;
    const w = r.waker();
    r.setMono(60_000);
    expect((await w.runOnce()).woken).toEqual([]);
    expect(r.notes.filter((n) => n.event === "wake.failed")).toHaveLength(1);
    expect(r.sent).toEqual([]);
    r.flags.sendFails = false;
    r.setMono(90_000); // 間隔に達していない
    expect((await w.runOnce()).woken).toEqual([]);
    r.setMono(120_000);
    expect((await w.runOnce()).woken).toEqual(["m1"]);
    expect(r.sent).toHaveLength(1);
    // 同じ要求は、再送でも二重に記録しない
    expect(r.instructions("m1")).toHaveLength(1);
  });

  it("3 回続けて失敗したら、新しい項目が届くまで再試行しない（打ち切り）。まとめに出す。新しい項目で再開する", async () => {
    const r = rig();
    r.item("f1", "failure", "a");
    r.flags.sendFails = true;
    const w = r.waker();
    for (const t of [60_000, 120_000, 180_000, 240_000, 300_000]) {
      r.setMono(t);
      await w.runOnce();
    }
    expect(r.notes.filter((n) => n.event === "wake.failed")).toHaveLength(3); // 4 回目以降は試さない
    const gave = r.notes.filter((n) => n.event === "wake.gaveUp");
    expect(gave).toHaveLength(1);
    expect(gave[0]?.data).toMatchObject({ nodeId: "m1", failures: 3 });
    // 新しい項目が届けば、再開する
    r.flags.sendFails = false;
    r.item("f2", "failure", "a");
    r.setMono(360_000);
    expect((await w.runOnce()).woken).toEqual(["m1"]);
  });

  it("まとめ（wake.summary）: 1 時間ごとに、ノードごとの起こした数・失敗・打ち切りを出す。何もなければ出さない", async () => {
    const r = rig();
    const w = r.waker();
    r.setMono(3_600_000);
    await w.runOnce();
    expect(r.notes.filter((n) => n.event === "wake.summary")).toHaveLength(0);
    r.item("f1", "failure", "a");
    r.setMono(3_660_000);
    await w.runOnce();
    r.setMono(7_300_000);
    await w.runOnce();
    const s = r.notes.filter((n) => n.event === "wake.summary");
    expect(s).toHaveLength(1);
    expect(s[0]?.data).toMatchObject({ nodes: { m1: { woken: 1, failed: 0, gaveUp: 0 } } });
    expect(Number(s[0]?.data.windowSec)).toBeGreaterThanOrEqual(3600);
  });

  it("上限（1 時間に minIntervalMs ごと）の 8 割に近づいたら、wake.nearLimit を出す", async () => {
    const r = rig({ minIntervalMs: 600_000 }); // 1 時間に最大 6 回。5 回目（8 割）で出す
    const w = r.waker();
    for (let i = 1; i <= 5; i++) {
      r.item(`f${i}`, "failure", "a");
      r.setMono(i * 600_000);
      await w.runOnce();
    }
    const near = r.notes.filter((n) => n.event === "wake.nearLimit");
    expect(near.length).toBeGreaterThanOrEqual(1);
    expect(near[0]?.data).toMatchObject({ nodeId: "m1", max: 6 });
  });

  it("isStopped なら動かさない。stop は実行中の 1 回を待つ。start し直しても周期は二重にならない", async () => {
    const r = rig();
    r.item("f1", "failure", "a");
    r.setMono(60_000);
    const stopped = r.waker({ isStopped: () => true });
    expect((await stopped.runOnce()).woken).toEqual([]);
    const w = r.waker();
    w.start();
    w.start();
    await r.mt.advance(15_000);
    await w.stop();
    expect(r.sent.length).toBeLessThanOrEqual(1);
    w.start();
    await w.stop();
  });

  it("束ねる: 起こしたあと、そのノード自身の操作（actor が自分のイベント）が 1 つもない間は、新しい項目が届いても、新しく起こさない。操作したら、次を起こせる", async () => {
    const r = rig();
    const w = r.waker();
    r.item("f1", "failure", "a");
    r.setMono(60_000);
    expect((await w.runOnce()).woken).toEqual(["m1"]);
    r.item("f2", "failure", "a");
    r.setMono(130_000); // 間隔は過ぎたが、m1 はまだ何も操作していない
    expect((await w.runOnce()).woken).toEqual([]);
    expect(r.sent).toHaveLength(1);
    // m1 が操作した（m1 を actor とするイベント）
    const acted = r.log.append({
      requestId: "m1-acts",
      actor: { nodeId: "m1" },
      body: {
        type: "inbox.added",
        payload: { id: "m1-info", kind: "info", nodeId: "m1" },
      } as never,
    });
    expect(acted.ok).toBe(true);
    r.setMono(200_000);
    expect((await w.runOnce()).woken).toEqual(["m1"]);
    expect(r.sent).toHaveLength(2);
  });

  it("束ねる: ほかのノードの操作では、解けない。10 分たてば（何も操作していなくても）、また起こせる", async () => {
    const r = rig();
    const w = r.waker();
    r.item("f1", "failure", "a");
    r.setMono(60_000);
    await w.runOnce();
    r.item("f2", "failure", "a");
    r.log.append({
      requestId: "other-acts",
      actor: { nodeId: "a" },
      body: { type: "inbox.added", payload: { id: "a-info", kind: "info", nodeId: "a" } } as never,
    });
    r.setMono(300_000);
    expect((await w.runOnce()).woken).toEqual([]);
    r.setMono(60_000 + 10 * 60_000 + 1);
    expect((await w.runOnce()).woken).toEqual(["m1"]);
  });

  it("全体の上限 maxPerHour（全ノード合計）: 超える分は、1 時間たつまで起こさない。上限に達したことは、窓ごとに 1 回だけ出す", async () => {
    const r = rig({ maxPerHour: 2 });
    const w = r.waker();
    r.item("f1", "failure", "a"); // m1
    r.item("f2", "failure", "y"); // x
    r.item("f3", "failure", "b"); // m2
    r.setMono(60_000);
    const first = (await w.runOnce()).woken;
    expect(first).toHaveLength(2);
    r.setMono(120_000);
    expect((await w.runOnce()).woken).toEqual([]);
    r.setMono(180_000);
    expect((await w.runOnce()).woken).toEqual([]);
    expect(r.notes.filter((n) => n.event === "wake.hourlyLimit")).toHaveLength(1);
    r.setMono(60_000 + 3_600_000 + 1_000);
    expect((await w.runOnce()).woken).toHaveLength(1);
    expect(r.sent).toHaveLength(3);
  });

  it("nearLimit は、ノードごとに、時間の窓（1 時間）につき 1 回だけ出す", async () => {
    const r = rig({ minIntervalMs: 600_000 }); // 1 時間に最大 6 回。5 回目から 8 割
    const w = r.waker();
    for (let i = 1; i <= 6; i++) {
      r.item(`f${i}`, "failure", "a");
      r.log.append({
        requestId: `m1-acts-${i}`,
        actor: { nodeId: "m1" },
        body: {
          type: "inbox.added",
          payload: { id: `m1-i${i}`, kind: "info", nodeId: "m1" },
        } as never,
      });
      r.setMono(i * 600_000);
      await w.runOnce();
      // 起こしたあとの操作（束ねるを解く）
      r.log.append({
        requestId: `m1-acts-after-${i}`,
        actor: { nodeId: "m1" },
        body: {
          type: "inbox.added",
          payload: { id: `m1-j${i}`, kind: "info", nodeId: "m1" },
        } as never,
      });
    }
    expect(r.notes.filter((n) => n.event === "wake.nearLimit")).toHaveLength(1);
  });

  it("start() で、起動の時刻を決め直す（作ってから start までの時間は、間隔に数えない）", async () => {
    const r = rig({ noStartMono: true });
    const w = r.waker(); // 作った時刻: mono 0
    r.setMono(1_000_000);
    w.start();
    r.item("f1", "failure", "a");
    r.setMono(1_030_000); // start から 30 秒
    expect((await w.runOnce()).woken).toEqual([]);
    r.setMono(1_060_000);
    expect((await w.runOnce()).woken).toEqual(["m1"]);
    await w.stop();
  });
});
