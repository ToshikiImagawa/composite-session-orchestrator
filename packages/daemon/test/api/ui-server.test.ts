import { request as httpRequest } from "node:http";
import { foldEvents, type OrchEvent, type OrchState } from "@cso/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { type ApiServer, createApiServer } from "../../src/api/server.js";

const HUMAN = "human-token-human-token-human-token-1234";
const SYS = { system: true } as const;
let n = 0;
const ev = (body: unknown): OrchEvent =>
  ({
    seq: ++n,
    at: "2026-10-20T00:00:00Z",
    requestId: `r${n}`,
    actor: SYS,
    ...(body as object),
  }) as OrchEvent;
const state = (): OrchState => {
  n = 0;
  const r = foldEvents([
    ev({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    }),
    ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
    ev({
      type: "node.created",
      payload: {
        nodeId: "a",
        role: "implement",
        parentId: "root",
        dependsOn: [],
        objective: "SECRET-OBJECTIVE",
        acceptanceCriteria: ["x"],
        scope: {
          writableLocations: ["src/secret-dir"],
          forbiddenLocations: [".git"],
          allowedCommands: ["pnpm test"],
        },
      },
    }),
    ev({
      type: "inbox.added",
      payload: { id: "f1", kind: "failure", nodeId: "a", summary: "落ちた" },
    }),
  ]);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
  return r.value;
};

let server: ApiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});
const start = async () => {
  const credentials = createCredentialStore({ humanToken: HUMAN });
  server = createApiServer({ credentials, getState: state, handlers: {} });
  const { url, port } = await server.listen(0);
  return {
    url,
    port,
    root: credentials.issueNodeToken("root", "integrator"),
    child: credentials.issueNodeToken("a", "child"),
  };
};

describe("画面の資産（GET /ui ほか）", () => {
  it("認証なしで、HTML・JS・CSS を返す。CSP など、安全なヘッダー付き", async () => {
    const r = await start();
    for (const [path, type] of [
      ["/ui", "text/html"],
      ["/ui/app.js", "text/javascript"],
      ["/ui/app.css", "text/css"],
    ] as const) {
      const res = await fetch(`${r.url}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toContain(type);
      expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
      expect(res.headers.get("x-content-type-options")).toBe("nosniff");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
      // HTML だけに、COOP と Permissions-Policy
      expect(res.headers.get("cross-origin-opener-policy")).toBe(
        path === "/ui" ? "same-origin" : null,
      );
      expect(res.headers.get("permissions-policy") !== null).toBe(path === "/ui");
      expect((await res.text()).length).toBeGreaterThan(50);
    }
  });

  it("GET 以外は 405。知らないパス・プロトタイプのキーは 404。誤った Host・Origin は 403", async () => {
    const r = await start();
    expect((await fetch(`${r.url}/ui`, { method: "POST" })).status).toBe(405);
    expect((await fetch(`${r.url}/ui/nothing`)).status).toBe(404);
    expect((await fetch(`${r.url}/ui/__proto__`)).status).toBe(404);
    expect(
      (await fetch(`${r.url}/ui`, { headers: { origin: "http://evil.example" } })).status,
    ).toBe(403);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        { host: "127.0.0.1", port: r.port, path: "/ui", headers: { host: "evil.example" } },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403); // DNS rebinding 対策（Host の検査）
  });
});

describe("GET /v1/ui/state（人間のトークンだけ）", () => {
  const get = (url: string, token?: string, headers: Record<string, string> = {}) =>
    fetch(`${url}/v1/ui/state`, {
      headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers },
    });

  it("トークンなし・不正は 401。ノードのトークン（統合・子）は 403", async () => {
    const r = await start();
    expect((await get(r.url)).status).toBe(401);
    expect((await get(r.url, "wrong-token-wrong-token-wrong-token-1")).status).toBe(401);
    expect((await get(r.url, r.root)).status).toBe(403);
    expect((await get(r.url, r.child)).status).toBe(403);
  });

  it("人間のトークンなら、表示モデルを返す。ブリーフ・パス・トークンを含まない", async () => {
    const r = await start();
    const res = await get(r.url, HUMAN);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.ok).toBe(true);
    expect(body.value.nodes.map((x: { id: string }) => x.id)).toEqual(["root", "a"]);
    expect(body.value.inbox[0]).toMatchObject({ id: "f1", priority: "failed", nodeId: "a" });
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("secret-dir");
    expect(text).not.toContain(HUMAN);
    expect(text).not.toContain(r.root);
  });

  it("CORP: same-origin。ETag は lastSeq。If-None-Match が一致すれば 304（本文なし）、違えば 200", async () => {
    const r = await start();
    const res = await get(r.url, HUMAN);
    expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    const etag = res.headers.get("etag");
    expect(etag).toBe(`"${state().lastSeq}"`);
    const same = await get(r.url, HUMAN, { "if-none-match": etag ?? "" });
    expect(same.status).toBe(304);
    expect(await same.text()).toBe("");
    expect(same.headers.get("etag")).toBe(etag);
    expect((await get(r.url, HUMAN, { "if-none-match": '"0"' })).status).toBe(200);
    // 304 でも、認証は先に通す（トークンなしは 401）
    expect((await get(r.url, undefined, { "if-none-match": etag ?? "" })).status).toBe(401);
  });

  it("表示モデルは lastSeq を鍵に、直近の 1 件を使い回す（lastSeq が変われば作り直す）", async () => {
    const credentials = createCredentialStore({ humanToken: HUMAN });
    let current = state();
    server = createApiServer({ credentials, getState: () => current, handlers: {} });
    const { url } = await server.listen(0);
    const first = await (await get(url, HUMAN)).text();
    // lastSeq は同じで、中身だけ変える（通常は起きない）。キャッシュなら、前の本文のまま
    current = { ...current, inbox: [] };
    expect(await (await get(url, HUMAN)).text()).toBe(first);
    current = { ...current, lastSeq: current.lastSeq + 1 };
    const next = await get(url, HUMAN);
    expect(next.headers.get("etag")).toBe(`"${current.lastSeq}"`);
    expect(JSON.parse(await next.text()).value.inbox).toEqual([]);
  });

  it("GET 以外は 405。誤った Origin は 403", async () => {
    const r = await start();
    const res = await fetch(`${r.url}/v1/ui/state`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUMAN}` },
    });
    expect(res.status).toBe(405);
    expect((await get(r.url, HUMAN, { origin: "http://evil.example" })).status).toBe(403);
  });
});
