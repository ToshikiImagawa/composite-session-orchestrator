/**
 * `cso-mcp` の起動。引数（または環境変数）の検査と、待ち受けの開始。
 * - `--daemon-url`（`CSO_DAEMON_URL`）: daemon の窓口。ループバックだけ。
 * - `--port`（`CSO_MCP_PORT`）: 待ち受けるポート（1〜65535。daemon の設定 `mcpUrl` のポートと合わせる）。
 * - `--config`（`CSO_DAEMON_CONFIG`）: daemon の設定ファイル。`--port` がなければ、`mcpUrl` のポートを使う（`--port` も
 *   あって違うときは拒否する）。設定の内容は、失敗の原因に出さない。
 * 引数が環境変数より優先。起動の前に、daemon に届くか確かめる（`GET /v1/whoami`。401 が返れば daemon がいるとみなす）。
 *
 * daemon の身元確認（T10m-i2。`docs/daemon-identity.md`）:
 * - `--config` が**必須**。設定の `stateDir`（絶対パス。相対なら拒否）の `daemon-identity` を使い、トークンつきの要求の直前に、
 *   毎回、daemon の身元を検証する。`--config` がないと、起動しない。
 * - 環境変数 `CSO_MCP_ALLOW_UNVERIFIED` が**ちょうど `1`** のときだけ、`--config` なしで、検証なしで動く（`true`・空文字などでは
 *   有効にしない）。起動のログ（`identityUnverified`）を 1 回と、すべての応答のヘッダー（`x-cso-identity: unverified`）で分かる。
 *   `--config` があるときは、この変数があっても検証する。
 */
import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { type Failure, failure, ok, type Result } from "@cso/core";
import { createMcpHttpServer, type IdentityMode, type McpHttpServer } from "./http-server.js";
import { createIdentityVerifier, IDENTITY_FILE } from "./identity.js";

export interface McpCliArgs {
  readonly daemonUrl: string;
  readonly port: number;
  /** 秘密のファイル（`<stateDir>/daemon-identity`）。検証なしで動くときは `undefined`。 */
  readonly identityPath?: string;
  /** 起動時の身元確認が失敗したら、起動しない（`--config` があるとき、既定で true。`--no-strict-start` で false）。 */
  readonly strictStart: boolean;
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

/** daemon の設定ファイルから、`mcpUrl` のポートと `stateDir` を読む。内容は原因に出さない。 */
function readConfig(
  path: string,
  readFile: (p: string) => string,
): Result<{ port: number; stateDir: string }> {
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
  const stateDir =
    typeof json === "object" && json !== null
      ? (json as Record<string, unknown>).stateDir
      : undefined;
  if (typeof stateDir !== "string" || stateDir === "")
    return bad("daemon の設定に stateDir がない");
  if (!isAbsolute(stateDir)) {
    return bad(
      "daemon の設定の stateDir が絶対パスでない（読むファイルが、起動した場所で変わってしまう）",
    );
  }
  return ok({ port: Number(url.port), stateDir });
}

/** 値を取らないフラグ。 */
const BOOLEAN_FLAGS: ReadonlySet<string> = new Set(["--strict-start", "--no-strict-start"]);

export function parseArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  deps: ParseDeps = {},
): Result<McpCliArgs> {
  let daemonUrl = env.CSO_DAEMON_URL;
  let portText = env.CSO_MCP_PORT;
  let configPath = env.CSO_DAEMON_CONFIG;
  let identityPath: string | undefined;
  let strict = false;
  let relaxed = false;
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    if (typeof flag === "string" && BOOLEAN_FLAGS.has(flag)) {
      if (flag === "--strict-start") strict = true;
      else relaxed = true;
      i -= 1; // 値を取らない（次の反復で、次の引数に進む）
      continue;
    }
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
  if (strict && relaxed) return bad("--strict-start と --no-strict-start は同時に指定できない");
  if (configPath !== undefined && configPath !== "") {
    const fromConfig = readConfig(configPath, deps.readFile ?? ((p) => readFileSync(p, "utf8")));
    if (!fromConfig.ok) return fromConfig;
    if (port !== undefined && port !== fromConfig.value.port) {
      return bad("--port が、daemon の設定の mcpUrl のポートと違う（子が接続できなくなる）");
    }
    port = fromConfig.value.port;
    identityPath = join(fromConfig.value.stateDir, IDENTITY_FILE);
  } else if (env.CSO_MCP_ALLOW_UNVERIFIED !== "1") {
    return bad(
      "daemon の設定（--config）が必要（daemon の身元を確認できないので、起動しない）。検証なしで動かすときだけ、CSO_MCP_ALLOW_UNVERIFIED=1 を付ける",
    );
  }
  if (port === undefined) return bad("ポート（--port）または daemon の設定（--config）が必要");
  if (strict && identityPath === undefined) {
    return bad(
      "--strict-start は、daemon の設定（--config）があるときだけ（検証がないので、強制できない）",
    );
  }
  return ok({
    daemonUrl,
    port,
    ...(identityPath === undefined ? {} : { identityPath }),
    strictStart: identityPath !== undefined && !relaxed,
  });
}

