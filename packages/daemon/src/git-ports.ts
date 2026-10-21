/**
 * git の作業ツリーの口（`WorktreePorts` の実装）。ノードごとの作業ツリーとブランチを、ノード ID から決定的に導く
 * （エージェントに決めさせない。DC_003）。状態は持たず、git の登録（`git worktree list`）を正とする。
 *
 * - 名前: ブランチ `cso/<名前>`、作業ツリー `<worktreeRoot>/<名前>`。`<名前>` は、ノード ID の安全な部分（最大 32 文字）と
 *   ノード ID のハッシュ（12 桁）から導く（ノード ID の `:` などは git のブランチ名に使えないため）。
 * - 作成: 親のブランチ（根の子は、根の作業ツリーで今チェックアウト中のブランチ。detached HEAD は失敗）から、
 *   `git worktree add --track -b`。上流を親のブランチにするので、統合済みかの判定とブランチの削除（`-d`）が、親のブランチを基準にできる。
 *   同じノード ID の再要求は、同じ結果を返す（冪等）。登録されていない同名のディレクトリがあれば、上書きせずに失敗する。
 * - 削除: **`--force` を使わない**（`git worktree remove`）。ブランチは `git branch -d`（統合済みだけ。**`-D` は使わない**）。
 *   未保存の変更・未追跡のファイルがあれば作業ツリーを消さずに失敗し、未統合のコミットがあればブランチを残して失敗する
 *   （失うものがある場合は拒否する。NFR_006）。`expectedPath`（判定に使った実パス）が、そのノードの作業ツリーと違えば、何もしない。
 * - 事実: きれいか（`git status --porcelain --untracked-files=all` が空）、統合済みか（上流に含まれる）。調べられなければ、
 *   安全側（きれいでない・統合済みでない）にする。
 * - `repoRoot`・`worktreeRoot` は、実パス（リンクを含まない）であること。git の操作は直列に行う。
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { type Failure, failure, isPathUnder, type Result } from "@cso/core";

export interface GitResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export type GitRunner = (
  args: readonly string[],
  opts: { readonly cwd: string },
) => Promise<GitResult>;

/**
 * git に渡す環境変数: `GIT_` で始まるものをすべて外し（`GIT_DIR`・`GIT_WORK_TREE`・`GIT_CONFIG_*` などで、別のリポジトリ・設定を
 * 指されないように）、システムの設定を読まず、対話を求めず、出力の言語を固定する。
 */
export function gitEnv(parent: Readonly<Record<string, string | undefined>>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(parent)) if (!k.startsWith("GIT_")) env[k] = v;
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
}

/** `git` の実行。例外を出さず、結果（終了コード・出力）を返す。起動できない・時間切れは `code: null`。 */
export const nodeGit: GitRunner = (args, { cwd }) =>
  new Promise((resolve) => {
    execFile(
      "git",
      [...args],
      {
        cwd,
        timeout: 60_000,
        maxBuffer: 16 * 1024 * 1024,
        encoding: "utf8",
        env: gitEnv(process.env),
      },
      (err, stdout, stderr) => {
        if (err === null) return resolve({ code: 0, stdout, stderr });
        const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
        resolve({
          code: typeof code === "number" ? code : null,
          stdout: typeof stdout === "string" ? stdout : "",
          stderr: typeof stderr === "string" && stderr !== "" ? stderr : String(err.message),
        });
      },
    );
  });

export interface GitPortsOptions {
  readonly repoRoot: string;
  readonly worktreeRoot: string;
  readonly rootCwd: string;
  readonly rootNodeId: string;
  /**
   * 再生成できるので、残っていても未保存の変更とみなさない、gitignore の対象（パスの先頭のディレクトリ名）。
   * これ以外の gitignore の対象（`.env` など）が作業ツリーにあれば、きれいでない（回収は拒否される）。既定は
   * `node_modules`・`dist`・`.turbo`。
   */
  readonly regenerableIgnored?: readonly string[];
}

export const DEFAULT_REGENERABLE_IGNORED: readonly string[] = ["node_modules", "dist", ".turbo"];

export interface GitPorts {
  factsFor(
    nodeId: string,
  ): Promise<{ merged: boolean; clean: boolean; worktreePath: string } | undefined>;
  removeWorktree(
    nodeId: string,
    opts: { expectedPath: string; force?: boolean },
  ): Promise<Result<undefined, Failure>>;
  provisionWorktree(req: {
    parentId: string;
    nodeId: string;
  }): Promise<Result<{ worktreePath: string }, Failure>>;
  cwdOf(nodeId: string): Promise<string | undefined>;
}

const fail = (code: string, cause: string, ...next: [string, ...string[]]) => ({
  ok: false as const,
  error: failure(code, cause, ...next),
});

const nameOf = (nodeId: string): string => {
  const slug = nodeId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 32);
  const h = createHash("sha256").update(nodeId, "utf8").digest("hex").slice(0, 12);
  return `${slug}-${h}`;
};

const realOrUndefined = (p: string): string | undefined => {
  try {
    return realpathSync(p);
  } catch {
    return undefined;
  }
};

