import { type EventBody, type NodeEvent, ok, stateOf } from "@cso/core";
import { describe, expect, it, vi } from "vitest";
import { createHandlers, createHandlersWithScheduler } from "../../../src/api/handlers/index.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";
import type { RuntimeAdapter } from "../../../src/sdk/runtime.js";

const clock = (): string => "2026-10-20T00:00:00Z";
const open = () => {
  const r = EventLog.open(createMemoryStore().open(), { clock });
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};
const spawnDeps = {
  ports: {
    cwdOf: async () => "/wt/x",
    provisionWorktree: async () => ok({ worktreePath: "/wt/y" }),
    removeWorktree: async () => ok(undefined),
    worktreeRoot: "/wt",
    mcpUrl: "http://127.0.0.1:1/mcp",
  },
  credentials: { issueNodeToken: () => "t", revokeNode: () => undefined },
};

describe("createHandlers の組み立て", () => {
  it("読み取りと状態の操作だけ（既定）", () => {
    const h = createHandlers({ log: open(), clock });
    expect(h["tree.list"]).toBeTypeOf("function");
    expect(h["node.spawn"]).toBeUndefined();
    expect(h["scope.extend"]).toBeUndefined();
  });

  it("runtime と spawn がそろうと、子の生成・一時停止の再開・範囲の拡張も有効になる", () => {
    const adapter = {} as unknown as RuntimeAdapter;
    const h = createHandlers(
      { log: open(), clock },
      { adapterFor: () => adapter },
      undefined,
      spawnDeps,
    );
    for (const op of [
      "node.spawn",
      "node.split",
      "node.send",
      "scope.extend",
      "scope.decide",
      "decision.present",
      "decision.answer",
    ] as const) {
      expect(h[op], op).toBeTypeOf("function");
    }
  });

  it("node.review の受理（依存先の完了）で、依存が揃った pending の子が起動する", async () => {
    const log = open();
    const add = (body: EventBody): void => {
      const r = log.append({ requestId: `seed-${Math.random()}`, actor: { system: true }, body });
      if (!r.ok) throw new Error(r.error.code);
    };
    const ev = (nodeId: string, event: NodeEvent) =>
      add({ type: "node.stateChanged", payload: { nodeId, event } });
    const scope = {
      writableLocations: ["src"],
      forbiddenLocations: [".git"],
      allowedCommands: ["pnpm test"],
    };
    const node = (
      nodeId: string,
      role: "integrator" | "implement",
      parentId: string | null,
      dependsOn: string[] = [],
    ) =>
      add({
        type: "node.created",
        payload: {
          nodeId,
          role,
          parentId,
          dependsOn,
          ...(parentId === null ? {} : { objective: nodeId, acceptanceCriteria: ["c"], scope }),
        },
      });
    node("m1", "integrator", null);
    ev("m1", { type: "start" });
    node("a", "implement", "m1");
    ev("a", { type: "start" });
    ev("a", { type: "reportDone" });
    node("b", "implement", "m1", ["a"]);
    const started: string[] = [];
    const adapter = {
      start: async (req: { nodeId: string; worktreePath: string }) => {
        started.push(req.nodeId);
        return ok({ sessionId: "s", cwd: req.worktreePath, removedEnv: [] });
      },
    } as unknown as RuntimeAdapter;
    const h = createHandlers({ log, clock }, { adapterFor: () => adapter }, undefined, {
      ...spawnDeps,
      rootScope: scope,
    });
    const r = await h["node.review"]?.({
      requestId: "rv-1",
      operation: "node.review",
      role: "integrator",
      caller: { nodeId: "m1" },
      params: { nodeId: "a", verdict: "accept" },
    } as never);
    expect(r?.ok).toBe(true);
    await vi.waitFor(() => expect(started).toEqual(["b"]));
    expect(stateOf(log.state(), "b")).toBe("running");
  });

  it("close は、実行中の tick が終わるのを待つ。close の後は、起動しない。tree.list は、破棄済みの依存先を示す", async () => {
    const log = open();
    const add = (body: EventBody): void => {
      const r = log.append({ requestId: `seed-${Math.random()}`, actor: { system: true }, body });
      if (!r.ok) throw new Error(r.error.code);
    };
    const ev = (nodeId: string, event: NodeEvent) =>
      add({ type: "node.stateChanged", payload: { nodeId, event } });
    const scope = {
      writableLocations: ["src"],
      forbiddenLocations: [".git"],
      allowedCommands: ["pnpm test"],
    };
    const node = (
      nodeId: string,
      role: "integrator" | "implement",
      parentId: string | null,
      dependsOn: string[] = [],
    ) =>
      add({
        type: "node.created",
        payload: {
          nodeId,
          role,
          parentId,
          dependsOn,
          ...(parentId === null ? {} : { objective: nodeId, acceptanceCriteria: ["c"], scope }),
        },
      });
    node("m1", "integrator", null);
    ev("m1", { type: "start" });
    node("a", "implement", "m1");
    ev("a", { type: "start" });
    ev("a", { type: "stop", mode: "immediate" });
    ev("a", { type: "confirmStopped" });
    add({ type: "node.discardDecided", payload: { nodeId: "a" } });
    ev("a", { type: "markReclaimable", discarded: true });
    ev("a", { type: "archive" });
    node("b", "implement", "m1", ["a"]);
    node("p", "implement", "m1"); // 依存なし。起動できる
    let release!: () => void;
    const gate = new Promise<void>((res) => {
      release = res;
    });
    const started: string[] = [];
    const adapter = {
      start: async (req: { nodeId: string; worktreePath: string }) => {
        started.push(req.nodeId);
        await gate;
        return ok({ sessionId: "s", cwd: req.worktreePath, removedEnv: [] });
      },
    } as unknown as RuntimeAdapter;
    const made = createHandlersWithScheduler(
      { log, clock },
      { adapterFor: () => adapter },
      undefined,
      {
        ...spawnDeps,
        rootScope: scope,
      },
    );
    const listed = made.handlers["tree.list"]?.({
      requestId: "tl",
      operation: "tree.list",
      role: "integrator",
      caller: { nodeId: "m1" },
      params: {},
    } as never);
    expect(JSON.stringify(listed)).toContain("a(破棄済み)");

    const t = made.tick();
    await vi.waitFor(() => expect(started).toEqual(["p"]));
    let closed = false;
    const c = made.close().then(() => {
      closed = true;
    });
    await new Promise((res) => setTimeout(res, 10));
    expect(closed).toBe(false); // 起動の途中なので、まだ待つ
    release();
    await c;
    await t;
    expect(closed).toBe(true);
    expect(stateOf(log.state(), "p")).toBe("running");
    await made.tick(); // close の後は、何もしない
    expect(started).toEqual(["p"]);
  });

  it("decision.answer の成功後に、起動できる pending の子が起動する", async () => {
    const log = open();
    const add = (body: EventBody): void => {
      const r = log.append({ requestId: `seed-${Math.random()}`, actor: { system: true }, body });
      if (!r.ok) throw new Error(r.error.code);
    };
    const scope = {
      writableLocations: ["src"],
      forbiddenLocations: [".git"],
      allowedCommands: ["pnpm test"],
    };
    add({
      type: "node.created",
      payload: { nodeId: "m1", role: "integrator", parentId: null, dependsOn: [] },
    });
    add({ type: "node.stateChanged", payload: { nodeId: "m1", event: { type: "start" } } });
    add({
      type: "node.created",
      payload: {
        nodeId: "p",
        role: "implement",
        parentId: "m1",
        dependsOn: [],
        objective: "p",
        acceptanceCriteria: ["c"],
        scope,
      },
    });
    const started: string[] = [];
    const adapter = {
      start: async (req: { nodeId: string; worktreePath: string }) => {
        started.push(req.nodeId);
        return ok({ sessionId: "s", cwd: req.worktreePath, removedEnv: [] });
      },
    } as unknown as RuntimeAdapter;
    const h = createHandlers({ log, clock }, { adapterFor: () => adapter }, undefined, {
      ...spawnDeps,
      rootScope: scope,
    });
    const present = await h["decision.present"]?.({
      requestId: "dp-1",
      operation: "decision.present",
      role: "integrator",
      caller: { nodeId: "m1" },
      params: { question: "どうする？", options: ["a", "b"] },
    } as never);
    expect(present?.ok).toBe(true);
    expect(started).toEqual([]); // 回答の前は、起動しない（tick を呼ぶ契機がまだない）
    const decisionId = (present as { value: { decisionId: string } }).value.decisionId;
    const answered = await h["decision.answer"]?.({
      requestId: "da-1",
      operation: "decision.answer",
      role: "human",
      params: { decisionId, choice: "a" },
    } as never);
    expect(answered?.ok).toBe(true);
    await vi.waitFor(() => expect(started).toEqual(["p"]));
  });
});
