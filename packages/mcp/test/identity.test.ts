import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIdentityVerifier,
  hostPortOf,
  IDENTITY_MAX_BYTES,
  type IdentityVerifierOptions,
  parseIdentityFile,
  proofMatches,
  proofOf,
  RESTART_BUDGET_MS,
  readIdentityFileSecure,
} from "../src/identity.js";
import { createRelay } from "../src/relay.js";

const DAEMON_ID = "00112233445566778899aabbccddeeff";
const SECRET = "ff".repeat(32);
const PORT = 43210;
const URL1 = `http://127.0.0.1:${PORT}`;
const NONCE = "0123456789abcdef0123456789abcdef";
const fileText = (o: Record<string, unknown> = {}) =>
  `${JSON.stringify({ version: 1, daemonId: DAEMON_ID, secret: SECRET, ...o })}\n`;

describe("proofOf（契約 §3 の試験ベクトル）", () => {
  const id = { daemonId: DAEMON_ID, secret: SECRET };
  it("daemon の実装と同じ値になる", () => {
    expect(proofOf(id, "127.0.0.1:43210", NONCE)).toBe(
      "a4c03bfab8207e7a550d464c02f9467f4bed4a7e504bfb5da6fe98b22e29be3a",
    );
    expect(proofOf(id, "127.0.0.1:43211", NONCE)).toBe(
      "1577069198737695bc2df73dc098dce25f6abd3157c269450ab49f29d58f4855",
    );
  });
  it("定数時間の比較: 同じなら一致、違い・長さ違い・空は不一致", () => {
    const p = proofOf(id, "127.0.0.1:43210", NONCE);
    expect(proofMatches(p, p)).toBe(true);
    expect(proofMatches(p, `${p.slice(0, 63)}0`)).toBe(false);
    expect(proofMatches(p, p.slice(0, 62))).toBe(false);
    expect(proofMatches(p, "")).toBe(false);
  });
});

describe("parseIdentityFile・hostPortOf", () => {
  it("正しい形だけを読む", () => {
    expect(parseIdentityFile(fileText())).toEqual({ daemonId: DAEMON_ID, secret: SECRET });
  });
  it.each([
    ["version が 1 でない", fileText({ version: 2 })],
    ["version がない", JSON.stringify({ daemonId: DAEMON_ID, secret: SECRET })],
    ["daemonId が短い", fileText({ daemonId: "00" })],
    ["daemonId が大文字", fileText({ daemonId: DAEMON_ID.toUpperCase() })],
    ["secret が短い", fileText({ secret: "ff".repeat(31) })],
    ["secret が 16 進でない", fileText({ secret: "zz".repeat(32) })],
    ["secret が文字列でない", fileText({ secret: 5 })],
    ["JSON でない", "{oops"],
    ["配列", "[]"],
    ["null", "null"],
    ["大きすぎる", " ".repeat(5000) + fileText()],
  ])("信用しない: %s", (_n, text) => {
    expect(parseIdentityFile(text)).toBeUndefined();
  });
  it("hostPort: localhost・[::1] も 127.0.0.1 にする。ポートがなければ undefined", () => {
    expect(hostPortOf("http://127.0.0.1:43210")).toBe("127.0.0.1:43210");
    expect(hostPortOf("http://localhost:43210")).toBe("127.0.0.1:43210");
    expect(hostPortOf("http://[::1]:43210")).toBe("127.0.0.1:43210");
    expect(hostPortOf("http://127.0.0.1")).toBeUndefined();
    expect(hostPortOf("not a url")).toBeUndefined();
  });
});

