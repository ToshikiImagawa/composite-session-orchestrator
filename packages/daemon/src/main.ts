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
import type { AgentLauncher } from "./sdk/agent.js";

export interface MainDeps {
  /** 実際のエージェントの起動（Agent SDK の実バインディング）。 */
  readonly loadLauncher: (config: DaemonConfig) => Promise<Result<AgentLauncher, Failure>>;
  /** git の作業ツリーの口。 */
  readonly loadWorktreePorts: (config: DaemonConfig) => Promise<Result<WorktreePorts, Failure>>;
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface MainResult {
  readonly exitCode: 0 | 1 | 2;
  /** 起動できたときの、daemon。止めるには `stop()`。 */
  readonly daemon?: Daemon;
}

const USAGE = `使い方:
  cso-daemon --config <設定ファイルの絶対パス>
  -h, --help  この使い方を表示する（終了コード 0）
終了コード: 0 起動した（または --help） / 1 起動に失敗 / 2 引数の誤り`;

const formatFailure = (f: Failure): string =>
  `失敗 [${f.code}]: ${f.cause}\n次の操作:\n${f.nextActions.map((a) => `  - ${a}`).join("\n")}\n`;

export async function main(argv: readonly string[], deps: MainDeps): Promise<MainResult> {
  if (argv.includes("-h") || argv.includes("--help")) {
    deps.stdout(`${USAGE}\n`);
    return { exitCode: 0 };
  }
  const i = argv.indexOf("--config");
  const configPath = i >= 0 ? argv[i + 1] : undefined;
  if (argv.length !== 2 || i !== 0 || configPath === undefined) {
    deps.stderr(`--config <設定ファイル> だけを指定する\n${USAGE}\n`);
    return { exitCode: 2 };
  }

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
  const made = createDaemon(config.value, { launcher: launcher.value, worktree: worktree.value });
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
      `失敗 [listenFailed]: 窓口を起動できない（${String(e instanceof Error ? e.message : e)}）\n次の操作:\n  - port を変える・使用中のプロセスを確認する\n`,
    );
    return { exitCode: 1 };
  }
}
