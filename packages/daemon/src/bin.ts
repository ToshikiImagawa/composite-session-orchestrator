#!/usr/bin/env node
/** `cso-daemon` の入口。実際の launcher・git の口を読み込んで `main` を呼び、終了の信号で止める。 */

import { failure, type Result } from "@cso/core";
import type { WorktreePorts } from "./compose.js";
import { main } from "./main.js";
import type { AgentLauncher } from "./sdk/agent.js";

async function load<T>(
  path: string,
  what: string,
  pick: (m: Record<string, unknown>) => T | undefined,
): Promise<Result<T, ReturnType<typeof failure>>> {
  try {
    const mod = (await import(path)) as Record<string, unknown>;
    const v = pick(mod);
    if (v !== undefined) return { ok: true, value: v };
  } catch {
    // 見つからない・読み込めない
  }
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

const result = await main(process.argv.slice(2), {
  loadLauncher: (config) =>
    load(
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
        ? (m.createGitPorts as (c: unknown) => WorktreePorts)(config)
        : undefined,
    ),
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
});
if (result.daemon === undefined) {
  process.exitCode = result.exitCode;
} else {
  const daemon = result.daemon;
  const shutdown = (): void => {
    void daemon.stop().finally(() => process.exit(0));
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
