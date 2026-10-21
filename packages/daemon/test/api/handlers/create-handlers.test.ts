import { type EventBody, type NodeEvent, ok, stateOf } from "@cso/core";
import { describe, expect, it, vi } from "vitest";
import { createHandlers } from "../../../src/api/handlers/index.js";
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
});
