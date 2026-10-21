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
import { createSpawnHandlers, type SpawnPorts } from "../../../src/api/handlers/spawn-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";
import type { RuntimeAdapter, StartRequest, StartValue } from "../../../src/sdk/runtime.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-10-20T00:00:00Z";
const WT = "/wt";
let n = 0;

const PARENT_SCOPE: Scope = {
  writableLocations: ["src", "docs"],
  forbiddenLocations: [".git"],
  allowedCommands: ["pnpm test", "git status"],
};
const CHILD_SCOPE: Scope = {
  writableLocations: ["src/ui"],
  forbiddenLocations: [".git"],
  allowedCommands: ["pnpm test"],
};
const brief = (over: Record<string, unknown> = {}) => ({
  role: "implement",
  objective: "UI を直す",
  acceptanceCriteria: ["テストが通る"],
  scope: CHILD_SCOPE,
  ...over,
});

/** root ─ m1(統合・範囲 PARENT_SCOPE・running) ─ a(running)、root ─ m2(統合)。呼び出し元は既定で m1 */
const ROOT_SCOPE: Scope = {
  writableLocations: ["src", "docs"],
  forbiddenLocations: [".git"],
  allowedCommands: ["pnpm test"],
};
const rig = (opts: { rootScope?: Scope | null } = {}) => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  add({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  });
  ev("root", { type: "start" });
  add({
    type: "node.created",
    payload: {
      nodeId: "m1",
      role: "integrator",
      parentId: "root",
      dependsOn: [],
      objective: "統合",
      acceptanceCriteria: ["完了"],
      scope: PARENT_SCOPE,
    },
  });
  ev("m1", { type: "start" });
  add({
    type: "node.created",
    payload: {
      nodeId: "a",
      role: "implement",
      parentId: "m1",
      dependsOn: [],
      objective: "a",
      acceptanceCriteria: ["a"],
      scope: PARENT_SCOPE,
    },
  });
  ev("a", { type: "start" });
  add({
    type: "node.created",
    payload: { nodeId: "m2", role: "integrator", parentId: "root", dependsOn: [] },
  });
  ev("m2", { type: "start" });

  const calls = {
    provisioned: [] as string[],
    removed: [] as string[],
    issued: [] as [string, string][],
    revoked: [] as string[],
    started: [] as StartRequest[],
    stopped: [] as string[],
    failures: [] as string[],
  };
  const flags = {
    startFails: false,
    issueThrows: false,
    removeFails: false,
    revokeThrows: false,
    provisionFails: false,
    cwdOfParent: `${WT}/m1` as string | undefined,
  };
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
      if (flags.startFails)
        return { ok: false, error: failure("startFailed", "起動できない", "もう一度試す") };
      return ok({ sessionId: "sess", cwd: req.worktreePath, removedEnv: [] });
    },
    async send() {
      return ok({ status: "queued" as const });
    },
    async stop() {
      throw new Error("not used");
    },
    updateScope: () => ok(undefined),
  } as unknown as RuntimeAdapter;
  const ports: SpawnPorts = {
    cwdOf: async (id) => (id === "m1" ? flags.cwdOfParent : id === "m2" ? `${WT}/m2` : undefined),
    provisionWorktree: async ({ nodeId }) => {
      calls.provisioned.push(nodeId);
      if (flags.provisionFails)
        return { ok: false, error: failure("provisionFailed", "作れない", "確認する") };
      return ok({ worktreePath: `${WT}/${nodeId}` });
    },
    removeWorktree: async (id) => {
      calls.removed.push(id);
      if (flags.removeFails) throw new Error("rm 失敗");
      return ok(undefined);
    },
    mcpUrl: "http://127.0.0.1:1/mcp",
  };
  const credentials = {
    issueNodeToken: (id: string, role: string) => {
      if (flags.issueThrows) throw new Error("保存できない");
      calls.issued.push([id, role]);
      return `tok-${id}`;
    },
    revokeNode: (id: string) => {
      calls.revoked.push(id);
      if (flags.revokeThrows) throw new Error("失効できない");
    },
  };
  const h = createSpawnHandlers({
    log,
    clock,
    adapterFor: () => adapter,
    ports,
    credentials,
    ...(opts.rootScope === null ? {} : { rootScope: opts.rootScope ?? ROOT_SCOPE }),
    stop: async (req) => {
      calls.stopped.push(req.params.nodeId);
      return ok({ state: "stopping" as const });
    },
    onFailure: (_id, cause) => calls.failures.push(cause),
  });
  const call = async (
    op: keyof typeof h,
    params: Record<string, unknown>,
    caller = "m1",
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
  return { log, call, calls, flags, ev, s: () => log.state() };
};

