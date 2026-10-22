import { describe, expect, it, vi } from "vitest";
import {
  createRelay,
  DEFAULT_TIMEOUT_MS,
  LONG_OPERATION_TIMEOUT_MS,
  MAX_RELAY_BYTES,
  timeoutFor,
} from "../src/index.js";

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
    expect(!t.ok && t.error.code).toBe("daemon_result_unknown");
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

describe("二重実行の防止（タイムアウト・接続失敗）", () => {
  it("接続の失敗では、同じ requestId で 1 度だけ再送する。2 回目に成功すればその結果を返す", async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new Error("reset");
      return json(200, { ok: true, value: { accepted: true } });
    });
    const r = await relayWith(f as never).request("report.progress", { text: "t" });
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
    const ids = f.mock.calls.map(
      (c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).requestId,
    );
    expect(ids[0]).toBe(ids[1]);
  });

  it("再送でも失敗したら、結果は不明と案内する（状態を確かめるよう促す。呼び直しとは言わない）", async () => {
    const f = vi.fn(async () => {
      throw new Error("down");
    });
    const r = await relayWith(f as never).request("node.spawn", {});
    expect(f).toHaveBeenCalledTimes(2);
    expect(!r.ok && r.error.code).toBe("daemon_result_unknown");
    if (!r.ok) {
      expect(r.error.cause).toContain("結果は不明");
      expect(r.error.nextActions.join(" ")).toContain("tree_list");
      expect(r.error.nextActions.join(" ")).not.toContain("呼び直");
    }
  });

  it("タイムアウトも同様（再送し、それでも失敗なら結果は不明）", async () => {
    const f = vi.fn(
      (_u: string, init: RequestInit) =>
        new Promise((_res, rej) => {
          init.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        }),
    );
    const r = await relayWith(f as never, { timeoutMs: 15 }).request("tree.list", {});
    expect(f).toHaveBeenCalledTimes(2);
    expect(!r.ok && r.error.code).toBe("daemon_result_unknown");
  });

  it("daemon の応答（失敗を含む）が返ったときは、再送しない", async () => {
    const f = vi.fn(async () =>
      json(422, { ok: false, error: { code: "c", cause: "x", nextActions: ["n"] } }),
    );
    await relayWith(f as never).request("node.spawn", {});
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("whoami は読み取りなので、失敗を結果は不明にしない", async () => {
    const r = await relayWith((async () => {
      throw new Error("x");
    }) as never).whoami();
    expect(!r.ok && r.error.code).toBe("daemon_unreachable");
  });

  it("操作ごとのタイムアウト: spawn・split・reclaim は長め", () => {
    expect(timeoutFor("node.spawn")).toBe(LONG_OPERATION_TIMEOUT_MS);
    expect(timeoutFor("node.split")).toBe(LONG_OPERATION_TIMEOUT_MS);
    expect(timeoutFor("node.reclaim")).toBe(LONG_OPERATION_TIMEOUT_MS);
    expect(timeoutFor("tree.list")).toBe(DEFAULT_TIMEOUT_MS);
    expect(LONG_OPERATION_TIMEOUT_MS).toBeGreaterThan(DEFAULT_TIMEOUT_MS);
  });
});

describe("その他の防御", () => {
  it("リダイレクトは辿らない（redirect: error）", async () => {
    const f = vi.fn(async () => json(200, { ok: true, value: {} }));
    await relayWith(f as never).request("tree.list", {});
    expect((f.mock.calls[0] as unknown as [string, RequestInit])[1].redirect).toBe("error");
    await relayWith(f as never).whoami();
    expect((f.mock.calls[1] as unknown as [string, RequestInit])[1].redirect).toBe("error");
  });

  it("トークンの長さに上限がある（8 KiB）", () => {
    expect(createRelay({ daemonUrl: "http://127.0.0.1:1", token: "a".repeat(8192) }).ok).toBe(true);
    expect(createRelay({ daemonUrl: "http://127.0.0.1:1", token: "a".repeat(8193) }).ok).toBe(
      false,
    );
  });

  it("daemon の失敗の cause・nextActions は、長さを抑える（約 2000 文字）", async () => {
    const error = { code: "c", cause: "x".repeat(10_000), nextActions: ["y".repeat(10_000), "z"] };
    const r = await relayWith((async () => json(422, { ok: false, error })) as never).request(
      "tree.list",
      {},
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.cause.length).toBeLessThanOrEqual(2000);
      expect(r.error.nextActions[0]?.length).toBeLessThanOrEqual(2000);
      expect(r.error.nextActions).toHaveLength(2);
    }
  });
});

const tooMany = (retryAfter?: string) =>
  new Response(
    JSON.stringify({
      ok: false,
      error: { code: "tooManyRequests", cause: "要求が多すぎる", nextActions: ["待つ"] },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        ...(retryAfter ? { "retry-after": retryAfter } : {}),
      },
    },
  );
const okRes = () => json(200, { ok: true, value: { accepted: true } });
const idOf = (call: unknown): string =>
  JSON.parse(String((call as [string, RequestInit])[1].body)).requestId;