export function createGitPorts(
  options: GitPortsOptions,
  run: GitRunner = nodeGit,
): Result<GitPorts, Failure> {
  for (const [k, v] of Object.entries({
    repoRoot: options.repoRoot,
    worktreeRoot: options.worktreeRoot,
  })) {
    if (realOrUndefined(v) !== v) {
      return fail(
        "invalidConfig",
        `${k} ${v} が、実パスでない（存在しない、またはリンクを含む）`,
        `${k} を、リンクを解決した実パスで指定する`,
      );
    }
  }
  const { repoRoot, worktreeRoot, rootCwd, rootNodeId } = options;
  const realRootCwd = realOrUndefined(rootCwd);
  if (realRootCwd === undefined || !isPathUnder(realRootCwd, repoRoot)) {
    return fail(
      "invalidConfig",
      `rootCwd ${rootCwd} が、repoRoot の配下の実在するパスでない`,
      "rootCwd を、repoRoot 自身かその配下にする",
    );
  }
  const regenerable = new Set(options.regenerableIgnored ?? DEFAULT_REGENERABLE_IGNORED);

  // git の操作は直列に行う（作業ツリーの追加・削除は、リポジトリの内部で競合しうる）。
  let tail: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => {
    const next = tail.then(f, f);
    tail = next.catch(() => undefined);
    return next;
  };
  const git = (args: readonly string[], cwd = repoRoot): Promise<GitResult> => run(args, { cwd });

  const branchOf = (nodeId: string): string => `cso/${nameOf(nodeId)}`;
  const pathOf = (nodeId: string): string => join(worktreeRoot, nameOf(nodeId));

  /** 登録されている作業ツリーのパスとブランチ（`git worktree list --porcelain`）。調べられなければ undefined。 */
  const registeredWorktrees = async (): Promise<Map<string, string> | undefined> => {
    const r = await git(["worktree", "list", "--porcelain"]);
    if (r.code !== 0) return undefined;
    const out = new Map<string, string>();
    let cur: string | undefined;
    for (const line of r.stdout.split("\n")) {
      if (line.startsWith("worktree ")) cur = line.slice("worktree ".length);
      else if (line.startsWith("branch refs/heads/") && cur !== undefined) {
        out.set(cur, line.slice("branch refs/heads/".length));
      }
    }
    return out;
  };

  const isRegistered = async (nodeId: string): Promise<boolean | undefined> => {
    const list = await registeredWorktrees();
    if (list === undefined) return undefined;
    return list.get(pathOf(nodeId)) === branchOf(nodeId);
  };

  const branchExists = async (branch: string): Promise<boolean> =>
    (await git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;

  const dirExists = (p: string): boolean => {
    try {
      lstatSync(p);
      return true;
    } catch {
      return false;
    }
  };

  /** きれいか: 未保存の変更・未追跡のファイルがなく、gitignore の対象は、再生成できるもの（許可リスト）だけ。調べられなければ false。 */
  const isClean = async (path: string): Promise<boolean> => {
    // fsmonitor・フックは使わない（作業ツリーの設定に、コマンドを走らせない）。
    const status = await git(
      [
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.hooksPath=/dev/null",
        "status",
        "--porcelain",
        "--untracked-files=all",
        "--ignored=matching",
      ],
      path,
    );
    return (
      status.code === 0 &&
      status.stdout
        .split("\n")
        .filter((l) => l !== "")
        .every((l) => l.startsWith("!! ") && regenerable.has(l.slice(3).split("/")[0] ?? ""))
    );
  };

  const ports: GitPorts = {
    provisionWorktree: ({ parentId, nodeId }) =>
      serial(async () => {
        const path = pathOf(nodeId);
        const branch = branchOf(nodeId);
        const registered = await isRegistered(nodeId);
        if (registered === undefined) {
          return fail("gitFailed", "作業ツリーの一覧を取得できなかった", "git の状態を確認する");
        }
        if (registered)
          return { ok: true as const, value: { worktreePath: realOrUndefined(path) ?? path } };
        if (dirExists(path)) {
          return fail(
            "worktreeConflict",
            `作業ツリーの場所 ${path} に、登録されていないものがある`,
            "場所の中身を確認して、人間が片付ける",
          );
        }
        let parentBranch: string;
        if (parentId === rootNodeId) {
          const head = await git(["symbolic-ref", "--short", "-q", "HEAD"], rootCwd);
          const name = head.stdout.trim();
          if (head.code !== 0 || name === "") {
            return fail(
              "rootBranchUnknown",
              "根の作業ツリーが、ブランチをチェックアウトしていない（detached HEAD など）",
              "根の作業ツリーで、ブランチをチェックアウトする",
            );
          }
          parentBranch = name;
        } else {
          parentBranch = branchOf(parentId);
          if (!(await branchExists(parentBranch))) {
            return fail(
              "parentBranchMissing",
              "親のブランチがない",
              "親の作業ツリーの状態を確認する",
            );
          }
        }
        const exists = await branchExists(branch);
        if (exists) {
          // 残っていたブランチを使うときは、上流が親のブランチのままか確かめる（違えば、統合の判定が狂う）。
          const up = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
          if (up.code !== 0 || up.stdout.trim() !== parentBranch) {
            return fail(
              "branchConflict",
              `ブランチ ${branch} が残っていて、上流が親のブランチ（${parentBranch}）と違う`,
              "残っているブランチの中身を確認して、人間が片付ける",
            );
          }
        }
        const args = exists
          ? ["worktree", "add", path, branch]
          : ["worktree", "add", "--track", "-b", branch, path, parentBranch];
        const r = await git(args);
        if (r.code !== 0) {
          return fail(
            "gitFailed",
            `作業ツリーを作れなかった: ${r.stderr.trim()}`,
            "git の状態を確認する",
          );
        }
        return { ok: true as const, value: { worktreePath: realOrUndefined(path) ?? path } };
      }),

    cwdOf: (nodeId) =>
      serial(async () =>
        (await isRegistered(nodeId)) === true ? realOrUndefined(pathOf(nodeId)) : undefined,
      ),

    factsFor: (nodeId) =>
      serial(async () => {
        if ((await isRegistered(nodeId)) !== true) return undefined;
        const path = pathOf(nodeId);
        const real = realOrUndefined(path);
        if (real === undefined) return undefined;
        const clean = await isClean(path);
        let merged = false;
        const up = await git(["rev-parse", "--abbrev-ref", `${branchOf(nodeId)}@{upstream}`]);
        if (up.code === 0 && up.stdout.trim() !== "") {
          const anc = await git([
            "merge-base",
            "--is-ancestor",
            branchOf(nodeId),
            up.stdout.trim(),
          ]);
          merged = anc.code === 0;
        }
        return { merged, clean, worktreePath: real };
      }),

    removeWorktree: (nodeId, { expectedPath, force }) =>
      serial(async () => {
        const path = pathOf(nodeId);
        // 判定に使った実パスと、削除するパスが同じか（違えば何もしない）。
        if (typeof expectedPath !== "string" || expectedPath !== (realOrUndefined(path) ?? path)) {
          return fail(
            "pathMismatch",
            "判定に使った作業ツリーのパスと、削除するパスが違う",
            "回収の判定をやり直す",
          );
        }
        const registered = await isRegistered(nodeId);
        if (registered === undefined) {
          return fail("gitFailed", "作業ツリーの一覧を取得できなかった", "git の状態を確認する");
        }
        const branch = branchOf(nodeId);
        // 削除の前に、ブランチが統合済みか確かめる。統合されていなければ、作業ツリーも消さずに失敗する（成果を失わない）。
        // `force`（破棄の判断を経た停止ノード。判断は呼び出し側が行う）のときは、成果を捨てる判断済みなので、確かめない。
        if (force !== true && (registered || (await branchExists(branch)))) {
          const up = await git(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
          const anc =
            up.code === 0 && up.stdout.trim() !== ""
              ? await git(["merge-base", "--is-ancestor", branch, up.stdout.trim()])
              : undefined;
          if (anc === undefined || anc.code !== 0) {
            return fail(
              "branchNotMerged",
              `ブランチ ${branch} が、上流に統合済みと確認できない（作業ツリーもブランチも残した）`,
              "成果を統合してから、もう一度回収する",
            );
          }
        }
        // `git worktree remove` は、gitignore の対象（`.env` など）を黙って消すので、消す前に、同じ規則できれいか確かめる。
        if (force !== true && registered && !(await isClean(path))) {
          return fail(
            "removeFailed",
            "作業ツリーに、未保存の変更・未追跡のファイル・再生成できない gitignore の対象がある（消さなかった）",
            "作業ツリーの中身を確認する（強制は削除しない）",
          );
        }
        if (registered) {
          // `--force` は、`force`（破棄の判断を経たノード）のときだけ。登録されていない場所は、強制でも消さない（下）。
          const r = await git(
            force === true ? ["worktree", "remove", "--force", path] : ["worktree", "remove", path],
          );
          if (r.code !== 0) {
            return fail(
              "removeFailed",
              `作業ツリーを消せなかった（未保存の変更などがある）: ${r.stderr.trim()}`,
              "作業ツリーの中身を確認する（強制は削除しない）",
            );
          }
        } else if (dirExists(path)) {
          return fail(
            "worktreeConflict",
            `${path} は、登録されていない作業ツリー（消さない）`,
            "場所の中身を確認して、人間が片付ける",
          );
        }
        if (await branchExists(branch)) {
          // 統合済みだけ（`-d`）。`-D` は、`force` のときだけ。
          const r = await git(["branch", force === true ? "-D" : "-d", branch]);
          if (r.code !== 0) {
            return fail(
              "branchNotMerged",
              `ブランチ ${branch} に、統合されていない成果がある（残した）: ${r.stderr.trim()}`,
              "成果を統合してから、もう一度回収する",
            );
          }
        }
        return { ok: true as const, value: undefined };
      }),
  };
  return { ok: true, value: ports };
}
