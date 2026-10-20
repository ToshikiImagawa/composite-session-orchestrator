import { request as httpRequest } from "node:http";
import { type EventBody, foldEvents, type OrchEvent, type OrchState, ok } from "@cso/core";
import { afterEach, describe, expect, it } from "vitest";
import { createBindCodes, createThrottle, formatBindCodeForDisplay } from "../../src/api/bind.js";
import { createCredentialStore } from "../../src/api/credentials.js";
import {
  type ApiLogger,
  type ApiServer,
  createApiServer,
  type Handlers,
} from "../../src/api/server.js";

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
      payload: { nodeId: "m1", role: "integrator", parentId: "root", dependsOn: [] },
    }),
    ev({ type: "node.stateChanged", payload: { nodeId: "m1", event: { type: "start" } } }),
    ev({
      type: "node.created",
      payload: { nodeId: "a", role: "implement", parentId: "m1", dependsOn: [] },
    }),
    ev({
      type: "node.created",
      payload: { nodeId: "m2", role: "integrator", parentId: "root", dependsOn: [] },
    }),
  ]);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};
const HUMAN = "human-token-human-token-human-token-1234";

interface Rig {
  server: ApiServer;
  url: string;
  port: number;
  tokens: { human: string; m1: string; root: string; a: string };
  calls: unknown[];
}
let rig: Rig | undefined;
afterEach(async () => {
  await rig?.server.close();
  rig = undefined;
});

const start = async (
  handlers?: Handlers,
  over: { maxBodyBytes?: number; logger?: ApiLogger; state?: OrchState } = {},
): Promise<Rig> => {
  const credentials = createCredentialStore({ humanToken: HUMAN });
  const calls: unknown[] = [];
  const s = over.state ?? state();
  const { state: _ignored, ...rest } = over;
  const server = createApiServer({
    credentials,
    getState: () => s,
    handlers: handlers ?? {
      "tree.list": (req) => {
        calls.push(req);
        return ok({ table: "t" });
      },
      "node.send": (req) => {
        calls.push(req);
        return ok({ delivered: true });
      },
      "node.purge": (req) => {
        calls.push(req);
        return ok({ purged: [req.params.nodeId] });
      },
    },
    ...rest,
  });
  const { port, url } = await server.listen(0);
  rig = {
    server,
    url,
    port,
    calls,
    tokens: {
      human: HUMAN,
      m1: credentials.issueNodeToken("m1", "integrator"),
      root: credentials.issueNodeToken("root", "integrator"),
      a: credentials.issueNodeToken("a", "child"),
    },
  };
  return rig;
};

