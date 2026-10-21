/**
 * `cso-mcp` の起動。引数（または環境変数）の検査と、待ち受けの開始。
 * `--daemon-url`（`CSO_DAEMON_URL`）: daemon の窓口。ループバックだけ。`--port`（`CSO_MCP_PORT`）: 待ち受けるポート（1〜65535。
 * daemon の設定 `mcpUrl` のポートと合わせる）。引数が環境変数より優先。
 */
import { type Failure, failure, ok, type Result } from "@cso/core";
import { createMcpHttpServer, type McpHttpServer } from "./http-server.js";

export interface McpCliArgs {
  readonly daemonUrl: string;
  readonly port: number;
}

const bad = (cause: string): Result<never> => ({
  ok: false,
  error: failure(
    "invalid_config",
    cause,
    "引数・環境変数を確認する",
    "cso-mcp --daemon-url <URL> --port <ポート>",
  ),
});

export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Result<McpCliArgs> {
  let daemonUrl = env.CSO_DAEMON_URL;
  let portText = env.CSO_MCP_PORT;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined) return bad(`${String(flag)} に値がない`);
    if (flag === "--daemon-url") daemonUrl = value;
    else if (flag === "--port") portText = value;
    else return bad(`未知の引数: ${String(flag)}`);
  }
  if (daemonUrl === undefined || daemonUrl === "")
    return bad("daemon の URL（--daemon-url）が必要");
  if (portText === undefined || !/^[0-9]{1,5}$/.test(portText))
    return bad("ポート（--port）は 1〜65535 の整数");
  const port = Number(portText);
  if (port < 1 || port > 65535) return bad("ポート（--port）は 1〜65535 の整数");
  return ok({ daemonUrl, port });
}

export interface MainResult {
  readonly exitCode: number;
  /** 待ち受けを始めたときだけ。止めるのは呼び出し側。 */
  readonly server?: McpHttpServer;
}

export async function main(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: { stdout(t: string): void; stderr(t: string): void },
): Promise<MainResult> {
  const fail = (e: Failure): MainResult => {
    io.stderr(`失敗 [${e.code}]: ${e.cause}\n  次の操作: ${e.nextActions.join(" / ")}\n`);
    return { exitCode: e.code === "invalid_config" ? 2 : 1 };
  };
  const args = parseArgs(argv, env);
  if (!args.ok) return fail(args.error);
  const created = createMcpHttpServer({
    daemonUrl: args.value.daemonUrl,
    logger: (e) => io.stderr(`${JSON.stringify(e)}\n`),
  });
  if (!created.ok) return fail(created.error);
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
