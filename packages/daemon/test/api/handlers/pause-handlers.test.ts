import {
  type EventBody,
  type Failure,
  failure,
  type NodeEvent,
  ok,
  type Result,
  type Scope,
  stateOf,
} from "@cso/core";
import { describe, expect, it } from "vitest";
import { createPauseHandlers } from "../../../src/api/handlers/pause-handlers.js";
import { createRuntimeHandlers } from "../../../src/api/handlers/runtime-handlers.js";
import { createStateHandlers } from "../../../src/api/handlers/state-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";
import type { RuntimeAdapter, StartRequest, StartValue } from "../../../src/sdk/runtime.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-10-20T00:00:00Z";
let n = 0;
const SCOPE: Scope = {
  writableLocations: ["src"],
  forbiddenLocations: [],
  allowedCommands: ["pnpm test"],
};

/** root ─ m1(統合) ─ a(running)・b(running)・p(pending)・d(done)。呼び出し元は m1 */
const rig = () => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  const node = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
    add({
      type: "node.created",
      payload: {
        nodeId,
        role,
        parentId,
        dependsOn: [],
        objective: "o",
        acceptanceCriteria: ["c"],
        scope: SCOPE,
      },
    });
  add({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  });
  ev("root", { type: "start" });
  node("m1", "integrator", "root");
  ev("m1", { type: "start" });
  for (const id of ["a", "b"]) {
    node(id, "implement", "m1");
    ev(id, { type: "start" });
  }
  node("p", "implement", "m1");
  node("d", "implement", "m1");
  ev("d", { type: "start" });
  ev("d", { type: "reportDone" });

  const calls = {
    started: [] as StartRequest[],
    stops: [] as string[],
    issued: [] as string[],
    revoked: [] as string[],
    failures: [] as string[],
  };
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
    async start(req: StartRequest): Promise<Result<StartValue, Failure>> {
      calls.started.push(req);
      if (flags.startFails) return { ok: false, error: failure("startFailed", "x", "y") };
      return ok({ sessionId: "s", cwd: req.worktreePath, removedEnv: [] });
    },
    async send() {
      return ok({ status: "queued" as const });
    },
    async stop(nodeId: string) {
      calls.stops.push(nodeId);
      return ok({ state: "stopped" as const, outcome: "aborted" as const, blockers: [] });
    },
    updateScope: () => ok(undefined),
  } as unknown as RuntimeAdapter;
  const runtime = createRuntimeHandlers({ log, clock, adapterFor: () => adapter });
  const state = createStateHandlers({ log, clock, allowPause: true });
  const h = createPauseHandlers({
    log,
    clock,
    present: state["decision.present"],
    answer: state["decision.answer"],
    stop: runtime["node.stop"],
    adapterFor: () => adapter,
    ports: { cwdOf: async (id) => `/wt/${id}`, mcpUrl: "http://127.0.0.1:1/mcp" },
    credentials: {
      issueNodeToken: (id) => {
        calls.issued.push(id);
        return `tok-${id}`;
      },
      revokeNode: (id) => {
        calls.revoked.push(id);
      },
    },
    onFailure: (_id, cause) => calls.failures.push(cause),
  });
  const present = async (params: Record<string, unknown>, requestId = `q-${++n}`) => {
    const req = {
      requestId,
      operation: "decision.present",
      role: "integrator",
      caller: { nodeId: "m1" },
      params,
    } as unknown as HandlerRequest<"decision.present">;
    return (await h["decision.present"](req)) as Loose<{ decisionId: string }>;
  };
  const answer = async (decisionId: string, text: string, requestId = `q-${++n}`) => {
    const req = {
      requestId,
      operation: "decision.answer",
      role: "human",
      params: { decisionId, choice: text },
    } as unknown as HandlerRequest<"decision.answer">;
    return (await h["decision.answer"](req)) as Loose<{ accepted: true }>;
  };
  const flush = () => new Promise((r) => setTimeout(r, 0));
  return { log, present, answer, ev, calls, flags, flush, s: () => log.state() };
};
type Loose<V> = { ok: boolean; value?: V; error?: Failure };
const Q = { question: "どうする？", options: ["A", "B"] };