const post = async (
  r: Rig,
  body: unknown,
  headers: Record<string, string> = {},
  path = "/v1/request",
) => {
  const res = await fetch(`${r.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return {
    status: res.status,
    json: (await res.json()) as {
      ok: boolean;
      error: { code: string; nextActions: string[] };
      value?: unknown;
    },
    headers: res.headers,
  };
};
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const treeList = { requestId: "q1", operation: "tree.list", params: {} };

describe("窓口の HTTP サーバー（127.0.0.1）", () => {
  it("127.0.0.1 だけで待ち受ける", async () => {
    const r = await start();
    expect(r.url).toBe(`http://127.0.0.1:${r.port}`);
  });

  it("認証済みの要求は、封筒を検証・認可して、ハンドラを呼ぶ。ロールと caller は認証から決まる", async () => {
    const r = await start();
    const res = await post(r, treeList, bearer(r.tokens.m1));
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, value: { table: "t" } });
    expect(r.calls[0]).toMatchObject({
      requestId: "q1",
      operation: "tree.list",
      role: "integrator",
      caller: { nodeId: "m1" },
      params: {},
    });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("人間は caller を持たない", async () => {
    const r = await start();
    const res = await post(
      r,
      { requestId: "q2", operation: "node.purge", params: { nodeId: "root", tombstone: false } },
      bearer(r.tokens.human),
    );
    expect(res.status).toBe(200);
    expect(r.calls[0]).toMatchObject({
      role: "human",
      params: { nodeId: "root", tombstone: false },
    });
    expect(r.calls[0]).not.toHaveProperty("caller");
  });

  it("資格情報がない・不正なら 401（ハンドラは呼ばれず、本文も読まない）", async () => {
    const r = await start();
    for (const h of [
      {},
      { authorization: "Bearer wrongwrongwrongwrong" },
      { authorization: "Basic abc" },
    ]) {
      const res = await post(r, treeList, h);
      expect(res.status, JSON.stringify(h)).toBe(401);
      expect(res.json.ok).toBe(false);
      expect(res.json.error.code).toBe("unauthenticated");
      expect(res.json.error.nextActions.length).toBeGreaterThan(0);
      expect(res.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect(r.calls).toHaveLength(0);
  });

  it("ロールの操作表にない操作・部分木の外・申告の食い違いは 403、範囲外の記録の参照は 404", async () => {
    const r = await start();
    const purge = { requestId: "q3", operation: "node.purge", params: { nodeId: "root" } };
    expect((await post(r, purge, bearer(r.tokens.m1))).status).toBe(403);
    expect((await post(r, purge, bearer(r.tokens.a))).status).toBe(403);
    const send = (nodeId: string) => ({
      requestId: `s-${nodeId}`,
      operation: "node.send",
      params: { nodeId, text: "x" },
    });
    expect((await post(r, send("a"), bearer(r.tokens.m1))).status).toBe(200);
    const out = await post(r, send("m2"), bearer(r.tokens.m1));
    expect(out.status).toBe(403);
    expect(out.json.error.code).toBe("forbidden");
    const spoof = await post(r, { ...treeList, role: "human" }, bearer(r.tokens.m1));
    expect(spoof.status).toBe(403);
    const get = await post(
      r,
      { requestId: "g", operation: "decision.get", params: { decisionId: "x" } },
      bearer(r.tokens.m1),
    );
    expect(get.status).toBe(404);
    expect(r.calls).toHaveLength(1); // 許可された node.send だけ
  });

  it("不正な本文・未知の操作・不正な引数は 400 / 404（ハンドラは呼ばれない）", async () => {
    const r = await start();
    const h = bearer(r.tokens.m1);
    expect((await post(r, "{not json", h)).status).toBe(400);
    expect((await post(r, "[]", h)).status).toBe(400);
    expect((await post(r, { requestId: "x", operation: "nope", params: {} }, h)).status).toBe(404);
    const bad = await post(
      r,
      { requestId: "x", operation: "node.send", params: { nodeId: "a" } },
      h,
    );
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("invalidRequest");
    expect(r.calls).toHaveLength(0);
  });

  it("本文が上限を超えたら 413。Content-Type が JSON でなければ 415", async () => {
    const r = await start(undefined, { maxBodyBytes: 200 });
    const h = bearer(r.tokens.m1);
    const big = {
      requestId: "x",
      operation: "node.send",
      params: { nodeId: "a", text: "x".repeat(500) },
    };
    expect((await post(r, big, h)).status).toBe(413);
    const res = await fetch(`${r.url}/v1/request`, {
      method: "POST",
      headers: { ...h, "content-type": "text/plain" },
      body: JSON.stringify(treeList),
    });
    expect(res.status).toBe(415);
  });

  it("ルートとメソッドは POST /v1/request だけ（それ以外は 404 / 405）", async () => {
    const r = await start();
    const h = bearer(r.tokens.m1);
    expect((await post(r, treeList, h, "/v1/other")).status).toBe(404);
    expect((await post(r, treeList, h, "/")).status).toBe(404);
    const get = await fetch(`${r.url}/v1/request`, { headers: h });
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
  });

  it("未実装の操作は 501（失敗として返す）。ハンドラの例外は 500 で内部の詳細を返さない", async () => {
    const r = await start({
      "tree.list": () => {
        throw new Error("secret-internal-detail");
      },
    });
    const h = bearer(r.tokens.m1);
    const boom = await post(r, treeList, h);
    expect(boom.status).toBe(500);
    expect(JSON.stringify(boom.json)).not.toContain("secret-internal-detail");
    const none = await post(r, { requestId: "x", operation: "inbox.fetch", params: {} }, h);
    expect(none.status).toBe(501);
    expect(none.json.error.code).toBe("notImplemented");
  });

  it("ハンドラの失敗は 422 で、そのまま返す（原因と次の操作つき）", async () => {
    const r = await start({
      "tree.list": () => ({
        ok: false,
        error: { code: "x", cause: "c", nextActions: ["a"] as [string, ...string[]] },
      }),
    });
    const res = await post(r, treeList, bearer(r.tokens.m1));
    expect(res.status).toBe(422);
    expect(res.json).toEqual({ ok: false, error: { code: "x", cause: "c", nextActions: ["a"] } });
  });

  it("Host・Origin の検査（DNS リバインディング・ブラウザからの要求を拒否）", async () => {
    const r = await start();
    const h = bearer(r.tokens.m1);
    const raw = (headers: Record<string, string>) =>
      new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port: r.port,
            path: "/v1/request",
            method: "POST",
            headers: { "content-type": "application/json", ...h, ...headers },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(treeList));
      });
    expect(await raw({ host: "evil.example.com" })).toBe(403);
    expect(await raw({ host: `127.0.0.1:${r.port}`, origin: "https://evil.example.com" })).toBe(
      403,
    );
    expect(await raw({ host: `127.0.0.1:${r.port}`, origin: `http://127.0.0.1:${r.port}` })).toBe(
      200,
    );
    expect(await raw({ host: `localhost:${r.port}` })).toBe(200);
  });

  it("失効したトークンは使えない", async () => {
    const credentials = createCredentialStore({ humanToken: HUMAN });
    const server = createApiServer({
      credentials,
      getState: state,
      handlers: { "tree.list": () => ok({ table: "t" }) },
    });
    const { url } = await server.listen(0);
    try {
      const t = credentials.issueNodeToken("m1", "integrator");
      const call = () =>
        fetch(`${url}/v1/request`, {
          method: "POST",
          headers: { "content-type": "application/json", ...bearer(t) },
          body: JSON.stringify(treeList),
        });
      expect((await call()).status).toBe(200);
      credentials.revokeNode("m1");
      expect((await call()).status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

describe("判定の順序・主体の検査・チャンク転送・結果の写し・ログ", () => {
  it("ロールの判定は引数の検証より先（ロールのない操作は、引数が不正でも 403。400 で形を教えない）", async () => {
    const r = await start();
    const res = await post(
      r,
      { requestId: "o1", operation: "node.stop", params: { bogus: 1 } },
      bearer(r.tokens.a),
    );
    expect(res.status).toBe(403);
    const ok = await post(
      r,
      { requestId: "o2", operation: "node.send", params: { bogus: 1 } },
      bearer(r.tokens.m1),
    );
    expect(ok.status).toBe(400); // ロールがある操作は、引数の形を検証する
  });

  it("停止後・回収済みのノードのトークンは 401（トークンが生きていても使えない）", async () => {
    const stopped = foldEvents([
      ev({
        type: "node.created",
        payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
      }),
      ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
      ev({
        type: "node.created",
        payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
      }),
      ev({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } }),
      ev({
        type: "node.stateChanged",
        payload: { nodeId: "a", event: { type: "stop", mode: "immediate" } },
      }),
      ev({
        type: "node.stateChanged",
        payload: { nodeId: "a", event: { type: "confirmStopped" } },
      }),
    ]);
    if (!stopped.ok) throw new Error(stopped.error.code);
    const r = await start(undefined, { state: stopped.value });
    const res = await post(
      r,
      { requestId: "p1", operation: "report.progress", params: { text: "x" } },
      bearer(r.tokens.a),
    );
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("unauthenticated");
  });

  it("チャンク転送で上限を超えたら 413 を返して接続を破棄する（上限を超えて読み続けない）", async () => {
    const r = await start(undefined, { maxBodyBytes: 200 });
    const result = await new Promise<{ status: number; closed: boolean }>((resolve, reject) => {
      let status = 0;
      let socketClosed = false;
      const req = httpRequest({
        host: "127.0.0.1",
        port: r.port,
        path: "/v1/request",
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          ...bearer(r.tokens.m1),
          "transfer-encoding": "chunked",
        },
      });
      req.on("socket", (sock) => sock.once("close", () => (socketClosed = true)));
      req.on("response", (res) => {
        status = res.statusCode ?? 0;
        res.resume();
      });
      req.on("error", () => undefined);
      const timer = setInterval(() => {
        if (!req.destroyed) req.write("x".repeat(100));
      }, 5);
      const settle = setInterval(() => {
        if (socketClosed) {
          clearInterval(timer);
          clearInterval(settle);
          resolve({ status, closed: true });
        }
      }, 10);
      setTimeout(() => {
        clearInterval(timer);
        clearInterval(settle);
        req.destroy();
        reject(new Error("接続が閉じられなかった"));
      }, 4000);
    });
    expect(result.status).toBe(413);
    expect(result.closed).toBe(true);
  });

  it("結果は OperationMap の result のキーだけに写して返す（余計なキーは返さない）。形が違う結果は 500", async () => {
    const r = await start({
      "tree.list": () => ({ ok: true, value: { table: "t", secret: "internal" } }) as never,
      "node.send": () => ({ ok: true, value: "oops" }) as never,
    });
    const res = await post(r, treeList, bearer(r.tokens.m1));
    expect(res.json).toEqual({ ok: true, value: { table: "t" } });
    const bad = await post(
      r,
      { requestId: "x", operation: "node.send", params: { nodeId: "a", text: "x" } },
      bearer(r.tokens.m1),
    );
    expect(bad.status).toBe(500);
  });

  it("ハンドラの例外は、注入した logger に記録する（応答には詳細を出さない）", async () => {
    const logs: Record<string, unknown>[] = [];
    const r = await start(
      {
        "tree.list": () => {
          throw new Error("secret-internal-detail");
        },
      },
      { logger: (e) => logs.push(e as unknown as Record<string, unknown>) },
    );
    const res = await post(r, treeList, bearer(r.tokens.m1));
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.json)).not.toContain("secret-internal-detail");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      event: "internalError",
      requestId: "q1",
      operation: "tree.list",
    });
    expect(typeof logs[0]?.at).toBe("string");
    expect(String(logs[0]?.error)).toContain("secret-internal-detail");
  });

  it("logger が例外を投げても、応答は 500 のまま", async () => {
    const r = await start(
      {
        "tree.list": () => {
          throw new Error("x");
        },
      },
      {
        logger: () => {
          throw new Error("logger broke");
        },
      },
    );
    expect((await post(r, treeList, bearer(r.tokens.m1))).status).toBe(500);
  });
});

