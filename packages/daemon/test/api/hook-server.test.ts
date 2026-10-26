import { request as httpRequest } from "node:http";
import { type EventBody, foldEvents, type OrchEvent, type OrchState } from "@cso/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { createHookTokens, createSessionBinder, type HookDecider } from "../../src/api/hook.js";
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

const start = async (
  decide: HookDecider,
  over: {
    maxBodyBytes?: number;
    rateLimit?: { perPrincipal: { burst: number; perSecond: number }; monotonicMs: () => number };
  } = {},
) => {
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

  it("重みは 0.5: 容量 10 の bucket で、フック 10 回（5 トークン）のあとも whoami（1）が通り、残り 4 トークンでフックが 8 回通って、次で 429", async () => {
    const r = await start(policy, {
      rateLimit: { perPrincipal: { burst: 10, perSecond: 1 }, monotonicMs: () => 0 },
    });
    for (let i = 0; i < 10; i++)
      expect((await post(r.url, r.child, pre("Read", {}))).status).toBe(200);
    // 重み 1 なら、ここで bucket が尽きている。0.5 なので、whoami（重み 1）も通る
    const who = await fetch(`${r.url}/v1/whoami`, {
      headers: { authorization: `Bearer ${r.child}` },
    });
    expect(who.status).toBe(200);
    for (let i = 0; i < 8; i++)
      expect((await post(r.url, r.child, pre("Read", {}))).status).toBe(200);
    expect((await post(r.url, r.child, pre("Read", {}))).status).toBe(429);
  });

  it("トークンを発行し直すと、結び付けが外れる。古いトークンのセッションは、その間も後も結び直せない（T22-hu）", async () => {
    const sessions = createSessionBinder();
    const credentials = createCredentialStore({
      humanToken: HUMAN,
      onNodeTokenChanged: (nodeId) => void sessions.unbind(nodeId),
    });
    const s = state();
    server = createApiServer({
      credentials,
      getState: () => s,
      handlers: {},
      hook: policy,
      hookSessions: sessions,
    });
    const { url } = await server.listen(0);
    const old = credentials.issueNodeToken("a", "child");
    expect((await post(url, old, pre("Read", {}, "s-old"))).status).toBe(200);
    expect((await post(url, old, pre("Read", {}, "s-new"))).status).toBe(403);
    const fresh = credentials.issueNodeToken("a", "child");
    // 古いトークンは、発行し直した時点で無効（結び付けを外したあとに、古いトークンで結ぶことはできない）
    expect((await post(url, old, pre("Read", {}, "s-old"))).status).toBe(401);
    expect((await post(url, fresh, pre("Read", {}, "s-new"))).status).toBe(200);
    expect((await post(url, fresh, pre("Read", {}, "s-old"))).status).toBe(403);
  });

  it("本文を読んでいるあいだにトークンを発行し直すと、古い要求は 401 になり、結び付けも起きない（T22-hu の R1）", async () => {
    const sessions = createSessionBinder();
    const credentials = createCredentialStore({
      humanToken: HUMAN,
      onNodeTokenChanged: (nodeId) => void sessions.unbind(nodeId),
    });
    const s = state();
    server = createApiServer({
      credentials,
      getState: () => s,
      handlers: {},
      hook: policy,
      hookSessions: sessions,
    });
    const { port } = await server.listen(0);
    const old = credentials.issueNodeToken("a", "child");
    const body = JSON.stringify(pre("Read", {}, "s-old"));
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port,
          path: "/v1/hook",
          method: "POST",
          headers: {
            host: `127.0.0.1:${port}`,
            "content-type": "application/json",
            "content-length": Buffer.byteLength(body),
            authorization: `Bearer ${old}`,
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      // 本文の前半だけ送り、認証を済ませたところで、トークンを発行し直してから、残りを送る
      req.write(body.slice(0, 10));
      setTimeout(() => {
        credentials.issueNodeToken("a", "child");
        req.end(body.slice(10));
      }, 100);
    });
    expect(status).toBe(401);
    expect(sessions.has("a")).toBe(false);
  });
});

describe("受け口の要求数（apiSummary の hook。T24-hc）", () => {
  it("received（認証の前）・allowed・denied を数え、まとめに件数だけ出す（nodeId・session_id・ツール名・内容は出さない）", async () => {
    const r = await start(policy);
    await post(r.url, r.child, pre("Read", { file_path: "a" }, "sess-secret-1"));
    await post(r.url, r.child, pre("Write", { file_path: "secret-path" }, "sess-secret-1"));
    await post(r.url, r.child, { hook_event_name: "Stop", session_id: "sess-secret-1", cwd: "/x" });
    await post(r.url, "wrong-token-wrong-token-wrong-token-1", pre("Read", {}));
    await server?.close(); // 停止のときに、溜まった件数を 1 行にまとめる
    server = undefined;
    const summary = r.logs.find((e) => e.event === "apiSummary") as
      | { hook?: Record<string, number>; authFailed: Record<string, number> }
      | undefined;
    expect(summary?.hook).toEqual({ received: 4, allowed: 2, denied: 1 });
    expect(summary?.authFailed).toEqual({ invalid: 1 });
    // 窓の最初の 1 件の記録は、hook では出さない
    expect(r.logs.filter((e) => e.event !== "apiSummary" && e.event !== "apiAuthFailed")).toEqual(
      [],
    );
    const text = JSON.stringify(r.logs);
    for (const secret of ["sess-secret-1", "secret-path", "Write", "Read", '"a"']) {
      expect(text.includes(secret), secret).toBe(false);
    }
  });

  it("メソッドの検査（405）は数えない。認証に失敗した要求は received に入る", async () => {
    const r = await start(policy);
    await post(r.url, "wrong-token-wrong-token-wrong-token-1", {});
    const s2 = await fetch(`${r.url}/v1/hook`, { method: "GET" });
    expect(s2.status).toBe(405);
    await server?.close();
    server = undefined;
    // 405（メソッドの検査）は数えない。数えるのは、認証に失敗した 1 件だけ
    const summary = r.logs.find((e) => e.event === "apiSummary") as {
      hook?: Record<string, number>;
    };
    expect(summary.hook).toEqual({ received: 1 });
  });
});