describe("node.spawn（子の生成と起動）", () => {
  it("作業ツリーを作り、範囲を検査し、ブリーフつきで記録して、トークンを発行して起動する", async () => {
    const r = rig();
    const res = await r.call("node.spawn", { parentId: "m1", ...brief() });
    expect(res.ok).toBe(true);
    const id = res.value.nodeId as string;
    expect(stateOf(r.s(), id)).toBe("running");
    const rec = r.s().nodes.find((x) => x.id === id);
    expect(rec).toMatchObject({
      parentId: "m1",
      role: "implement",
      objective: "UI を直す",
      acceptanceCriteria: ["テストが通る"],
    });
    expect(r.calls.provisioned).toEqual([id]);
    expect(r.calls.issued).toEqual([[id, "child"]]);
    expect(r.calls.started).toHaveLength(1);
    expect(r.calls.started[0]).toMatchObject({
      nodeId: id,
      worktreePath: `${WT}/${id}`,
      scope: CHILD_SCOPE,
    });
    expect(r.calls.started[0]?.instruction).toContain("UI を直す");
    expect(r.calls.started[0]?.instruction).toContain("テストが通る");
    expect(r.calls.started[0]?.mcp).toEqual({ url: "http://127.0.0.1:1/mcp", token: `tok-${id}` });
  });

  it("親の範囲に収まらない子の範囲は、何も記録せず、作った作業ツリーを片付けて失敗する", async () => {
    const r = rig();
    const res = await r.call("node.spawn", {
      parentId: "m1",
      ...brief({ scope: { ...CHILD_SCOPE, allowedCommands: ["rm -rf"] } }),
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("scopeNotSubset");
    expect(r.s().nodes.map((x) => x.id)).toEqual(["root", "m1", "a", "m2"]);
    expect(r.calls.removed).toHaveLength(1);
    expect(r.calls.issued).toEqual([]);
    expect(r.calls.started).toEqual([]);
  });

  it("作業ツリーの外を指す範囲（validateScope）は、片付けて失敗する", async () => {
    const r = rig();
    const res = await r.call("node.spawn", {
      parentId: "m1",
      ...brief({ scope: { ...CHILD_SCOPE, writableLocations: ["/etc"] } }),
    });
    expect(res.ok).toBe(false);
    expect(r.calls.removed).toHaveLength(1);
    expect(r.s().nodes).toHaveLength(4);
  });

  it("親の作業ツリーを取得できなければ、何もせずに失敗する（安全側）", async () => {
    const r = rig();
    r.flags.cwdOfParent = undefined;
    const res = await r.call("node.spawn", { parentId: "m1", ...brief() });
    expect(res.ok).toBe(false);
    expect(r.calls.provisioned).toEqual([]);
  });

  it("依存が未完了なら、作業ツリーを作って pending を記録して返す（起動しない）", async () => {
    const r = rig();
    const res = await r.call("node.spawn", { parentId: "m1", ...brief({ dependsOn: ["a"] }) });
    expect(res.ok).toBe(true);
    expect(stateOf(r.s(), res.value.nodeId)).toBe("pending");
    expect(r.calls.provisioned).toHaveLength(1);
    expect(r.calls.issued).toEqual([]);
    expect(r.calls.started).toEqual([]);
  });

  it("同じ requestId の再試行は、作業ツリー・トークン・起動を重複させず、同じ nodeId を返す", async () => {
    const r = rig();
    const first = await r.call("node.spawn", { parentId: "m1", ...brief() }, "m1", "sp-1");
    const seq = r.s().lastSeq;
    const again = await r.call("node.spawn", { parentId: "m1", ...brief() }, "m1", "sp-1");
    expect(again).toEqual(first);
    expect(r.s().lastSeq).toBe(seq);
    expect(r.calls.provisioned).toHaveLength(1);
    expect(r.calls.issued).toHaveLength(1);
    expect(r.calls.started).toHaveLength(1);
    const conflict = await r.call(
      "node.spawn",
      { parentId: "m1", ...brief({ objective: "別" }) },
      "m1",
      "sp-1",
    );
    expect(conflict.error?.code).toBe("requestIdConflict");
  });

  it("起動の失敗: トークンを失効し、作業ツリーを消し、ノードを停止済みにして、失敗を返す（後始末の通し）。後始末の失敗は例外にせず記録する", async () => {
    const r = rig();
    r.flags.startFails = true;
    r.flags.removeFails = true;
    r.flags.revokeThrows = true;
    const res = await r.call("node.spawn", { parentId: "m1", ...brief() });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("startFailed");
    const id = r.calls.provisioned[0] as string;
    expect(r.calls.revoked).toEqual([id]);
    expect(r.calls.removed).toEqual([id]);
    expect(stateOf(r.s(), id)).toBe("stopped");
    expect(r.calls.failures.length).toBeGreaterThanOrEqual(2);
  });

  it("トークンを発行できなければ、起動せずに後始末して失敗する", async () => {
    const r = rig();
    r.flags.issueThrows = true;
    const res = await r.call("node.spawn", { parentId: "m1", ...brief() });
    expect(res.ok).toBe(false);
    expect(r.calls.started).toEqual([]);
    const id = r.calls.provisioned[0] as string;
    expect(r.calls.removed).toEqual([id]);
    expect(r.calls.revoked).toEqual([id]);
    expect(stateOf(r.s(), id)).toBe("stopped");
  });

  it("ブリーフのない親（根など）は、設定の根の範囲と比べる。範囲を超える子・設定がない場合は失敗する", async () => {
    const r = rig();
    const ok1 = await r.call("node.spawn", { parentId: "m2", ...brief() }, "m2");
    expect(ok1.ok).toBe(true);
    const wide = await r.call(
      "node.spawn",
      { parentId: "m2", ...brief({ scope: { ...CHILD_SCOPE, allowedCommands: ["git push"] } }) },
      "m2",
    );
    expect(wide.error?.code).toBe("scopeNotSubset");
    const none = rig({ rootScope: null });
    const res = await none.call("node.spawn", { parentId: "m2", ...brief() }, "m2");
    expect(res.error?.code).toBe("rootScopeUnconfigured");
    expect(none.calls.removed).toHaveLength(1);
    expect(none.calls.started).toEqual([]);
    const badRoot = rig({ rootScope: { ...ROOT_SCOPE, writableLocations: ["/etc"] } });
    expect(
      (await badRoot.call("node.spawn", { parentId: "m2", ...brief() }, "m2")).error?.code,
    ).toBe("rootScopeInvalid");
  });

  it("作業ツリーを作れなければ、何も記録せずに失敗する", async () => {
    const r = rig();
    r.flags.provisionFails = true;
    const res = await r.call("node.spawn", { parentId: "m1", ...brief() });
    expect(res.error?.code).toBe("provisionFailed");
    expect(r.s().nodes).toHaveLength(4);
  });

  it("親が動作中の統合ノードでない・呼び出し元の部分木の外・依存が木の外なら、何もせずに失敗する", async () => {
    const r = rig();
    expect((await r.call("node.spawn", { parentId: "a", ...brief() })).ok).toBe(false); // 親が統合ノードでない
    expect((await r.call("node.spawn", { parentId: "m2", ...brief() })).error?.code).toBe(
      "forbidden",
    ); // 別の部分木
    expect(
      (await r.call("node.spawn", { parentId: "m1", ...brief({ dependsOn: ["nope"] }) })).ok,
    ).toBe(false);
    expect(r.calls.provisioned).toEqual([]);
  });
});

describe("node.split（切り出し）", () => {
  it("元のノードと同じ役割・親で新しい子を作る。mainline は元を止めない", async () => {
    const r = rig();
    const res = await r.call("node.split", {
      nodeId: "a",
      keep: "mainline",
      ...brief({ role: undefined }),
    });
    expect(res.ok).toBe(true);
    const rec = r.s().nodes.find((x) => x.id === res.value.newNodeId);
    expect(rec).toMatchObject({ parentId: "m1", role: "implement" });
    expect(stateOf(r.s(), res.value.newNodeId)).toBe("running");
    expect(r.calls.stopped).toEqual([]);
  });

  it("keep が stop なら、新しい子の起動のあとで元のノードを止める", async () => {
    const r = rig();
    const res = await r.call("node.split", {
      nodeId: "a",
      keep: "stop",
      ...brief({ role: undefined }),
    });
    expect(res.ok).toBe(true);
    expect(r.calls.stopped).toEqual(["a"]);
  });

  it("動作中でないノード・部分木の外は、何もせずに失敗する", async () => {
    const r = rig();
    r.ev("a", { type: "reportDone" });
    expect(
      (await r.call("node.split", { nodeId: "a", keep: "mainline", ...brief({ role: undefined }) }))
        .ok,
    ).toBe(false);
    expect(
      (
        await r.call("node.split", {
          nodeId: "m2",
          keep: "mainline",
          ...brief({ role: undefined }),
        })
      ).error?.code,
    ).toBe("forbidden");
    expect(r.calls.provisioned).toEqual([]);
  });
});
