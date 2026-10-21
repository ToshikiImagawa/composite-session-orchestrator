import {
  type EventBody,
  type Failure,
  failure,
  type NodeEvent,
  ok,
  type Result,
  stateOf,
} from "@cso/core";
import { describe, expect, it } from "vitest";
import { createRuntimeHandlers } from "../../../src/api/handlers/runtime-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";
import type {
  Capabilities,
  DeliveryValue,
  RuntimeAdapter,
  StopRequest,
  StopValue,
} from "../../../src/sdk/runtime.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-10-20T00:00:00Z";
let n = 0;

class FakeAdapter implements RuntimeAdapter {
  readonly kind = "cli" as const;
  readonly sent: [string, string][] = [];
  readonly stops: [string, StopRequest][] = [];
  sendResult: Result<DeliveryValue, Failure> = ok({ status: "queued" as const });
  stopResult: Result<StopValue, Failure> = ok({
    state: "stopped",
    outcome: "aborted",
    blockers: [],
  });
  caps: Capabilities = {
    send: "delayed",
    stopGraceful: true,
    stopImmediate: true,
    hooks: "ok",
    sessionId: true,
  };
  capabilities(): Capabilities {
    return this.caps;
  }
  async start(): Promise<never> {
    throw new Error("not used");
  }
  async send(nodeId: string, text: string) {
    this.sent.push([nodeId, text]);
    return this.sendResult;
  }
  async stop(nodeId: string, request: StopRequest) {
    this.stops.push([nodeId, request]);
    return this.stopResult;
  }
  updateScope(): Result<undefined, Failure> {
    return ok(undefined);
  }
}