describe("拒否の経路ごとの要求数（T24-hc）: received が 1 増え、allowed・denied は増えない", () => {
  const raw = (url: string, token: string, body: string, type = "application/json") =>
    fetch(`${url}/v1/hook`, {
      method: "POST",
      headers: { "content-type": type, authorization: `Bearer ${token}` },
      body,
    }).then((x) => x.status);
  type Rig = Awaited<ReturnType<typeof start>>;
  const cases: {
    name: string;
    over?: Parameters<typeof start>[1];
    /** 前置きの要求（すべて許可される。received・allowed に入る）と、その数。 */
    setup?: (r: Rig) => Promise<void>;
    setupCount?: number;
    act: (r: Rig) => Promise<number>;
    status: number;
  }[] = [
    {
      name: "人間のトークン",
      act: (r) => post(r.url, HUMAN, pre("Read", {})).then((x) => x.status),
      status: 403,
    },
    {
      name: "session_id の不一致",
      setup: async (r) => void (await post(r.url, r.child, pre("Read", {}, "s-1"))),
      setupCount: 1,
      act: (r) => post(r.url, r.child, pre("Read", {}, "s-2")).then((x) => x.status),
      status: 403,
    },
    {
      name: "本文が 1 MiB を超える",
      act: (r) =>
        post(r.url, r.child, pre("Write", { content: "x".repeat(1024 * 1024 + 1) })).then(
          (x) => x.status,
          () => 413, // 本文を読まずに閉じると、送り手には接続のエラーに見えることがある（どちらでも受け口は拒否）
        ),
      status: 413,
    },
    {
      name: "text/plain",
      act: (r) => raw(r.url, r.child, JSON.stringify(pre("Read", {})), "text/plain"),
      status: 415,
    },
    { name: "壊れた JSON", act: (r) => raw(r.url, r.child, "{"), status: 400 },
    {
      name: "回数の制限（429）",
      over: { rateLimit: { perPrincipal: { burst: 1, perSecond: 0.001 }, monotonicMs: () => 0 } },
      setup: async (r) => {
        // 重み 0.5 なので、容量 1 で 2 回通る
        await post(r.url, r.child, pre("Read", {}));
        await post(r.url, r.child, pre("Read", {}));
      },
      setupCount: 2,
      act: (r) => post(r.url, r.child, pre("Read", {})).then((x) => x.status),
      status: 429,
    },
  ];
  it.each(cases)("$name", async (c) => {
    const r = await start(policy, c.over ?? {});
    await c.setup?.(r);
    const n = c.setupCount ?? 0;
    expect(await c.act(r)).toBe(c.status);
    await server?.close();
    server = undefined;
    const summary = r.logs.find((e) => e.event === "apiSummary") as {
      hook?: Record<string, number>;
    };
    expect(summary.hook?.received ?? 0).toBe(n + 1);
    expect(summary.hook?.allowed ?? 0).toBe(n);
    expect(summary.hook?.denied ?? 0).toBe(0);
  });

  it("フック専用のトークン（T22-ht）は /v1/hook だけで通り、/v1/request・/v1/whoami では 401。ノードのトークン（SDK の子）は無効にならない", async () => {
    const credentials = createCredentialStore({ humanToken: HUMAN });
    const hookTokens = createHookTokens();
    const st = state();
    const calls2: unknown[][] = [];
    server = createApiServer({
      credentials,
      getState: () => st,
      handlers: { "tree.list": () => ({ ok: true, value: { table: "t" } }) } as never,
      hook: async (nodeId, toolName) => {
        calls2.push([nodeId, toolName]);
        return { allow: true };
      },
      hookTokens,
    });
    const { url } = await server.listen(0);
    const nodeToken = credentials.issueNodeToken("a", "child");
    const hookToken = hookTokens.issue("a");
    const ok = await post(url, hookToken, pre("Read", {}, "s-manual"));
    expect(ok.status).toBe(200);
    expect(calls2).toEqual([["a", "Read"]]); // ノードはトークンから決まる
    const req = await fetch(`${url}/v1/request`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${hookToken}` },
      body: JSON.stringify({ requestId: "q", operation: "tree.list", params: {} }),
    });
    expect(req.status).toBe(401);
    const who = await fetch(`${url}/v1/whoami`, {
      headers: { authorization: `Bearer ${hookToken}` },
    });
    expect(who.status).toBe(401);
    // ノードのトークンは、そのまま使える
    const who2 = await fetch(`${url}/v1/whoami`, {
      headers: { authorization: `Bearer ${nodeToken}` },
    });
    expect(who2.status).toBe(200);
    expect(credentials.authenticate(nodeToken)).toEqual({ role: "child", nodeId: "a" });
    // 発行し直すと、古いフック用トークンは 401
    hookTokens.issue("a");
    expect((await post(url, hookToken, pre("Read", {}, "s-manual"))).status).toBe(401);
  });
});
