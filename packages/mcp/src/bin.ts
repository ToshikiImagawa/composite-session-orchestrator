#!/usr/bin/env node
/**
 * `cso-mcp` の入口。終了の信号（SIGINT・SIGTERM）で止める。止まらなければ 10 秒で諦めて、終了コード 1。
 */
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

const result = await main(process.argv.slice(2), process.env, {
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
});
if (result.server === undefined) {
  process.exitCode = result.exitCode;
} else {
  const server = result.server;
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => {
      process.stderr.write("失敗 [shutdownTimeout]: 10 秒以内に止まらなかった\n");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    server.close().then(
      () => process.exit(0),
      (e: unknown) => fatal("shutdownFailed", e),
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
