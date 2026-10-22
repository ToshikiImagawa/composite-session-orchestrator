import { type EventBody, foldEvents, type OrchEvent, type OrchState, ok } from "@cso/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../daemon/src/api/credentials.js";
import { type ApiServer, createApiServer } from "../../daemon/src/api/server.js";
import { createMcpHttpServer, type McpHttpServer, toolsFor } from "../src/index.js";

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

interface Rig {
  daemon: ApiServer;
  mcp: McpHttpServer;
  mcpUrl: string;
  tokens: { human: string; root: string; a: string };
  calls: { operation: string; params: unknown; role: string }[];
}
let rig: Rig | undefined;
afterEach(async () => {
  await rig?.mcp.close();
  await rig?.daemon.close();
  rig = undefined;
});

const start = async (
  over: {
    daemonUrl?: string;
    fetch?: typeof fetch;
    shutdownGraceMs?: number;
    bodyTimeoutMs?: number;
    relayTimeoutMs?: number;
  } = {},
): Promise<Rig> => {
  const credentials = createCredentialStore({ humanToken: HUMAN });
  const calls: Rig["calls"] = [];
  const daemon = createApiServer({
    credentials,
    getState: () => state(),
    handlers: {
      "report.progress": (req) => {
        calls.push({ operation: req.operation, params: req.params, role: req.role });
        return ok({ accepted: true });
      },
      "tree.list": (req) => {
        calls.push({ operation: req.operation, params: req.params, role: req.role });
        return ok({ table: "t" });
      },
    },
  });
  const d = await daemon.listen(0);
  const created = createMcpHttpServer({
    identity: { kind: "unverified" },
    daemonUrl: over.daemonUrl ?? d.url,
    ...(over.fetch ? { fetch: over.fetch } : {}),
    ...(over.shutdownGraceMs !== undefined ? { shutdownGraceMs: over.shutdownGraceMs } : {}),
    ...(over.bodyTimeoutMs !== undefined ? { bodyTimeoutMs: over.bodyTimeoutMs } : {}),
    ...(over.relayTimeoutMs !== undefined ? { relayTimeoutMs: over.relayTimeoutMs } : {}),
  });
  if (!created.ok) throw new Error(created.error.cause);
  const mcp = created.value;
  const m = await mcp.listen(0);
  rig = {
    daemon,
    mcp,
    mcpUrl: `${m.url}/mcp`,
    calls,
    tokens: {
      human: HUMAN,
      root: credentials.issueNodeToken("root", "integrator"),
      a: credentials.issueNodeToken("a", "child"),
    },
  };
  return rig;
};

const connect = async (r: Rig, token: string) => {
  const client = new Client({ name: "t", version: "0" });
  const transport = new StreamableHTTPClientTransport(new URL(r.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  await client.connect(transport as unknown as Transport);
  return client;
};

const raw = (r: Rig, init: RequestInit & { path?: string } = {}) =>
  fetch(`${r.mcpUrl.replace(/\/mcp$/, "")}${init.path ?? "/mcp"}`, {
    method: "POST",
    ...init,
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(init.headers as Record<string, string>),
    },
  });
const INIT = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "t", version: "0" },
  },
});

