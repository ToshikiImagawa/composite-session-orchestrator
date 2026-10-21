import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/main.js";

describe("cso-mcp の引数", () => {
  it("--daemon-url と --port を読む。環境変数でも指定できる（引数が優先）", () => {
    expect(parseArgs(["--daemon-url", "http://127.0.0.1:7777", "--port", "8123"], {})).toEqual({
      ok: true,
      value: { daemonUrl: "http://127.0.0.1:7777", port: 8123 },
    });
    expect(
      parseArgs([], { CSO_DAEMON_URL: "http://127.0.0.1:7777", CSO_MCP_PORT: "8123" }),
    ).toEqual({ ok: true, value: { daemonUrl: "http://127.0.0.1:7777", port: 8123 } });
    const both = parseArgs(["--port", "9000"], {
      CSO_DAEMON_URL: "http://127.0.0.1:7777",
      CSO_MCP_PORT: "8123",
    });
    expect(both.ok && both.value.port).toBe(9000);
  });

  it.each([
    [[], {}],
    [["--port", "8123"], {}],
    [["--daemon-url", "http://127.0.0.1:1"], {}],
    [["--daemon-url", "http://127.0.0.1:1", "--port", "0"], {}],
    [["--daemon-url", "http://127.0.0.1:1", "--port", "65536"], {}],
    [["--daemon-url", "http://127.0.0.1:1", "--port", "abc"], {}],
    [["--daemon-url", "http://127.0.0.1:1", "--port", "80.5"], {}],
    [["--daemon-url", "http://127.0.0.1:1", "--port", "8123", "--unknown", "x"], {}],
    [["--daemon-url"], {}],
  ])("不正な引数 %j は拒否する", (argv, env) => {
    const r = parseArgs(argv as string[], env as Record<string, string>);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.nextActions.length).toBeGreaterThan(0);
  });
});