/** 偽・本物の daemon を、fetch の差し替えで作る。 */
type Reply = Response | Error | (() => Response | Promise<Response>);
const rig = (over: Partial<IdentityVerifierOptions> = {}) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const replies: Reply[] = [];
  const files: (string | Error)[] = [fileText()];
  const sleeps: number[] = [];
  const fetchImpl = (async (u: string, init?: RequestInit) => {
    calls.push({ url: u, init });
    const r = replies.shift();
    if (r === undefined) throw new Error("予定外の呼び出し");
    if (r instanceof Error) throw r;
    return typeof r === "function" ? await r() : r;
  }) as unknown as typeof fetch;
  const v = createIdentityVerifier({
    daemonUrl: URL1,
    identityPath: "/s/daemon-identity",
    fetch: fetchImpl,
    readFile: () => {
      const f = files.length > 1 ? files.shift() : files[0];
      if (f instanceof Error) throw f;
      return f as string;
    },
    random: (n) => randomBytes(n),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    jitter: () => 0,
    ...over,
  });
  /** 本物の daemon の応答（nonce は URL から取り、自分の secret・ポートで proof を作る）。 */
  const genuine =
    (secret = SECRET, port = PORT, daemonId = DAEMON_ID): Reply =>
    () => {
      const nonce = new URL(calls[calls.length - 1]?.url ?? "").searchParams.get("nonce") ?? "";
      const proof = proofOf({ daemonId, secret }, `127.0.0.1:${port}`, nonce);
      return Response.json({ ok: true, value: { daemonId, proof } });
    };
  return { v, calls, replies, files, sleeps, genuine };
};