describe("429（回数の制限。daemon は実行していない）", () => {
  const rig = (responses: (() => Response | Promise<Response>)[], extra: object = {}) => {
    const sleeps: number[] = [];
    const queue = [...responses];
    const f = vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("予定外の呼び出し");
      return next();
    });
    const relay = relayWith(f as never, {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => 0,
      ...extra,
    });
    return { relay, f, sleeps };
  };

  it("Retry-After の秒数だけ待ち、同じ requestId で 1 回だけ再送する", async () => {
    const { relay, f, sleeps } = rig([() => tooMany("2"), okRes]);
    const r = await relay.request("report.progress", { text: "t" });
    expect(r.ok).toBe(true);
    expect(sleeps).toEqual([2000]);
    expect(f).toHaveBeenCalledTimes(2);
    expect(idOf(f.mock.calls[0])).toBe(idOf(f.mock.calls[1]));
  });

  it.each([
    ["99", 10_000],
    ["10", 10_000],
    ["0", 0],
    [undefined, 1000],
    ["abc", 1000],
    ["-3", 1000],
    ["1.5", 1000],
    ["Wed, 21 Oct 2026 07:28:00 GMT", 1000],
  ])(
    "Retry-After %j は、待つ時間 %i ms（上限 10 秒。不正・なしは 1 秒）",
    async (header, expected) => {
      const { relay, sleeps } = rig([() => tooMany(header), okRes]);
      await relay.request("tree.list", {});
      expect(sleeps).toEqual([expected]);
    },
  );

  it("2 回目も 429 なら、rate_limited を返す（実行されていないので、呼び直してよい）。再送は 1 回だけ", async () => {
    const { relay, f } = rig([() => tooMany("1"), () => tooMany("3")]);
    const r = await relay.request("node.spawn", {});
    expect(f).toHaveBeenCalledTimes(2);
    expect(!r.ok && r.error.code).toBe("rate_limited");
    if (!r.ok) {
      expect((r.error as { retryAfterSec?: number }).retryAfterSec).toBe(3);
      expect(r.error.nextActions.join(" ")).toContain("実行されていない");
    }
  });

  it("401 に付いた Retry-After では、再送しない", async () => {
    const f = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: { code: "unauthenticated", cause: "x", nextActions: ["n"] },
          }),
          { status: 401, headers: { "retry-after": "5" } },
        ),
    );
    const sleeps: number[] = [];
    const r = await relayWith(f as never, {
      sleep: async (ms: number) => void sleeps.push(ms),
    }).request("tree.list", {});
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(!r.ok && r.error.code).toBe("unauthenticated");
  });

  it("429 の後に接続が失敗しても、同じ requestId で再送する（送信は合計 3 回まで）", async () => {
    const { relay, f } = rig([
      () => tooMany("1"),
      () => {
        throw new Error("reset");
      },
      okRes,
    ]);
    const r = await relay.request("tree.list", {});
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(3);
    const ids = new Set(f.mock.calls.map(idOf));
    expect(ids.size).toBe(1);
  });

  it("429 の後に接続が 2 回失敗したら、結果は不明", async () => {
    const boom = () => {
      throw new Error("down");
    };
    const { relay, f } = rig([() => tooMany("1"), boom, boom]);
    const r = await relay.request("tree.list", {});
    expect(f).toHaveBeenCalledTimes(3);
    expect(!r.ok && r.error.code).toBe("daemon_result_unknown");
  });

  it("whoami の 429 は、Retry-After（10 秒まで）だけ待って、1 度だけ再送する（読み取りなので安全）", async () => {
    const { relay, f, sleeps } = rig([
      () => tooMany("4"),
      () => json(200, { ok: true, value: { role: "child" } }),
    ]);
    const r = await relay.whoami();
    expect(r.ok && r.value.role).toBe("child");
    expect(f).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([4000]);
  });

  it("whoami が 2 回続けて 429 なら、rate_limited を返す（retryAfterSec を持つ）", async () => {
    const { relay, f } = rig([() => tooMany("4"), () => tooMany("99")]);
    const r = await relay.whoami();
    expect(f).toHaveBeenCalledTimes(2);
    expect(!r.ok && r.error.code).toBe("rate_limited");
    if (!r.ok) expect((r.error as { retryAfterSec?: number }).retryAfterSec).toBe(10);
  });
});

const inProgress = (retryAfter = "2") =>
  new Response(
    JSON.stringify({
      ok: false,
      error: { code: "inProgress", cause: "同じ要求を処理中", nextActions: ["待つ"] },
    }),
    { status: 409, headers: { "content-type": "application/json", "retry-after": retryAfter } },
  );
const conflict = () =>
  new Response(
    JSON.stringify({
      ok: false,
      error: { code: "requestIdConflict", cause: "別の内容", nextActions: ["新しい requestId"] },
    }),
    { status: 422, headers: { "content-type": "application/json" } },
  );

