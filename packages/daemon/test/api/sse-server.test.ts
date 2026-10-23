import { request as httpRequest } from "node:http";
import { foldEvents, type OrchEvent, type OrchState } from "@cso/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { type ApiServer, createApiServer } from "../../src/api/server.js";

const HUMAN = "human-token-human-token-human-token-1234";
const SYS = { system: true } as const;
const base = (): OrchState => {
  const e = (seq: number, body: unknown): OrchEvent =>
    ({
      seq,
      at: "2026-10-20T00:00:00Z",
      requestId: `r${seq}`,
      actor: SYS,
      ...(body as object),
    }) as OrchEvent;
  const r = foldEvents([
    e(1, {
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    }),
    e(2, { type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
  ]);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};

let server: ApiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

interface Rig {
  url: string;
  port: number;
  bump(): void;
  root: string;
}
const start = async (
  sse: {
    maxConnections?: number;
    coalesceMs?: number;
    heartbeatMs?: number;
    drainTimeoutMs?: number;
    maxLifetimeMs?: number;
  } = {},
): Promise<Rig> => {
  const credentials = createCredentialStore({ humanToken: HUMAN });
  let current = base();
  server = createApiServer({
    credentials,
    getState: () => current,
    handlers: {},
    sse: { coalesceMs: 20, heartbeatMs: 60, ...sse },
  });
  const { url, port } = await server.listen(0);
  return {
    url,
    port,
    bump: () => {
      current = { ...current, lastSeq: current.lastSeq + 1 };
    },
    root: credentials.issueNodeToken("root", "integrator"),
  };
};

/** SSE に接続して、受け取ったテキストを溜める。 */
const open = (
  r: Rig,
  token: string | null = HUMAN,
  headers: Record<string, string> = {},
): Promise<{ status: number; headers: Record<string, unknown>; text(): string; close(): void }> =>
  new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: r.port,
        path: "/v1/events",
        headers: {
          ...(token === null ? {} : { authorization: `Bearer ${token}` }),
          ...headers,
        },
      },
      (res) => {
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          buf += c;
        });
        res.on("error", () => {});
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          text: () => buf,
          close: () => req.destroy(),
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
const until = async (f: () => boolean, ms = 3000): Promise<void> => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("GET /v1/events（SSE。T23 PR2）", () => {
  it("人間のトークンだけ: なし・不正は 401、ノードのトークンは 403、POST は 405、誤った Origin は 403", async () => {
    const r = await start();
    expect((await open(r, null)).status).toBe(401);
    expect((await open(r, "wrong-token-wrong-token-wrong-token-1")).status).toBe(401);
    expect((await open(r, r.root)).status).toBe(403);
    expect((await open(r, HUMAN, { origin: "http://evil.example" })).status).toBe(403);
    const post = await fetch(`${r.url}/v1/events`, {
      method: "POST",
      headers: { authorization: `Bearer ${HUMAN}` },
    });
    expect(post.status).toBe(405);
  });

  it("接続したら、ヘッダー（event-stream・no-store・CORP）と、今の lastSeq をすぐ送る", async () => {
    const r = await start();
    const c = await open(r);
    expect(c.status).toBe(200);
    expect(c.headers["content-type"]).toContain("text/event-stream");
    expect(c.headers["cache-control"]).toBe("no-store");
    expect(c.headers["cross-origin-resource-policy"]).toBe("same-origin");
    await until(() => c.text().includes("event: seq"));
    expect(c.text()).toContain('data: {"lastSeq":2}');
    expect(c.text()).toContain("retry: 3000");
    c.close();
  });

  it("lastSeq が変わったら通知する。送るのは lastSeq だけ（中身は送らない）。変わらなければ送らない", async () => {
    const r = await start({ heartbeatMs: 60_000 });
    const c = await open(r);
    await until(() => c.text().includes('"lastSeq":2'));
    const before = c.text();
    await new Promise((x) => setTimeout(x, 100));
    expect(c.text()).toBe(before); // 変わらない間は、何も送らない
    r.bump();
    await until(() => c.text().includes('"lastSeq":3'));
    expect(c.text()).not.toContain("nodes");
    c.close();
  });

  it("周期（coalesceMs）で、まとめて送る（短い間の連続した変化は、最新の lastSeq の 1 件）", async () => {
    const r = await start({ coalesceMs: 100, heartbeatMs: 60_000 });
    const c = await open(r);
    await until(() => c.text().includes('"lastSeq":2'));
    r.bump();
    r.bump();
    r.bump();
    await until(() => c.text().includes('"lastSeq":5'));
    expect(c.text()).not.toContain('"lastSeq":3');
    expect(c.text()).not.toContain('"lastSeq":4');
    c.close();
  });

  it("変化がなくても、heartbeat（コメント行）を送る", async () => {
    const r = await start({ heartbeatMs: 40 });
    const c = await open(r);
    await until(() => c.text().includes(": heartbeat"));
    c.close();
  });

  it("同時の接続は上限（既定 4）まで。超えたら 429（Retry-After）。切れたら空く", async () => {
    const r = await start({ maxConnections: 2 });
    const a = await open(r);
    const b = await open(r);
    expect([a.status, b.status]).toEqual([200, 200]);
    const over = await open(r);
    expect(over.status).toBe(429);
    expect(over.headers["retry-after"]).toBeDefined();
    a.close();
    await until(() => true);
    let again = await open(r);
    for (let i = 0; i < 100 && again.status === 429; i++) {
      await new Promise((x) => setTimeout(x, 20));
      again = await open(r);
    }
    expect(again.status).toBe(200);
    again.close();
    b.close();
  });

  it("寿命（maxLifetimeMs）が来たら、サーバーが接続を閉じる（画面は再接続する）", async () => {
    const r = await start({ maxLifetimeMs: 150, coalesceMs: 20, heartbeatMs: 10_000 });
    const closed = new Promise<void>((resolve) => {
      const req = httpRequest(
        {
          host: "127.0.0.1",
          port: r.port,
          path: "/v1/events",
          headers: { authorization: `Bearer ${HUMAN}` },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve());
          res.on("close", () => resolve());
        },
      );
      req.on("error", () => resolve());
      req.end();
    });
    await Promise.race([
      closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("閉じなかった")), 3000)),
    ]);
  });

  it("サーバーを止めると、接続は閉じる（タイマーが残らない）", async () => {
    const r = await start();
    const c = await open(r);
    await until(() => c.text().includes("event: seq"));
    await server?.close();
    server = undefined;
    c.close();
  });
});
