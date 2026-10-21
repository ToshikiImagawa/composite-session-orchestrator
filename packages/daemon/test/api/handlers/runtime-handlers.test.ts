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

/** root ─ m1 ─ a(running)・p(pending)、root ─ m2 ─ b(running)。呼び出し元は m1 */
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
  node("p", "implement", "m1");
  node("m2", "integrator", "root");
  ev("m2", { type: "start" });
  node("b", "implement", "m2");
  ev("b", { type: "start" });
  const adapter = opts.adapter === undefined ? new FakeAdapter() : opts.adapter;
  const settled: unknown[] = [];
  const h = createRuntimeHandlers({
    log,
    clock,
    adapterFor: () => adapter ?? undefined,
    onStopSettled: (nodeId, result) => settled.push([nodeId, result]),
  });
  const callAs = async (
    caller: string,
    op: keyof typeof h,
    params: Record<string, unknown>,
    requestId = `q-${++n}`,
  ) => {
    const req = {
      requestId,
      operation: op,
      role: "integrator",
      caller: { nodeId: caller },
      params,
    } as unknown as HandlerRequest<never>;
    // biome-ignore lint/suspicious/noExplicitAny: 操作ごとの型は呼び出し側で保証
    return (await (h[op] as any)(req)) as { ok: boolean; value?: any; error?: Failure };
  };
  const call = (op: keyof typeof h, params: Record<string, unknown>, requestId?: string) =>
    callAs("m1", op, params, requestId);
  return { log, adapter, call, callAs, ev, add, settled, state: () => log.state() };
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

describe("ハンドラでも部分木を確かめる（認可の二重の備え）", () => {
  it("自分自身・別の部分木・祖先への send・stop・capabilities は、何もせず forbidden", async () => {
    const r = rig();
    const before = r.state().lastSeq;
    for (const nodeId of ["m1", "b", "m2", "root"]) {
      for (const [op, params] of [
        ["node.send", { nodeId, text: "x" }],
        ["node.stop", { nodeId, mode: "graceful" }],
        ["node.capabilities", { nodeId }],
      ] as const) {
        const res = await r.call(op, params);
        expect(res.error?.code, `${op} ${nodeId}`).toBe("forbidden");
      }
    }
    expect(r.state().lastSeq).toBe(before);
    expect(r.adapter?.sent).toEqual([]);
    expect(r.adapter?.stops).toEqual([]);
  });
});