describe("409 inProgress（同じ要求を処理中。daemon は実行していない）", () => {
  const rig2 = (responses: (() => Response)[], extra: object = {}) => {
    const sleeps: number[] = [];
    const queue = [...responses];
    const f = vi.fn(async () => {
      const next = queue.shift();
      if (next === undefined) throw new Error("予定外の呼び出し");
      return next();
    });
    const relay = relayWith(f as never, {
      sleep: async (ms: number) => void sleeps.push(ms),
      random: () => 0,
      ...extra,
    });
    return { relay, f, sleeps };
  };

  it("429 と同じように、Retry-After だけ待って、同じ requestId で 1 回だけ再送する", async () => {
    const { relay, f, sleeps } = rig2([() => inProgress("3"), okRes]);
    const r = await relay.request("node.spawn", {});
    expect(r.ok).toBe(true);
    expect(sleeps).toEqual([3000]);
    expect(f).toHaveBeenCalledTimes(2);
    expect(idOf(f.mock.calls[0])).toBe(idOf(f.mock.calls[1]));
  });

  it("2 回続けて 409 なら、in_progress を返す（実行されていない）", async () => {
    const { relay, f } = rig2([() => inProgress(), () => inProgress()]);
    const r = await relay.request("node.spawn", {});
    expect(f).toHaveBeenCalledTimes(2);
    expect(!r.ok && r.error.code).toBe("in_progress");
  });

  it("429 と 409 を合わせて、再送は 1 回だけ（送信は合計 3 回まで）", async () => {
    const { relay, f } = rig2([() => tooMany("1"), () => inProgress(), okRes]);
    const r = await relay.request("tree.list", {});
    expect(f).toHaveBeenCalledTimes(2);
    expect(!r.ok && r.error.code).toBe("in_progress");
  });

  it("422 requestIdConflict は再送しない", async () => {
    const { relay, f, sleeps } = rig2([conflict]);
    const r = await relay.request("tree.list", {});
    expect(f).toHaveBeenCalledTimes(1);
    expect(sleeps).toEqual([]);
    expect(!r.ok && r.error.code).toBe("requestIdConflict");
  });
});

describe("待ちの合計の締め切り（その操作のタイムアウト + 10 秒）と、ジッター", () => {
  it("ジッター: 429 のあとの待ちに、0〜500ms を加える", async () => {
    const mk = (random: number) => {
      const sleeps: number[] = [];
      const queue = [() => tooMany("2"), okRes];
      const f = async () => (queue.shift() as () => Response)();
      const relay = relayWith(f as never, {
        sleep: async (ms: number) => void sleeps.push(ms),
        random: () => random,
      });
      return { relay, sleeps };
    };
    const a = mk(0);
    await a.relay.request("tree.list", {});
    expect(a.sleeps).toEqual([2000]);
    const b = mk(0.5);
    await b.relay.request("tree.list", {});
    expect(b.sleeps).toEqual([2250]);
    const c = mk(0.999999);
    await c.relay.request("tree.list", {});
    expect(c.sleeps[0]).toBeLessThan(2500);
    expect(c.sleeps[0]).toBeGreaterThanOrEqual(2000);
  });

  it("接続の失敗で締め切りを過ぎたら、新しい再送は始めずに daemon_result_unknown を返す", async () => {
    let clock = 0;
    const f = vi.fn(async () => {
      clock += 12_000; // 1 回の呼び出しに、締め切り（1000 + 10000）を超える時間がかかった
      throw new Error("down");
    });
    const relay = relayWith(f as never, { timeoutMs: 1000, now: () => clock, random: () => 0 });
    const r = await relay.request("tree.list", {});
    expect(f).toHaveBeenCalledTimes(1);
    expect(!r.ok && r.error.code).toBe("daemon_result_unknown");
  });

  it("429 の待ちで締め切りを過ぎるなら、再送せずに rate_limited を返す（実行されていないので、結果は不明にしない）", async () => {
    let clock = 0;
    const f = vi.fn(async () => {
      clock += 5_000; // 1 回目の呼び出しに 5 秒かかり、このあと 10 秒待つと、締め切り（1000 + 10000）を超える
      return tooMany("10");
    });
    const relay = relayWith(f as never, {
      timeoutMs: 1000,
      now: () => clock,
      random: () => 0,
      sleep: async (ms: number) => {
        clock += ms;
      },
    });
    const r = await relay.request("tree.list", {});
    expect(f).toHaveBeenCalledTimes(1);
    expect(!r.ok && r.error.code).toBe("rate_limited");
  });

  it("締め切りの内側なら、再送する", async () => {
    let clock = 0;
    const queue = [() => tooMany("2"), okRes];
    const f = vi.fn(async () => (queue.shift() as () => Response)());
    const relay = relayWith(f as never, {
      timeoutMs: 1000,
      now: () => clock,
      random: () => 0,
      sleep: async (ms: number) => {
        clock += ms;
      },
    });
    const r = await relay.request("tree.list", {});
    expect(r.ok).toBe(true);
    expect(f).toHaveBeenCalledTimes(2);
  });
});
