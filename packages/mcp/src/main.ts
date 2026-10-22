/**
 * `cso-mcp` の起動。引数（または環境変数）の検査と、待ち受けの開始。
 * - `--daemon-url`（`CSO_DAEMON_URL`）: daemon の窓口。ループバックだけ。
 * - `--port`（`CSO_MCP_PORT`）: 待ち受けるポート（1〜65535。daemon の設定 `mcpUrl` のポートと合わせる）。
 * - `--config`（`CSO_DAEMON_CONFIG`）: daemon の設定ファイル。`--port` がなければ、`mcpUrl` のポートを使う（`--port` も
 *   あって違うときは拒否する）。設定の内容は、失敗の原因に出さない。
 * 引数が環境変数より優先。起動の前に、daemon に届くか確かめる（`GET /v1/whoami`。401 が返れば daemon がいるとみなす）。
 */
import { readFileSync } from "node:fs";
import { type Failure, failure, ok, type Result } from "@cso/core";
import { createMcpHttpServer, type McpHttpServer } from "./http-server.js";

export interface McpCliArgs {
  readonly daemonUrl: string;
  readonly port: number;
}

export interface ParseDeps {
  readonly readFile?: (path: string) => string;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const bad = (cause: string): Result<never> => ({
  ok: false,
  error: failure(
    "invalid_config",
    cause,
    "引数・環境変数を確認する",
    "cso-mcp --daemon-url <URL> (--port <ポート> | --config <daemon の設定>)",
  ),
});

/** daemon の設定ファイルから、`mcpUrl` のポートを読む。内容は原因に出さない。 */
function portFromConfig(path: string, readFile: (p: string) => string): Result<number> {
  let text: string;
  try {
    text = readFile(path);
  } catch {
    return bad("daemon の設定ファイル（--config）を読めない");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return bad("daemon の設定ファイルが JSON でない");
  }
  const mcpUrl =
    typeof json === "object" && json !== null
      ? (json as Record<string, unknown>).mcpUrl
      : undefined;
  if (typeof mcpUrl !== "string") return bad("daemon の設定に mcpUrl がない");
  let url: URL;
  try {
    url = new URL(mcpUrl);
  } catch {
    return bad("daemon の設定の mcpUrl が URL でない");
  }
  if (!LOOPBACK.has(url.hostname)) return bad("daemon の設定の mcpUrl が、ループバックでない");
  if (!/^[0-9]{1,5}$/.test(url.port) || Number(url.port) < 1 || Number(url.port) > 65535) {
    return bad("daemon の設定の mcpUrl に、ポートがない");
  }
  return ok(Number(url.port));
}

export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: ParseDeps = {},
): Result<McpCliArgs> {
  let daemonUrl = env.CSO_DAEMON_URL;
  let portText = env.CSO_MCP_PORT;
  let configPath = env.CSO_DAEMON_CONFIG;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) return bad(`${String(flag)} に値がない`);
    if (flag === "--daemon-url") daemonUrl = value;
    else if (flag === "--port") portText = value;
    else if (flag === "--config") configPath = value;
    else return bad(`未知の引数: ${String(flag)}`);
  }
  if (daemonUrl === undefined || daemonUrl === "")
    return bad("daemon の URL（--daemon-url）が必要");
  let port: number | undefined;
  if (portText !== undefined) {
    if (!/^[0-9]{1,5}$/.test(portText)) return bad("ポート（--port）は 1〜65535 の整数");
    port = Number(portText);
    if (port < 1 || port > 65535) return bad("ポート（--port）は 1〜65535 の整数");
  }
  if (configPath !== undefined && configPath !== "") {
    const fromConfig = portFromConfig(
      configPath,
      deps.readFile ?? ((p) => readFileSync(p, "utf8")),
    );
    if (!fromConfig.ok) return fromConfig;
    if (port !== undefined && port !== fromConfig.value) {
      return bad("--port が、daemon の設定の mcpUrl のポートと違う（子が接続できなくなる）");
    }
    port = fromConfig.value;
  }
  if (port === undefined) return bad("ポート（--port）または daemon の設定（--config）が必要");
  return ok({ daemonUrl, port });
}

export interface MainResult {
  readonly exitCode: number;
  /** 待ち受けを始めたときだけ。止めるのは呼び出し側。 */
  readonly server?: McpHttpServer;
}

export interface MainDeps extends ParseDeps {
  readonly fetch?: typeof fetch;
}

/** daemon に届くか確かめる（認証なしの `GET /v1/whoami`。応答があれば、401 でも daemon がいるとみなす）。 */
async function daemonReachable(daemonUrl: string, doFetch: typeof fetch): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    await doFetch(`${new URL(daemonUrl).origin}/v1/whoami`, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: { stdout(t: string): void; stderr(t: string): void },
  deps: MainDeps = {},
): Promise<MainResult> {
  const fail = (e: Failure): MainResult => {
    io.stderr(`失敗 [${e.code}]: ${e.cause}\n  次の操作: ${e.nextActions.join(" / ")}\n`);
    return { exitCode: e.code === "invalid_config" ? 2 : 1 };
  };
  const args = parseArgs(argv, env, deps);
  if (!args.ok) return fail(args.error);
  const created = createMcpHttpServer({
    daemonUrl: args.value.daemonUrl,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    logger: (e) => io.stderr(`${JSON.stringify(e)}\n`),
  });
  if (!created.ok) return fail(created.error);
  if (!(await daemonReachable(args.value.daemonUrl, deps.fetch ?? globalThis.fetch))) {
    return fail(
      failure(
        "daemon_unreachable",
        "daemon の窓口に届かない",
        "daemon が起動しているか確認する（daemon → cso-mcp → 子の順）",
        "--daemon-url を確認する",
      ),
    );
  }
  try {
    const listening = await created.value.listen(args.value.port);
    io.stdout(`${JSON.stringify({ event: "listening", url: `${listening.url}/mcp` })}\n`);
    return { exitCode: 0, server: created.value };
  } catch (e) {
    return fail(
      failure(
        "listen_failed",
        `待ち受けを始められない: ${String(e instanceof Error ? e.message : e)}`,
        "ポートが空いているか確認する",
      ),
    );
  }
}