export interface MainResult {
  readonly exitCode: number;
  /** 待ち受けを始めたときだけ。止めるのは呼び出し側。 */
  readonly server?: McpHttpServer;
}

export interface MainDeps extends ParseDeps {
  readonly fetch?: typeof fetch;
  /** 秘密のファイルの読み出し（テスト用）。 */
  readonly readIdentityFile?: (path: string) => string;
  /** 起動時の身元確認の、一時的な失敗のあとの待ち（テスト用）。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** 起動時の到達確認・身元確認で、一時的な失敗のあとに待つ時間（最大 5 回試す。待ちの合計 15 秒）。 */
const STARTUP_RETRY_MS = [1_000, 2_000, 4_000, 8_000] as const;
/** 起動時の身元の失敗のあとに待つ時間（2 回だけ確認し直す。daemon の起動し直しの直後など、秘密が入れ替わる間を見込む）。 */
const STARTUP_IDENTITY_RETRY_MS = [1_000, 2_000] as const;
/** 身元の失敗の終了コード（daemon を起動し直して設定を確認するまで、再起動を繰り返しても直らない）。 */
const EXIT_IDENTITY = 3;

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
    return {
      exitCode:
        e.code === "invalid_config" ? 2 : e.code === "daemon_identity_failed" ? EXIT_IDENTITY : 1,
    };
  };
  const args = parseArgs(argv, env, deps);
  if (!args.ok) return fail(args.error);
  const verifier =
    args.value.identityPath === undefined
      ? undefined
      : createIdentityVerifier({
          daemonUrl: args.value.daemonUrl,
          identityPath: args.value.identityPath,
          ...(deps.fetch ? { fetch: deps.fetch } : {}),
          ...(deps.readIdentityFile ? { readFile: deps.readIdentityFile } : {}),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          log: (e) => io.stderr(`${JSON.stringify(e)}\n`),
        });
  const identity: IdentityMode =
    verifier === undefined ? { kind: "unverified" } : { kind: "verified", verifier };
  const created = createMcpHttpServer({
    daemonUrl: args.value.daemonUrl,
    identity,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    logger: (e) => io.stderr(`${JSON.stringify(e)}\n`),
  });
  if (!created.ok) return fail(created.error);
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const doFetch = deps.fetch ?? globalThis.fetch;
  const retryLog = (phase: string, attempt: number, waitMs: number) =>
    io.stderr(`${JSON.stringify({ event: "startupRetry", phase, attempt, waitMs })}\n`);
  // 到達確認。強制（既定）のときは、接続拒否など（daemon がまだ起動していない）を一時的な失敗として、待って確かめ直す。
  let reachable = await daemonReachable(args.value.daemonUrl, doFetch);
  if (args.value.strictStart) {
    for (const [i, wait] of STARTUP_RETRY_MS.entries()) {
      if (reachable) break;
      retryLog("reachable", i + 1, wait);
      await sleep(wait);
      reachable = await daemonReachable(args.value.daemonUrl, doFetch);
    }
  }
  if (!reachable) {
    return fail(
      failure(
        "daemon_unreachable",
        "daemon の窓口に届かない",
        "daemon が起動しているか確認する（daemon → cso-mcp → 子の順）",
        "--daemon-url を確認する",
      ),
    );
  }
  if (verifier !== undefined) {
    // 起動時にも検証する。強制（既定）のときは、失敗したら起動しない。
    // - 一時的な失敗: 待って最大 5 回試す（尽きたら終了コード 1）。
    // - 身元の失敗: 1 秒・2 秒の 2 回だけ待って確かめ直す（それでも失敗なら終了コード 3。人手での確認が要る）。
    // 強制でないとき（`--no-strict-start`）は、1 回だけで、失敗しても警告にとどめる（最初の要求が、daemon_identity_failed で失敗する）。
    let transientRetries = 0;
    let identityRetries = 0;
    for (;;) {
      // 起動時は、自前の待ち（下）を使う（要求の中の待ちは使わない）。
      const v = await verifier.verify({ waitForRestart: false });
      if (v.ok) break;
      io.stderr(
        `${JSON.stringify({ event: "identityCheckFailed", code: v.failure.code, at: new Date().toISOString() })}\n`,
      );
      if (!args.value.strictStart) break;
      const schedule = v.kind === "identity" ? STARTUP_IDENTITY_RETRY_MS : STARTUP_RETRY_MS;
      const used = v.kind === "identity" ? identityRetries++ : transientRetries++;
      const wait = schedule[used];
      if (wait === undefined) return fail(v.failure); // 身元の失敗は終了コード 3、一時的な失敗が尽きたら 1
      io.stderr(
        `${JSON.stringify({ event: "identityCheckRetry", attempt: used + 1, waitMs: wait })}\n`,
      );
      await sleep(wait);
    }
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
