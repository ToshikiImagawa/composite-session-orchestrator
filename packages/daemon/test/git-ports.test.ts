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
import {
  createGitPorts,
  type GitPorts,
  type GitRunner,
  gitEnv,
  nodeGit,
} from "../src/git-ports.js";

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

const setup = (
  options: {
    detached?: boolean;
    failBranchD?: boolean;
    failBranchDOnce?: boolean;
    failUpdateRef?: boolean;
    discardedRefsMax?: number;
  } = {},
) => {
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
    if (
      options.failUpdateRef === true &&
      args[0] === "update-ref" &&
      String(args[1]).startsWith("refs/cso/discarded/")
    ) {
      return Promise.resolve({ code: 1, stdout: "", stderr: "error: cannot lock ref" });
    }
    if (options.failBranchDOnce === true && args[0] === "branch" && args[1] === "-D") {
      options.failBranchDOnce = false; // 最初の 1 回だけ失敗する
      return Promise.resolve({ code: 1, stdout: "", stderr: "error: cannot delete branch" });
    }
    if (options.failBranchD === true && args[0] === "branch" && args[1] === "-D") {
      return Promise.resolve({ code: 1, stdout: "", stderr: "error: cannot delete branch" });
    }
    return nodeGit(args, opts);
  };
  const made = createGitPorts(
    {
      repoRoot,
      worktreeRoot,
      rootCwd: repoRoot,
      rootNodeId: "root",
      ...(options.discardedRefsMax === undefined
        ? {}
        : { discardedRefsMax: options.discardedRefsMax }),
    },
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

const withIgnore = (s: ReturnType<typeof setup>, ...patterns: string[]) => {
  writeFileSync(join(s.repoRoot, ".gitignore"), `${patterns.join("\n")}\n`);
  git(s.repoRoot, "add", ".gitignore");
  git(s.repoRoot, "commit", "-q", "-m", "ignore");
};

describe("gitignore の対象（再生成できるものだけ許す）", () => {
  it("許可リスト（node_modules・dist・.turbo）の gitignore の対象は、きれいとみなす。それ以外（.env など）は、きれいでない", async () => {
    const s = setup();
    withIgnore(s, "node_modules", "dist", ".turbo", ".env", "secret.local");
    const p = await provision(s, "c1");
    mkdirSync(join(p, "node_modules"));
    writeFileSync(join(p, "node_modules", "x.js"), "x\n");
    mkdirSync(join(p, "dist"));
    writeFileSync(join(p, "dist", "o.js"), "o\n");
    expect((await s.ports.factsFor("c1"))?.clean).toBe(true);
    writeFileSync(join(p, ".env"), "TOKEN=1\n");
    expect((await s.ports.factsFor("c1"))?.clean).toBe(false);
    const removed = await s.ports.removeWorktree("c1", { expectedPath: p });
    expect(removed.ok).toBe(false); // .env は消さない
    expect(existsSync(join(p, ".env"))).toBe(true);
  });

  it("許可リストは指定できる。入れ子の同名（src/dist）は許可されない", async () => {
    const s0 = setup();
    withIgnore(s0, "build", "dist");
    const made = createGitPorts({
      repoRoot: s0.repoRoot,
      worktreeRoot: s0.worktreeRoot,
      rootCwd: s0.repoRoot,
      rootNodeId: "root",
      regenerableIgnored: ["build"],
    });
    if (!made.ok) throw new Error(made.error.cause);
    const p = await made.value.provisionWorktree({ parentId: "root", nodeId: "c1" });
    if (!p.ok) throw new Error("provision");
    mkdirSync(join(p.value.worktreePath, "build"));
    writeFileSync(join(p.value.worktreePath, "build", "b"), "b\n");
    expect((await made.value.factsFor("c1"))?.clean).toBe(true);
    mkdirSync(join(p.value.worktreePath, "dist"));
    writeFileSync(join(p.value.worktreePath, "dist", "d"), "d\n");
    expect((await made.value.factsFor("c1"))?.clean).toBe(false); // dist は、この設定では許可リストにない
  });
});

describe("安全の強化", () => {
  it("git の環境変数: GIT_ で始まるものを外し、システムの設定・対話・言語を固定する", () => {
    const env = gitEnv({
      PATH: "/usr/bin",
      GIT_DIR: "/x",
      GIT_WORK_TREE: "/y",
      GIT_CONFIG_GLOBAL: "/z",
      HOME: "/h",
    });
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_WORK_TREE).toBeUndefined();
    expect(env.GIT_CONFIG_GLOBAL).toBeUndefined();
    expect(env).toMatchObject({
      PATH: "/usr/bin",
      HOME: "/h",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      LC_ALL: "C",
    });
  });

  it("status は fsmonitor・フックを使わない", async () => {
    const s = setup();
    await provision(s, "c1");
    await s.ports.factsFor("c1");
    const status = s.calls.find((c) => c.includes("status"));
    expect(status).toContain("core.fsmonitor=false");
    expect(status).toContain("core.hooksPath=/dev/null");
    expect(status).toContain("--ignored=matching");
  });

  it("未統合なら、作業ツリーも消さずに失敗する（成果を失わない）", async () => {
    const s = setup();
    const p = await provision(s, "c1");
    writeFileSync(join(p, "w.txt"), "w\n");
    git(p, "add", ".");
    git(p, "commit", "-q", "-m", "work");
    const r = await s.ports.removeWorktree("c1", { expectedPath: p });
    expect(r.ok).toBe(false);
    expect(existsSync(join(p, "w.txt"))).toBe(true); // 作業ツリーが残る
    expect(s.calls.some((c) => c[0] === "worktree" && c[1] === "remove")).toBe(false);
  });

  it("残っていたブランチの上流が、親のブランチと違えば、作業ツリーを作らずに失敗する", async () => {
    const s = setup();
    git(s.repoRoot, "branch", "other");
    const p = await provision(s, "c1");
    await s.ports.removeWorktree("c1", { expectedPath: p });
    // 同じ名前のブランチを、上流なしで残す
    const name = git(s.repoRoot, "rev-parse", "--abbrev-ref", "HEAD");
    expect(name).toBe("main");
    const branchName = s.calls.flat().find((a) => a.startsWith("cso/")) as string;
    git(s.repoRoot, "branch", branchName);
    const again = await s.ports.provisionWorktree({ parentId: "root", nodeId: "c1" });
    expect(again.ok).toBe(false);
  });

  it("rootCwd が repoRoot の配下でなければ、作れずに失敗する", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "cso-git-")));
    mkdirSync(join(base, "repo"));
    mkdirSync(join(base, "wt"));
    mkdirSync(join(base, "elsewhere"));
    const made = createGitPorts({
      repoRoot: join(base, "repo"),
      worktreeRoot: join(base, "wt"),
      rootCwd: join(base, "elsewhere"),
      rootNodeId: "root",
    });
    expect(made.ok).toBe(false);
  });
});

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
    expect(await s.ports.factsFor("c1")).toEqual({
      merged: true,
      clean: true,
      worktreePath: p,
      headCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
    });
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

  describe("force（破棄の判断を経た停止ノードだけ。判断は、呼び出し側が行う）", () => {
    it("未保存の変更・未追跡のファイル・未統合のコミットがあっても、作業ツリーを消し、ブランチを -D で消す", async () => {
      const s = setup();
      const p = await provision(s, "c1");
      mkdirSync(join(p, "src"));
      writeFileSync(join(p, "src", "new.txt"), "未追跡\n");
      writeFileSync(join(p, "w.txt"), "w\n");
      git(p, "add", "w.txt");
      git(p, "commit", "-q", "-m", "work"); // 未統合のコミット
      writeFileSync(join(p, "a.txt"), "変更\n"); // 未保存の変更
      const r = await s.ports.removeWorktree("c1", { expectedPath: p, force: true });
      expect(r.ok).toBe(true);
      expect(existsSync(p)).toBe(false);
      expect(git(s.repoRoot, "branch", "--list", "cso/*")).toBe("");
      const flat = s.calls.flat();
      expect(flat).toContain("--force");
      expect(flat).toContain("-D");
    });

    it("force でないとき（既定・false）は、同じ状態でも、強制せずに失敗し、何も消さない", async () => {
      for (const opts of [{}, { force: false }]) {
        const s = setup();
        const p = await provision(s, "c1");
        writeFileSync(join(p, "untracked.txt"), "x\n");
        const r = await s.ports.removeWorktree("c1", { expectedPath: p, ...opts });
        expect(r.ok).toBe(false);
        expect(existsSync(join(p, "untracked.txt"))).toBe(true);
        expect(s.calls.flat()).not.toContain("--force");
        expect(s.calls.flat()).not.toContain("-D");
      }
    });

    it("force でも、expectedPath が違えば、何も消さずに失敗する（pathMismatch）", async () => {
      const s = setup();
      const a = await provision(s, "a1");
      const b = await provision(s, "b1");
      writeFileSync(join(a, "wip.txt"), "x\n");
      const r = await s.ports.removeWorktree("a1", { expectedPath: b, force: true });
      expect(r.ok === false && r.error.code).toBe("pathMismatch");
      expect(existsSync(a)).toBe(true);
      expect(existsSync(b)).toBe(true);
      expect(s.calls.some((c) => c.includes("--force"))).toBe(false);
    });

    it("force でも、登録されていない場所は消さない（worktreeConflict）", async () => {
      const s = setup();
      const p = join(s.worktreeRoot, "not-registered");
      mkdirSync(p);
      writeFileSync(join(p, "keep.txt"), "k\n");
      // 登録されていない作業ツリーの名前は、ノード ID から決まる。ここでは、同じ名前のディレクトリを先に作る。
      const first = await s.ports.provisionWorktree({ parentId: "root", nodeId: "c9" });
      expect(first.ok).toBe(true);
      const real = first.ok ? first.value.worktreePath : "";
      git(s.repoRoot, "worktree", "remove", "--force", real); // 登録を外す（ディレクトリも消える）
      mkdirSync(real);
      writeFileSync(join(real, "keep.txt"), "k\n");
      const r = await s.ports.removeWorktree("c9", { expectedPath: real, force: true });
      expect(r.ok).toBe(false);
      expect(existsSync(join(real, "keep.txt"))).toBe(true);
      expect(existsSync(join(p, "keep.txt"))).toBe(true);
    });

    it("force: 消す前に、ブランチの先端の SHA を onTip に渡す", async () => {
      const s = setup();
      const p = await provision(s, "c1");
      writeFileSync(join(p, "x.txt"), "x\n");
      git(p, "add", "-A");
      git(p, "commit", "-m", "work");
      const sha = git(p, "rev-parse", "HEAD").trim();
      const tips: string[] = [];
      const r = await s.ports.removeWorktree("c1", {
        expectedPath: p,
        force: true,
        onTip: (t) => tips.push(t),
      });
      expect(r.ok).toBe(true);
      expect(tips).toEqual([sha]);
    });

    it("factsFor は、ブランチの先端（最終コミット）を headCommit に載せる（SHA の形）", async () => {
      const s = setup();
      const p = await provision(s, "c1");
      writeFileSync(join(p, "x.txt"), "x\n");
      git(p, "add", "-A");
      git(p, "commit", "-m", "work");
      const sha = git(p, "rev-parse", "HEAD").trim();
      const facts = await s.ports.factsFor("c1");
      expect(facts?.headCommit).toBe(sha);
      expect(facts?.headCommit).toMatch(/^[0-9a-f]{40}$/);
    });

    it("作業ツリーが消えてブランチだけ残ったノードの事実にも、headCommit を載せる", async () => {
      const s = setup();
      const p = await provision(s, "c1");
      const sha = git(p, "rev-parse", "HEAD").trim();
      git(s.repoRoot, "worktree", "remove", "--force", p);
      const facts = await s.ports.factsFor("c1");
      expect(facts?.headCommit).toBe(sha);
    });

    it("force: -D だけ失敗したら removeFailed（作業ツリーは消えた・ブランチだけ残った）。そのあとの再実行で、残りを消せる", async () => {
      const s = setup({ failBranchD: true });
      const p = await provision(s, "c1");
      const r = await s.ports.removeWorktree("c1", { expectedPath: p, force: true });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("removeFailed");
        expect(r.error.cause).toContain("ブランチ");
        expect(r.error.cause).toContain("残った");
      }
      expect(existsSync(p)).toBe(false);
      expect(git(s.repoRoot, "branch", "--list", "cso/*")).not.toBe("");
      // 再実行（同じ expectedPath）。ここでは -D を、まだ失敗させる版なので、もう一度 removeFailed。冪等に、同じ失敗を返す
      const again = await s.ports.removeWorktree("c1", { expectedPath: p, force: true });
      expect(again.ok).toBe(false);
    });

    it("force でも、同じ呼び出しを繰り返せる（冪等。作業ツリーもブランチもなければ成功）", async () => {
      const s = setup();
      const p = await provision(s, "c1");
      writeFileSync(join(p, "x.txt"), "x\n");
      expect((await s.ports.removeWorktree("c1", { expectedPath: p, force: true })).ok).toBe(true);
      expect((await s.ports.removeWorktree("c1", { expectedPath: p, force: true })).ok).toBe(true);
    });
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

  describe("lossFor（強制の回収で失われるもの。T21r）", () => {
    it("作ったばかり（統合済み・きれい）なら、何も失われない", async () => {
      const s = setup();
      await provision(s, "c1");
      expect(await s.ports.lossFor("c1")).toEqual({
        aheadCommits: 0,
        subjects: [],
        uncommitted: false,
        untracked: 0,
      });
    });

    it("統合されていないコミットの数と件名（新しい順。5 件まで）、追跡中の変更、未追跡のファイルの数を返す", async () => {
      const s = setup();
      const p = await provision(s, "c1");
      for (let i = 1; i <= 7; i++) {
        writeFileSync(join(p, `f${i}.txt`), `${i}\n`);
        git(p, "add", "-A");
        git(p, "commit", "-q", "-m", `件名 ${i}`);
      }
      writeFileSync(join(p, "a.txt"), "変更\n"); // 追跡中のファイルの変更
      writeFileSync(join(p, "new1.txt"), "x\n");
      writeFileSync(join(p, "new2.txt"), "x\n"); // 未追跡 2 つ
      const loss = await s.ports.lossFor("c1");
      expect(loss).toEqual({
        aheadCommits: 7,
        subjects: ["件名 7", "件名 6", "件名 5", "件名 4", "件名 3"],
        uncommitted: true,
        untracked: 2,
      });
    });

    it("再生成できる gitignore の対象（node_modules）は数えない。それ以外（.env）は、未追跡として数える", async () => {
      const s = setup();
      const p = await provision(s, "c1");
      writeFileSync(join(p, ".gitignore"), "node_modules\n.env\n");
      git(p, "add", ".gitignore");
      git(p, "commit", "-q", "-m", "gitignore");
      mkdirSync(join(p, "node_modules"));
      writeFileSync(join(p, "node_modules", "x.js"), "x\n");
      writeFileSync(join(p, ".env"), "SECRET=1\n");
      const loss = await s.ports.lossFor("c1");
      expect(loss?.untracked).toBe(1);
      expect(loss?.uncommitted).toBe(false);
      expect(loss?.aheadCommits).toBe(1);
    });

    it("L2a: 作業ツリーは消えたがブランチだけ残ったノードは、ブランチ側の差と件名を返す（作業ツリーの変更はない）", async () => {
      const s = setup();
      const p = await provision(s, "c1");
      writeFileSync(join(p, "f.txt"), "1\n");
      git(p, "add", "-A");
      git(p, "commit", "-q", "-m", "残る成果");
      git(s.repoRoot, "worktree", "remove", "--force", p);
      expect(await s.ports.lossFor("c1")).toEqual({
        aheadCommits: 1,
        subjects: ["残る成果"],
        uncommitted: false,
        untracked: 0,
      });
    });

    it("L2c: git status が失敗したら、uncommitted・untracked は不明（workingTreeUnknown）", async () => {
      const s = setup();
      const p = await provision(s, "c1");
      writeFileSync(join(p, ".git"), "gitdir: /nonexistent\n"); // 作業ツリーの .git を壊す（登録は残る）
      const loss = await s.ports.lossFor("c1");
      expect(loss?.workingTreeUnknown).toBe(true);
    });

    it("上流が分からなければ、aheadCommits を省略する（不明）。作業ツリーが登録されていなければ undefined", async () => {
      const s = setup();
      const p = await provision(s, "c1");
      const branch = git(p, "rev-parse", "--abbrev-ref", "HEAD");
      git(p, "branch", "--unset-upstream", branch);
      const loss = await s.ports.lossFor("c1");
      expect(loss).toBeDefined();
      expect(loss?.aheadCommits).toBeUndefined();
      expect(loss?.subjects).toEqual([]);
      expect(await s.ports.lossFor("no-such")).toBeUndefined();
    });
  });
});