describe("createIdentityVerifier", () => {
  it("本物の daemon なら成功する。要求は GET /v1/identity?nonce=<小文字 16 進 32 桁>・Bearer なし・redirect: manual", async () => {
    const r = rig();
    r.replies.push(r.genuine());
    expect(await r.v.verify()).toEqual({ ok: true, daemonId: DAEMON_ID });
    expect(r.calls).toHaveLength(1);
    const url = new URL(r.calls[0]?.url ?? "");
    expect(url.origin + url.pathname).toBe(`${URL1}/v1/identity`);
    expect(url.searchParams.get("nonce")).toMatch(/^[0-9a-f]{32}$/);
    expect([...url.searchParams.keys()]).toEqual(["nonce"]);
    expect(r.calls[0]?.init?.method).toBe("GET");
    expect(r.calls[0]?.init?.redirect).toBe("manual");
    expect(JSON.stringify(r.calls[0]?.init?.headers ?? {})).not.toMatch(/authorization/i);
  });

  it("キャッシュしない: 検証のたびに、新しい nonce で呼ぶ", async () => {
    const r = rig();
    r.replies.push(r.genuine(), r.genuine());
    await r.v.verify();
    await r.v.verify();
    const nonces = r.calls.map((c) => new URL(c.url).searchParams.get("nonce"));
    expect(nonces).toHaveLength(2);
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it("ファイルは毎回開き直す（呼ぶたびに読む）", async () => {
    let reads = 0;
    const r = rig({
      readFile: () => {
        reads++;
        return fileText();
      },
    });
    r.replies.push(r.genuine(), r.genuine());
    await r.v.verify();
    await r.v.verify();
    expect(reads).toBe(2);
  });

  it("proof が違えば、1 度だけやり直して、それでも違えば daemon_identity_failed（原因に secret・proof を出さない）", async () => {
    const r = rig();
    r.replies.push(r.genuine("aa".repeat(32)), r.genuine("aa".repeat(32)));
    const res = await r.v.verify();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("identity");
      expect(res.failure.code).toBe("daemon_identity_failed");
      const text = JSON.stringify(res.failure);
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("aa".repeat(32));
    }
    expect(r.calls).toHaveLength(2);
  });

  it("daemon の再起動で秘密が変わっても、ファイルを読み直して 1 度のやり直しで成功する", async () => {
    const NEW = "11".repeat(32);
    const r = rig();
    r.files.length = 0;
    r.files.push(fileText(), fileText({ secret: NEW }));
    r.replies.push(r.genuine(NEW), r.genuine(NEW));
    expect(await r.v.verify()).toEqual({ ok: true, daemonId: DAEMON_ID });
    expect(r.calls).toHaveLength(2);
  });

  it.each([
    ["別の daemonId", (r: ReturnType<typeof rig>) => r.genuine(SECRET, PORT, "ff".repeat(16))],
    [
      "別のポートの proof（本物の identity を中継した偽の daemon）",
      (r: ReturnType<typeof rig>) => r.genuine(SECRET, PORT + 1),
    ],
    ["JSON でない", () => new Response("<html>", { status: 200 })],
    ["ok がない", () => Response.json({ value: { daemonId: DAEMON_ID, proof: "0".repeat(64) } })],
    ["value がない", () => Response.json({ ok: true })],
    [
      "proof が 16 進でない",
      () => Response.json({ ok: true, value: { daemonId: DAEMON_ID, proof: "z".repeat(64) } }),
    ],
    [
      "proof が大文字",
      () => Response.json({ ok: true, value: { daemonId: DAEMON_ID, proof: "A".repeat(64) } }),
    ],
    ["404（古い daemon・別のプロセス）", () => new Response("", { status: 404 })],
    ["400", () => new Response("", { status: 400 })],
    ["403", () => new Response("", { status: 403 })],
    ["405", () => new Response("", { status: 405 })],
    ["500", () => new Response("", { status: 500 })],
    ["502", () => new Response("", { status: 502 })],
    ["401", () => new Response("", { status: 401 })],
    ["302", () => new Response("", { status: 302, headers: { location: "http://evil" } })],
    ["上限を超える本文", () => new Response("x".repeat(IDENTITY_MAX_BYTES + 1), { status: 200 })],
  ])("身元の失敗（%s）は、daemon_identity_failed。トークンは送らない", async (_n, mk) => {
    const r = rig();
    r.replies.push(mk(r) as Reply, mk(r) as Reply);
    const res = await r.v.verify();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe("daemon_identity_failed");
    expect(r.calls).toHaveLength(2);
    for (const c of r.calls) {
      expect(JSON.stringify(c.init?.headers ?? {})).not.toMatch(/authorization/i);
    }
  });

  it.each([
    ["ファイルが読めない（ENOENT 以外）", new Error("EIO")],
    ["形が違う（version 2）", fileText({ version: 2 })],
  ])(
    "秘密のファイルが使えない（%s）: 身元の失敗。daemon へ呼ばず、読み直しは 1 度",
    async (_n, f) => {
      const r = rig();
      r.files.length = 0;
      r.files.push(f);
      const res = await r.v.verify();
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.failure.code).toBe("daemon_identity_failed");
      expect(r.calls).toHaveLength(0);
    },
  );

  it("daemonUrl にポートがなければ、身元の失敗", async () => {
    const r = rig({ daemonUrl: "http://127.0.0.1" });
    const res = await r.v.verify();
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.failure.code).toBe("daemon_identity_failed");
    expect(r.calls).toHaveLength(0);
  });

  it("待たない指定のとき、接続できない・タイムアウト・503 は通常の失敗（やり直さない）", async () => {
    const a = rig();
    a.replies.push(new Error("ECONNREFUSED"));
    const ra = await a.v.verify({ waitForRestart: false });
    expect(!ra.ok && ra.kind).toBe("transient");
    expect(!ra.ok && ra.failure.code).toBe("daemon_unreachable");
    expect(a.calls).toHaveLength(1);

    // fetch の差し替えは abort を見ないので、abort で reject する応答を作る
    const slow = createIdentityVerifier({
      daemonUrl: URL1,
      identityPath: "/s/x",
      readFile: () => fileText(),
      timeoutMs: 20,
      fetch: ((_u: string, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () => rej(new Error("aborted")));
        })) as unknown as typeof fetch,
    });
    const rt = await slow.verify();
    expect(!rt.ok && rt.failure.code).toBe("daemon_timeout");

    const u = rig();
    u.replies.push(new Response("", { status: 503 }));
    const ru = await u.v.verify({ waitForRestart: false });
    expect(!ru.ok && ru.kind).toBe("transient");
    expect(!ru.ok && ru.failure.code).toBe("daemon_unreachable");
    expect(u.calls).toHaveLength(1);
  });

  describe("daemon の再起動の途中（要求の中で待ってかけ直す）", () => {
    const enoent = () => Object.assign(new Error("no such file"), { code: "ENOENT" });
    const fakeClock = () => {
      let t = 0;
      return {
        now: () => t,
        sleep: async (ms: number) => {
          t += ms;
        },
        get t() {
          return t;
        },
      };
    };

    it("ENOENT のあと 2 回目で成功: ファイルを読み直し、新しい nonce で確かめる。記録に秘密・ID・パスを出さない", async () => {
      const logs: unknown[] = [];
      const r = rig({ restartJitter: () => 100, log: (e) => logs.push(e) });
      r.files.length = 0;
      r.files.push(enoent(), fileText());
      r.replies.push(r.genuine());
      expect(await r.v.verify()).toEqual({ ok: true, daemonId: DAEMON_ID });
      expect(r.sleeps).toEqual([600]);
      expect(r.calls).toHaveLength(1);
      expect(logs).toEqual([
        { event: "daemonRetry", attempt: 1, reason: "identityFileMissing", waitMs: 600 },
        { event: "daemonRecovered", attempts: 2 },
      ]);
      const text = JSON.stringify(logs);
      for (const s of [DAEMON_ID, SECRET, "/s/daemon-identity"]) expect(text).not.toContain(s);
    });

    it("接続の拒否・503 も待ってかけ直す（毎回、新しい nonce）", async () => {
      const logs: { reason?: string }[] = [];
      const r = rig({ restartJitter: () => 0, log: (e) => logs.push(e as { reason?: string }) });
      r.replies.push(new Error("ECONNREFUSED"), new Response("", { status: 503 }), r.genuine());
      expect(await r.v.verify()).toEqual({ ok: true, daemonId: DAEMON_ID });
      expect(r.sleeps).toEqual([500, 1000]);
      expect(logs.map((l) => l.reason)).toEqual(["refused", "unavailable", undefined]);
      const nonces = r.calls.map((c) => new URL(c.url).searchParams.get("nonce"));
      expect(new Set(nonces).size).toBe(3);
    });

    it("尽きたら daemon_unreachable。待った合計は 8 秒以内（偽の時計）。案内は cso-mcp の起動し直しを求めない", async () => {
      const clock = fakeClock();
      const logs: { event: string }[] = [];
      const r = rig({
        restartJitter: () => 250,
        now: clock.now,
        sleep: clock.sleep,
        log: (e) => logs.push(e),
      });
      r.files.length = 0;
      r.files.push(enoent());
      const res = await r.v.verify();
      expect(res.ok).toBe(false);
      expect(!res.ok && res.kind).toBe("transient");
      expect(!res.ok && res.failure.code).toBe("daemon_unreachable");
      expect(!res.ok && res.failure.nextActions.join(" ")).toContain("cso-mcp の起動し直しは不要");
      expect(clock.t).toBeLessThanOrEqual(RESTART_BUDGET_MS);
      expect(clock.t).toBe(750 + 1250 + 2250 + 3750);
      expect(r.calls).toHaveLength(0);
      expect(logs.at(-1)).toEqual({ event: "daemonGaveUp" });
    });

    it("予算は、待ちの合計ではなく、確認を始めてからの経過時間で測る（確認そのものの時間も含む）。budgetMs で狭められる", async () => {
      let t = 0;
      const r = rig({
        restartJitter: () => 0,
        now: () => t,
        sleep: async (ms) => {
          t += ms;
        },
        fetch: (async () => {
          t += 3_000; // 1 回の確認に 3 秒かかる（接続の拒否が遅い）
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
      });
      const res = await r.v.verify();
      expect(!res.ok && res.failure.code).toBe("daemon_unreachable");
      expect(t).toBeLessThanOrEqual(RESTART_BUDGET_MS + 3_000); // 最後の確認の 1 回分だけ超えうる
      t = 0;
      const narrow = await r.v.verify({ budgetMs: 1_000 });
      expect(!narrow.ok && narrow.failure.code).toBe("daemon_unreachable");
      expect(t).toBe(3_000); // 1 回目で予算を使い切り、待たない
    });

    it("体裁の正しいファイルで proof が合わないときは、待たずに daemon_identity_failed", async () => {
      const r = rig();
      r.replies.push(r.genuine("aa".repeat(32)), r.genuine("aa".repeat(32)));
      const res = await r.v.verify();
      expect(!res.ok && res.failure.code).toBe("daemon_identity_failed");
      expect(r.sleeps).toEqual([]);
      expect(r.calls).toHaveLength(2);
    });

    it("ENOENT 以外の読めない理由（権限など）は、身元の失敗（待たない）", async () => {
      const r = rig();
      r.files.length = 0;
      r.files.push(Object.assign(new Error("EACCES"), { code: "EACCES" }));
      const res = await r.v.verify();
      expect(!res.ok && res.failure.code).toBe("daemon_identity_failed");
      expect(r.sleeps).toEqual([]);
    });
  });

  it("429: Retry-After（上限 10 秒）+ ジッターを待って 1 度だけやり直す。2 度目も 429 なら rate_limited", async () => {
    const r = rig({ jitter: () => 7 });
    r.replies.push(new Response("", { status: 429, headers: { "retry-after": "3" } }), r.genuine());
    expect(await r.v.verify()).toEqual({ ok: true, daemonId: DAEMON_ID });
    expect(r.sleeps).toEqual([3007]);

    const l = rig();
    l.replies.push(
      new Response("", { status: 429, headers: { "retry-after": "99" } }),
      new Response("", { status: 429, headers: { "retry-after": "99" } }),
    );
    const res = await l.v.verify();
    expect(!res.ok && res.kind).toBe("transient");
    expect(!res.ok && res.failure.code).toBe("rate_limited");
    expect(l.sleeps).toEqual([10_000]);
    expect(l.calls).toHaveLength(2);
  });
});

