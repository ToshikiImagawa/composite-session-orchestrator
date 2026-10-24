import { type EventBody, foldEvents, type OrchEvent, type OrchState } from "@cso/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import type { HookDecider } from "../../src/api/hook.js";
import { type ApiLogEvent, type ApiServer, createApiServer } from "../../src/api/server.js";

let n = 0;
const ev = (body: EventBody): OrchEvent =>
  ({
    seq: ++n,
    at: "2026-10-20T00:00:00Z",
    requestId: `r${n}`,
    actor: { system: true },
    ...body,
  }) as OrchEvent;
const state = (): OrchState => {
  const r = foldEvents([
    ev({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    }),
    ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
    ev({
      type: "node.created",
      payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
    }),
  ]);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};
const HUMAN = "human-token-human-token-human-token-1234";

let server: ApiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const start = async (decide: HookDecider, over: { maxBodyBytes?: number } = {}) => {
  const credentials = createCredentialStore({ humanToken: HUMAN });
  const logs: ApiLogEvent[] = [];
  const s = state();
  server = createApiServer({
    credentials,
    getState: () => s,
    handlers: {},
    hook: decide,
    logger: (e) => void logs.push(e),
    ...over,
  });
  const { url } = await server.listen(0);
  return {
    url,
    logs,
    child: credentials.issueNodeToken("a", "child"),
    root: credentials.issueNodeToken("root", "integrator"),
  };
};

const post = async (url: string, token: string | undefined, body: unknown) => {
  const res = await fetch(`${url}/v1/hook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
};

const pre = (tool: string, input: unknown, session = "s-1") => ({
  hook_event_name: "PreToolUse",
  session_id: session,
  cwd: "/somewhere/else",
  tool_name: tool,
  tool_input: input,
});

const calls: unknown[][] = [];
const policy: HookDecider = async (nodeId, toolName, toolInput) => {
  calls.push([nodeId, toolName, toolInput]);
  return toolName === "Write" ? { allow: false, reason: "範囲外" } : { allow: true };
};

describe("POST /v1/hook（ファイルで設定するフック。T22-h）", () => {
  it("子のトークンの PreToolUse を判定に流し、許可・拒否を返す。nodeId はトークンから決める（入力の cwd は渡さない）", async () => {
    calls.length = 0;
    const r = await start(policy);
    const ok = await post(r.url, r.child, pre("Read", { file_path: "a" }));
    expect(ok).toEqual({ status: 200, json: { ok: true, value: { decision: "allow" } } });
    const ng = await post(r.url, r.child, pre("Write", { file_path: "x" }));
    expect(ng.json).toEqual({ ok: true, value: { decision: "deny", reason: "範囲外" } });
    expect(calls).toEqual([
      ["a", "Read", { file_path: "a" }],
      ["a", "Write", { file_path: "x" }],
    ]);
  });

  it("PostToolUse・Stop は判定せず allow を返す", async () => {
    calls.length = 0;
    const r = await start(policy);
    const post1 = await post(r.url, r.child, {
      ...pre("Write", {}),
      hook_event_name: "PostToolUse",
    });
    const stop = await post(r.url, r.child, { hook_event_name: "Stop", session_id: "s-1" });
    expect(post1.json).toEqual({ ok: true, value: { decision: "allow" } });
    expect(stop.json).toEqual({ ok: true, value: { decision: "allow" } });
    expect(calls).toEqual([]);
  });

  it("トークンがない・未知なら 401。統合ノードのトークンは 403（範囲を持たない）", async () => {
    const r = await start(policy);
    expect((await post(r.url, undefined, pre("Read", {}))).status).toBe(401);
    expect((await post(r.url, "x".repeat(40), pre("Read", {}))).status).toBe(401);
    expect((await post(r.url, r.root, pre("Read", {}))).status).toBe(403);
    expect((await post(r.url, HUMAN, pre("Read", {}))).status).toBe(403);
  });

  it("最初の session_id にノードを結び、別の session_id は 403 で拒否して記録する（ID は記録に出さない）", async () => {
    const r = await start(policy);
    expect((await post(r.url, r.child, pre("Read", {}, "s-1"))).status).toBe(200);
    const other = await post(r.url, r.child, pre("Read", {}, "s-2"));
    expect(other.status).toBe(403);
    expect(r.logs.map((l) => l.event)).toContain("hookSessionMismatch");
    expect(JSON.stringify(r.logs)).not.toContain("s-2");
    expect((await post(r.url, r.child, pre("Read", {}, "s-1"))).status).toBe(200);
  });

  it("入力の形が違えば 400、本文が上限を超えたら 413（理由つき）", async () => {
    const r = await start(policy, { maxBodyBytes: 200 });
    expect((await post(r.url, r.child, { session_id: "s-1" })).status).toBe(400);
    expect((await post(r.url, r.child, "{")).status).toBe(400);
    const big = await post(r.url, r.child, pre("Write", { content: "x".repeat(500) }));
    expect(big.status).toBe(413);
    expect(JSON.stringify(big.json)).toContain("本文が大きすぎる");
  });

  it("判定が例外を投げたら、拒否を返す（フェイルクローズ）", async () => {
    const r = await start(async () => {
      throw new Error("boom");
    });
    const res = await post(r.url, r.child, pre("Read", {}));
    expect(res.json).toMatchObject({ ok: true, value: { decision: "deny" } });
  });

  it("GET は 405", async () => {
    const r = await start(policy);
    const res = await fetch(`${r.url}/v1/hook`);
    expect(res.status).toBe(405);
  });
});
