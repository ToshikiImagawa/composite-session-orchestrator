/**
 * 実際の launcher（Agent SDK の実バインディング）と git の作業ツリーの口の読み込み（`cso-daemon` の `bin` が使う）。
 *
 * - 読み込むモジュールがない（`ERR_MODULE_NOT_FOUND`）ときだけ「未設定」（`notConfigured`）にする。読み込みの途中の例外など
 *   ほかの失敗は、別のコード（`moduleLoadFailed`）で原因を返す。
 * - 口を作る関数が `Result` を返す場合（`createGitPorts`）は、失敗をそのまま（原因つきで）返す。
 */

import { type Failure, failure, type Result } from "@cso/core";
import type { WorktreePorts } from "./compose.js";
import type { DaemonConfig } from "./config.js";
import type { AgentLauncher } from "./sdk/agent.js";

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

export const loadLauncher = (config: DaemonConfig): Promise<Result<AgentLauncher, Failure>> =>
  load<AgentLauncher>(
    "./sdk/claude-launcher.js",
    "エージェントの launcher（Agent SDK の実バインディング）",
    (m) =>
      typeof m.createClaudeLauncher === "function"
        ? (m.createClaudeLauncher as (c: unknown) => AgentLauncher)(config)
        : undefined,
  );

export const loadWorktreePorts = (config: DaemonConfig): Promise<Result<WorktreePorts, Failure>> =>
  load<WorktreePorts>("./git-ports.js", "git の作業ツリーの口", (m) =>
    typeof m.createGitPorts === "function"
      ? (m.createGitPorts as (c: unknown) => Result<WorktreePorts, Failure>)(config)
      : undefined,
  );
