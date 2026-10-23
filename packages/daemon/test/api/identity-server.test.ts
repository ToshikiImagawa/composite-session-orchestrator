import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { foldEvents, type OrchState } from "@cso/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { createIdentity, proofOf } from "../../src/api/identity.js";
import { type ApiServer, createApiServer } from "../../src/api/server.js";

const HUMAN = "human-token-human-token-human-token-1234";
const NONCE = "0123456789abcdef0123456789abcdef";
const empty = (): OrchState => {
  const r = foldEvents([]);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};

const servers: (ApiServer | Server)[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    await new Promise<void>((resolve) => {
      if ("listen" in s && "address" in s) (s as Server).close(() => resolve());
      else (s as ApiServer).close().then(() => resolve());
    });
  }
});

const start = async (identitySpec?: { burst: number; perSecond: number }) => {
  const id = createIdentity();
  const server = createApiServer({
    credentials: createCredentialStore({ humanToken: HUMAN }),
    getState: empty,
    handlers: {},
    identity: () => id,
    rateLimit: {
      perPrincipal: { burst: 10, perSecond: 1 },
      ...(identitySpec === undefined ? {} : { identity: identitySpec }),
    },
  });
  servers.push(server);
  const { url, port } = await server.listen(0);
  return { id, url, port };
};

describe("GET /v1/identity: 接続先（ポート）を proof に含める（中継の攻撃を防ぐ）", () => {
  it("proof は、daemon が待ち受けているポートで作られる（別のポートでは一致しない）", async () => {
    const r = await start();
    const body = await (await fetch(`${r.url}/v1/identity?nonce=${NONCE}`)).json();
    expect(body.value.proof).toBe(proofOf(r.id, `127.0.0.1:${r.port}`, NONCE));
    expect(body.value.proof).not.toBe(proofOf(r.id, `127.0.0.1:${r.port + 1}`, NONCE));
  });

  it("偽の daemon（別のポート）が、本物へ中継しても、proof は一致しない（相手が接続したポートで検証するため）", async () => {
    const real = await start();
    // 偽の daemon: 要求を、そのまま本物へ中継する（Host だけ、本物のポートに書き換える）
    const fake = createServer((req, res) => {
      const up = httpRequest(
        {
          host: "127.0.0.1",
          port: real.port,
          path: req.url,
          method: req.method,
          headers: { host: `127.0.0.1:${real.port}` },
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      req.pipe(up);
    });
    servers.push(fake);
    await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve));
    const fakePort = (fake.address() as AddressInfo).port;
    const res = await fetch(`http://127.0.0.1:${fakePort}/v1/identity?nonce=${NONCE}`);
    const body = await res.json();
    expect(body.ok).toBe(true);
    // mcp は、自分が接続したポート（fakePort）で、期待する proof を計算する → 本物が返した proof とは違う
    const expected = proofOf(real.id, `127.0.0.1:${fakePort}`, NONCE);
    expect(body.value.proof).not.toBe(expected);
    expect(body.value.proof).toBe(proofOf(real.id, `127.0.0.1:${real.port}`, NONCE));
  });
});

describe("GET /v1/identity: 専用の回数の制限", () => {
  it("接続元ごとの専用の bucket。尽きたら 429（Retry-After つき）。認証済みの要求の bucket は、消費しない", async () => {
    const r = await start({ burst: 3, perSecond: 0.001 });
    const statuses: number[] = [];
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) {
      last = await fetch(`${r.url}/v1/identity?nonce=${NONCE}`);
      statuses.push(last.status);
    }
    expect(statuses.slice(0, 3)).toEqual([200, 200, 200]);
    expect(statuses.slice(3)).toEqual([429, 429, 429]);
    expect(last?.headers.get("retry-after")).toBeTruthy();
    // 認証済みの要求（whoami）は、別の bucket なので、影響を受けない
    for (let i = 0; i < 5; i++) {
      const w = await fetch(`${r.url}/v1/whoami`, {
        headers: { authorization: `Bearer ${HUMAN}` },
      });
      expect(w.status).toBe(200);
    }
  });

  it("既定は、mcp の検証の頻度（トークンつきの要求ごとに 1 回）に耐える: 続けて 100 回は、すべて 200", async () => {
    const r = await start();
    for (let i = 0; i < 100; i++) {
      expect((await fetch(`${r.url}/v1/identity?nonce=${NONCE}`)).status).toBe(200);
    }
  });

  it("identity を渡さなければ、この入口はない（404）。身元がまだなければ 503", async () => {
    const none = createApiServer({
      credentials: createCredentialStore({ humanToken: HUMAN }),
      getState: empty,
      handlers: {},
    });
    servers.push(none);
    const a = await none.listen(0);
    expect((await fetch(`${a.url}/v1/identity?nonce=${NONCE}`)).status).toBe(404);
    const pending = createApiServer({
      credentials: createCredentialStore({ humanToken: HUMAN }),
      getState: empty,
      handlers: {},
      identity: () => undefined,
    });
    servers.push(pending);
    const b = await pending.listen(0);
    expect((await fetch(`${b.url}/v1/identity?nonce=${NONCE}`)).status).toBe(503);
  });
});

describe("x-cso-daemon-id（すべての応答に daemonId を付ける。相手の検知用）", () => {
  it("成功・認証の失敗・404・405・identity の入口の応答のどれにも、daemonId が付く", async () => {
    const r = await start();
    const want = r.id.daemonId;
    const get = (path: string, init: RequestInit = {}) => fetch(`${r.url}${path}`, init);
    expect((await get(`/v1/identity?nonce=${NONCE}`)).headers.get("x-cso-daemon-id")).toBe(want);
    expect((await get("/v1/whoami")).headers.get("x-cso-daemon-id")).toBe(want); // 401
    expect((await get("/v1/nothing")).headers.get("x-cso-daemon-id")).toBe(want); // 404
    expect((await get("/v1/request", { method: "GET" })).headers.get("x-cso-daemon-id")).toBe(want); // 405
    expect(
      (await get(`/v1/identity?nonce=${NONCE}`, { method: "POST" })).headers.get("x-cso-daemon-id"),
    ).toBe(want);
    expect(
      (await get("/v1/whoami", { headers: { authorization: `Bearer ${HUMAN}` } })).headers.get(
        "x-cso-daemon-id",
      ),
    ).toBe(want);
  });

  it("起動の途中で、まだ身元がないとき（503）は、付けない", async () => {
    const server = createApiServer({
      credentials: createCredentialStore({ humanToken: HUMAN }),
      getState: empty,
      handlers: {},
      identity: () => undefined,
    });
    servers.push(server);
    const { url } = await server.listen(0);
    const res = await fetch(`${url}/v1/identity?nonce=${NONCE}`);
    expect(res.status).toBe(503);
    expect(res.headers.get("x-cso-daemon-id")).toBeNull();
  });
});