describe("decision.present の pauseNodeIds（判断待ちの間に子を止める）", () => {
  it("判断要求に止める子を記録し、その子を穏当に止める。ほかの子は止めない", async () => {
    const r = rig();
    const res = await r.present({ ...Q, pauseNodeIds: ["a"] });
    expect(res.ok).toBe(true);
    expect(r.s().decisions[0]?.pauseNodeIds).toEqual(["a"]);
    expect(stateOf(r.s(), "a")).toBe("stopping");
    expect(stateOf(r.s(), "b")).toBe("running");
    await r.flush();
    expect(r.calls.stops).toEqual(["a"]);
  });

  it("同じ requestId の再送は、止める操作を重複させない", async () => {
    const r = rig();
    await r.present({ ...Q, pauseNodeIds: ["a"] }, "pr-1");
    const seq = r.s().lastSeq;
    const again = await r.present({ ...Q, pauseNodeIds: ["a"] }, "pr-1");
    expect(again.ok).toBe(true);
    expect(r.s().lastSeq).toBe(seq);
  });

  it("終わった子・子孫でない子は、何も記録せずに失敗する", async () => {
    const r = rig();
    const seq = r.s().lastSeq;
    expect((await r.present({ ...Q, pauseNodeIds: ["d"] })).error?.code).toBe("notActive");
    expect((await r.present({ ...Q, pauseNodeIds: ["root"] })).ok).toBe(false);
    expect(r.s().lastSeq).toBe(seq);
  });
});

describe("decision.answer（回答で、止めた子を必ず再開する）", () => {
  const paused = async (r: ReturnType<typeof rig>) => {
    const res = await r.present({ ...Q, pauseNodeIds: ["a"] });
    await r.flush();
    r.ev("a", { type: "confirmStopped" });
    return res.value?.decisionId as string;
  };

  it("回答を記録し、止めた子を再開する（作業ツリー・範囲・回答を渡して起動）", async () => {
    const r = rig();
    const id = await paused(r);
    const res = await r.answer(id, "B");
    expect(res.ok).toBe(true);
    expect(stateOf(r.s(), "a")).toBe("running");
    expect(r.calls.started).toHaveLength(1);
    expect(r.calls.started[0]).toMatchObject({
      nodeId: "a",
      worktreePath: "/wt/a",
      scope: SCOPE,
      mcp: { token: "tok-a" },
    });
    expect(r.calls.started[0]?.instruction).toContain("B");
  });

  it("停止の途中なら、回答は記録して resumePending で失敗する。停止が済んだあとの同じ回答の再送で再開する（二重に起動しない）", async () => {
    const r = rig();
    const res = await r.present({ ...Q, pauseNodeIds: ["a"] });
    const id = res.value?.decisionId as string;
    await r.flush();
    const first = await r.answer(id, "B", "ans-1");
    expect(first.ok).toBe(false);
    expect(first.error?.code).toBe("resumePending");
    expect(r.s().decisions[0]?.status).toBe("answered");
    r.ev("a", { type: "confirmStopped" });
    const retry = await r.answer(id, "B", "ans-2");
    expect(retry.ok).toBe(true);
    expect(stateOf(r.s(), "a")).toBe("running");
    const again = await r.answer(id, "B", "ans-3");
    expect(again.ok).toBe(true);
    expect(r.calls.started).toHaveLength(1);
  });

  it("起動に失敗したら、トークンを失効して停止済みに戻し、失敗を返す。直したあとの再送で再開する", async () => {
    const r = rig();
    const id = await paused(r);
    r.flags.startFails = true;
    const res = await r.answer(id, "A", "ans-1");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("resumePending");
    expect(stateOf(r.s(), "a")).toBe("stopped");
    expect(r.calls.revoked).toEqual(["a"]);
    r.flags.startFails = false;
    const retry = await r.answer(id, "A", "ans-2");
    expect(retry.ok).toBe(true);
    expect(stateOf(r.s(), "a")).toBe("running");
    expect(r.calls.started).toHaveLength(2);
  });

  it("後から来た別の回答（却下）では、再開を試みない。止めていない判断は、そのまま", async () => {
    const r = rig();
    const id = await paused(r);
    await r.answer(id, "A", "ans-1");
    const late = await r.answer(id, "B", "ans-2");
    expect(late.error?.code).toBe("alreadyAnswered");
    const plain = await r.present(Q);
    expect(plain.ok).toBe(true);
    const pid = plain.value?.decisionId as string;
    expect((await r.answer(pid, "A")).ok).toBe(true);
    expect(r.calls.started).toHaveLength(1);
  });
});
