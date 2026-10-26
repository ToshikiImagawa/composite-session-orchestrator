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
import { type CredentialStore, createCredentialStore } from "../../../src/api/credentials.js";
import { createPauseHandlers } from "../../../src/api/handlers/pause-handlers.js";
import { createRuntimeHandlers } from "../../../src/api/handlers/runtime-handlers.js";
import { createStateHandlers } from "../../../src/api/handlers/state-handlers.js";
import { createHookTokens } from "../../../src/api/hook.js";
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
const rig = (
  opts: { credentials?: Pick<CredentialStore, "issueNodeToken" | "revokeNode"> } = {},
) => {
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
  const flags = { startFails: false, revokeThrows: false, authMissing: false };
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
      if (flags.authMissing)
        return {
          ok: false,
          error: failure(
            "childAuthMissing",
            "子に渡す環境変数に認証がない",
            "claude setup-token",
            "inherit",
          ),
        };
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
    credentials: opts.credentials ?? {
      issueNodeToken: (id) => {
        calls.issued.push(id);
        return `tok-${id}`;
      },
      revokeNode: (id) => {
        calls.revoked.push(id);
        if (flags.revokeThrows) throw new Error("失効できない");
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
    expect((await r.present({ ...Q, pauseNodeIds: ["p"] })).error?.code).toBe("notActive"); // 依存待ち（pending）
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

  it("子の認証がない（childAuthMissing）なら、原因を返し、親の受信箱に failure を 1 件だけ出す（再試行で増えない）", async () => {
    const r = rig();
    const id = await paused(r);
    r.flags.authMissing = true;
    const res = await r.answer(id, "A", "ans-1");
    expect(res.error?.code).toBe("resumePending");
    expect(res.error?.cause).toContain("認証がない");
    expect(stateOf(r.s(), "a")).toBe("stopped");
    const items = () =>
      r
        .s()
        .inbox.filter(
          (i) =>
            i.kind === "failure" && i.nodeId === "a" && i.summary?.includes("childAuthMissing"),
        );
    expect(items()).toHaveLength(1);
    expect(items()[0]?.summary).toContain("claude setup-token");
    await r.answer(id, "A", "ans-2");
    await r.answer(id, "A", "ans-3");
    expect(items()).toHaveLength(1);
  });

  it("人間などが止めた子は、回答が来ても再開しない（受信箱に載せる）。判断による停止だけの子は再開する", async () => {
    const r = rig();
    const res = await r.present({ ...Q, pauseNodeIds: ["a", "b"] });
    const id = res.value?.decisionId as string;
    await r.flush();
    r.ev("a", { type: "confirmStopped" });
    // b は、停止の途中で応答がなく、人間が止め直した（retryStop）
    r.ev("b", { type: "stopTimeout" });
    r.ev("b", { type: "retryStop" });
    r.ev("b", { type: "confirmStopped" });
    const ans = await r.answer(id, "A");
    expect(ans.ok).toBe(true);
    expect(stateOf(r.s(), "a")).toBe("running");
    expect(stateOf(r.s(), "b")).toBe("stopped");
    expect(r.calls.started.map((x) => x.nodeId)).toEqual(["a"]);
    expect(r.s().inbox.at(-1)?.summary).toContain("b");
  });

  it("人間が破棄を判断した（node.discardDecided）停止中の子は、回答が来ても再開しない", async () => {
    const r = rig();
    const id = await paused(r);
    r.log.append({
      requestId: "disc-1",
      actor: { human: true },
      body: { type: "node.discardDecided", payload: { nodeId: "a" } },
    });
    const res = await r.answer(id, "A");
    expect(res.ok).toBe(true);
    expect(stateOf(r.s(), "a")).toBe("stopped");
    expect(r.calls.started).toEqual([]);
  });

  it("同時に同じ回答が 2 件来ても、再開の起動は 1 回", async () => {
    const r = rig();
    const id = await paused(r);
    const [x, y] = await Promise.all([r.answer(id, "B", "c-1"), r.answer(id, "B", "c-2")]);
    expect(x.ok && y.ok).toBe(true);
    expect(r.calls.started).toHaveLength(1);
    expect(r.calls.issued).toEqual(["a"]);
  });

  it("再開の指示に、ブリーフ（目的・受け入れ基準・範囲）と回答を含める", async () => {
    const r = rig();
    const id = await paused(r);
    await r.answer(id, "B");
    const text = r.calls.started[0]?.instruction ?? "";
    for (const part of ["B", "o", "c", "src", "pnpm test"]) expect(text).toContain(part);
  });

  it("再開の指示の先頭に、自分のノード ID・role・親を書く（T10m-id）", async () => {
    const r = rig();
    const id = await paused(r);
    await r.answer(id, "B");
    const first = (r.calls.started[0]?.instruction ?? "").split("\n")[0];
    expect(first).toBe("あなたのノード ID: a（role: implement、親: m1）");
  });

  it("失効に失敗したら、応答に警告を含める", async () => {
    const r = rig();
    const id = await paused(r);
    r.flags.startFails = true;
    r.flags.revokeThrows = true;
    const res = await r.answer(id, "A");
    expect(res.error?.cause).toContain("失効できなかった");
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

describe("判断の回答と、フック専用のトークン（T22-ht・H6）", () => {
  // compose と同じ配線: ノードのトークンが変わったら、フック専用のトークンも無効にする
  const wired = () => {
    const hookTokens = createHookTokens();
    const credentials = createCredentialStore({
      humanToken: "h".repeat(40),
      onNodeTokenChanged: (id) => hookTokens.revoke(id),
    });
    credentials.issueNodeToken("a", "child");
    return { hookTokens, credentials };
  };

  it("判断要求で子を止め（pauseNodeIds）、回答で再開すると、回答の前のフック専用のトークンは無効になる", async () => {
    const w = wired();
    const r = rig({ credentials: w.credentials });
    const hook = w.hookTokens.issue("a");
    const p = await r.present({ ...Q, pauseNodeIds: ["a"] });
    await r.flush();
    r.ev("a", { type: "confirmStopped" });
    expect((await r.answer(p.value?.decisionId as string, "B")).ok).toBe(true);
    expect(stateOf(r.s(), "a")).toBe("running");
    expect(w.hookTokens.authenticate(hook)).toBeUndefined();
  });

  it("子を止めない判断に回答しても、子のトークンは変わらず、フック専用のトークンは使えるまま", async () => {
    const w = wired();
    const r = rig({ credentials: w.credentials });
    const hook = w.hookTokens.issue("a");
    const p = await r.present({ ...Q });
    expect((await r.answer(p.value?.decisionId as string, "B")).ok).toBe(true);
    expect(w.hookTokens.authenticate(hook)).toBe("a");
  });
});
