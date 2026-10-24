import type { EventBody, NodeEvent } from "@cso/core";
import { describe, expect, it } from "vitest";
import { createHookHandlers } from "../../../src/api/handlers/hook-handlers.js";
import { createSessionBinder } from "../../../src/api/hook.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-10-24T00:00:00Z";
let n = 0;

/** root ─ m1 ─ a、root ─ m2 ─ b */
const rig = () => {
  const store = createMemoryStore().open();
  const opened = EventLog.open(store, { clock });
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
  node("m2", "integrator", "root");
  ev("m2", { type: "start" });
  node("b", "implement", "m2");
  const sessions = createSessionBinder();
  const h = createHookHandlers({ log, sessions });
  const call = (caller: string, nodeId: string, requestId = `q-${++n}`) =>
    h["node.hookUnbind"](
      (caller === "human"
        ? { requestId, operation: "node.hookUnbind", role: "human", params: { nodeId } }
        : {
            requestId,
            operation: "node.hookUnbind",
            role: "integrator",
            caller: { nodeId: caller },
            params: { nodeId },
          }) as unknown as HandlerRequest<"node.hookUnbind">,
    );
  const unboundEvents = () =>
    store
      .readAll()
      .filter((e) => e.type === "node.hookUnbound")
      .map((e) => ({ actor: JSON.parse(e.actor), payload: JSON.parse(e.payload) }));
  return { log, store, sessions, call, unboundEvents };
};

describe("node.hookUnbind（フックの結び付けを外す。T22-hu）", () => {
  it("人間は外せる。外したあと、別の session_id に結び直し、元の session_id は拒否される", () => {
    const r = rig();
    expect(r.sessions.check("a", "s-old")).toBe(true);
    expect(r.sessions.check("a", "s-new")).toBe(false);
    expect(r.call("human", "a")).toEqual({ ok: true, value: { unbound: true } });
    expect(r.sessions.check("a", "s-new")).toBe(true);
    expect(r.sessions.check("a", "s-old")).toBe(false);
    expect(r.unboundEvents()).toEqual([
      { actor: { human: true }, payload: { nodeId: "a", hadBinding: true } },
    ]);
  });

  it("祖先の統合ノードは外せる（記録の actor はその統合ノード）。部分木の外・自分自身は 403", () => {
    const r = rig();
    r.sessions.check("a", "s-1");
    expect(r.call("root", "a")).toEqual({ ok: true, value: { unbound: true } });
    expect(r.unboundEvents()[0]?.actor).toEqual({ nodeId: "root" });
    r.sessions.check("a", "s-2");
    const outside = r.call("m2", "a");
    expect(outside.ok ? null : outside.error.code).toBe("forbidden");
    const self = r.call("m1", "m1");
    expect(self.ok ? null : self.error.code).toBe("forbidden");
    expect(r.sessions.check("a", "s-2")).toBe(true); // 外れていない
    expect(r.unboundEvents()).toHaveLength(1);
  });

  it("結び付けがなくても成功し（unbound: false）、記録は残す。未知のノードは notFound", () => {
    const r = rig();
    expect(r.call("human", "a")).toEqual({ ok: true, value: { unbound: false } });
    expect(r.unboundEvents()).toEqual([
      { actor: { human: true }, payload: { nodeId: "a", hadBinding: false } },
    ]);
    const unknown = r.call("human", "zzz");
    expect(unknown.ok ? null : unknown.error.code).toBe("notFound");
  });

  it("同じ requestId の再送は、もう一度は外さない（その間に結んだ新しいセッションを外さない）", () => {
    const r = rig();
    r.sessions.check("a", "s-1");
    expect(r.call("human", "a", "same")).toEqual({ ok: true, value: { unbound: true } });
    r.sessions.check("a", "s-2");
    expect(r.call("human", "a", "same")).toEqual({ ok: true, value: { unbound: false } });
    expect(r.sessions.check("a", "s-2")).toBe(true);
    expect(r.unboundEvents()).toHaveLength(1);
  });

  it("ログを開き直して再生しても、記録は読める（状態の形は変わらない）", () => {
    const r = rig();
    r.call("human", "a");
    const again = EventLog.open(r.store, { clock });
    if (!again.ok) throw new Error(again.error.code);
    expect(again.value.state().nodes).toEqual(r.log.state().nodes);
    expect(again.value.state().lastSeq).toBe(r.log.state().lastSeq);
  });
});
