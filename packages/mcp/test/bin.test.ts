import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { hostPortOf, proofOf } from "../src/identity.js";
import { main, parseArgs } from "../src/main.js";

const DID = "00112233445566778899aabbccddeeff";

const URL1 = "http://127.0.0.1:7777";
const noFile = () => {
  throw new Error("読まない");
};
const cfg = (mcpUrl: unknown) => () => JSON.stringify({ stateDir: "/s", mcpUrl });
/** 検証なしで動く（`--config` なし）ための環境変数。ちょうど "1" のときだけ有効。 */
const UNVERIFIED = { CSO_MCP_ALLOW_UNVERIFIED: "1" };

describe("cso-mcp の引数", () => {
  it("--daemon-url と --port を読む。環境変数でも指定できる（引数が優先）", () => {
    expect(
      parseArgs(["--daemon-url", URL1, "--port", "8123"], UNVERIFIED, { readFile: noFile }),
    ).toEqual({
      ok: true,
      value: { daemonUrl: URL1, port: 8123, strictStart: false },
    });
    expect(
      parseArgs(
        [],
        { CSO_DAEMON_URL: URL1, CSO_MCP_PORT: "8123", ...UNVERIFIED },
        { readFile: noFile },
      ),
    ).toEqual({ ok: true, value: { daemonUrl: URL1, port: 8123, strictStart: false } });
    const both = parseArgs(
      ["--port", "9000"],
      { CSO_DAEMON_URL: URL1, CSO_MCP_PORT: "8123", ...UNVERIFIED },
      { readFile: noFile },
    );
    expect(both.ok && both.value.port).toBe(9000);
  });

  it.each([
    [[], {}],
    [["--port", "8123"], {}],
    [["--daemon-url", URL1], {}],
    [["--daemon-url", URL1, "--port", "0"], {}],
    [["--daemon-url", URL1, "--port", "65536"], {}],
    [["--daemon-url", URL1, "--port", "abc"], {}],
    [["--daemon-url", URL1, "--port", "80.5"], {}],
    [["--daemon-url", URL1, "--port", "8123", "--unknown", "x"], {}],
    [["--daemon-url"], {}],
  ])("不正な引数 %j は拒否する", (argv, env) => {
    const r = parseArgs(argv as string[], env as Record<string, string>, { readFile: noFile });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.nextActions.length).toBeGreaterThan(0);
  });
});

describe("--config（daemon の設定から mcpUrl のポートを読む）", () => {
  it("--port がなければ、設定の mcpUrl のポートを使う（--daemon-url は別に必要）", () => {
    const r = parseArgs(
      ["--daemon-url", URL1, "--config", "/c.json"],
      {},
      { readFile: cfg("http://127.0.0.1:7788/mcp") },
    );
    expect(r).toEqual({
      ok: true,
      value: {
        daemonUrl: URL1,
        port: 7788,
        identityPath: "/s/daemon-identity",
        strictStart: true,
      },
    });
  });

  it("環境変数 CSO_DAEMON_CONFIG でも指定できる", () => {
    const r = parseArgs(
      ["--daemon-url", URL1],
      { CSO_DAEMON_CONFIG: "/c.json" },
      { readFile: cfg("http://localhost:7788/mcp") },
    );
    expect(r.ok && r.value.port).toBe(7788);
  });

  it("--port と設定のポートが違えば拒否する（mcpUrl とずれると、子が接続できない）。同じなら通る", () => {
    const bad = parseArgs(
      ["--daemon-url", URL1, "--config", "/c.json", "--port", "9"],
      {},
      { readFile: cfg("http://127.0.0.1:7788/mcp") },
    );
    expect(bad.ok).toBe(false);
    const good = parseArgs(
      ["--daemon-url", URL1, "--config", "/c.json", "--port", "7788"],
      {},
      { readFile: cfg("http://127.0.0.1:7788/mcp") },
    );
    expect(good.ok).toBe(true);
  });

  it.each([
    ["mcpUrl がない", () => JSON.stringify({})],
    ["mcpUrl が文字列でない", cfg(5)],
    ["URL でない", cfg("not a url")],
    ["ポートがない", cfg("http://127.0.0.1/mcp")],
    ["ループバックでない", cfg("http://example.com:7788/mcp")],
    ["JSON でない", () => "{oops"],
    [
      "読めない",
      () => {
        throw new Error("ENOENT secret-path");
      },
    ],
  ])("設定が不正（%s）なら拒否する。原因に、ファイルの内容を出さない", (_name, readFile) => {
    const r = parseArgs(["--daemon-url", URL1, "--config", "/c.json"], {}, { readFile });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.nextActions.length).toBeGreaterThan(0);
      expect(r.error.cause).not.toContain("secret-path");
    }
  });
});

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: { stdout: (t: string) => out.push(t), stderr: (t: string) => err.push(t) },
  };
};