describe("relay と身元確認: 失敗のときは、トークンを送らない", () => {
  const TOKEN = "secret-token-0123456789";
  const mk = (
    verify: () => Promise<
      { ok: true; daemonId: string } | { ok: false; kind: "identity" | "transient"; failure: never }
    >,
  ) => {
    const sent: string[] = [];
    const fetchImpl = (async (_u: string, init?: RequestInit) => {
      sent.push(JSON.stringify(init?.headers ?? {}));
      return Response.json(
        { ok: true, value: { role: "child" } },
        { headers: { "x-cso-daemon-id": DAEMON_ID } },
      );
    }) as unknown as typeof fetch;
    const relay = createRelay({
      daemonUrl: URL1,
      token: TOKEN,
      fetch: fetchImpl,
      verifier: { verify: verify as never },
    });
    if (!relay.ok) throw new Error("relay");
    return { relay: relay.value, sent };
  };
  const failed = (kind: "identity" | "transient", code: string) =>
    ({
      ok: false,
      kind,
      failure: { code, cause: "c", nextActions: ["n"] },
    }) as never;

  it("whoami: 身元の失敗なら daemon_identity_failed。fetch（トークンつき）は呼ばれない", async () => {
    const { relay, sent } = mk(async () => failed("identity", "daemon_identity_failed"));
    const r = await relay.whoami();
    expect(!r.ok && r.error.code).toBe("daemon_identity_failed");
    expect(sent).toHaveLength(0);
  });

  it("request: 身元の失敗は、再送もしない（トークンつきの呼び出しは 0 回）。結果は「実行していない」失敗", async () => {
    let n = 0;
    const { relay, sent } = mk(async () => {
      n++;
      return failed("identity", "daemon_identity_failed");
    });
    const r = await relay.request("tree.list", {});
    expect(!r.ok && r.error.code).toBe("daemon_identity_failed");
    expect(n).toBe(1);
    expect(sent).toHaveLength(0);
  });

  it("request: 通常の失敗（接続できない）でも、トークンは送らず、daemon_result_unknown にしない", async () => {
    const { relay, sent } = mk(async () => failed("transient", "daemon_unreachable"));
    const r = await relay.request("tree.list", {});
    expect(!r.ok && r.error.code).toBe("daemon_unreachable");
    expect(sent).toHaveLength(0);
  });

  it("成功したときだけ、トークンを送る。送るたび（whoami・request・再送）に、直前で検証する", async () => {
    let n = 0;
    const { relay, sent } = mk(async () => {
      n++;
      return { ok: true, daemonId: DAEMON_ID };
    });
    expect((await relay.whoami()).ok).toBe(true);
    expect(n).toBe(1);
    expect(sent).toHaveLength(1);
    await relay.request("tree.list", {});
    expect(n).toBe(2);
  });
});

