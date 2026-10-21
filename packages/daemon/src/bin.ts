#!/usr/bin/env node
/**
 * `cso-daemon` の入口。実際の launcher・git の口を読み込んで `main` を呼び、終了の信号で止める。
 *
 * - 読み込むモジュールがない（`ERR_MODULE_NOT_FOUND`）ときだけ「未設定」（`notConfigured`）にする。読み込みの途中の例外など
 *   ほかの失敗は、別のコード（`moduleLoadFailed`）で原因を返す。
 * - 終了の信号（SIGINT・SIGTERM）で止める。止まらなければ 10 秒で諦めて、終了コード 1。
 * - 捕捉されない例外・拒否された Promise は、標準エラーに記録して、終了コード 1 で終わる。
 */

import { type Failure, failure, type Result } from "@cso/core";
import type { WorktreePorts } from "./compose.js";
import { main } from "./main.js";
import type { AgentLauncher } from "./sdk/agent.js";

const SHUTDOWN_TIMEOUT_MS = 10_000;

async function load<T>(
  path: string,
  what: string,
  pick: (m: Record<string, unknown>) => T | Result<T, Failure> | undefined,
): Promise<Result<T, Failure>> {
  let mod: Record<string, unknown>;
  try {
    mod = (await import(path)) as Record<string, unknown>;
  } catch (e) {
    if ((e as { code?: unknown } | null)?.code === "ERR_MODULE_NOT_FOUND") {
      return {
        ok: false,
        error: failure(
          "notConfigured",
          `${what} が用意されていない（${path}）`,
          "daemon の実装（T10b の実バインディング）を確認する",
          "docs の手動確認手順書を見る",
        ),
      };
    }
    return {
      ok: false,
      error: failure(
        "moduleLoadFailed",
        `${what} を読み込めなかった（${path}: ${String(e instanceof Error ? e.message : e)}）`,
        "モジュールの内容と依存を確認する",
      ),
    };
  }
  let picked: T | Result<T, Failure> | undefined;
  try {
    picked = pick(mod);
  } catch (e) {
    return {
      ok: false,
      error: failure(
        "moduleLoadFailed",
        `${what} を組み立てられなかった（${String(e instanceof Error ? e.message : e)}）`,
        "モジュールの内容と設定を確認する",
      ),
    };
  }
  if (picked === undefined) {
    return {
      ok: false,
      error: failure(
        "notConfigured",
        `${what} の入口（${path}）が、期待した関数を出していない`,
        "daemon の実装を確認する",
      ),
    };
  }
  const maybe = picked as { ok?: unknown };
  return typeof maybe.ok === "boolean"
    ? (picked as Result<T, Failure>)
    : { ok: true, value: picked as T };
}

const fatal = (what: string, e: unknown): void => {
  process.stderr.write(
    `${JSON.stringify({ at: new Date().toISOString(), event: what, error: String(e instanceof Error ? (e.stack ?? e.message) : e) })}\n`,
  );
  process.exit(1);
};
process.on("uncaughtException", (e) => fatal("uncaughtException", e));
process.on("unhandledRejection", (e) => fatal("unhandledRejection", e));

const result = await main(process.argv.slice(2), {
  loadLauncher: (config) =>
    load<AgentLauncher>(
      "./sdk/claude-launcher.js",
      "エージェントの launcher（Agent SDK の実バインディング）",
      (m) =>
        typeof m.createClaudeLauncher === "function"
          ? (m.createClaudeLauncher as (c: unknown) => AgentLauncher)(config)
          : undefined,
    ),
  loadWorktreePorts: (config) =>
    load<WorktreePorts>("./git-ports.js", "git の作業ツリーの口", (m) =>
      typeof m.createGitPorts === "function"
        ? (m.createGitPorts as (c: unknown) => Result<WorktreePorts, Failure>)(config)
        : undefined,
    ),
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
});
if (result.daemon === undefined) {
  process.exitCode = result.exitCode;
} else {
  const daemon = result.daemon;
  let stopping = false;
  const shutdown = (): void => {
    if (stopping) return;
    stopping = true;
    const timer = setTimeout(() => {
      process.stderr.write("失敗 [shutdownTimeout]: 10 秒以内に止まらなかった\n");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    daemon.stop().then(
      () => process.exit(0),
      (e: unknown) => fatal("shutdownFailed", e),
    );
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
