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
import { createSpawner, type SpawnPorts } from "../../../src/api/handlers/spawn-handlers.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";
import type { RuntimeAdapter, StartRequest, StartValue } from "../../../src/sdk/runtime.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-10-20T00:00:00Z";
const WT = "/wt";
let n = 0;

const SCOPE: Scope = {
  writableLocations: ["src"],
  forbiddenLocations: [".git"],
  allowedCommands: ["pnpm test"],
};

/** root ─ m1(統合・running) ─ a(running)、b（a に依存・pending）、c（a・b に依存・pending）。 */
const rig = (opts: { startLimits?: { perParent?: number; total?: number } } = {}) => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
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
        ...(parentId === null
          ? {}
          : { objective: `目的 ${nodeId}`, acceptanceCriteria: ["完了"], scope: SCOPE }),
      },
    });
  node("root", "integrator", null);
  ev("root", { type: "start" });
  node("m1", "integrator", "root");
  ev("m1", { type: "start" });
  node("a", "implement", "m1");
  ev("a", { type: "start" });
  node("b", "implement", "m1", ["a"]);
  node("c", "implement", "m1", ["a", "b"]);

  const calls = {
    provisioned: [] as string[],
    removed: [] as string[],
    started: [] as StartRequest[],
    failures: [] as string[],
  };
  const flags = {
    startFails: false,
    startGate: undefined as Promise<void> | undefined,
    noAdapter: false,
  };
  const adapter = {
    kind: "cli" as const,
    async start(req: StartRequest): Promise<Result<StartValue, Failure>> {
      calls.started.push(req);
      if (flags.startGate !== undefined) await flags.startGate;
      if (flags.startFails) return { ok: false, error: failure("startFailed", "内部X", "内部Y") };
      return ok({ sessionId: "sess", cwd: req.worktreePath, removedEnv: [] });
    },
    async stop() {
      return ok({ state: "stopped" as const, outcome: "aborted" as const, blockers: [] });
    },
  } as unknown as RuntimeAdapter;
  const ports: SpawnPorts = {
    cwdOf: async (id) => `${WT}/${id}`,
    provisionWorktree: async ({ nodeId }) => {
      calls.provisioned.push(nodeId);
      return ok({ worktreePath: `${WT}/${nodeId}` });
    },
    removeWorktree: async (id) => {
      calls.removed.push(id);
      return ok(undefined);
    },
    worktreeRoot: WT,
    mcpUrl: "http://127.0.0.1:1/mcp",
  };
  const spawner = createSpawner({
    log,
    clock,
    adapterFor: () => (flags.noAdapter ? undefined : adapter),
    ...(opts.startLimits === undefined ? {} : { startLimits: opts.startLimits }),
    ports,
    credentials: { issueNodeToken: (id) => `tok-${id}`, revokeNode: () => undefined },
    rootScope: SCOPE,
    stop: async () => ok({ state: "stopping" as const }),
    onFailure: (_id, cause) => calls.failures.push(cause),
  });
  const verify = (id: string) => {
    ev(id, { type: "reportDone" });
    ev(id, { type: "accept" });
  };
  const discard = (id: string) => {
    ev(id, { type: "stop", mode: "immediate" });
    ev(id, { type: "confirmStopped" });
    log.append({
      requestId: `seed-discard-${id}`,
      actor: SYS,
      body: { type: "node.discardDecided", payload: { nodeId: id } },
    });
    ev(id, { type: "markReclaimable", discarded: true });
    ev(id, { type: "archive" });
  };
  const node2 = (nodeId: string, dependsOn: string[]) =>
    log.append({
      requestId: `seed-node2-${nodeId}`,
      actor: SYS,
      body: {
        type: "node.created",
        payload: {
          nodeId,
          role: "implement",
          parentId: "m1",
          dependsOn,
          objective: `目的 ${nodeId}`,
          acceptanceCriteria: ["完了"],
          scope: SCOPE,
        },
      },
    });
  const failures = (id: string) =>
    log.state().inbox.filter((i) => i.nodeId === id && i.kind === "failure");
  return { log, calls, flags, spawner, ev, verify, discard, node2, failures };
};

