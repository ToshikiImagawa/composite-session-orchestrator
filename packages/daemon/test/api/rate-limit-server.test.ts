import { type EventBody, foldEvents, type OrchEvent, type OrchState, ok } from "@cso/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import {
  type ApiLogEvent,
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
    ev({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } }),
  ]);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};
/** 形式は正しい（43 文字の base64url）が、発行していないトークン。形式が違うものは、トークンなし（missing）と同じ扱い。 */
const UNKNOWN_A = "b".repeat(43);
const UNKNOWN_B = "c".repeat(43);
const UNKNOWN_C = "d".repeat(43);
const HUMAN = "human-token-human-token-human-token-1234";

interface Rig {
  server: ApiServer;
  url: string;
  tokens: { human: string; m1: string; a: string };
  calls: string[];
  logs: ApiLogEvent[];
  mono: { now: () => number; advance: (ms: number) => void };
}
let rig: Rig | undefined;
afterEach(async () => {
  await rig?.server.close();
  rig = undefined;
});

const start = async (
  limits: {
    perPrincipal?: { burst: number; perSecond: number };
    authFailures?: { burst: number; perSecond: number };
    summaryWindowMs?: number;
  } = {},
): Promise<Rig> => {
  const credentials = createCredentialStore({ humanToken: HUMAN });
  const calls: string[] = [];
  const logs: ApiLogEvent[] = [];
  let t = 1_000;
  const mono = { now: () => t, advance: (ms: number) => (t += ms) };
  const handlers: Handlers = {
    "tree.list": () => {
      calls.push("tree.list");
      return ok({ table: "t" });
    },
    "report.progress": () => {
      calls.push("report.progress");
      return ok({ accepted: true as const });
    },
    "node.purgePreview": () => {
      calls.push("node.purgePreview");
      return ok({
        nodeIds: [],
        archivedAt: "2026-01-01T00:00:00Z",
        elapsedDays: 0,
        retentionDays: 90,
        tombstoneTitle: "x",
        purgeable: false,
        blockers: [],
      });
    },
    "node.purge": (req) => {
      calls.push("node.purge");
      return ok({ purged: [req.params.nodeId] });
    },
  };
  const s = state();
  const server = createApiServer({
    credentials,
    getState: () => s,
    handlers,
    logger: (e) => logs.push(e),
    rateLimit: {
      perPrincipal: limits.perPrincipal ?? { burst: 10, perSecond: 1 },
      authFailures: limits.authFailures ?? { burst: 5, perSecond: 0.1 },
      monotonicMs: mono.now,
      ...(limits.summaryWindowMs === undefined ? {} : { summaryWindowMs: limits.summaryWindowMs }),
    },
  });
  const { url } = await server.listen(0);
  rig = {
    server,
    url,
    calls,
    logs,
    mono,
    tokens: {
      human: HUMAN,
      m1: credentials.issueNodeToken("m1", "integrator"),
      a: credentials.issueNodeToken("a", "child"),
    },
  };
  return rig;
};

