import { ok } from "@cso/core";
import { describe, expect, it } from "vitest";
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
});
