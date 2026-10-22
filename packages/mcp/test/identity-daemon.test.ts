/**
 * 身元確認（T10m-i2）と、本物の daemon の窓口（`createApiServer` の `GET /v1/identity`）の統合。
 * 偽の窓口（別のプロセスがポートを奪った・本物の identity を中継した）には、トークンを一切送らないことを確かめる。
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foldEvents, type OrchEvent, type OrchState } from "@cso/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../daemon/src/api/credentials.js";
import { type ApiServer, createApiServer } from "../../daemon/src/api/server.js";
import { createMcpHttpServer, type McpHttpServer } from "../src/http-server.js";
import { createIdentityVerifier } from "../src/identity.js";
import { createRelay } from "../src/relay.js";

const DAEMON_ID = "00112233445566778899aabbccddeeff";
const SECRET = "ab".repeat(32);

const state = (): OrchState => {
  let n = 0;
  const ev = (body: object): OrchEvent =>
    ({
      seq: ++n,
      at: "2026-10-20T00:00:00Z",
      requestId: `r${n}`,
      actor: { system: true },
      ...body,
    }) as OrchEvent;
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

let dir: string;
let daemon: ApiServer | undefined;
const extra: Server[] = [];
let mcp: McpHttpServer | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cso-mcp-identity-"));
});
afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
  await daemon?.close();
  daemon = undefined;
  for (const s of extra.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  rmSync(dir, { recursive: true, force: true });
});

const identityFile = (secret = SECRET, daemonId = DAEMON_ID): string => {
  const p = join(dir, "daemon-identity");
  writeFileSync(p, `${JSON.stringify({ version: 1, daemonId, secret })}\n`, { mode: 0o600 });
  return p;
};
const startDaemon = async (port = 0) => {
  const credentials = createCredentialStore({
    humanToken: "human-token-human-token-human-token-1234",
  });
  daemon = createApiServer({
    credentials,
    getState: () => state(),
    handlers: {},
    identity: () => ({ daemonId: DAEMON_ID, secret: SECRET }),
  });
  const { url } = await daemon.listen(port);
  return { url, token: credentials.issueNodeToken("a", "child") };
};

/** 窓口を奪った偽のプロセス。受け取った要求（パスと Authorization の有無）を記録する。 */
const startAttacker = async (
  port: number,
  mode: "relay" | "forged" | "silent",
  genuineUrl?: string,
) => {
  const seen: { path: string; authorization: string | undefined }[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const path = req.url ?? "";
    seen.push({ path, authorization: req.headers.authorization });
    if (path.startsWith("/v1/identity") && mode === "relay" && genuineUrl !== undefined) {
      // 本物の daemon の identity を、そのまま中継する。
      fetch(`${genuineUrl}${path}`)
        .then(async (r) => {
          res.writeHead(r.status, { "content-type": "application/json" });
          res.end(await r.text());
        })
        .catch(() => res.destroy());
      return;
    }
    if (path.startsWith("/v1/identity") && mode === "forged") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, value: { daemonId: DAEMON_ID, proof: "0".repeat(64) } }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, value: { role: "child" } }));
  });
  extra.push(server);
  await new Promise<void>((r) => server.listen(port, "127.0.0.1", () => r()));
  const actual = (server.address() as { port: number }).port;
  return { seen, url: `http://127.0.0.1:${actual}`, port: actual };
};

const relayFor = (url: string, token: string, path: string) => {
  const r = createRelay({
    daemonUrl: url,
    token,
    verifier: createIdentityVerifier({ daemonUrl: url, identityPath: path }),
  });
  if (!r.ok) throw new Error(r.error.cause);
  return r.value;
};

describe("本物の daemon（createApiServer）", () => {
  it("本物なら、検証に成功して、トークンつきの whoami・request が通る", async () => {
    const { url, token } = await startDaemon();
    const relay = relayFor(url, token, identityFile());
    const who = await relay.whoami();
    expect(who.ok && who.value.role).toBe("child");
    const list = await relay.request("tree.list", {});
    expect(list.ok || list.error.code).not.toBe("daemon_identity_failed");
  });

  it("秘密が違う（古いファイル・別の daemon のファイル）と、daemon_identity_failed", async () => {
    const { url, token } = await startDaemon();
    const relay = relayFor(url, token, identityFile("cd".repeat(32)));
    const who = await relay.whoami();
    expect(!who.ok && who.error.code).toBe("daemon_identity_failed");
  });
});

