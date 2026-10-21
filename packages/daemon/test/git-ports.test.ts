import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitPorts, type GitPorts, type GitRunner, nodeGit } from "../src/git-ports.js";

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

const setup = (options: { detached?: boolean } = {}) => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cso-git-")));
  const repoRoot = join(base, "repo");
  const worktreeRoot = join(base, "worktrees");
  mkdirSync(repoRoot);
  mkdirSync(worktreeRoot);
  git(repoRoot, "init", "-q", "-b", "main");
  writeFileSync(join(repoRoot, "a.txt"), "a\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-q", "-m", "init");
  if (options.detached) git(repoRoot, "checkout", "-q", "--detach");
  const calls: string[][] = [];
  const runner: GitRunner = (args, opts) => {
    calls.push([...args]);
    return nodeGit(args, opts);
  };
  const made = createGitPorts(
    { repoRoot, worktreeRoot, rootCwd: repoRoot, rootNodeId: "root" },
    runner,
  );
  if (!made.ok) throw new Error(made.error.cause);
  return { base, repoRoot, worktreeRoot, ports: made.value as GitPorts, calls };
};

const provision = async (s: ReturnType<typeof setup>, nodeId: string, parentId = "root") => {
  const r = await s.ports.provisionWorktree({ parentId, nodeId });
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
  return r.value.worktreePath;
};

describe("createGitPorts（実際の git で、作業ツリーの作成・事実・削除を確かめる）", () => {
  it("作業ツリーを置き場の配下に作り、同じ nodeId の再要求は同じ結果を返す。cwdOf は作ったものだけ返す", async () => {
    const s = setup();
    const p = await provision(s, "child-1");
    expect(p.startsWith(`${s.worktreeRoot}/`)).toBe(true);
    expect(existsSync(join(p, "a.txt"))).toBe(true);
    expect(await provision(s, "child-1")).toBe(p);
    expect(await s.ports.cwdOf("child-1")).toBe(p);
    expect(await s.ports.cwdOf("nope")).toBeUndefined();
    expect(await s.ports.cwdOf("root")).toBeUndefined(); // 根の cwd は設定が持つ
  });

  it("子の子は、親の子のブランチから作る", async () => {
    const s = setup();
    const parent = await provision(s, "p1");
    writeFileSync(join(parent, "p.txt"), "p\n");
    git(parent, "add", ".");
    git(parent, "commit", "-q", "-m", "p");
    const child = await provision(s, "c1", "p1");
    expect(existsSync(join(child, "p.txt"))).toBe(true);
  });

  it("事実: 作ったばかりは、統合済みできれい。変更・未追跡のファイル・未統合のコミットがあれば、そう返す。なければ undefined", async () => {
    const s = setup();
    const p = await provision(s, "c1");
    expect(await s.ports.factsFor("c1")).toEqual({ merged: true, clean: true, worktreePath: p });
    writeFileSync(join(p, "new.txt"), "x\n");
    expect((await s.ports.factsFor("c1"))?.clean).toBe(false); // 未追跡
    git(p, "add", ".");
    expect((await s.ports.factsFor("c1"))?.clean).toBe(false); // ステージ済み
    git(p, "commit", "-q", "-m", "work");
    const f = await s.ports.factsFor("c1");
    expect(f?.clean).toBe(true);
    expect(f?.merged).toBe(false); // 親のブランチに入っていないコミット
    const branch =
      git(s.repoRoot, "branch", "--list", "cso/*")
        .replace(/^[*+ ]+/, "")
        .split("\n")[0] ?? "";
    // 親（main）に統合する: 親の作業ツリーで、子のブランチを取り込む
    git(s.repoRoot, "merge", "-q", "--no-edit", branch.trim());
    expect((await s.ports.factsFor("c1"))?.merged).toBe(true);
    expect(await s.ports.factsFor("none")).toBeUndefined();
  });

  it("回収: きれいで統合済みなら、作業ツリーとブランチを消す（--force・-D は使わない）。再実行しても成功する", async () => {
    const s = setup();
    const p = await provision(s, "c1");
    const r = await s.ports.removeWorktree("c1", { expectedPath: p });
    expect(r.ok).toBe(true);
    expect(existsSync(p)).toBe(false);
    expect(git(s.repoRoot, "branch", "--list", "cso/*")).toBe("");
    expect((await s.ports.removeWorktree("c1", { expectedPath: p })).ok).toBe(true); // 冪等
    const flat = s.calls.flat();
    expect(flat).not.toContain("--force");
    expect(flat).not.toContain("-f");
    expect(flat).not.toContain("-D");
  });

  it("未保存の変更・未追跡のファイルがあれば、強制せずに失敗し、何も消さない", async () => {
    const s = setup();
    const p = await provision(s, "c1");
    writeFileSync(join(p, "wip.txt"), "未保存\n");
    const r = await s.ports.removeWorktree("c1", { expectedPath: p });
    expect(r.ok).toBe(false);
    expect(existsSync(join(p, "wip.txt"))).toBe(true);
    expect(git(s.repoRoot, "branch", "--list", "cso/*")).not.toBe("");
  });

  it("未統合のコミットがあれば、ブランチを消さずに失敗する（成果はブランチに残る）", async () => {
    const s = setup();
    const p = await provision(s, "c1");
    writeFileSync(join(p, "w.txt"), "w\n");
    git(p, "add", ".");
    git(p, "commit", "-q", "-m", "work");
    const r = await s.ports.removeWorktree("c1", { expectedPath: p });
    expect(r.ok).toBe(false);
    expect(git(s.repoRoot, "branch", "--list", "cso/*")).not.toBe("");
    expect(s.calls.flat()).not.toContain("-D");
  });

  it("expectedPath が、そのノードの作業ツリーと違えば、何も消さずに失敗する", async () => {
    const s = setup();
    const a = await provision(s, "a1");
    const b = await provision(s, "b1");
    for (const wrong of [b, s.worktreeRoot, s.repoRoot, "/etc", "relative", `${a}/../${"b1"}`]) {
      const r = await s.ports.removeWorktree("a1", { expectedPath: wrong });
      expect(r.ok, wrong).toBe(false);
    }
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);
    expect(existsSync(s.repoRoot)).toBe(true);
  });

  it("根が detached HEAD なら、作業ツリーを作らずに失敗する", async () => {
    const s = setup({ detached: true });
    const r = await s.ports.provisionWorktree({ parentId: "root", nodeId: "c1" });
    expect(r.ok).toBe(false);
  });

  it("置き場・リポジトリが実パスでない（リンクを含む）なら、作れずに失敗する", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "cso-git-")));
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "link"));
    const made = createGitPorts({
      repoRoot: join(base, "real"),
      worktreeRoot: join(base, "link"),
      rootCwd: join(base, "real"),
      rootNodeId: "root",
    });
    expect(made.ok).toBe(false);
  });
});
