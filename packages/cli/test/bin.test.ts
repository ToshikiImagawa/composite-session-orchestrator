import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runBin } from "../src/bin.js";

const TOKEN = "human-token-human-token-human-token-1234";
const ENV = {
  CSO_DAEMON_URL: "http://127.0.0.1:7777",
  CSO_HUMAN_TOKEN: TOKEN,
  CSO_CLI_ALLOW_UNVERIFIED: "1",
};
const TTY = { stdin: false, stdout: false };

/** 偽の窓口: POST /v1/request の要求を記録して、決まった応答を返す。 */
const fakeFetch = (value: unknown) => {
  const seen: { url: string; headers: Record<string, string>; body: unknown }[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    seen.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    return new Response(JSON.stringify({ ok: true, value }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { f, seen };
};

describe("cso（bin。T22-cli）", () => {
  it("環境変数で受けた窓口・トークンで POST /v1/request を呼ぶ。requestId はそのまま。出力にトークンを出さない", async () => {
    const { f, seen } = fakeFetch({ unbound: true, duplicate: false });
    const r = await runBin(["hook-unbind", "a", "--request-id", "again-1"], {
      env: ENV,
      isTTY: TTY,
      fetch: f,
    });
    expect(r.exitCode).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("http://127.0.0.1:7777/v1/request");
    expect(seen[0]?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.body).toMatchObject({
      requestId: "again-1",
      operation: "node.hookUnbind",
      params: { nodeId: "a" },
    });
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
  });

  it("daemon（偽の窓口）が、応答にトークンを入れても、出力・エラーには出さない（*** に置き換える）", async () => {
    const f = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error: { code: "boom", cause: `echo ${TOKEN} back`, nextActions: [`use ${TOKEN}`] },
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      )) as typeof fetch;
    const r = await runBin(["hook-unbind", "a"], { env: ENV, isTTY: TTY, fetch: f });
    expect(r.exitCode).toBe(1);
    expect(r.stdout + r.stderr).not.toContain(TOKEN);
    expect(r.stderr).toContain("echo *** back");
  });

  it("CSO_DAEMON_URL・CSO_HUMAN_TOKEN がなければ、終了コード 2（何も送らない）。--token の引数は受けない", async () => {
    const { f, seen } = fakeFetch({});
    for (const env of [
      { ...ENV, CSO_DAEMON_URL: undefined },
      { ...ENV, CSO_HUMAN_TOKEN: undefined },
      { ...ENV, CSO_HUMAN_TOKEN: "" },
    ]) {
      const r = await runBin(["hook-unbind", "a"], { env, isTTY: TTY, fetch: f });
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("CSO_HUMAN_TOKEN");
    }
    const t = await runBin(["hook-unbind", "a", "--token", TOKEN], {
      env: ENV,
      isTTY: TTY,
      fetch: f,
    });
    expect(t.exitCode).toBe(2);
    expect(seen).toEqual([]);
  });

  it("CSO_DAEMON_CONFIG がなければ、動かない（CSO_CLI_ALLOW_UNVERIFIED がちょうど 1 のときだけ例外）", async () => {
    const { f, seen } = fakeFetch({});
    for (const allow of [undefined, "true", "", "0"]) {
      const r = await runBin(["hook-unbind", "a"], {
        env: { ...ENV, CSO_CLI_ALLOW_UNVERIFIED: allow },
        isTTY: TTY,
        fetch: f,
      });
      expect(r.exitCode, String(allow)).toBe(2);
    }
    expect(seen).toEqual([]);
  });

  it("CSO_DAEMON_CONFIG があれば、トークンを送る前に身元を確かめる（秘密が読めなければ、トークンを送らない）", async () => {
    const { f, seen } = fakeFetch({ unbound: true, duplicate: false });
    const r = await runBin(["hook-unbind", "a"], {
      env: { ...ENV, CSO_CLI_ALLOW_UNVERIFIED: undefined, CSO_DAEMON_CONFIG: "/x/config.json" },
      isTTY: TTY,
      fetch: f,
      readFile: (p) => {
        if (p === "/x/config.json") return JSON.stringify({ stateDir: "/x/state" });
        throw new Error("no file");
      },
    });
    expect(r.exitCode).toBe(1);
    expect(seen.some((s) => s.headers.authorization !== undefined)).toBe(false);
  });

  it("cli が mcp から読むのは @cso/mcp/relay だけ。relay・identity は MCP SDK・zod を import しない", () => {
    const here = fileURLToPath(new URL("../src", import.meta.url));
    for (const f of readdirSync(here)) {
      const text = readFileSync(join(here, f), "utf8");
      for (const m of text.matchAll(/from\s+["'](@cso\/mcp[^"']*)["']/g)) {
        expect(m[1], f).toBe("@cso/mcp/relay");
      }
    }
    const mcp = fileURLToPath(new URL("../../mcp/src", import.meta.url));
    for (const f of ["relay-entry.ts", "relay.ts", "identity.ts"]) {
      const text = readFileSync(join(mcp, f), "utf8");
      expect(text, f).not.toMatch(/@modelcontextprotocol|from\s+["']zod["']/);
      for (const m of text.matchAll(/from\s+["'](\.[^"']*)["']/g)) {
        expect(["./identity.js", "./relay.js"], `${f}: ${m[1]}`).toContain(m[1]);
      }
    }
  });
});
