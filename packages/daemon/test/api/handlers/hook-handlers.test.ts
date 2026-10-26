import type { EventBody, NodeEvent } from "@cso/core";
import { describe, expect, it } from "vitest";
import { createHookHandlers } from "../../../src/api/handlers/hook-handlers.js";
import { createHookTokens, createSessionBinder } from "../../../src/api/hook.js";
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
    expect(r.call("human", "a")).toEqual({ ok: true, value: { unbound: true, duplicate: false } });
    expect(r.sessions.check("a", "s-new")).toBe(true);
    expect(r.sessions.check("a", "s-old")).toBe(false);
    expect(r.unboundEvents()).toEqual([
      { actor: { human: true }, payload: { nodeId: "a", hadBinding: true } },
    ]);
  });

  it("祖先の統合ノードは外せる（記録の actor はその統合ノード）。部分木の外・自分自身は 403", () => {
    const r = rig();
    r.sessions.check("a", "s-1");
    expect(r.call("root", "a")).toEqual({ ok: true, value: { unbound: true, duplicate: false } });
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
    expect(r.call("human", "a")).toEqual({ ok: true, value: { unbound: false, duplicate: false } });
    expect(r.unboundEvents()).toEqual([
      { actor: { human: true }, payload: { nodeId: "a", hadBinding: false } },
    ]);
    const unknown = r.call("human", "zzz");
    expect(unknown.ok ? null : unknown.error.code).toBe("notFound");
  });

  it("同じ requestId の再送は、もう一度は外さない（その間に結んだ新しいセッションを外さない）", () => {
    const r = rig();
    r.sessions.check("a", "s-1");
    expect(r.call("human", "a", "same")).toEqual({
      ok: true,
      value: { unbound: true, duplicate: false },
    });
    r.sessions.check("a", "s-2");
    expect(r.call("human", "a", "same")).toEqual({
      ok: true,
      value: { unbound: false, duplicate: true },
    });
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

describe("node.hookToken（手動の CLI セッション用の、フック専用のトークン。T22-ht）", () => {
  const setup = (opts: { cli?: boolean; managed?: boolean } = {}) => {
    const store = createMemoryStore().open();
    const opened = EventLog.open(store, { clock });
    if (!opened.ok) throw new Error(opened.error.code);
    const log = opened.value;
    const add = (body: EventBody): void => {
      const r = log.append({ requestId: `seed-${++n}`, actor: SYS, body });
      if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
    };
    add({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    });
    add({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } });
    add({
      type: "node.created",
      payload: { nodeId: "m1", role: "integrator", parentId: "root", dependsOn: [] },
    });
    add({ type: "node.stateChanged", payload: { nodeId: "m1", event: { type: "start" } } });
    add({
      type: "node.created",
      payload: { nodeId: "a", role: "implement", parentId: "m1", dependsOn: [] },
    });
    add({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } });
    add({
      type: "node.created",
      payload: { nodeId: "p", role: "implement", parentId: "m1", dependsOn: [] },
    });
    const sessions = createSessionBinder();
    const tokens = createHookTokens();
    const h = createHookHandlers({
      log,
      sessions,
      ...(opts.cli === false ? {} : { hookTokens: tokens }),
      managed: () => opts.managed !== false,
      baseUrl: () => "http://127.0.0.1:7777",
    });
    const call = (nodeId: string, role = "human", requestId = `q-${++n}`) =>
      h["node.hookToken"]({
        requestId,
        operation: "node.hookToken",
        role,
        ...(role === "human" ? {} : { caller: { nodeId: "m1" } }),
        params: { nodeId },
      } as unknown as HandlerRequest<"node.hookToken">);
    return { store, log, sessions, tokens, call };
  };

  it("人間だけが、動作中の CLI の子に発行できる。トークンはフック用の表で通り、記録にはトークンが入らない", () => {
    const r = setup();
    const res = r.call("a");
    if (!res.ok) throw new Error(res.error.code);
    expect(res.value.nodeId).toBe("a");
    expect(res.value.daemonUrl).toBe("http://127.0.0.1:7777");
    expect(r.tokens.authenticate(res.value.token)).toBe("a");
    const rows = r.store.readAll();
    expect(
      rows.filter((e) => e.type === "node.hookTokenIssued").map((e) => JSON.parse(e.payload)),
    ).toEqual([{ nodeId: "a" }]);
    expect(JSON.stringify(rows)).not.toContain(res.value.token);
  });

  it("統合ノードのトークン・統合ノード・依存待ち・desktop・管理していないノードは、発行しない", () => {
    const r = setup();
    const code = (x: ReturnType<typeof r.call>) => (x.ok ? null : x.error.code);
    expect(code(r.call("a", "integrator"))).toBe("forbidden");
    expect(code(r.call("m1"))).toBe("integratorNotSupported");
    expect(code(r.call("p"))).toBe("notActive");
    expect(code(r.call("zzz"))).toBe("notFound");
    expect(code(setup({ cli: false }).call("a"))).toBe("notCli");
    expect(code(setup({ managed: false }).call("a"))).toBe("notManaged");
  });

  it("発行し直すと、古いトークンは無効になり、フックの結び付けも外れる。同じ requestId の再送は記録 1 回", () => {
    const r = setup();
    const first = r.call("a", "human", "same");
    if (!first.ok) throw new Error("x");
    r.sessions.check("a", "s-1");
    const again = r.call("a", "human", "same");
    if (!again.ok) throw new Error("x");
    expect(again.value.token).not.toBe(first.value.token);
    expect(r.tokens.authenticate(first.value.token)).toBeUndefined();
    expect(r.tokens.authenticate(again.value.token)).toBe("a");
    expect(r.sessions.has("a")).toBe(false);
    expect(r.store.readAll().filter((e) => e.type === "node.hookTokenIssued")).toHaveLength(1);
    // ログを開き直しても、同じ状態
    const reopened = EventLog.open(r.store, { clock });
    if (!reopened.ok) throw new Error(reopened.error.code);
    expect(reopened.value.state().nodes).toEqual(r.log.state().nodes);
  });
});