describe("スケジューラ（依存が揃った pending の子を起動する）", () => {
  it("依存先が未完了のあいだは、起動しない", async () => {
    const r = rig();
    await r.spawner.tick();
    expect(r.calls.started).toEqual([]);
    expect(stateOf(r.log.state(), "b")).toBe("pending");
  });

  it("依存先が verified になったら起動する。依存が残る子は起動しない", async () => {
    const r = rig();
    r.verify("a");
    await r.spawner.tick();
    expect(r.calls.started.map((s) => s.nodeId)).toEqual(["b"]);
    expect(stateOf(r.log.state(), "b")).toBe("running");
    expect(stateOf(r.log.state(), "c")).toBe("pending");
    // 起動の入力は、記録したブリーフから作る
    expect(r.calls.started[0]?.instruction).toContain("目的 b");
    expect(r.calls.started[0]?.scope).toEqual(SCOPE);
    expect(r.calls.started[0]?.worktreePath).toBe(`${WT}/b`);
    // b が完了したら c が起動する
    r.verify("b");
    await r.spawner.tick();
    expect(r.calls.started.map((s) => s.nodeId)).toEqual(["b", "c"]);
  });

  it("tick を繰り返しても、二重に起動しない", async () => {
    const r = rig();
    r.verify("a");
    await r.spawner.tick();
    await r.spawner.tick();
    expect(r.calls.started.map((s) => s.nodeId)).toEqual(["b"]);
  });

  it("同時の tick でも、二重に起動しない（起動の最中に重なっても 1 回）", async () => {
    const r = rig();
    r.verify("a");
    let release!: () => void;
    r.flags.startGate = new Promise<void>((res) => {
      release = res;
    });
    const t1 = r.spawner.tick();
    const t2 = r.spawner.tick();
    await Promise.resolve();
    release();
    await Promise.all([t1, t2]);
    expect(r.calls.started.map((s) => s.nodeId)).toEqual(["b"]);
    expect(stateOf(r.log.state(), "b")).toBe("running");
  });

  it("親が動作中の統合ノードでなければ、起動しない（止まっている親の下で起動しない）", async () => {
    const r = rig();
    r.verify("a");
    r.ev("m1", { type: "stop", mode: "immediate" });
    r.ev("m1", { type: "confirmStopped" });
    await r.spawner.tick();
    expect(r.calls.started).toEqual([]);
    expect(stateOf(r.log.state(), "b")).toBe("pending");
  });

  it("起動に失敗したら、spawn と同じ後始末（停止・作業ツリー削除・アーカイブ）をして、親の受信箱に失敗を残す。再試行しない", async () => {
    const r = rig();
    r.verify("a");
    r.flags.startFails = true;
    await r.spawner.tick();
    expect(r.calls.removed).toEqual(["b"]);
    expect(stateOf(r.log.state(), "b")).toBe("archived");
    const inbox = r.log.state().inbox.filter((i) => i.nodeId === "b" && i.kind === "failure");
    expect(inbox).toHaveLength(1);
    // もう起動しない（c は b が完了しないので待つ）
    r.flags.startFails = false;
    await r.spawner.tick();
    expect(r.calls.started.map((s) => s.nodeId)).toEqual(["b"]);
  });

  it("ブリーフのない pending は起動せず、失敗として記録する（安全側）", async () => {
    const r = rig();
    r.log.append({
      requestId: "seed-nobrief",
      actor: SYS,
      body: {
        type: "node.created",
        payload: { nodeId: "x", role: "implement", parentId: "m1", dependsOn: [] },
      },
    });
    await r.spawner.tick();
    expect(r.calls.started).toEqual([]);
    expect(stateOf(r.log.state(), "x")).toBe("pending");
    expect(r.calls.failures.join("\n")).toContain("ブリーフ");
  });

  it("依存先が破棄されたら、依存する子について、受信箱に失敗を 1 度だけ出す（案内つき）。連鎖でも出る", async () => {
    const r = rig();
    r.discard("a");
    r.node2("d", ["b"]); // d は b を待つ。b は、破棄された a を待つ（連鎖）
    await r.spawner.tick();
    await r.spawner.tick();
    for (const id of ["b", "c", "d"]) {
      const f = r.failures(id);
      expect(f, id).toHaveLength(1);
      expect(f[0]?.summary).toContain("node.stop");
      expect(f[0]?.summary).toContain("a");
    }
    expect(r.calls.started).toEqual([]);
    expect(stateOf(r.log.state(), "b")).toBe("pending");
  });

  it("破棄済みの依存先を指定した spawn は、失敗させる。tree.list のような一覧では、破棄済みと分かる", async () => {
    const r = rig();
    r.discard("a");
    const res = await r.spawner.handlers["node.spawn"]({
      requestId: "sp-1",
      operation: "node.spawn",
      role: "integrator",
      caller: { nodeId: "m1" },
      params: {
        parentId: "m1",
        role: "implement",
        objective: "x",
        acceptanceCriteria: ["y"],
        scope: SCOPE,
        dependsOn: ["a"],
      },
    } as never);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("dependencyDiscarded");
  });

  it("同時に起動する数は、親ごとの上限まで。残りは、空きができてから起動する", async () => {
    const r = rig({ startLimits: { perParent: 1 } });
    r.node2("e", ["a"]);
    r.verify("a");
    let release!: () => void;
    r.flags.startGate = new Promise<void>((res) => {
      release = res;
    });
    const t = r.spawner.tick();
    await new Promise((res) => setTimeout(res, 10));
    expect(r.calls.started).toHaveLength(1); // b か e の 1 つだけ
    release();
    await t;
    expect(r.calls.started.map((s) => s.nodeId).sort()).toEqual(["b", "e"]);
  });

  it("起動できない理由は、最初の 1 度だけ受信箱に出す（作業を続けられるよう、pending のまま）", async () => {
    const r = rig();
    r.verify("a");
    r.flags.noAdapter = true;
    await r.spawner.tick();
    await r.spawner.tick();
    expect(r.failures("b")).toHaveLength(1);
    expect(stateOf(r.log.state(), "b")).toBe("pending");
    // 直ったら起動する
    r.flags.noAdapter = false;
    await r.spawner.tick();
    expect(stateOf(r.log.state(), "b")).toBe("running");
  });
});