describe("起動時の確認（daemon に届くか）", () => {
  it("GET /v1/whoami を 1 回送り、401 が返れば daemon がいるとみなして待ち受ける", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (u: string) => {
      calls.push(u);
      return new Response("{}", { status: 401 });
    }) as unknown as typeof fetch;
    const x = io();
    const port = String(await freePort());
    const r = await main(["--daemon-url", URL1, "--port", port], UNVERIFIED, x.io, {
      fetch: fetchImpl,
      readFile: noFile,
    });
    expect(r.exitCode).toBe(0);
    expect(calls).toEqual([`${URL1}/v1/whoami`]);
    expect(x.out.join("")).toContain("listening");
    await r.server?.close();
  });

  it("daemon に届かなければ、待ち受けずに失敗にする（原因にトークン・本文はない）", async () => {
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const x = io();
    const port = String(await freePort());
    const r = await main(["--daemon-url", URL1, "--port", port], UNVERIFIED, x.io, {
      fetch: fetchImpl,
      readFile: noFile,
    });
    expect(r.exitCode).toBe(1);
    expect(r.server).toBeUndefined();
    expect(x.err.join("")).toContain("daemon");
  });

  it("引数が不正なら、終了コード 2", async () => {
    const x = io();
    const r = await main([], {}, x.io, { readFile: noFile });
    expect(r.exitCode).toBe(2);
  });
});