describe("実 HTTP の統合（MCP クライアント ↔ cso-mcp ↔ daemon の窓口）", () => {
  it("子のトークン: 子のツールだけを公開し、呼び出しを窓口へ中継する（ロールは窓口が認証から決める）", async () => {
    const r = await start();
    const c = await connect(r, r.tokens.a);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(
      toolsFor("child").map((t) => t.name),
    );
    const res = await c.callTool({ name: "report_progress", arguments: { text: "進捗" } });
    expect(res.isError).toBeFalsy();
    expect(r.calls).toEqual([
      { operation: "report.progress", params: { text: "進捗" }, role: "child" },
    ]);
    await c.close();
  });

  it("統合のトークン: 統合のツールを公開し、inbox 以外の読み取りも通る", async () => {
    const r = await start();
    const c = await connect(r, r.tokens.root);
    expect((await c.listTools()).tools.map((t) => t.name)).toEqual(
      toolsFor("integrator").map((t) => t.name),
    );
    const res = await c.callTool({ name: "tree_list", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(r.calls[0]?.role).toBe("integrator");
    await c.close();
  });

  it("子のトークンで、統合のツール（node_spawn）は呼べない。窓口へも届かない", async () => {
    const r = await start();
    const c = await connect(r, r.tokens.a);
    const res = await c.callTool({ name: "node_spawn", arguments: {} });
    expect(res.isError).toBe(true);
    expect(r.calls).toEqual([]);
    await c.close();
  });

  it("入力が不正なら、窓口へ届かずに invalid_argument", async () => {
    const r = await start();
    const c = await connect(r, r.tokens.a);
    const res = await c.callTool({ name: "report_progress", arguments: { text: 1 } });
    expect(res.isError).toBe(true);
    expect(r.calls).toEqual([]);
    await c.close();
  });

  it("人間のトークンには、ツールを公開しない（403）", async () => {
    const r = await start();
    const res = await raw(r, {
      body: INIT,
      headers: { authorization: `Bearer ${r.tokens.human}` },
    });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(r.tokens.human);
  });

  it.each([
    ["Authorization がない", {}],
    ["Bearer の形でない", { authorization: "Basic abc" }],
    ["無効なトークン", { authorization: "Bearer not-a-valid-token-0123456789" }],
  ])("%s なら 401", async (_name, headers) => {
    const r = await start();
    const res = await raw(r, { body: INIT, headers: headers as Record<string, string> });
    expect(res.status).toBe(401);
  });

  it("POST /mcp 以外は拒否する（GET・DELETE は 405、別のパスは 404）", async () => {
    const r = await start();
    const h = { authorization: `Bearer ${r.tokens.a}` };
    expect((await raw(r, { method: "GET", headers: h })).status).toBe(405);
    expect((await raw(r, { method: "DELETE", headers: h })).status).toBe(405);
    expect((await raw(r, { path: "/other", body: INIT, headers: h })).status).toBe(404);
  });

  it("Host・Origin がループバックでなければ拒否する（DNS リバインディング対策）", async () => {
    const r = await start();
    const h = { authorization: `Bearer ${r.tokens.a}` };
    const origin = await raw(r, { body: INIT, headers: { ...h, origin: "http://evil.example" } });
    expect(origin.status).toBe(403);
    const host = await new Promise<number>((resolve, reject) => {
      import("node:http").then(({ request }) => {
        const url = new URL(r.mcpUrl);
        const req = request(
          {
            host: "127.0.0.1",
            port: url.port,
            path: "/mcp",
            method: "POST",
            headers: { ...h, host: "evil.example", "content-type": "application/json" },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(INIT);
      });
    });
    expect(host).toBe(403);
  });

  it("Content-Type が JSON でなければ 415、本文が JSON でなければ 400、大きすぎれば 413", async () => {
    const r = await start();
    const h = { authorization: `Bearer ${r.tokens.a}` };
    expect(
      (await raw(r, { body: INIT, headers: { ...h, "content-type": "text/plain" } })).status,
    ).toBe(415);
    expect((await raw(r, { body: "{not json", headers: h })).status).toBe(400);
    const big = JSON.stringify({ x: "y".repeat(1024 * 1024 + 1) });
    expect((await raw(r, { body: big, headers: h })).status).toBe(413);
  });

  it("daemon に接続できなければ 502。トークンを含めない", async () => {
    const r = await start({ daemonUrl: "http://127.0.0.1:1" });
    const res = await raw(r, { body: INIT, headers: { authorization: `Bearer ${r.tokens.a}` } });
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(r.tokens.a);
  });
});

describe("createMcpHttpServer の設定の検査", () => {
  it("daemonUrl がループバックでなければ失敗にする", () => {
    const r = createMcpHttpServer({
      daemonUrl: "http://example.com",
      identity: { kind: "unverified" },
    });
    expect(r.ok).toBe(false);
  });
});

import { request as httpRequest } from "node:http";

const rawHttp = (
  url: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number; text: string }> =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest(
      { host: "127.0.0.1", port: u.port, path: "/mcp", method: "POST", headers },
      (res) => {
        let text = "";
        res.on("data", (c) => {
          text += c;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });

describe("停止（graceful shutdown）", () => {
  it("停止の要求のあとも、処理中の呼び出しは完了し、結果が返る", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = false;
    const slowFetch: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/v1/request")) {
        inFlight = true;
        await gate;
      }
      return fetch(input, init);
    };
    const r = await start({ fetch: slowFetch, shutdownGraceMs: 3000 });
    const c = await connect(r, r.tokens.a);
    const call = c.callTool({ name: "report_progress", arguments: { text: "t" } });
    while (!inFlight) await new Promise((res) => setTimeout(res, 5));
    const closing = r.mcp.close();
    // 停止の要求のあとで、処理中の呼び出しを進める
    await new Promise((res) => setTimeout(res, 50));
    release?.();
    const res = await call;
    expect(res.isError).toBeFalsy();
    await closing;
    expect(r.calls).toHaveLength(1);
  });

  it("猶予を超えた処理中の要求は、強制的に切って、close が終わる", async () => {
    const never: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/v1/request")) await new Promise(() => undefined);
      return fetch(input, init);
    };
    const r = await start({ fetch: never, shutdownGraceMs: 100 });
    const c = await connect(r, r.tokens.a);
    void c.callTool({ name: "report_progress", arguments: { text: "t" } }).catch(() => undefined);
    await new Promise((res) => setTimeout(res, 100));
    const t0 = Date.now();
    await r.mcp.close();
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("停止の後は、新しい接続を受け付けない", async () => {
    const r = await start();
    const url = r.mcpUrl;
    await r.mcp.close();
    await expect(fetch(url, { method: "POST", body: INIT })).rejects.toThrow();
  });
});

describe("遅い接続・並列の要求への対策", () => {
  it("本文の読み取りに全体の上限があり、遅い本文は 408 で切る", async () => {
    const r = await start({ bodyTimeoutMs: 150 });
    const u = new URL(r.mcpUrl);
    const status = await new Promise<number>((resolve) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: u.port,
          path: "/mcp",
          method: "POST",
          headers: {
            authorization: `Bearer ${r.tokens.a}`,
            "content-type": "application/json",
            "content-length": "1000",
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", () => resolve(0));
      req.write('{"jsonrpc"');
      // 続きを送らない
    });
    expect([408, 0]).toContain(status);
  });

  it("並列の要求が、それぞれ正しく処理される", async () => {
    const r = await start();
    const clients = await Promise.all([1, 2, 3, 4, 5].map(() => connect(r, r.tokens.a)));
    const results = await Promise.all(
      clients.map((c, i) => c.callTool({ name: "report_progress", arguments: { text: `p${i}` } })),
    );
    expect(results.every((x) => !x.isError)).toBe(true);
    expect(r.calls).toHaveLength(5);
    await Promise.all(clients.map((c) => c.close()));
  });

  it("接続の上限・タイムアウトを明示している", async () => {
    const r = await start();
    const info = r.mcp.limits();
    expect(info.maxConnections).toBe(64);
    expect(info.requestTimeoutMs).toBe(30_000);
    expect(info.headersTimeoutMs).toBe(10_000);
    expect(info.keepAliveTimeoutMs).toBe(5_000);
  });
});

describe("検査の順序（トークンの確認が本文より先）", () => {
  it("無効なトークンは、Content-Type・本文の検査より先に 401 になる", async () => {
    const r = await start();
    const res = await raw(r, {
      body: "x",
      headers: {
        authorization: "Bearer not-a-valid-token-0123456789",
        "content-type": "text/plain",
      },
    });
    expect(res.status).toBe(401);
  });

  it("有効なトークンで Content-Type が違えば 415（トークンの確認のあと）", async () => {
    const r = await start();
    const res = await raw(r, {
      body: "x",
      headers: { authorization: `Bearer ${r.tokens.a}`, "content-type": "text/plain" },
    });
    expect(res.status).toBe(415);
  });
});

describe("Host・Origin のポートの照合", () => {
  it("listen したポートと違う Host・Origin は拒否する。同じポートは許可する", async () => {
    const r = await start();
    const port = new URL(r.mcpUrl).port;
    const h = { authorization: `Bearer ${r.tokens.a}`, "content-type": "application/json" };
    const wrongHost = await rawHttp(r.mcpUrl, { ...h, host: "127.0.0.1:9" }, INIT);
    expect(wrongHost.status).toBe(403);
    const noPortHost = await rawHttp(r.mcpUrl, { ...h, host: "127.0.0.1" }, INIT);
    expect(noPortHost.status).toBe(403);
    const rightHost = await rawHttp(
      r.mcpUrl,
      { ...h, host: `localhost:${port}`, accept: "application/json, text/event-stream" },
      INIT,
    );
    expect(rightHost.status).toBe(200);
    const wrongOrigin = await rawHttp(r.mcpUrl, { ...h, origin: "http://127.0.0.1:9" }, INIT);
    expect(wrongOrigin.status).toBe(403);
    const rightOrigin = await rawHttp(
      r.mcpUrl,
      { ...h, origin: `http://127.0.0.1:${port}`, accept: "application/json, text/event-stream" },
      INIT,
    );
    expect(rightOrigin.status).toBe(200);
  });
});

describe("Bearer の形と daemon の失敗の状態", () => {
  it("Bearer の形は daemon と同じ規則（スキームは大文字小文字を区別。トークンは 16〜512 文字の許可された文字）", async () => {
    const r = await start();
    const send = (authorization: string) => raw(r, { body: INIT, headers: { authorization } });
    expect((await send(`bearer ${r.tokens.a}`)).status).toBe(401);
    expect((await send(`BEARER ${r.tokens.a}`)).status).toBe(401);
    expect((await send("Bearer short")).status).toBe(401);
    expect((await send(`Bearer ${"a".repeat(513)}`)).status).toBe(401);
    expect((await send(`Bearer ${r.tokens.a} extra`)).status).toBe(401);
  });

  it("daemon の応答が遅れたときは 504", async () => {
    const hang = ((_input: unknown, init: RequestInit) =>
      new Promise((_res, rej) => {
        init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
      })) as unknown as typeof fetch;
    const r = await start({ fetch: hang, relayTimeoutMs: 50 });
    const res = await raw(r, { body: INIT, headers: { authorization: `Bearer ${r.tokens.a}` } });
    expect(res.status).toBe(504);
  });
});

describe("daemon の 429（回数の制限）", () => {
  const limited = (retryAfter: string): typeof fetch =>
    (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: "tooManyRequests", cause: "x", nextActions: ["待つ"] },
        }),
        { status: 429, headers: { "retry-after": retryAfter, "content-type": "application/json" } },
      )) as unknown as typeof fetch;

  it("whoami が（再送のあとも）429 なら、502 にせず 429 と Retry-After を返す。本文は code・cause・nextActions だけ", async () => {
    const r = await start({ fetch: limited("1") });
    const res = await raw(r, { body: INIT, headers: { authorization: `Bearer ${r.tokens.a}` } });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
    const text = await res.text();
    expect(text).not.toContain(r.tokens.a);
    const body = JSON.parse(text) as { error: Record<string, unknown> };
    expect(Object.keys(body.error).sort()).toEqual(["cause", "code", "nextActions"]);
  }, 15_000);

  it("Retry-After が不正・なしでも 429（待ち時間は 1 秒を伝える）", async () => {
    const r = await start({ fetch: limited("abc") });
    const res = await raw(r, { body: INIT, headers: { authorization: `Bearer ${r.tokens.a}` } });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1");
  }, 15_000);
});

