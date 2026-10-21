import { describe, expect, it, vi } from "vitest";
import { createRelay, MAX_RELAY_BYTES } from "../src/index.js";

const TOKEN = "tok-secret-123";
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const relayWith = (fetchImpl: typeof fetch, extra: object = {}) => {
  const r = createRelay({
    daemonUrl: "http://127.0.0.1:7777",
    token: TOKEN,
    fetch: fetchImpl,
    ...extra,
  });
  if (!r.ok) throw new Error(r.error.cause);
  return r.value;
};

describe("daemonUrl の検査", () => {
  it.each(["http://127.0.0.1:1", "http://localhost:1", "http://[::1]:1", "https://127.0.0.1:1"])(
    "%s は受け付ける",
    (daemonUrl) => {
      expect(createRelay({ daemonUrl, token: TOKEN }).ok).toBe(true);
    },
  );
  it.each([
    "http://example.com",
    "http://10.0.0.1:1",
    "ftp://127.0.0.1",
    "not a url",
    "http://u:p@127.0.0.1:1",
    "",
  ])("%s は拒否する（トークンを外へ送らない）", (daemonUrl) => {
    const r = createRelay({ daemonUrl, token: TOKEN });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.nextActions.length).toBeGreaterThan(0);
  });
  it("空・不正な形のトークンは拒否する", () => {
    for (const token of ["", "a b", "a\nb"]) {
      expect(createRelay({ daemonUrl: "http://127.0.0.1:1", token }).ok).toBe(false);
    }
  });
});

describe("whoami", () => {
  it("GET /v1/whoami に Bearer を付け、{ role } を返す", async () => {
    const f = vi.fn(async () => json(200, { ok: true, value: { role: "child" } }));
    const r = await relayWith(f as never).whoami();
    expect(r.ok && r.value.role).toBe("child");
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:7777/v1/whoami");
    expect(init.method).toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it.each([401, 403])("daemon が %s を返したら、そのまま失敗にする", async (status) => {
    const err = { code: "unauthenticated", cause: "x", nextActions: ["資格情報を再発行する"] };
    const r = await relayWith((async () =>
      json(status, { ok: false, error: err })) as never).whoami();
    expect(!r.ok && r.error.code).toBe("unauthenticated");
  });

  it("role が文字列でない・本文が JSON でない応答は失敗", async () => {
    const bad1 = await relayWith((async () =>
      json(200, { ok: true, value: { role: 1 } })) as never).whoami();
    expect(bad1.ok).toBe(false);
    const bad2 = await relayWith(
      (async () => new Response("<html>", { status: 200 })) as never,
    ).whoami();
    expect(bad2.ok).toBe(false);
  });
});

describe("request（/v1/request への中継）", () => {
  it("封筒 { requestId, operation, params } を POST し、成功を返す", async () => {
    const f = vi.fn(async () => json(200, { ok: true, value: { accepted: true } }));
    const r = await relayWith(f as never).request("report.progress", { text: "t" });
    expect(r.ok && r.value).toEqual({ accepted: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:7777/v1/request");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(headers["content-type"]).toBe("application/json");
    const body = JSON.parse(String(init.body));
    expect(body.operation).toBe("report.progress");
    expect(body.params).toEqual({ text: "t" });
    expect(body.requestId).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  });

  it("daemon の失敗（4xx・5xx）は、code・cause・nextActions をそのまま返す", async () => {
    for (const status of [400, 401, 403, 404, 422, 500]) {
      const error = { code: "c", cause: "原因", nextActions: ["次"] };
      const r = await relayWith((async () => json(status, { ok: false, error })) as never).request(
        "tree.list",
        {},
      );
      expect(!r.ok && r.error).toEqual(error);
    }
  });

  it("接続できない・タイムアウトは、nextActions つきの失敗にする。トークンを含めない", async () => {
    const down = relayWith((async () => {
      throw new Error(`connect failed ${TOKEN}`);
    }) as never);
    const r = await down.request("tree.list", {});
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.nextActions.length).toBeGreaterThan(0);
      expect(JSON.stringify(r.error)).not.toContain(TOKEN);
    }
    const slow = relayWith(
      ((_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        })) as never,
      { timeoutMs: 20 },
    );
    const t = await slow.request("tree.list", {});
    expect(!t.ok && t.error.code).toBe("daemon_timeout");
  });

  it("送る本文が上限（1 MiB）を超えるなら、送らずに失敗にする", async () => {
    const f = vi.fn(async () => json(200, { ok: true, value: {} }));
    const r = await relayWith(f as never).request("node.send", {
      text: "x".repeat(MAX_RELAY_BYTES),
    });
    expect(r.ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });

  it("応答が上限を超えるなら失敗にする", async () => {
    const big = "x".repeat(MAX_RELAY_BYTES + 10);
    const r = await relayWith((async () => new Response(big, { status: 200 })) as never).request(
      "tree.list",
      {},
    );
    expect(!r.ok && r.error.code).toBe("daemon_response_too_large");
  });

  it("応答の形が Result でないなら失敗にする", async () => {
    for (const body of [null, 1, [], {}, { ok: "yes" }, { ok: false }, { ok: false, error: {} }]) {
      const r = await relayWith((async () => json(200, body)) as never).request("tree.list", {});
      expect(r.ok, JSON.stringify(body)).toBe(false);
    }
  });
});