describe("bind 専用の入口（POST /v1/bind。Bearer なしで、nodeId と bindCode）", () => {
  const rigBind = async (
    over: {
      now?: () => number;
      state?: OrchState | (() => OrchState);
      logger?: ApiLogger;
      bindOptions?: Parameters<typeof createBindCodes>[0];
      throttle?: ReturnType<typeof createThrottle>;
    } = {},
  ) => {
    const credentials = createCredentialStore({ humanToken: HUMAN });
    const bind = createBindCodes({ clock: over.now ?? Date.now, ...over.bindOptions });
    const server = createApiServer({
      credentials,
      bind,
      ...(over.logger ? { logger: over.logger } : {}),
      ...(over.throttle ? { bindThrottle: over.throttle } : {}),
      clock: () => "2026-10-20T00:00:00.000Z",
      getState: () => (typeof over.state === "function" ? over.state() : (over.state ?? state())),
      handlers: { "report.progress": () => ok({ accepted: true }) },
    });
    const { url } = await server.listen(0);
    rig = { server, url, port: 0, tokens: { human: HUMAN, m1: "", root: "", a: "" }, calls: [] };
    const call = (body: unknown, headers: Record<string, string> = {}) =>
      post(rig as Rig, body, headers, "/v1/bind");
    return { credentials, bind, url, call };
  };

  it("有効なコードで、子ロールのノードトークンを受け取る。そのトークンで窓口を呼べる", async () => {
    const r = await rigBind();
    const code = r.bind.issue("a");
    const res = await r.call({ nodeId: "a", bindCode: code });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    const value = res.json.value as { nodeId: string; token: string };
    expect(value.nodeId).toBe("a");
    expect(value.token.length).toBeGreaterThanOrEqual(43);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(r.credentials.authenticate(value.token)).toEqual({ role: "child", nodeId: "a" });
    const used = await fetch(`${r.url}/v1/request`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${value.token}` },
      body: JSON.stringify({ requestId: "p", operation: "report.progress", params: { text: "x" } }),
    });
    expect(used.status).toBe(200);
  });

  it("bind で発行すると、そのノードの既存のトークンは無効になる", async () => {
    const r = await rigBind();
    const old = r.credentials.issueNodeToken("a", "child");
    const res = await r.call({ nodeId: "a", bindCode: r.bind.issue("a") });
    const fresh = (res.json.value as { token: string }).token;
    expect(r.credentials.authenticate(old)).toBeUndefined();
    expect(r.credentials.authenticate(fresh)).toEqual({ role: "child", nodeId: "a" });
  });

  it("小文字・区切りなしで入力したコードも使える", async () => {
    const r = await rigBind();
    const code = r.bind.issue("a");
    const res = await r.call({ nodeId: "a", bindCode: code.toLowerCase().replaceAll("-", "") });
    expect(res.status).toBe(200);
  });

  it("コードは一度だけ・結び付いたノードだけ。未知・使用済み・期限切れ・別のノードは、区別せず 401", async () => {
    let now = 1_000_000;
    const r = await rigBind({ now: () => now });
    const code = r.bind.issue("a");
    expect((await r.call({ nodeId: "a", bindCode: code })).status).toBe(200);
    for (const [nodeId, c] of [
      ["a", code],
      ["a", "WXYZ2345ABCDEFGHJKMNPQRSTV"],
    ] as const) {
      const res = await r.call({ nodeId, bindCode: c });
      expect(res.status).toBe(401);
      expect(res.json.error.code).toBe("unauthenticated");
    }
    const other = r.bind.issue("a");
    expect((await r.call({ nodeId: "m2", bindCode: other })).status).toBe(401);
    now += 10 * 60_000;
    expect((await r.call({ nodeId: "a", bindCode: other })).status).toBe(401);
  });

  it("ノード単位のロックで 429（Retry-After つき）。他のノードは使える", async () => {
    const r = await rigBind();
    for (let i = 0; i < 5; i++) await r.call({ nodeId: "a", bindCode: `${String(i).repeat(26)}` });
    const locked = await r.call({ nodeId: "a", bindCode: r.bind.issue("a") });
    expect(locked.status).toBe(429);
    expect(locked.json.error.code).toBe("tooManyRequests");
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    const other = await r.call({ nodeId: "a2", bindCode: r.bind.issue("a2") });
    expect(other.status).toBe(401); // a2 は木にいない。ロックではなく通常の失敗
  });

  it("全体は、ロックではなく短いスロットル（1 秒あたり N 回の失敗）。不正な本文・型違いも数える。次の秒には解ける", async () => {
    let now = 5_000;
    const throttle = createThrottle({ clock: () => now, perSecond: 3 });
    const r = await rigBind({ throttle });
    expect((await r.call("{not json")).status).toBe(400); // 不正な本文
    expect((await r.call({ nodeId: "a", bindCode: 5 })).status).toBe(400); // 型違い
    expect((await r.call({ nodeId: "n1", bindCode: "0".repeat(26) })).status).toBe(401);
    const blocked = await r.call({ nodeId: "a", bindCode: r.bind.issue("a") });
    expect(blocked.status).toBe(429);
    expect(blocked.json.error.code).toBe("tooManyRequests");
    expect(blocked.headers.get("retry-after")).toBe("1");
    now += 1000;
    const ok1 = await r.call({ nodeId: "a", bindCode: r.bind.issue("a") });
    expect(ok1.status).toBe(200);
  });

  it("ノードの状態が許さないときは、コードを消費しない。許すようになれば同じコードで紐付けられる", async () => {
    let allowed = false;
    const stopped = foldEvents([
      ev({
        type: "node.created",
        payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
      }),
      ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
      ev({
        type: "node.created",
        payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
      }),
      ev({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } }),
      ev({
        type: "node.stateChanged",
        payload: { nodeId: "a", event: { type: "stop", mode: "immediate" } },
      }),
      ev({
        type: "node.stateChanged",
        payload: { nodeId: "a", event: { type: "confirmStopped" } },
      }),
    ]);
    if (!stopped.ok) throw new Error(stopped.error.code);
    const running = state();
    const r = await rigBind({ state: () => (allowed ? running : stopped.value) });
    const code = r.bind.issue("a");
    expect((await r.call({ nodeId: "a", bindCode: code })).status).toBe(401);
    allowed = true;
    expect((await r.call({ nodeId: "a", bindCode: code })).status).toBe(200);
  });

  it("ロール・状態が合わないノードのコードは使えない（統合ノード・木にないノード）", async () => {
    const r = await rigBind();
    expect((await r.call({ nodeId: "m1", bindCode: r.bind.issue("m1") })).status).toBe(401);
    expect((await r.call({ nodeId: "ghost", bindCode: r.bind.issue("ghost") })).status).toBe(401);
  });

  it("紐付けの成功・失敗・ロック・スロットルを logger に記録する（コード・ハッシュ・先頭の文字・トークンは書かない）", async () => {
    const logs: Record<string, unknown>[] = [];
    const now = 5_000;
    const r = await rigBind({
      logger: (e) => logs.push(e as unknown as Record<string, unknown>),
      throttle: createThrottle({ clock: () => now, perSecond: 100 }),
    });
    const code = r.bind.issue("a");
    const ok1 = await r.call({ nodeId: "a", bindCode: formatBindCodeForDisplay(code) });
    await r.call({ nodeId: "a", bindCode: "ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZZ" });
    await r.call("{not json");
    for (let i = 0; i < 5; i++)
      await r.call({ nodeId: "a", bindCode: `${String(i + 1).repeat(26)}` });
    await r.call({ nodeId: "a", bindCode: code });
    const events = logs.map((l) => l.event);
    expect(events[0]).toBe("bindSucceeded");
    expect(logs[0]).toMatchObject({ nodeId: "a", at: "2026-10-20T00:00:00.000Z" });
    expect(logs[1]).toMatchObject({ event: "bindFailed", reason: "invalid" });
    expect(logs[2]).toMatchObject({ event: "bindFailed", reason: "malformed" });
    expect(events).toContain("bindLocked");
    // 失敗の記録に nodeId は含めない（申告された値は信用できない）
    for (const l of logs.filter((x) => x.event !== "bindSucceeded"))
      expect(l).not.toHaveProperty("nodeId");
    const text = JSON.stringify(logs);
    for (const secret of [
      code,
      code.slice(0, 5),
      "ZZZZZ",
      (ok1.json.value as { token: string }).token,
    ]) {
      expect(text).not.toContain(secret);
    }
    const t = await rigBind({
      logger: (e) => logs.push(e as unknown as Record<string, unknown>),
      throttle: createThrottle({ clock: () => now, perSecond: 1 }),
    });
    await t.call("{bad");
    await t.call("{bad");
    expect(logs.at(-1)).toMatchObject({ event: "bindThrottled", reason: "global" });
  });

  it("形の検査: 余計なキー・不正なコード・JSON でない・大きすぎる本文・GET・Content-Type", async () => {
    const r = await rigBind();
    expect((await r.call({ nodeId: "a", bindCode: "x", extra: 1 })).status).toBe(400);
    expect((await r.call({ nodeId: "a", bindCode: 5 })).status).toBe(400);
    expect((await r.call({ bindCode: "ABCDEFGHJKMNPQRSTVWXYZ0123" })).status).toBe(400);
    expect((await r.call({ nodeId: "../x", bindCode: "ABCDEFGHJKMNPQRSTVWXYZ0123" })).status).toBe(
      400,
    );
    expect((await r.call({})).status).toBe(400);
    expect((await r.call("{not json")).status).toBe(400);
    expect((await r.call({ nodeId: "a", bindCode: "A".repeat(5000) })).status).toBe(413);
    expect((await fetch(`${r.url}/v1/bind`)).status).toBe(405);
    const text = await fetch(`${r.url}/v1/bind`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(text.status).toBe(415);
  });

  it("bind を設定していなければ、入口はない（404）。Host の検査は同じ", async () => {
    const credentials = createCredentialStore({ humanToken: HUMAN });
    const server = createApiServer({ credentials, getState: state, handlers: {} });
    const { url, port } = await server.listen(0);
    try {
      const res = await fetch(`${url}/v1/bind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ nodeId: "a", bindCode: "ABCDEFGHJKMNPQRSTVWXYZ0123" }),
      });
      expect(res.status).toBe(404);
      const raw = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/v1/bind",
            method: "POST",
            headers: { host: "evil.example.com", "content-type": "application/json" },
          },
          (r2) => {
            r2.resume();
            resolve(r2.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end("{}");
      });
      expect(raw).toBe(403);
    } finally {
      await server.close();
    }
  });
});