describe("relay: 応答の x-cso-daemon-id を、検証で得た daemonId と照合する（検証から送信までの窓の検知）", () => {
  const TOKEN = "secret-token-0123456789";
  const mk = (headers: Record<string, string>, onMismatch?: () => void) => {
    const fetchImpl = (async () =>
      Response.json(
        { ok: true, value: { role: "child" } },
        { headers },
      )) as unknown as typeof fetch;
    const relay = createRelay({
      daemonUrl: URL1,
      token: TOKEN,
      fetch: fetchImpl,
      verifier: { verify: async () => ({ ok: true, daemonId: DAEMON_ID }) },
      ...(onMismatch === undefined ? {} : { onIdentityMismatch: onMismatch }),
    });
    if (!relay.ok) throw new Error("relay");
    return relay.value;
  };

  it("一致すれば、応答を受け取る", async () => {
    const r = await mk({ "x-cso-daemon-id": DAEMON_ID }).whoami();
    expect(r.ok && r.value.role).toBe("child");
  });

  it.each([
    ["別の daemonId", { "x-cso-daemon-id": "ff".repeat(16) }],
    ["ヘッダーがない", {}],
    ["空", { "x-cso-daemon-id": "" }],
    ["大文字（形が違う）", { "x-cso-daemon-id": DAEMON_ID.toUpperCase() }],
  ])(
    "不一致（%s）: 応答を捨てて daemon_identity_failed にし、知らせる。再送しない",
    async (_n, headers) => {
      let mismatches = 0;
      const r = mk(headers, () => {
        mismatches++;
      });
      const who = await r.whoami();
      expect(!who.ok && who.error.code).toBe("daemon_identity_failed");
      expect(JSON.stringify(who)).not.toContain("child"); // 応答の内容は返さない
      expect(mismatches).toBe(1);
      const req = await r.request("tree.list", {});
      expect(!req.ok && req.error.code).toBe("daemon_identity_failed");
      expect(!req.ok && req.error.nextActions.join(" ")).toContain("再発行");
      expect(mismatches).toBe(2);
    },
  );
});

