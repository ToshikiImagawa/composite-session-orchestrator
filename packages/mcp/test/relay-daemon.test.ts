/**
 * relay と、本物の daemon の窓口（`createApiServer`）の統合。429・409 のあとの再送で、操作が二重に実行されないことを確かめる。
 * 時間に依存する部分は、待ちを短く設定して、OS の違いで不安定にならないようにする（EPIPE などの接続エラーは、fetch の差し替えで再現する）。
 */
import { type EventBody, foldEvents, type OrchEvent, type OrchState, ok } from "@cso/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../daemon/src/api/credentials.js";
import { type ApiServer, createApiServer, type Handlers } from "../../daemon/src/api/server.js";
import { createRelay, type Relay } from "../src/index.js";

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

let daemon: ApiServer | undefined;
afterEach(async () => {
  await daemon?.close();
  daemon = undefined;
});

const start = async (
  handlers: Handlers,
  extra: Partial<Parameters<typeof createApiServer>[0]> = {},
) => {
  const credentials = createCredentialStore({
    humanToken: "human-token-human-token-human-token-1234",
  });
  daemon = createApiServer({ credentials, getState: () => state(), handlers, ...extra });
  const { url } = await daemon.listen(0);
  return { url, credentials, token: credentials.issueNodeToken("a", "child") };
};
const relayFor = (url: string, token: string, extra: object = {}): Relay => {
  const r = createRelay({ daemonUrl: url, token, ...extra });
  if (!r.ok) throw new Error(r.error.cause);
  return r.value;
};

describe("同時数の制限（maxInFlightPerPrincipal）", () => {
  it("14 本を同時に送ると、8 本が受理され 6 本が 429 になる。再送で全部が成功し、ハンドラはそれぞれ 1 回ずつ実行される", async () => {
    const executed: string[] = [];
    let inFlight = 0;
    let peak = 0;
    const { url, token } = await start(
      {
        "report.progress": async (req) => {
          executed.push((req.params as { text: string }).text);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await new Promise((r) => setTimeout(r, 400));
          inFlight -= 1;
          return ok({ accepted: true });
        },
      },
      { rateLimit: { maxInFlightPerPrincipal: 8, perPrincipal: { burst: 100, perSecond: 100 } } },
    );
    const relay = relayFor(url, token);
    const results = await Promise.all(
      Array.from({ length: 14 }, (_, i) => relay.request("report.progress", { text: `p${i}` })),
    );
    expect(results.every((r) => r.ok)).toBe(true);
    expect(peak).toBeLessThanOrEqual(8);
    expect([...executed].sort()).toEqual(Array.from({ length: 14 }, (_, i) => `p${i}`).sort());
  }, 30_000);
});

describe("主体の bucket（回数の制限）", () => {
  it("bucket が尽きたら 429 になり、Retry-After のあとで再送されて成功する。実行は 1 回ずつ", async () => {
    const executed: string[] = [];
    const { url, token } = await start(
      {
        "report.progress": (req) => {
          executed.push((req.params as { text: string }).text);
          return ok({ accepted: true });
        },
      },
      { rateLimit: { perPrincipal: { burst: 2, perSecond: 5 } } },
    );
    const relay = relayFor(url, token);
    const results = [];
    for (let i = 0; i < 4; i++)
      results.push(await relay.request("report.progress", { text: `p${i}` }));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(executed).toEqual(["p0", "p1", "p2", "p3"]);
  }, 30_000);
});

describe("401 は再送しない", () => {
  it("無効なトークンの要求は、1 回だけ送られ、再送されない", async () => {
    let handled = 0;
    const { url } = await start({
      "tree.list": () => {
        handled += 1;
        return ok({ table: "t" });
      },
    });
    let sent = 0;
    const counting = ((input: string, init?: RequestInit) => {
      sent += 1;
      return fetch(input, init);
    }) as unknown as typeof fetch;
    const relay = relayFor(url, "not-a-valid-token-0123456789", { fetch: counting });
    const r = await relay.request("tree.list", {});
    expect(!r.ok && r.error.code).toBe("unauthenticated");
    expect(sent).toBe(1);
    expect(handled).toBe(0);
  });
});

describe("タイムアウトしても、同じ要求が二重に実行されない", () => {
  it("relay のタイムアウト（400ms）より遅いハンドラ（900ms）。再送は同じ requestId で、ハンドラは 1 回だけ実行される", async () => {
    let executed = 0;
    const { url, token } = await start({
      "report.progress": async () => {
        executed += 1;
        await new Promise((r) => setTimeout(r, 900));
        return ok({ accepted: true });
      },
    });
    const relay = relayFor(url, token, { timeoutMs: 400 });
    const r = await relay.request("report.progress", { text: "t" });
    // 結果は、成功か「結果は不明」のどちらか（タイミングによる）。どちらでも、実行は 1 回だけ。
    if (!r.ok) expect(r.error.code).toBe("daemon_result_unknown");
    await new Promise((res) => setTimeout(res, 1200));
    expect(executed).toBe(1);
  }, 20_000);
});

describe("接続エラー（EPIPE など）", () => {
  it("接続エラーは、同じ requestId で再送する。OS の違いに依存しないよう、fetch の差し替えで再現する", async () => {
    let executed = 0;
    const { url, token } = await start({
      "report.progress": () => {
        executed += 1;
        return ok({ accepted: true });
      },
    });
    let n2 = 0;
    const ids: string[] = [];
    const flaky = (async (input: string, init?: RequestInit) => {
      n2 += 1;
      ids.push(JSON.parse(String(init?.body)).requestId);
      if (n2 === 1)
        throw Object.assign(new TypeError("fetch failed"), { cause: { code: "EPIPE" } });
      return fetch(input, init);
    }) as unknown as typeof fetch;
    const r = await relayFor(url, token, { fetch: flaky }).request("report.progress", {
      text: "t",
    });
    expect(r.ok).toBe(true);
    expect(new Set(ids).size).toBe(1);
    expect(ids).toHaveLength(2);
    expect(executed).toBe(1);
  });
});