const post = async (r: Rig, body: unknown, token?: string, extra: Record<string, string> = {}) => {
  const res = await fetch(`${r.url}/v1/request`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...extra,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return {
    status: res.status,
    retryAfter: res.headers.get("retry-after"),
    json: (await res.json()) as {
      ok: boolean;
      error?: { code: string; cause: string; nextActions: string[] };
    },
  };
};
const list = (id = "q") => ({ requestId: id, operation: "tree.list", params: {} });
const progress = (id = "g") => ({
  requestId: id,
  operation: "report.progress",
  params: { text: "x" },
});
const preview = (id = "v") => ({
  requestId: id,
  operation: "node.purgePreview",
  params: { nodeId: "x" },
});
const purge = (id = "p") => ({ requestId: id, operation: "node.purge", params: { nodeId: "x" } });

describe("窓口の回数の制限（T10l）", () => {
  it("容量を使い切ると 429（tooManyRequests）と Retry-After を返す。429 の要求は実行されていない（ハンドラを呼ばない）", async () => {
    const r = await start();
    for (let i = 0; i < 10; i++)
      expect((await post(r, list(`q${i}`), r.tokens.m1)).status).toBe(200);
    const over = await post(r, list("q-over"), r.tokens.m1);
    expect(over.status).toBe(429);
    expect(over.json.error?.code).toBe("tooManyRequests");
    expect(Number(over.retryAfter)).toBeGreaterThanOrEqual(1);
    expect(r.calls).toHaveLength(10); // 11 件目は、ハンドラが呼ばれていない
    // Retry-After の秒数だけ待てば、同じ要求を（同じ requestId で）やり直せて、1 回だけ実行される
    r.mono.advance(Number(over.retryAfter) * 1000);
    expect((await post(r, list("q-over"), r.tokens.m1)).status).toBe(200);
    expect(r.calls).toHaveLength(11);
  });

  it("429 の cause・nextActions には、トークン・nodeId・残りの量の詳細を出さない（Retry-After だけ）", async () => {
    const r = await start();
    for (let i = 0; i < 10; i++) await post(r, progress(`g${i}`), r.tokens.a);
    const over = await post(r, progress("g-over"), r.tokens.a);
    expect(over.status).toBe(429);
    const text = JSON.stringify(over.json);
    expect(text).not.toContain(r.tokens.a);
    expect(text).not.toContain('"a"');
    expect(over.json.error?.cause).not.toMatch(/\d/); // 数量を出さない
    expect(over.json.error?.nextActions.join("")).not.toMatch(/\d/);
    expect(over.json.error?.nextActions.join("")).toContain("Retry-After");
  });

  it("制限の判定は、本文を読む前（巨大な本文でも 413 でなく 429）。認証の前には行わない（無効なトークンは 401）", async () => {
    const r = await start();
    for (let i = 0; i < 10; i++) await post(r, list(`q${i}`), r.tokens.m1);
    const big = await post(r, `{"x":"${"y".repeat(2 * 1024 * 1024)}"}`, r.tokens.m1);
    expect(big.status).toBe(429);
    const unauth = await post(r, list(), "wrong-token");
    expect(unauth.status).toBe(401); // 主体の制限は、認証の後
  });

  it("主体ごとに独立している: 子 a が使い切っても、統合ノード m1 と人間は通る", async () => {
    const r = await start();
    for (let i = 0; i < 10; i++) await post(r, progress(`g${i}`), r.tokens.a);
    expect((await post(r, progress("ga"), r.tokens.a)).status).toBe(429);
    expect((await post(r, list("qm"), r.tokens.m1)).status).toBe(200);
    expect((await post(r, preview("vh"), r.tokens.human)).status).toBe(200);
  });

  it("重い操作は 5 トークン: 容量 10 で、最終削除は 2 回まで（読み取りは 1）", async () => {
    const r = await start();
    expect((await post(r, purge("p1"), r.tokens.human)).status).toBe(200);
    expect((await post(r, purge("p2"), r.tokens.human)).status).toBe(200);
    expect((await post(r, purge("p3"), r.tokens.human)).status).toBe(429);
    expect(r.calls.filter((c) => c === "node.purge")).toHaveLength(2);
  });

  it("重みの判定は、操作の名前が分かった後・ハンドラの前: 残りが足りなければ 429 で、実行しない", async () => {
    const r = await start();
    for (let i = 0; i < 6; i++) await post(r, preview(`v${i}`), r.tokens.human); // 残り 4
    const heavy = await post(r, purge("p"), r.tokens.human); // 基本の 1 は足りるが、追加の 4 が足りない…残り 3
    expect(heavy.status).toBe(429);
    expect(r.calls.filter((c) => c === "node.purge")).toHaveLength(0);
  });

  it("認証の失敗は、接続元ごとに数え、容量を超えたら、401 でなく 429 にする。有効なトークンは、失敗の制限に影響されない", async () => {
    const r = await start();
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await post(r, list(`q${i}`), UNKNOWN_A)).status);
    expect(statuses.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(statuses.slice(5)).toEqual([429, 429, 429]);
    // 失敗の制限に達しても、有効なトークンの要求は通る（締め出されない）
    expect((await post(r, list("ok"), r.tokens.m1)).status).toBe(200);
    expect((await post(r, preview("ok-h"), r.tokens.human)).status).toBe(200);
  });

  it("whoami も、主体ごとの制限を受ける。認証の失敗は同じ入口で数える", async () => {
    const r = await start();
    const who = (token?: string) =>
      fetch(`${r.url}/v1/whoami`, {
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
      });
    for (let i = 0; i < 10; i++) expect((await who(r.tokens.a)).status).toBe(200);
    const over = await who(r.tokens.a);
    expect(over.status).toBe(429);
    expect(over.headers.get("retry-after")).not.toBeNull();
    expect((await who(r.tokens.m1)).status).toBe(200);
    expect((await who(UNKNOWN_A)).status).toBe(401);
    expect(r.logs.some((e) => e.event === "apiAuthFailed" && e.reason === "invalid")).toBe(true);
  });

  it("T10a: 認証の失敗は、理由の種類だけ（窓の最初の 1 件をすぐに、窓の終わりに件数のまとめ）。制限の発動も同様。トークン・nodeId は出ない", async () => {
    const r = await start({ summaryWindowMs: 60_000 });
    await post(r, list("u1")); // トークンなし
    await post(r, list("u2"), UNKNOWN_A);
    await post(r, list("u3"), UNKNOWN_B);
    for (let i = 0; i < 11; i++) await post(r, progress(`g${i}`), r.tokens.a);
    const firsts = r.logs.filter(
      (e) => e.event === "apiAuthFailed" || e.event === "apiRateLimited",
    );
    expect(firsts).toEqual([
      expect.objectContaining({ event: "apiAuthFailed", reason: "missing" }),
      expect.objectContaining({ event: "apiAuthFailed", reason: "invalid" }),
      expect.objectContaining({ event: "apiRateLimited", key: "principal" }),
    ]);
    expect(r.logs.some((e) => e.event === "apiSummary")).toBe(false);
    r.mono.advance(60_000);
    await post(r, list("u4"), UNKNOWN_C); // 窓が終わった
    const summary = r.logs.find((e) => e.event === "apiSummary");
    expect(summary).toMatchObject({
      windowSec: 60,
      authFailed: { missing: 1, invalid: 2 },
      rateLimited: { principal: 1 },
    });
    const text = JSON.stringify(r.logs);
    for (const secret of [
      r.tokens.a,
      r.tokens.m1,
      r.tokens.human,
      UNKNOWN_A,
      UNKNOWN_B,
      UNKNOWN_C,
      '"a"',
      '"m1"',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it("停止のとき、溜まっている件数を 1 行にまとめて出す", async () => {
    const r = await start();
    await post(r, list("u1"), UNKNOWN_A);
    await r.server.close();
    expect(r.logs.some((e) => e.event === "apiSummary")).toBe(true);
    rig = undefined;
  });
});
