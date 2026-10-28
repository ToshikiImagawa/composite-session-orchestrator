/**
 * daemon の起動（コマンドライン）。`cso-daemon --config <設定ファイルの絶対パス>`。
 *
 * 設定がない・不正なとき、実際のエージェントの起動（launcher）・git の作業ツリーの口が用意できないときは、起動せずに失敗する
 * （終了コード 1。原因と次の操作を標準エラーに出す）。標準出力には、窓口の URL とトークンのファイルの場所だけを出し、
 * トークンそのものは出さない。実際の launcher・git の口は、既定では動的に読み込み、なければ「未設定」として失敗させる。
 */

import type { Failure, Result } from "@cso/core";
import { createDaemon, type Daemon, type WorktreePorts } from "./compose.js";
import { type DaemonConfig, loadConfigFile } from "./config.js";
import { isPort } from "./port-file.js";
import type { AgentLauncher } from "./sdk/agent.js";

export interface MainDeps {
  /** 実際のエージェントの起動（Agent SDK の実バインディング）。 */
  readonly loadLauncher: (config: DaemonConfig) => Promise<Result<AgentLauncher, Failure>>;
  /** git の作業ツリーの口。 */
  readonly loadWorktreePorts: (config: DaemonConfig) => Promise<Result<WorktreePorts, Failure>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  /** 最終削除の後に、追記のみの保証を確かめられなかったとき。呼び出し側は daemon を止める（fail closed）。 */
  readonly onFatal?: (cause: string) => void;
}

export interface MainResult {
  readonly exitCode: 0 | 1 | 2;
  /** 起動できたときの、daemon。止めるには `stop()`。 */
  readonly daemon?: Daemon;
}

const USAGE = `使い方:
  cso-daemon --config <設定ファイルの絶対パス> [--port <1〜65535>]
  --port      窓口のポート（設定の port より優先。どちらもなければ、前回のポートを stateDir に保存して使い続ける）
  -h, --help  この使い方を表示する（終了コード 0）
終了コード: 0 起動した（または --help） / 1 起動に失敗 / 2 引数の誤り`;

const formatFailure = (f: Failure): string =>
  `失敗 [${f.code}]: ${f.cause}\n次の操作:\n${f.nextActions.map((a) => `  - ${a}`).join("\n")}\n`;

type ParsedArgs =
  | { readonly ok: true; readonly configPath: string; readonly port?: number }
  | { readonly ok: false; readonly error: string };

/** `--config <パス>`（必須）と `--port <1〜65535>`（任意）。順は問わない。ほかの引数・重複は誤り。 */
function parseArgs(argv: readonly string[]): ParsedArgs {
  let configPath: string | undefined;
  let port: number | undefined;
  for (let k = 0; k < argv.length; k += 2) {
    const name = argv[k];
    const value = argv[k + 1];
    if (value === undefined) return { ok: false, error: `${name} の値がない` };
    if (name === "--config" && configPath === undefined) configPath = value;
    else if (name === "--port" && port === undefined) {
      const n = /^\d{1,5}$/.test(value) ? Number(value) : Number.NaN;
      if (!isPort(n)) return { ok: false, error: "--port は 1〜65535 の整数" };
      port = n;
    } else
      return {
        ok: false,
        error: `--config <設定ファイル> と --port <ポート> だけを、1 回ずつ指定する（${name}）`,
      };
  }
  if (configPath === undefined) return { ok: false, error: "--config <設定ファイル> を指定する" };
  return port === undefined ? { ok: true, configPath } : { ok: true, configPath, port };
}

export async function main(argv: readonly string[], deps: MainDeps): Promise<MainResult> {
  if (argv.includes("-h") || argv.includes("--help")) {
    deps.stdout(`${USAGE}\n`);
    return { exitCode: 0 };
  }
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    deps.stderr(`${parsed.error}\n${USAGE}\n`);
    return { exitCode: 2 };
  }
  const { configPath, port } = parsed;

  const config = loadConfigFile(configPath);
  if (!config.ok) {
    deps.stderr(formatFailure(config.error));
    return { exitCode: 1 };
  }
  const launcher = await deps.loadLauncher(config.value);
  if (!launcher.ok) {
    deps.stderr(formatFailure(launcher.error));
    return { exitCode: 1 };
  }
  const worktree = await deps.loadWorktreePorts(config.value);
  if (!worktree.ok) {
    deps.stderr(formatFailure(worktree.error));
    return { exitCode: 1 };
  }
  const made = createDaemon(config.value, {
    launcher: launcher.value,
    worktree: worktree.value,
    ...(deps.onFatal === undefined ? {} : { onFatal: deps.onFatal }),
    ...(port === undefined ? {} : { port }),
  });
  if (!made.ok) {
    deps.stderr(formatFailure(made.error));
    return { exitCode: 1 };
  }
  try {
    const run = await made.value.start();
    deps.stdout(
      `起動した: ${run.url}\n人間のトークンのファイル: ${run.humanTokenPath}\n根のトークンのファイル: ${run.rootTokenPath}\n`,
    );
    return { exitCode: 0, daemon: made.value };
  } catch (e) {
    await made.value.stop().catch(() => undefined);
    deps.stderr(
      `失敗 [listenFailed]: 窓口を起動できない（${String(e instanceof Error ? e.message : e)}）\n次の操作:\n  - そのポートを使っているプロセスを確認して止める\n  - --port か設定の port でポートを指定する\n`,
    );
    return { exitCode: 1 };
  }
}
