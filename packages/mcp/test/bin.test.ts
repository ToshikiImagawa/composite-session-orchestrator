import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { main, parseArgs } from "../src/main.js";

const URL1 = "http://127.0.0.1:7777";
const noFile = () => {
  throw new Error("読まない");
};
const cfg = (mcpUrl: unknown) => () => JSON.stringify({ stateDir: "/s", mcpUrl });

describe("cso-mcp の引数", () => {
  it("--daemon-url と --port を読む。環境変数でも指定できる（引数が優先）", () => {
    expect(parseArgs(["--daemon-url", URL1, "--port", "8123"], {}, { readFile: noFile })).toEqual({
      ok: true,
      value: { daemonUrl: URL1, port: 8123 },
    });
    expect(
      parseArgs([], { CSO_DAEMON_URL: URL1, CSO_MCP_PORT: "8123" }, { readFile: noFile }),
    ).toEqual({ ok: true, value: { daemonUrl: URL1, port: 8123 } });
    const both = parseArgs(
      ["--port", "9000"],
      { CSO_DAEMON_URL: URL1, CSO_MCP_PORT: "8123" },
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
    expect(r).toEqual({ ok: true, value: { daemonUrl: URL1, port: 7788 } });
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
    const r = await main(["--daemon-url", URL1, "--port", port], {}, x.io, {
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
    const r = await main(["--daemon-url", URL1, "--port", port], {}, x.io, {
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