describe("偽の窓口には、トークンを送らない", () => {
  it("本物の identity を、別のポートから中継する偽の daemon: proof が一致せず、トークンは届かない", async () => {
    const real = await startDaemon();
    const fake = await startAttacker(0, "relay", real.url);
    const relay = relayFor(fake.url, real.token, identityFile());
    const who = await relay.whoami();
    expect(!who.ok && who.error.code).toBe("daemon_identity_failed");
    const req = await relay.request("tree.list", {});
    expect(!req.ok && req.error.code).toBe("daemon_identity_failed");
    expect(fake.seen.length).toBeGreaterThan(0);
    expect(fake.seen.every((s) => s.path.startsWith("/v1/identity"))).toBe(true);
    expect(fake.seen.every((s) => s.authorization === undefined)).toBe(true);
  });

  it("secret を知らない偽の daemon（proof を偽造）: トークンは届かない", async () => {
    const real = await startDaemon();
    const fake = await startAttacker(0, "forged");
    const relay = relayFor(fake.url, real.token, identityFile());
    const who = await relay.whoami();
    expect(!who.ok && who.error.code).toBe("daemon_identity_failed");
    expect(fake.seen.every((s) => s.authorization === undefined)).toBe(true);
  });

  it("検証のあとでポートが奪われても、次の要求の直前に検証し直すので、トークンは届かない（キャッシュしない）", async () => {
    const real = await startDaemon();
    const file = identityFile();
    const relay = relayFor(real.url, real.token, file);
    expect((await relay.whoami()).ok).toBe(true);
    const port = Number(new URL(real.url).port);
    await daemon?.close();
    daemon = undefined;
    const fake = await startAttacker(port, "forged");
    // 最初の 1 回は、古い接続（keep-alive）の切断で、接続の失敗になることがある。どちらでも、トークンは送らない。
    const first = await relay.request("tree.list", {});
    expect(first.ok).toBe(false);
    const after = await relay.request("tree.list", {});
    expect(!after.ok && after.error.code).toBe("daemon_identity_failed");
    expect(fake.seen.length).toBeGreaterThan(0);
    expect(fake.seen.every((s) => s.authorization === undefined)).toBe(true);
  });
});

describe("cso-mcp（http-server）と身元確認", () => {
  const callTools = (url: string, token: string) =>
    fetch(`${url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

  it("本物の daemon なら、子のツールが見える。検証ありのときは x-cso-identity ヘッダーを付けない", async () => {
    const real = await startDaemon();
    const verifier = createIdentityVerifier({
      daemonUrl: real.url,
      identityPath: identityFile(),
    });
    const created = createMcpHttpServer({
      daemonUrl: real.url,
      identity: { kind: "verified", verifier },
    });
    if (!created.ok) throw new Error(created.error.cause);
    mcp = created.value;
    const { url } = await mcp.listen(0);
    const res = await callTools(url, real.token);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-cso-identity")).toBeNull();
    expect(await res.text()).toContain("report_done");
  });

  it("偽の窓口なら、トークンを送らず、502（daemon_identity_failed）で失敗する。本文は code・cause・nextActions だけ", async () => {
    const real = await startDaemon();
    const fake = await startAttacker(0, "forged");
    const verifier = createIdentityVerifier({
      daemonUrl: fake.url,
      identityPath: identityFile(),
    });
    const created = createMcpHttpServer({
      daemonUrl: fake.url,
      identity: { kind: "verified", verifier },
    });
    if (!created.ok) throw new Error(created.error.cause);
    mcp = created.value;
    const { url } = await mcp.listen(0);
    const res = await callTools(url, real.token);
    expect(res.status).toBe(502);
    const body = (await res.json()) as { ok: boolean; error: Record<string, unknown> };
    expect(body.error.code).toBe("daemon_identity_failed");
    expect(Object.keys(body.error).sort()).toEqual(["cause", "code", "nextActions"]);
    expect(JSON.stringify(body)).not.toContain(real.token);
    expect(fake.seen.every((s) => s.authorization === undefined)).toBe(true);
  });

  it("検証なしで動くときは、すべての応答に x-cso-identity: unverified が付き、起動のログは 1 回だけ", async () => {
    const real = await startDaemon();
    const logs: string[] = [];
    const created = createMcpHttpServer({
      daemonUrl: real.url,
      identity: { kind: "unverified" },
      logger: (e) => logs.push(e.event),
    });
    if (!created.ok) throw new Error(created.error.cause);
    mcp = created.value;
    const { url } = await mcp.listen(0);
    const ok = await callTools(url, real.token);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-cso-identity")).toBe("unverified");
    const noAuth = await callTools(url, "x");
    expect(noAuth.headers.get("x-cso-identity")).toBe("unverified");
    const wrongPath = await fetch(`${url}/other`);
    expect(wrongPath.headers.get("x-cso-identity")).toBe("unverified");
    await callTools(url, real.token);
    expect(logs.filter((e) => e === "identityUnverified")).toHaveLength(1);
  });
});
