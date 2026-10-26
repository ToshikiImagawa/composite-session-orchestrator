import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitPorts, nodeGit } from "../src/git-ports.js";

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
    },
  }).trim();

/** 実際の git で、作業ツリーに設定ファイルを写す（`.envrc`・`.claude/settings.local.json`）。 */
const setup = (seedList?: unknown) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cso-seed-")));
  const repoRoot = join(base, "repo");
  const worktreeRoot = join(base, "worktrees");
  mkdirSync(repoRoot);
  mkdirSync(worktreeRoot);
  git(repoRoot, "init", "-q", "-b", "main");
  writeFileSync(join(repoRoot, ".gitignore"), ".envrc\n.claude/settings.local.json\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-q", "-m", "init");
  writeFileSync(join(repoRoot, ".envrc"), "export A=1\n", { mode: 0o600 });
  mkdirSync(join(repoRoot, ".claude"));
  writeFileSync(join(repoRoot, ".claude", "settings.local.json"), "{}\n");
  if (seedList !== undefined) {
    writeFileSync(join(repoRoot, ".claude", "cso-worktree-files.json"), JSON.stringify(seedList));
  }
  const events: {
    copied: readonly string[];
    skipped: readonly string[];
    missing: readonly string[];
  }[] = [];
  const made = createGitPorts(
    {
      repoRoot,
      worktreeRoot,
      rootCwd: repoRoot,
      rootNodeId: "root",
      onSeed: (e) => events.push(e),
    },
    nodeGit,
  );
  if (!made.ok) throw new Error(made.error.cause);
  return { base, repoRoot, ports: made.value, events };
};

describe("作業ツリーへの設定ファイルのコピー", () => {
  it("一覧のファイルをコピーする（権限も）。元は変わらない。回収の判定で、きれいとみなす", async () => {
    const { repoRoot, ports, events } = setup({
      files: [".envrc", ".claude/settings.local.json", "nothing.txt"],
    });
    const r = await ports.provisionWorktree({ parentId: "root", nodeId: "c1" });
    if (!r.ok) throw new Error(r.error.cause);
    const wt = r.value.worktreePath;
    expect(readFileSync(join(wt, ".envrc"), "utf8")).toBe("export A=1\n");
    expect(existsSync(join(wt, ".claude", "settings.local.json"))).toBe(true);
    expect(statSync(join(wt, ".envrc")).mode & 0o777).toBe(0o600);
    expect(events).toEqual([
      {
        nodeId: "c1",
        copied: [".envrc", ".claude/settings.local.json"],
        skipped: [],
        missing: ["nothing.txt"],
      },
    ]);
    writeFileSync(join(wt, ".envrc"), "changed\n");
    expect(readFileSync(join(repoRoot, ".envrc"), "utf8")).toBe("export A=1\n");
    expect((await ports.factsFor("c1"))?.clean).toBe(true);
    expect((await ports.lossFor("c1"))?.untracked).toBe(0);
  });

  it("一覧がなければ、何も写さない", async () => {
    const { ports, events } = setup();
    const r = await ports.provisionWorktree({ parentId: "root", nodeId: "c1" });
    if (!r.ok) throw new Error(r.error.cause);
    expect(existsSync(join(r.value.worktreePath, ".envrc"))).toBe(false);
    expect(events).toEqual([]);
  });

  it.each([
    ["..", { files: ["../outside"] }, "seedListInvalid"],
    ["絶対パス", { files: ["/etc/hosts"] }, "seedListInvalid"],
    [".git の中", { files: [".git/config"] }, "seedListInvalid"],
    ["形が違う", { files: ".envrc" }, "seedListInvalid"],
  ])("一覧が不正（%s）なら、作業ツリーを作らずに失敗する", async (_n, list, code) => {
    const { base, ports } = setup(list);
    const r = await ports.provisionWorktree({ parentId: "root", nodeId: "c1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe(code);
    expect(existsSync(join(base, "worktrees", "c1"))).toBe(false);
    expect(git(join(base, "repo"), "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("repoRoot の外を指すリンクは、作業ツリーを作らずに失敗する", async () => {
    const { base, repoRoot, ports } = setup({ files: ["link"] });
    writeFileSync(join(base, "secret"), "s\n");
    symlinkSync(join(base, "secret"), join(repoRoot, "link"));
    const r = await ports.provisionWorktree({ parentId: "root", nodeId: "c1" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("seedOutsideRepo");
    expect(git(repoRoot, "worktree", "list").split("\n")).toHaveLength(1);
  });

  it("作業ツリー側にすでにあるファイルは、上書きしない", async () => {
    const { repoRoot, ports, events } = setup({ files: ["tracked.txt"] });
    writeFileSync(join(repoRoot, "tracked.txt"), "main\n");
    git(repoRoot, "add", "tracked.txt");
    git(repoRoot, "commit", "-q", "-m", "t");
    writeFileSync(join(repoRoot, "tracked.txt"), "local edit\n");
    const r = await ports.provisionWorktree({ parentId: "root", nodeId: "c1" });
    if (!r.ok) throw new Error(r.error.cause);
    expect(readFileSync(join(r.value.worktreePath, "tracked.txt"), "utf8")).toBe("main\n");
    expect(events[0]?.skipped).toEqual(["tracked.txt"]);
  });
});
