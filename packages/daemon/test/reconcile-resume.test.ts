import {
  type EventBody,
  type Failure,
  failure,
  type NodeEvent,
  ok,
  type ProcessInfo,
  type Scope,
  stateOf,
} from "@cso/core";
import { describe, expect, it } from "vitest";
import { createPauseHandlers } from "../src/api/handlers/pause-handlers.js";
import { createStateHandlers } from "../src/api/handlers/state-handlers.js";
import type { HandlerRequest } from "../src/api/server.js";
import { EventLog } from "../src/eventlog.js";
import { createMemoryStore } from "../src/memory-store.js";
import { reconcileOnStartup } from "../src/reconcile.js";
import type { RuntimeAdapter, StartRequest } from "../src/sdk/runtime.js";

const clock = (): string => "2026-10-20T00:00:00Z";
const SCOPE: Scope = {
  writableLocations: ["src"],
  forbiddenLocations: [],
  allowedCommands: ["pnpm test"],
};
let n = 0;

/** root ─ a（判断を待っている waiting）・b（running）。再起動のあとを再現する。 */
const rig = (opts: { processes?: Record<string, readonly ProcessInfo[] | null> } = {}) => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  add({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  });
  ev("root", { type: "start" });
  for (const id of ["a", "b"]) {
    add({
      type: "node.created",
      payload: {
        nodeId: id,
        role: "implement",
        parentId: "root",
        dependsOn: [],
        objective: "o",
        acceptanceCriteria: ["c"],
        scope: SCOPE,
      },
    });
    ev(id, { type: "start" });
  }
  const calls = { started: [] as StartRequest[], issued: [] as string[] };
  const flags = { startFails: false };
  const adapter = {
    kind: "cli" as const,
    capabilities: () => ({
      send: "ok",
      stopGraceful: true,
      stopImmediate: true,
      hooks: "ok",
      sessionId: true,
    }),
    async start(req: StartRequest) {
      calls.started.push(req);
      if (flags.startFails) return { ok: false as const, error: failure("startFailed", "x", "y") };
      return ok({ sessionId: "s", cwd: req.worktreePath, removedEnv: [] });
    },
    async send() {
      return ok({ status: "queued" as const });
    },
    async stop() {
      return ok({ state: "stopped" as const, outcome: "aborted" as const, blockers: [] });
    },
    updateScope: () => ok(undefined),
  } as unknown as RuntimeAdapter;
  const state = createStateHandlers({ log, clock, allowPause: true });
  const pause = createPauseHandlers({
    log,
    clock,
    present: state["decision.present"],
    answer: state["decision.answer"],
    stop: async () => ok({ state: "stopping" as const }),
    adapterFor: () => adapter,
    ports: { cwdOf: async (id) => `/wt/${id}`, mcpUrl: "http://127.0.0.1:1/mcp" },
    credentials: {
      issueNodeToken: (id) => {
        calls.issued.push(id);
        return `tok-${id}`;
      },
      revokeNode: () => undefined,
    },
  });
  const ask = async () => {
    const req = {
      requestId: `ask-${++n}`,
      operation: "report.decision",
      role: "child",
      caller: { nodeId: "a" },
      params: { question: "どうする？", options: ["A", "B"] },
    } as unknown as HandlerRequest<"report.decision">;
    const r = await state["report.decision"](req);
    if (!r.ok) throw new Error("ask");
    return r.value.decisionId;
  };
  const reconcile = () =>
    reconcileOnStartup({
      log,
      clock,
      cwdOf: async (id) => `/wt/${id}`,
      worktreeRoot: "/wt",
      probe: async () => {
        const all = Object.values(opts.processes ?? {}).flatMap((p) => p ?? []);
        return opts.processes !== undefined && Object.values(opts.processes).some((p) => p === null)
          ? null
          : all;
      },
    });
  const answer = async (decisionId: string, requestId = `ans-${++n}`) =>
    (await pause["decision.answer"]({
      requestId,
      operation: "decision.answer",
      role: "human",
      params: { decisionId, choice: "A" },
    } as unknown as HandlerRequest<"decision.answer">)) as { ok: boolean; error?: Failure };
  return { log, ev, ask, reconcile, answer, calls, flags, s: () => log.state() };
};