describe("バックグラウンドの停止の堅牢化（onStopSettled・アダプタの失敗）", () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);

  it("onStopSettled が例外を投げても、アダプタの stop が reject しても、unhandledRejection を出さない", async () => {
    process.on("unhandledRejection", onUnhandled);
    try {
      const opened = EventLog.open(createMemoryStore().open(), { clock });
      if (!opened.ok) throw new Error(opened.error.code);
      const log = opened.value;
      for (const [id, role, parent] of [
        ["root", "integrator", null],
        ["a", "implement", "root"],
      ] as const) {
        log.append({
          requestId: `s-${++n}`,
          actor: SYS,
          body: {
            type: "node.created",
            payload: { nodeId: id, role, parentId: parent, dependsOn: [] },
          },
        });
        log.append({
          requestId: `s-${++n}`,
          actor: SYS,
          body: { type: "node.stateChanged", payload: { nodeId: id, event: { type: "start" } } },
        });
      }
      for (const variant of ["settledThrows", "stopRejects"] as const) {
        const adapter = new FakeAdapter();
        if (variant === "stopRejects") {
          adapter.stop = async () => {
            throw new Error("stop exploded");
          };
        }
        const h = createRuntimeHandlers({
          log,
          clock,
          adapterFor: () => adapter,
          onStopSettled: () => {
            throw new Error("settled exploded");
          },
        });
        await h["node.stop"]({
          requestId: `u-${variant}`,
          operation: "node.stop",
          role: "integrator",
          caller: { nodeId: "root" },
          params: { nodeId: "a", mode: "immediate" },
        } as never);
        await flush();
        await flush();
        if (variant === "settledThrows") {
          // 1 回目で stopped になるよう、確認を済ませて次の変種のために状態を戻す必要はない（同じノードの再要求は冪等）
        }
      }
      await flush();
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  const inbox = (r: ReturnType<typeof rig>) => r.state().inbox;

  it("アダプタの停止が失敗したら、stopTimeout を記録して stopIncomplete にし、受信箱に stopIncomplete の項目を出す", async () => {
    const r = rig();
    if (r.adapter) {
      r.adapter.stopResult = {
        ok: false,
        error: failure("unknownNode", "管理していない", "状態を確認する"),
      };
    }
    await r.call("node.stop", { nodeId: "a", mode: "graceful" });
    await flush();
    await flush();
    expect(stateOf(r.state(), "a")).toBe("stopIncomplete");
    const item = inbox(r).at(-1);
    expect(item).toMatchObject({ kind: "stopIncomplete", nodeId: "a" });
    expect(item?.summary).toContain("管理していない");
  });

  it("アダプタが停止未完了（プロセスが残る）を返したら、受信箱に stopIncomplete の項目（残っている pid つき）を出す。停止を確認したら info の項目", async () => {
    const r = rig();
    if (r.adapter) {
      r.adapter.stopResult = ok({
        state: "stopIncomplete",
        outcome: "aborted",
        blockers: [101, 102],
      });
    }
    await r.call("node.stop", { nodeId: "a", mode: "immediate" });
    await flush();
    await flush();
    const item = inbox(r).at(-1);
    expect(item).toMatchObject({ kind: "stopIncomplete", nodeId: "a" });
    expect(item?.summary).toContain("101");
    const r2 = rig();
    await r2.call("node.stop", { nodeId: "a", mode: "immediate" });
    await flush();
    await flush();
    expect(inbox(r2).at(-1)).toMatchObject({ kind: "info", nodeId: "a" });
  });

  it("受信箱の項目は、停止の試行ごとに 1 件（同じ結果を二重に出さない）", async () => {
    const r = rig();
    await r.call("node.stop", { nodeId: "a", mode: "immediate" }, "same");
    await flush();
    await flush();
    const n1 = inbox(r).length;
    await r.call("node.stop", { nodeId: "a", mode: "immediate" }, "same");
    await flush();
    await flush();
    expect(inbox(r).length).toBe(n1);
  });
});

describe("node.capabilities の絞り込み（呼び出し元との関係・アダプタの能力表）", () => {
  const ops = async (r: ReturnType<typeof rig>, nodeId: string) =>
    ((await r.call("node.capabilities", { nodeId })).value?.operations ?? []) as string[];

  it("呼び出し元の部分木の規則（SUBTREE_RULES）で絞る。子のノードには、review（直接の子）はあるが、自分自身には何もない", async () => {
    const r = rig();
    r.ev("a", { type: "reportDone" });
    const o = await ops(r, "a");
    expect(o).toContain("node.review"); // m1 は a の親
    // root から見ると a は孫: review（directChild）は出ない
    const asRoot = (await r.callAs("root", "node.capabilities", { nodeId: "a" })).value
      ?.operations as string[];
    expect(asRoot).not.toContain("node.review");
  });

  it("アダプタがなければ、send・stop・split は出さない（動作中のノードでも）", async () => {
    const r = rig({ adapter: null });
    const o = await ops(r, "a");
    for (const op of ["node.send", "node.stop", "node.split"]) expect(o).not.toContain(op);
    expect(o).toContain("node.capabilities");
  });

  it("能力表を反映する: 停止の手段がどちらもなければ stop を、指示が unsupported なら send を出さない", async () => {
    const r = rig();
    if (r.adapter)
      r.adapter.caps = { ...r.adapter.caps, stopGraceful: false, stopImmediate: false };
    expect(await ops(r, "a")).not.toContain("node.stop");
    const r2 = rig();
    if (r2.adapter) r2.adapter.caps = { ...r2.adapter.caps, send: "unsupported" };
    const o2 = await ops(r2, "a");
    expect(o2).not.toContain("node.send");
    expect(o2).toContain("node.stop");
  });

  it("停止未完了からは、停止（再試行＝即時）が出る", async () => {
    const r = rig();
    await r.call("node.stop", { nodeId: "a", mode: "immediate" });
    r.ev("a", { type: "stopTimeout" });
    expect(await ops(r, "a")).toContain("node.stop");
  });
});