/** root ─ m1 ─ a(running), root ─ p(pending) */
const rig = (opts: { adapter?: FakeAdapter | null } = {}) => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const node = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
    add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  node("root", "integrator", null);
  ev("root", { type: "start" });
  node("m1", "integrator", "root");
  ev("m1", { type: "start" });
  node("a", "implement", "m1");
  ev("a", { type: "start" });
  node("p", "implement", "root");
  const adapter = opts.adapter === undefined ? new FakeAdapter() : opts.adapter;
  const settled: unknown[] = [];
  const h = createRuntimeHandlers({
    log,
    clock,
    adapterFor: () => adapter ?? undefined,
    onStopSettled: (nodeId, result) => settled.push([nodeId, result]),
  });
  const call = async (
    op: keyof typeof h,
    params: Record<string, unknown>,
    requestId = `q-${++n}`,
  ) => {
    const req = {
      requestId,
      operation: op,
      role: "integrator",
      caller: { nodeId: "m1" },
      params,
    } as unknown as HandlerRequest<never>;
    // biome-ignore lint/suspicious/noExplicitAny: 操作ごとの型は呼び出し側で保証
    return (await (h[op] as any)(req)) as { ok: boolean; value?: any; error?: Failure };
  };
  return { log, adapter, call, ev, add, settled, state: () => log.state() };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("node.send（稼働中の子への追加指示）", () => {
  it("動作中のノードの指示をアダプタへ渡し、受け付けた結果を返す", async () => {
    const r = rig();
    const res = await r.call("node.send", { nodeId: "a", text: "続けて" });
    expect(res).toEqual({ ok: true, value: { delivered: true } });
    expect(r.adapter?.sent).toEqual([["a", "続けて"]]);
  });

  it("動作中でないノード（pending・done・停止後）は、アダプタを呼ばずに失敗する（notActive）", async () => {
    const r = rig();
    const res = await r.call("node.send", { nodeId: "p", text: "x" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("notActive");
    expect(r.adapter?.sent).toEqual([]);
  });

  it("アダプタの失敗は、そのまま返す。アダプタがなければ noRuntime", async () => {
    const r = rig();
    if (r.adapter)
      r.adapter.sendResult = { ok: false, error: failure("sendFailed", "boom", "もう一度送る") };
    const res = await r.call("node.send", { nodeId: "a", text: "x" });
    expect(res.error?.code).toBe("sendFailed");
    const none = rig({ adapter: null });
    const res2 = await none.call("node.send", { nodeId: "a", text: "x" });
    expect(res2.error?.code).toBe("noRuntime");
  });
});

describe("node.stop（停止要求の記録 → アダプタの 2 段階停止）", () => {
  it("穏当な停止: 停止要求を記録し（stopping）、その seq を stopSeq にしてアダプタへ渡す。応答は要求を受け付けた時点", async () => {
    const r = rig();
    const res = await r.call("node.stop", { nodeId: "a", mode: "graceful" });
    expect(res).toEqual({ ok: true, value: { state: "stopping" } });
    expect(stateOf(r.state(), "a")).toBe("stopping");
    const req = r.state().stopRequests.at(-1);
    expect(req).toMatchObject({ nodeId: "a", kind: "stop", mode: "graceful" });
    await flush();
    expect(r.adapter?.stops).toEqual([["a", { mode: "graceful", stopSeq: req?.seq }]]);
  });

  it("即時停止は immediate。猶予中の即時の要求は、同じ停止の stopSeq でアダプタへ（切り替え）", async () => {
    const r = rig();
    await r.call("node.stop", { nodeId: "a", mode: "graceful" });
    const first = r.state().stopRequests.at(-1);
    const res = await r.call("node.stop", { nodeId: "a", mode: "immediate" });
    expect(res).toEqual({ ok: true, value: { state: "stopping" } });
    await flush();
    expect(r.adapter?.stops.map(([, q]) => [q.mode, q.stopSeq])).toEqual([
      ["graceful", first?.seq],
      ["immediate", first?.seq],
    ]);
  });

  it("起動前（pending）の停止は、取り消し（stopped）。アダプタは呼ばない", async () => {
    const r = rig();
    const res = await r.call("node.stop", { nodeId: "p", mode: "graceful" });
    expect(res).toEqual({ ok: true, value: { state: "stopped" } });
    await flush();
    expect(r.adapter?.stops).toEqual([]);
  });

  it("停止未完了からの再要求は retryStop（即時）として記録し、新しい stopSeq でアダプタへ", async () => {
    const r = rig();
    await r.call("node.stop", { nodeId: "a", mode: "immediate" });
    r.ev("a", { type: "stopTimeout" });
    expect(stateOf(r.state(), "a")).toBe("stopIncomplete");
    const before = r.state().stopRequests.length;
    const res = await r.call("node.stop", { nodeId: "a", mode: "graceful" });
    expect(res).toEqual({ ok: true, value: { state: "stopping" } });
    const last = r.state().stopRequests.at(-1);
    expect(r.state().stopRequests).toHaveLength(before + 1);
    expect(last).toMatchObject({ kind: "retryStop", mode: "immediate" });
    await flush();
    const call = r.adapter?.stops.at(-1);
    expect(call?.[1]).toEqual({ mode: "immediate", stopSeq: last?.seq });
  });

  it("停止の対象でない状態（done など）は、何も書かずアダプタも呼ばずに失敗する（alreadyFinished）", async () => {
    const r = rig();
    r.ev("a", { type: "reportDone" });
    const before = r.state().lastSeq;
    const res = await r.call("node.stop", { nodeId: "a", mode: "graceful" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("alreadyFinished");
    expect(r.state().lastSeq).toBe(before);
    expect(r.adapter?.stops).toEqual([]);
  });

  it("アダプタがない動作中のノードは、何も書かずに失敗する（noRuntime）", async () => {
    const r = rig({ adapter: null });
    const before = r.state().lastSeq;
    const res = await r.call("node.stop", { nodeId: "a", mode: "graceful" });
    expect(res.error?.code).toBe("noRuntime");
    expect(r.state().lastSeq).toBe(before);
  });

  it("同じ requestId の再試行は、停止要求を重複して記録しない", async () => {
    const r = rig();
    await r.call("node.stop", { nodeId: "a", mode: "graceful" }, "stop-1");
    const n1 = r.state().stopRequests.length;
    const res = await r.call("node.stop", { nodeId: "a", mode: "graceful" }, "stop-1");
    expect(res.ok).toBe(true);
    expect(r.state().stopRequests).toHaveLength(n1);
  });

  it("バックグラウンドの停止の結果は onStopSettled に渡す（応答は待たない。例外にしない）", async () => {
    const r = rig();
    await r.call("node.stop", { nodeId: "a", mode: "immediate" });
    await flush();
    expect(r.settled).toHaveLength(1);
    expect((r.settled[0] as [string, { ok: boolean }])[0]).toBe("a");
  });
});

describe("node.capabilities（状態とアダプタの能力表から、可能な操作を導く）", () => {
  const ops = async (r: ReturnType<typeof rig>, nodeId: string) =>
    ((await r.call("node.capabilities", { nodeId })).value?.operations ?? []) as string[];

  it("動作中: 指示・停止・切り出しができる。受理・回収はできない", async () => {
    const r = rig();
    const o = await ops(r, "a");
    expect(o).toEqual(
      expect.arrayContaining(["node.send", "node.stop", "node.split", "node.capabilities"]),
    );
    expect(o).not.toContain("node.review");
    expect(o).not.toContain("node.reclaim");
  });

  it("done: 受理（review）ができる。verified: 回収ができる。停止未完了: 再停止ができる", async () => {
    const r = rig();
    r.ev("a", { type: "reportDone" });
    expect(await ops(r, "a")).toContain("node.review");
    expect(await ops(r, "a")).not.toContain("node.send");
    r.ev("a", { type: "accept" });
    expect(await ops(r, "a")).toEqual(
      expect.arrayContaining(["node.reclaimPreview", "node.reclaim"]),
    );
    const r2 = rig();
    await r2.call("node.stop", { nodeId: "a", mode: "immediate" });
    r2.ev("a", { type: "stopTimeout" });
    expect(await ops(r2, "a")).toContain("node.stop");
  });

  it("アダプタが指示を受け付けない（send: unsupported）なら、node.send を含めない。結果は決定的", async () => {
    const r = rig();
    if (r.adapter) r.adapter.caps = { ...r.adapter.caps, send: "unsupported" };
    const a = await ops(r, "a");
    expect(a).not.toContain("node.send");
    expect(await ops(r, "a")).toEqual(a);
  });
});