describe("同時数による 429（daemon の窓口の maxInFlightPerPrincipal）", () => {
  it("上限を超えた分は 429 になり、relay が待って同じ要求を 1 回だけ再送する。実行は二重にならない", async () => {
    const credentials = createCredentialStore({ humanToken: HUMAN });
    const executed: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const daemon = createApiServer({
      credentials,
      getState: () => state(),
      rateLimit: { maxInFlightPerPrincipal: 2 },
      handlers: {
        "report.progress": async (req) => {
          executed.push((req.params as { text: string }).text);
          await gate;
          return ok({ accepted: true });
        },
      },
    });
    const d = await daemon.listen(0);
    const created = createMcpHttpServer({ daemonUrl: d.url, identity: { kind: "unverified" } });
    if (!created.ok) throw new Error(created.error.cause);
    const mcp = created.value;
    const m = await mcp.listen(0);
    const token = credentials.issueNodeToken("a", "child");
    const connectTo = async () => {
      const client = new Client({ name: "t", version: "0" });
      const transport = new StreamableHTTPClientTransport(new URL(`${m.url}/mcp`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      });
      await client.connect(transport as unknown as Transport);
      return client;
    };
    try {
      const clients = await Promise.all([1, 2, 3].map(connectTo));
      // 3 つ同時に呼ぶ。2 つが処理中のあいだ、3 つめは 429 になる（実行されない）。
      const calls = clients.map((c, i) =>
        c.callTool({ name: "report_progress", arguments: { text: `p${i}` } }),
      );
      await new Promise((r) => setTimeout(r, 300));
      expect(executed.length).toBe(2); // 3 つめは、まだ実行されていない（429 で待っている）
      release?.();
      const results = await Promise.all(calls);
      expect(results.every((r) => !r.isError)).toBe(true);
      // 3 つとも成功し、どれも二重には実行されていない
      expect([...executed].sort()).toEqual(["p0", "p1", "p2"]);
      await Promise.all(clients.map((c) => c.close()));
    } finally {
      await mcp.close();
      await daemon.close();
    }
  }, 20_000);
});