describe("検証の fetch は、リダイレクトに従わない（3xx は身元の失敗）", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });
  const listen = async (handler: Parameters<typeof createServer>[1]) => {
    const s = createServer(handler);
    servers.push(s);
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    return (s.address() as { port: number }).port;
  };

  it.each([301, 302, 303, 307, 308])(
    "本物の HTTP サーバーが %d を返しても、辿らず、身元の失敗にする",
    async (status) => {
      const hits: string[] = [];
      const target = await listen((req, res) => {
        hits.push(req.url ?? "");
        res.writeHead(200).end("{}");
      });
      const port = await listen((_req, res) => {
        res.writeHead(status, { location: `http://127.0.0.1:${target}/elsewhere` }).end();
      });
      const v = createIdentityVerifier({
        daemonUrl: `http://127.0.0.1:${port}`,
        identityPath: "/s/x",
        readFile: () => fileText(),
      });
      const res = await v.verify();
      expect(!res.ok && res.kind).toBe("identity");
      expect(!res.ok && res.failure.code).toBe("daemon_identity_failed");
      expect(hits).toEqual([]);
    },
  );
});

describe("readIdentityFileSecure（O_NOFOLLOW・fstat。daemon の assertSecureFile と対称）", () => {
  let dir: string;
  const setup = () => {
    dir = mkdtempSync(join(tmpdir(), "cso-id-"));
    return dir;
  };
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  });
  const write = (name: string, mode: number, text = fileText()) => {
    const p = join(setup(), name);
    writeFileSync(p, text, { mode });
    chmodSync(p, mode);
    return p;
  };

  it("0600 の通常のファイルは読める", () => {
    expect(readIdentityFileSecure(write("ok", 0o600))).toBe(fileText());
  });

  it.each([0o644, 0o640, 0o604, 0o660, 0o666, 0o755])("権限が緩い（%o）と拒否する", (mode) => {
    expect(() => readIdentityFileSecure(write("loose", mode))).toThrow();
  });

  it("symlink は辿らない（リンク先が正しいファイルでも拒否）", () => {
    const real = write("real", 0o600);
    const link = join(dir, "link");
    symlinkSync(real, link);
    expect(() => readIdentityFileSecure(link)).toThrow();
  });

  it("FIFO は、ブロックせずに拒否する", () => {
    const p = join(setup(), "fifo");
    execFileSync("mkfifo", [p]);
    chmodSync(p, 0o600);
    expect(() => readIdentityFileSecure(p)).toThrow();
  });

  it("ディレクトリ・存在しないものは拒否する", () => {
    expect(() => readIdentityFileSecure(setup())).toThrow();
    expect(() => readIdentityFileSecure(join(dir, "none"))).toThrow();
  });

  it("4 KiB を超えるものは拒否する", () => {
    expect(() => readIdentityFileSecure(write("big", 0o600, " ".repeat(4097)))).toThrow();
  });

  it("所有者が自分でなければ拒否する（getuid を差し替えて確かめる）", () => {
    const p = write("owner", 0o600);
    expect(() => readIdentityFileSecure(p, { getuid: () => 0x7ffffff0 })).toThrow();
    expect(readIdentityFileSecure(p, { getuid: () => process.getuid?.() })).toBe(fileText());
  });

  it("verifier の既定の読み出しは、これを使う（緩い権限のファイルは、身元の失敗）", async () => {
    const v = createIdentityVerifier({
      daemonUrl: URL1,
      identityPath: write("loose2", 0o644),
      fetch: (async () => {
        throw new Error("呼ばれない");
      }) as unknown as typeof fetch,
    });
    const res = await v.verify();
    expect(!res.ok && res.failure.code).toBe("daemon_identity_failed");
  });
});

