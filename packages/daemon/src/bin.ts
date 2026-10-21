#!/usr/bin/env node
/**
 * `cso-daemon` の入口。実際の launcher・git の口を読み込んで `main` を呼び、終了の信号で止める。
 *
 * - 終了の信号（SIGINT・SIGTERM）で止める。止まらなければ 10 秒で諦めて、終了コード 1。
 * - 捕捉されない例外・拒否された Promise は、標準エラーに記録して、終了コード 1 で終わる。
 */

import { loadLauncher, loadWorktreePorts } from "./loaders.js";
import { main } from "./main.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

const fatal = (what: string, e: unknown): void => {
  process.stderr.write(
    `${JSON.stringify({ at: new Date().toISOString(), event: what, error: String(e instanceof Error ? (e.stack ?? e.message) : e) })}\n`,
  );
  process.exit(1);
};
process.on("uncaughtException", (e) => fatal("uncaughtException", e));
process.on("unhandledRejection", (e) => fatal("unhandledRejection", e));

let fatalStop: (() => void) | undefined;
const result = await main(process.argv.slice(2), {
  // 最終削除の後に、追記のみの保証を確かめられなかったら、daemon を止めて、終了コード 1 で終わる（fail closed）。
  onFatal: (cause) => {
    process.stderr.write(`失敗 [storeIntegrity]: ${cause}\n`);
    process.exitCode = 1;
    fatalStop?.();
  },
  loadLauncher,
  loadWorktreePorts,
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
});
if (result.daemon === undefined) {
  process.exitCode = result.exitCode;
} else {
  const daemon = result.daemon;
  let stopping = false;
  const shutdown = (exitCode = 0): void => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => {
      process.stderr.write("失敗 [shutdownTimeout]: 10 秒以内に止まらなかった\n");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    daemon.stop().then(
      () => process.exit(exitCode),
      (e: unknown) => fatal("shutdownFailed", e),
    );
  };
  fatalStop = () => shutdown(1);
  process.once("SIGINT", () => shutdown());
  process.once("SIGTERM", () => shutdown());
}