describe("再起動で失われた、判断待ちの子の再開", () => {
  it("整合で停止済みにされた、判断待ちの子は、回答で再開される（ブリーフと回答を渡して起動）。待っていた判断が記録に残る", async () => {
    const r = rig();
    const decisionId = await r.ask();
    expect(stateOf(r.s(), "a")).toBe("waiting");
    await r.reconcile();
    expect(stateOf(r.s(), "a")).toBe("stopped");
    expect(JSON.stringify(r.s().reports) + JSON.stringify(r.s().inbox)).toContain(decisionId);
    const res = await r.answer(decisionId);
    expect(res.ok, JSON.stringify(res)).toBe(true);
    expect(stateOf(r.s(), "a")).toBe("running");
    expect(r.calls.started).toHaveLength(1);
    expect(r.calls.started[0]?.nodeId).toBe("a");
    expect(r.calls.started[0]?.instruction).toContain("A");
    // 動作中だった b は、判断と関係なく、再開もされない（整合で停止済みのまま）
    expect(stateOf(r.s(), "b")).toBe("stopped");
  });

  it("再開できなかったら、ok を返さず resumePending。直したあとの再送で再開する", async () => {
    const r = rig();
    const decisionId = await r.ask();
    await r.reconcile();
    r.flags.startFails = true;
    const first = await r.answer(decisionId, "ans-x");
    expect(first.ok).toBe(false);
    expect(first.error?.code).toBe("resumePending");
    expect(stateOf(r.s(), "a")).toBe("stopped");
    r.flags.startFails = false;
    const retry = await r.answer(decisionId, "ans-y");
    expect(retry.ok).toBe(true);
    expect(stateOf(r.s(), "a")).toBe("running");
  });

  it("人間が止めた（判断の待ちでない停止の要求がある）子と、破棄の判断を経た子は、再開しない", async () => {
    // 人間が止めた: 整合の前に、人間が停止を要求していた（stopping）→ 整合は停止を確認するだけで、判断待ちの記録ではない
    const r = rig();
    const decisionId = await r.ask();
    r.log.append({
      requestId: "human-stop",
      actor: { human: true },
      body: {
        type: "node.stateChanged",
        payload: { nodeId: "a", event: { type: "stop", mode: "immediate" } },
      },
    });
    await r.reconcile();
    expect(stateOf(r.s(), "a")).toBe("stopped");
    const res = await r.answer(decisionId);
    expect(res.ok).toBe(true);
    expect(stateOf(r.s(), "a")).toBe("stopped"); // 再開しない
    expect(r.calls.started).toEqual([]);

    const d = rig();
    const id2 = await d.ask();
    await d.reconcile();
    d.log.append({
      requestId: "disc",
      actor: { human: true },
      body: { type: "node.discardDecided", payload: { nodeId: "a" } },
    });
    expect((await d.answer(id2)).ok).toBe(true);
    expect(stateOf(d.s(), "a")).toBe("stopped");
    expect(d.calls.started).toEqual([]);
  });

  it("プロセスが残っているときは、node.exited を記録せず（停止の要求と停止未完了だけ）、再開もしない", async () => {
    const r = rig({ processes: { a: [{ pid: 7, cwd: "/wt/a", hasOpenFiles: true }] } });
    const decisionId = await r.ask();
    await r.reconcile();
    expect(stateOf(r.s(), "a")).toBe("stopIncomplete");
    expect(r.s().exits.some((e) => e.nodeId === "a")).toBe(false);
    // アダプタの予期しない終了と同じく、失敗の報告と、受信箱の failure の項目も出す（stopIncomplete の項目に加えて）。
    expect(r.s().reports.filter((x) => x.nodeId === "a" && x.kind === "failure")).toHaveLength(1);
    expect(
      r
        .s()
        .inbox.filter((i) => i.nodeId === "a")
        .map((i) => i.kind)
        .sort(),
    ).toEqual(["decision", "failure", "stopIncomplete"].sort());
    const res = await r.answer(decisionId);
    expect(res.ok).toBe(false); // 停止の途中なので、再開できない
    expect(res.error?.code).toBe("resumePending");
    expect(r.calls.started).toEqual([]);
  });

  it("プロセスの調査は、置き場全体に 1 回だけ", async () => {
    const opened = EventLog.open(createMemoryStore().open(), { clock });
    if (!opened.ok) throw new Error("open");
    const log = opened.value;
    const add = (body: EventBody): void => {
      const r = log.append({ requestId: `s-${++n}`, actor: { system: true }, body });
      if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
    };
    add({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    });
    add({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } });
    for (const id of ["a", "b", "c"]) {
      add({
        type: "node.created",
        payload: { nodeId: id, role: "implement", parentId: "root", dependsOn: [] },
      });
      add({ type: "node.stateChanged", payload: { nodeId: id, event: { type: "start" } } });
    }
    const probed: string[] = [];
    await reconcileOnStartup({
      log,
      clock,
      cwdOf: async (id) => `/wt/${id}`,
      worktreeRoot: "/wt",
      probe: async (p) => {
        probed.push(p);
        return [];
      },
    });
    expect(probed).toEqual(["/wt"]);
    for (const id of ["a", "b", "c"]) expect(stateOf(log.state(), id)).toBe("stopped");
  });
});
