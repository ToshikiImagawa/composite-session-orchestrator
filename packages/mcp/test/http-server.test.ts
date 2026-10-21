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

const start = async (over: { daemonUrl?: string } = {}): Promise<Rig> => {
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
  const created = createMcpHttpServer({ daemonUrl: over.daemonUrl ?? d.url });
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
    const r = createMcpHttpServer({ daemonUrl: "http://example.com" });
    expect(r.ok).toBe(false);
  });
});