describe("破棄した成果の保管（T13f-r）", () => {
  const commitIn = (p: string, file: string, subject: string): string => {
    writeFileSync(join(p, file), `${subject}\n`);
    git(p, "add", "-A");
    git(p, "commit", "-q", "-m", subject);
    return git(p, "rev-parse", "HEAD");
  };
  const force = (
    s: ReturnType<typeof setup>,
    id: string,
    p: string,
    onTip?: (t: string, r?: string) => void,
  ) =>
    s.ports.removeWorktree(id, {
      expectedPath: p,
      force: true,
      ...(onTip === undefined ? {} : { onTip }),
    });
  const refs = (s: ReturnType<typeof setup>): string[] =>
    git(s.repoRoot, "for-each-ref", "--format=%(refname)", "refs/cso/discarded/")
      .split("\n")
      .filter((l) => l !== "");

  it("強制の回収で、ブランチの先端を refs/cso/discarded/<名前> に保管してから、ブランチを消す。onTip に ref も渡す。gc のあとも残る", async () => {
    const s = setup();
    const p = await provision(s, "c1");
    const tip = commitIn(p, "w.txt", "捨てる成果");
    const seen: { tip: string; ref?: string }[] = [];
    const r = await force(s, "c1", p, (t, ref) =>
      seen.push({ tip: t, ...(ref === undefined ? {} : { ref }) }),
    );
    expect(r.ok).toBe(true);
    const key = s.ports.discardedKeyOf("c1");
    expect(seen).toEqual([{ tip, ref: `refs/cso/discarded/${key}` }]);
    expect(git(s.repoRoot, "rev-parse", `refs/cso/discarded/${key}`)).toBe(tip);
    expect(() => git(s.repoRoot, "rev-parse", "--verify", `refs/heads/cso/${key}`)).toThrow();
    git(s.repoRoot, "reflog", "expire", "--expire=now", "--all");
    git(s.repoRoot, "gc", "-q", "--prune=now");
    expect(git(s.repoRoot, "cat-file", "-t", tip)).toBe("commit"); // gc で消えない
  });

  it("保管できなければ（ref を作れない）、何も消さずに失敗する（作業ツリーもブランチも残る）", async () => {
    const s = setup({ failUpdateRef: true });
    const p = await provision(s, "c1");
    commitIn(p, "w.txt", "守る成果");
    const r = await force(s, "c1", p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("keepFailed");
    expect(existsSync(p)).toBe(true);
    expect(git(s.repoRoot, "branch", "--list", `cso/${s.ports.discardedKeyOf("c1")}`)).not.toBe("");
  });

  it("上限に達したら、強制の回収は discardedStoreFull で失敗する（何も消さない。nextActions に list・drop・restore の案内）。drop すれば、通る", async () => {
    const s = setup({ discardedRefsMax: 1 });
    const a = await provision(s, "c1");
    commitIn(a, "a.txt", "一つ目");
    expect((await force(s, "c1", a)).ok).toBe(true);
    const b = await provision(s, "c2");
    commitIn(b, "b.txt", "二つ目");
    const full = await force(s, "c2", b);
    expect(full.ok).toBe(false);
    if (!full.ok) {
      expect(full.error.code).toBe("discardedStoreFull");
      const next = full.error.nextActions.join("\n");
      expect(next).toContain("cso discarded list");
      expect(next).toContain("cso discarded drop");
      expect(next).toContain("cso discarded restore");
    }
    expect(existsSync(b)).toBe(true); // 何も消していない
    expect((await s.ports.discardedDrop(s.ports.discardedKeyOf("c1"))).ok).toBe(true);
    expect((await force(s, "c2", b)).ok).toBe(true);
  });

  it("ブランチの削除に失敗して回収をやり直しても、同じ先端なら、保管は 1 件のまま（冪等）", async () => {
    const s = setup({ failBranchDOnce: true });
    const p = await provision(s, "c1");
    const tip = commitIn(p, "w.txt", "成果");
    expect((await force(s, "c1", p)).ok).toBe(false); // 保管のあと、作業ツリーは消え、ブランチだけ残る
    expect(refs(s)).toHaveLength(1);
    const again = await force(s, "c1", p); // やり直し（残りのブランチを消す）
    expect(again.ok).toBe(true);
    expect(refs(s)).toHaveLength(1);
    const key = s.ports.discardedKeyOf("c1");
    expect(git(s.repoRoot, "rev-parse", `refs/cso/discarded/${key}`)).toBe(tip);
  });

  it("同じ名前で、違う先端の保管がすでにあれば、上書きせず、<名前>-<先頭 12 桁> に置く（両方残る）", async () => {
    const s = setup();
    const p1 = await provision(s, "c1");
    const tip1 = commitIn(p1, "w.txt", "最初の成果");
    expect((await force(s, "c1", p1)).ok).toBe(true);
    const p2 = await provision(s, "c1"); // 同じ nodeId を再利用
    const tip2 = commitIn(p2, "x.txt", "別の成果");
    expect((await force(s, "c1", p2)).ok).toBe(true);
    const key = s.ports.discardedKeyOf("c1");
    expect(git(s.repoRoot, "rev-parse", `refs/cso/discarded/${key}`)).toBe(tip1);
    expect(git(s.repoRoot, "rev-parse", `refs/cso/discarded/${key}-${tip2.slice(0, 12)}`)).toBe(
      tip2,
    );
  });

  it("一覧: 鍵・先端・日時・件名。上限も返す", async () => {
    const s = setup({ discardedRefsMax: 7 });
    const p = await provision(s, "c1");
    const tip = commitIn(p, "w.txt", "一覧に出る件名");
    await force(s, "c1", p);
    const l = await s.ports.discardedList();
    expect(l.ok).toBe(true);
    if (l.ok) {
      expect(l.value.max).toBe(7);
      expect(l.value.items).toHaveLength(1);
      expect(l.value.items[0]).toMatchObject({
        key: s.ports.discardedKeyOf("c1"),
        tip,
        subject: "一覧に出る件名",
      });
      expect(l.value.items[0]?.committedAt).toMatch(/^\d{4}-/);
    }
  });

  it("取り出し: 保管の先端から、新しいブランチを作る（作成だけ。保管は残る）。既存のブランチは上書きしない。不正な名前は拒否する", async () => {
    const s = setup();
    const p = await provision(s, "c1");
    const tip = commitIn(p, "w.txt", "取り出す成果");
    await force(s, "c1", p);
    const key = s.ports.discardedKeyOf("c1");
    const ok = await s.ports.discardedRestore({ key });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.value).toEqual({ branch: `cso/restored/${key}`, tip });
      expect(git(s.repoRoot, "rev-parse", `refs/heads/${ok.value.branch}`)).toBe(tip);
    }
    expect(refs(s)).toHaveLength(1); // 保管は残る
    // 既存のブランチ（main）を指定しても、上書きしない
    const mainBefore = git(s.repoRoot, "rev-parse", "refs/heads/main");
    const clash = await s.ports.discardedRestore({ key, branch: "main" });
    expect(clash.ok).toBe(false);
    if (!clash.ok) expect(clash.error.code).toBe("branchExists");
    expect(git(s.repoRoot, "rev-parse", "refs/heads/main")).toBe(mainBefore);
    // 同じ名前の 2 回目も、上書きしない
    expect((await s.ports.discardedRestore({ key })).ok).toBe(false);
    for (const bad of ["a..b", "-x", "x y", "a/", "x.lock", "a~b", "@{"]) {
      const r = await s.ports.discardedRestore({ key, branch: bad });
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.error.code, bad).toBe("invalidName");
    }
    const none = await s.ports.discardedRestore({ key: "no-such-key" });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.error.code).toBe("notFound");
    const badKey = await s.ports.discardedRestore({ key: "a..b" });
    expect(badKey.ok).toBe(false);
    if (!badKey.ok) expect(badKey.error.code).toBe("invalidName");
  });

  it("消去: 保管を 1 件消す。ないもの・不正な鍵は失敗する", async () => {
    const s = setup();
    const p = await provision(s, "c1");
    const tip = commitIn(p, "w.txt", "成果");
    await force(s, "c1", p);
    const key = s.ports.discardedKeyOf("c1");
    const bad = await s.ports.discardedDrop("a..b");
    expect(bad.ok).toBe(false);
    const none = await s.ports.discardedDrop("no-such");
    expect(none.ok).toBe(false);
    const r = await s.ports.discardedDrop(key);
    expect(r).toEqual({ ok: true, value: { key, tip } });
    expect(refs(s)).toEqual([]);
  });

  it("最終削除での掃除: 渡したノードの保管（名前違いの重複も）だけを消し、ほかは残す", async () => {
    const s = setup();
    const a = await provision(s, "c1");
    commitIn(a, "a.txt", "c1 の成果");
    await force(s, "c1", a);
    const a2 = await provision(s, "c1");
    commitIn(a2, "a2.txt", "c1 の別の成果");
    await force(s, "c1", a2); // <名前>-<12 桁> が増える
    const b = await provision(s, "c2");
    commitIn(b, "b.txt", "c2 の成果");
    await force(s, "c2", b);
    expect(refs(s)).toHaveLength(3);
    const r = await s.ports.discardedDeleteFor(["c1"]);
    expect(r.deleted).toHaveLength(2);
    expect(r.failed).toEqual([]);
    expect(refs(s)).toEqual([`refs/cso/discarded/${s.ports.discardedKeyOf("c2")}`]);
  });
});