describe("relay と再起動の待ち（本物の検証器）", () => {
  const TOKEN = "secret-token-0123456789";
  const mk = (identityReplies: (Error | "genuine")[], tokenReplies: (Error | Response)[]) => {
    const sleeps: number[] = [];
    const files: (string | Error)[] = [];
    const tokenSent: string[] = [];
    let identityCalls = 0;
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const url = new URL(u);
      if (url.pathname === "/v1/identity") {
        identityCalls++;
        const r = identityReplies.shift() ?? "genuine";
        if (r instanceof Error) throw r;
        const nonce = url.searchParams.get("nonce") ?? "";
        const proof = proofOf({ daemonId: DAEMON_ID, secret: SECRET }, `127.0.0.1:${PORT}`, nonce);
        return Response.json({ ok: true, value: { daemonId: DAEMON_ID, proof } });
      }
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (auth.includes(TOKEN)) tokenSent.push(url.pathname);
      const r = tokenReplies.shift();
      if (r === undefined) throw new Error("予定外の呼び出し");
      if (r instanceof Error) throw r;
      return r;
    }) as unknown as typeof fetch;
    const verifier = createIdentityVerifier({
      daemonUrl: URL1,
      identityPath: "/s/daemon-identity",
      fetch: fetchImpl,
      readFile: () => {
        const f = files.shift() ?? fileText();
        if (f instanceof Error) throw f;
        return f;
      },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      restartJitter: () => 0,
    });
    const relay = createRelay({
      daemonUrl: URL1,
      token: TOKEN,
      fetch: fetchImpl,
      verifier,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    if (!relay.ok) throw new Error("relay");
    return { relay: relay.value, sleeps, files, tokenSent, identityCalls: () => identityCalls };
  };
  const whoamiOk = () =>
    Response.json(
      { ok: true, value: { role: "human" } },
      { headers: { "x-cso-daemon-id": DAEMON_ID } },
    );

  it("ENOENT のあと 2 回目で成功: トークンを送るのは、成功の後の 1 回だけ", async () => {
    const m = mk([], [whoamiOk()]);
    m.files.push(Object.assign(new Error("x"), { code: "ENOENT" }));
    const r = await m.relay.whoami();
    expect(r).toEqual({ ok: true, value: { role: "human" } });
    expect(m.tokenSent).toEqual(["/v1/whoami"]);
    expect(m.sleeps).toEqual([500]);
    expect(m.identityCalls()).toBe(1);
  });

  it("401 はやり直さない（身元の確認は 1 回、トークンつきも 1 回、待ちなし）", async () => {
    const m = mk(
      [],
      [
        Response.json(
          { ok: false, error: { code: "unauthenticated", cause: "c", nextActions: ["n"] } },
          { status: 401, headers: { "x-cso-daemon-id": DAEMON_ID } },
        ),
      ],
    );
    const r = await m.relay.whoami();
    expect(!r.ok && r.error.code).toBe("unauthenticated");
    expect(m.tokenSent).toHaveLength(1);
    expect(m.identityCalls()).toBe(1);
    expect(m.sleeps).toEqual([]);
  });

  it("送ったあとの失敗（接続の失敗）は、再起動の待ちでかけ直さない", async () => {
    const m = mk([], [new Error("ECONNRESET")]);
    const r = await m.relay.whoami();
    expect(r.ok).toBe(false);
    expect(m.tokenSent).toEqual(["/v1/whoami"]);
    expect(m.sleeps).toEqual([]);
  });

  it("x-cso-daemon-id の不一致は、やり直さずに daemon_identity_failed", async () => {
    const m = mk(
      [],
      [
        Response.json(
          { ok: true, value: { role: "human" } },
          { headers: { "x-cso-daemon-id": "ff".repeat(16) } },
        ),
      ],
    );
    const r = await m.relay.whoami();
    expect(!r.ok && r.error.code).toBe("daemon_identity_failed");
    expect(m.tokenSent).toHaveLength(1);
    expect(m.sleeps).toEqual([]);
  });
});