describe("daemon の身元確認の設定（T10m-i2）", () => {
  const args = ["--daemon-url", URL1, "--port", "8123"];

  it("--config がないと、既定では起動しない（invalid_config）", () => {
    const r = parseArgs(args, {}, { readFile: noFile });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("invalid_config");
      expect(r.error.cause).toContain("CSO_MCP_ALLOW_UNVERIFIED=1");
    }
  });

  it.each(["true", "", "0", "yes", " 1", "1 ", "TRUE", "2"])(
    "CSO_MCP_ALLOW_UNVERIFIED=%j では、検証なしで動かさない（ちょうど 1 のときだけ）",
    (v) => {
      expect(parseArgs(args, { CSO_MCP_ALLOW_UNVERIFIED: v }, { readFile: noFile }).ok).toBe(false);
    },
  );

  it("CSO_MCP_ALLOW_UNVERIFIED=1 なら、--config なしで動く（identityPath なし）", () => {
    const r = parseArgs(args, UNVERIFIED, { readFile: noFile });
    expect(r).toEqual({ ok: true, value: { daemonUrl: URL1, port: 8123, strictStart: false } });
  });

  it("--config があるときは、CSO_MCP_ALLOW_UNVERIFIED=1 があっても検証する（identityPath あり）", () => {
    const r = parseArgs(["--daemon-url", URL1, "--config", "/c.json"], UNVERIFIED, {
      readFile: cfg("http://127.0.0.1:7788/mcp"),
    });
    expect(r.ok && r.value.identityPath).toBe("/s/daemon-identity");
  });

  it.each([
    ["stateDir が相対パス", { stateDir: "state", mcpUrl: "http://127.0.0.1:7788/mcp" }],
    ["stateDir が ./ で始まる相対パス", { stateDir: "./s", mcpUrl: "http://127.0.0.1:7788/mcp" }],
    ["stateDir が空", { stateDir: "", mcpUrl: "http://127.0.0.1:7788/mcp" }],
    ["stateDir が文字列でない", { stateDir: 5, mcpUrl: "http://127.0.0.1:7788/mcp" }],
    ["stateDir がない", { mcpUrl: "http://127.0.0.1:7788/mcp" }],
  ])("設定が不正（%s）なら起動を拒否する", (_n, conf) => {
    const r = parseArgs(
      ["--daemon-url", URL1, "--config", "/c.json"],
      {},
      { readFile: () => JSON.stringify(conf) },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("invalid_config");
  });

  it("検証なしで動くときは、起動のログ（identityUnverified）を 1 回だけ出す", async () => {
    const fetchImpl = (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch;
    const x = io();
    const port = String(await freePort());
    const r = await main(["--daemon-url", URL1, "--port", port], UNVERIFIED, x.io, {
      fetch: fetchImpl,
      readFile: noFile,
    });
    expect(r.exitCode).toBe(0);
    const warned = x.err.filter((l) => l.includes("identityUnverified"));
    expect(warned).toHaveLength(1);
    await r.server?.close();
  });

  it("--config なしで、環境変数もなければ、終了コード 2（待ち受けない）", async () => {
    const x = io();
    const r = await main(["--daemon-url", URL1, "--port", "8123"], {}, x.io, { readFile: noFile });
    expect(r.exitCode).toBe(2);
    expect(r.server).toBeUndefined();
  });

  it("--no-strict-start: 検証ありで起動したとき、起動時にも 1 回検証し、失敗しても起動は止めずに警告を出す", async () => {
    const fetchImpl = (async (u: string) => {
      if (u.includes("/v1/identity")) return new Response("{}", { status: 404 });
      return new Response("{}", { status: 401 });
    }) as unknown as typeof fetch;
    const x = io();
    const port = String(await freePort());
    const r = await main(
      ["--daemon-url", URL1, "--config", "/c.json", "--port", port, "--no-strict-start"],
      {},
      x.io,
      {
        fetch: fetchImpl,
        readFile: () => JSON.stringify({ stateDir: "/s", mcpUrl: `http://127.0.0.1:${port}/mcp` }),
        readIdentityFile: () => {
          throw new Error("ENOENT");
        },
      },
    );
    expect(r.exitCode).toBe(0);
    expect(x.err.join("")).toContain("identityCheckFailed");
    expect(x.err.join("")).not.toContain("identityUnverified");
    await r.server?.close();
  });

  describe("--strict-start（T10m-i3）", () => {
    const cfg = (port: string) => () =>
      JSON.stringify({ stateDir: "/s", mcpUrl: `http://127.0.0.1:${port}/mcp` });
    const run = async (
      identityStatus: number | "throw",
      extra: string[] = [],
      sleeps: number[] = [],
      statuses?: number[],
    ) => {
      let n = 0;
      const fetchImpl = (async (u: string) => {
        if (u.includes("/v1/identity")) {
          if (identityStatus === "throw") throw new Error("ECONNRESET");
          const st = statuses?.[Math.min(n++, statuses.length - 1)] ?? identityStatus;
          if (st === 200) {
            const nonce = new URL(u).searchParams.get("nonce") ?? "";
            const proof = proofOf(
              { daemonId: DID, secret: "ff".repeat(32) },
              hostPortOf(URL1) ?? "",
              nonce,
            );
            return Response.json({ ok: true, value: { daemonId: DID, proof } });
          }
          return new Response("{}", { status: st });
        }
        return new Response("{}", { status: 401 });
      }) as unknown as typeof fetch;
      const x = io();
      const port = String(await freePort());
      const r = await main(
        ["--daemon-url", URL1, "--config", "/c.json", "--port", port, ...extra],
        {},
        x.io,
        {
          fetch: fetchImpl,
          readFile: cfg(port),
          readIdentityFile: () =>
            identityStatus === 404
              ? (() => {
                  throw new Error("ENOENT");
                })()
              : JSON.stringify({ version: 1, daemonId: DID, secret: "ff".repeat(32) }),
          sleep: async (ms) => {
            sleeps.push(ms);
          },
        },
      );
      return { r, x };
    };

    it("既定で強制: 身元の失敗なら、待たずに終了コード 3（待ち受けない）。トークン類は出さない", async () => {
      const sleeps: number[] = [];
      const { r, x } = await run(404, [], sleeps);
      expect(r.exitCode).toBe(3);
      expect(r.server).toBeUndefined();
      expect(sleeps).toEqual([]);
      const err = x.err.join("");
      expect(err).toContain("daemon_identity_failed");
      expect(err).toContain("identityCheckFailed");
    });

    it("--strict-start の明示も、同じ（強制）", async () => {
      const { r } = await run(404, ["--strict-start"]);
      expect(r.exitCode).toBe(3);
    });

    it("一時的な失敗（503）は 1・2・4・8 秒待って、最大 5 回試す。尽きたら終了コード 1", async () => {
      const sleeps: number[] = [];
      const { r, x } = await run(503, [], sleeps);
      expect(r.exitCode).toBe(1);
      expect(r.server).toBeUndefined();
      expect(sleeps).toEqual([1000, 2000, 4000, 8000]);
      expect(x.err.join("")).toContain("identityCheckRetry");
    });

    it("一時的な失敗が途中で回復すれば、起動する", async () => {
      const sleeps: number[] = [];
      const { r } = await run(503, [], sleeps, [503, 503, 200]);
      expect(r.exitCode).toBe(0);
      expect(sleeps).toEqual([1000, 2000]);
      await r.server?.close();
    });

    it("一時的な失敗のあとで、身元の失敗に変わったら、待たずに終了コード 3", async () => {
      const sleeps: number[] = [];
      const { r } = await run(503, [], sleeps, [503, 404]);
      expect(r.exitCode).toBe(3);
      expect(sleeps).toEqual([1000]);
    });

    it("--no-strict-start は警告だけで起動する", async () => {
      const { r, x } = await run(404, ["--no-strict-start"]);
      expect(r.exitCode).toBe(0);
      expect(x.err.join("")).toContain("identityCheckFailed");
      await r.server?.close();
    });

    it.each([
      [["--strict-start", "--no-strict-start"]],
      [["--strict-start", "--strict-start", "--no-strict-start"]],
    ])("両方の指定（%j）は終了コード 2", async (extra) => {
      const { r } = await run(404, extra);
      expect(r.exitCode).toBe(2);
    });

    it("--config なしの --strict-start は終了コード 2（検証がないので強制できない）", async () => {
      const x = io();
      const r = await main(
        ["--daemon-url", URL1, "--port", "8123", "--strict-start"],
        UNVERIFIED,
        x.io,
        { readFile: noFile },
      );
      expect(r.exitCode).toBe(2);
    });

    it("parseArgs: strictStart は、検証あり（--config）のとき既定で true、--no-strict-start で false", () => {
      const base = ["--daemon-url", URL1, "--config", "/c.json"];
      const deps = {
        readFile: () => JSON.stringify({ stateDir: "/s", mcpUrl: "http://127.0.0.1:8123/mcp" }),
      };
      const def = parseArgs(base, {}, deps);
      const relaxed = parseArgs([...base, "--no-strict-start"], {}, deps);
      expect(def.ok && def.value.strictStart).toBe(true);
      expect(relaxed.ok && relaxed.value.strictStart).toBe(false);
    });
  });
});