describe("relay の再送と身元の確認", () => {
  it("1 回目は送ったが応答なし、再送の前の確認が尽きた: daemon_result_unknown（「送っていない」にしない）", async () => {
    let verifies = 0;
    const budgets: (number | undefined)[] = [];
    const relay = createRelay({
      daemonUrl: URL1,
      token: "secret-token-0123456789",
      fetch: (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch,
      verifier: {
        verify: async (o) => {
          budgets.push(o?.budgetMs);
          return verifies++ === 0
            ? { ok: true, daemonId: DAEMON_ID }
            : {
                ok: false,
                kind: "transient",
                failure: { code: "daemon_unreachable", cause: "c", nextActions: ["n"] },
              };
        },
      },
    });
    if (!relay.ok) throw new Error("relay");
    const r = await relay.value.request("tree.list", {});
    expect(!r.ok && r.error.code).toBe("daemon_result_unknown");
    expect(verifies).toBe(2);
    // 確認には、締め切りの残りを渡す
    expect(budgets.every((b) => typeof b === "number" && b > 0)).toBe(true);
  });
});

describe("relay の再送と身元の確認（429）", () => {
  it("429 のあと、再送の前の確認が尽きた: 前の 429（rate_limited）を返す", async () => {
    let verifies = 0;
    const relay = createRelay({
      daemonUrl: URL1,
      token: "secret-token-0123456789",
      fetch: (async () =>
        new Response("", {
          status: 429,
          headers: { "retry-after": "1", "x-cso-daemon-id": DAEMON_ID },
        })) as unknown as typeof fetch,
      sleep: async () => {},
      verifier: {
        verify: async () =>
          verifies++ === 0
            ? { ok: true, daemonId: DAEMON_ID }
            : {
                ok: false,
                kind: "transient",
                failure: { code: "daemon_unreachable", cause: "c", nextActions: ["n"] },
              },
      },
    });
    if (!relay.ok) throw new Error("relay");
    const r = await relay.value.request("tree.list", {});
    expect(!r.ok && r.error.code).toBe("rate_limited");
    expect(verifies).toBe(2);
  });
});
