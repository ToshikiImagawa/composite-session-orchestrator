import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventBody, failure, stateOf } from "@cso/core";
import { describe, expect, it } from "vitest";
import { createReclaimHandlers } from "../src/api/handlers/reclaim-handlers.js";
import type { HandlerRequest } from "../src/api/server.js";
import { EventLog } from "../src/eventlog.js";
import { createGitPorts, nodeGit } from "../src/git-ports.js";
import { createMemoryStore } from "../src/memory-store.js";

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

/** 実際の git で、破棄の判断を経た停止ノードを回収する（T10r2。実 SDK の確認で、未追跡のファイルがあると回収できなかった）。 */
const setup = async (mode: "discard" | "verified" = "discard") => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cso-reclaim-")));
  const repoRoot = join(base, "repo");
  const worktreeRoot = join(base, "worktrees");
  mkdirSync(repoRoot);
  mkdirSync(worktreeRoot);
  git(repoRoot, "init", "-q", "-b", "main");
  writeFileSync(join(repoRoot, "a.txt"), "a\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-q", "-m", "init");
  const made = createGitPorts(
    { repoRoot, worktreeRoot, rootCwd: repoRoot, rootNodeId: "root" },
    nodeGit,
  );
  if (!made.ok) throw new Error(made.error.cause);
  const ports = made.value;
  const opened = EventLog.open(createMemoryStore().open(), { clock: () => "2026-10-20T00:00:00Z" });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  let n = 0;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `s-${++n}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  add({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  });
  add({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } });
  add({
    type: "node.created",
    payload: { nodeId: "c1", role: "implement", parentId: "root", dependsOn: [] },
  });
  add({ type: "node.stateChanged", payload: { nodeId: "c1", event: { type: "start" } } });
  const p = await ports.provisionWorktree({ parentId: "root", nodeId: "c1" });
  if (!p.ok) throw new Error(p.error.cause);
  const wt = p.value.worktreePath;
  if (mode === "discard") {
    // 子の作業: 未追跡のファイルと、未統合のコミット、未保存の変更
    mkdirSync(join(wt, "src"));
    writeFileSync(join(wt, "src", "new.txt"), "新規\n");
    writeFileSync(join(wt, "w.txt"), "w\n");
    git(wt, "add", "w.txt");
    git(wt, "commit", "-q", "-m", "work");
    writeFileSync(join(wt, "a.txt"), "変更\n");
    add({
      type: "node.stateChanged",
      payload: { nodeId: "c1", event: { type: "stop", mode: "immediate" } },
    });
    add({
      type: "node.stateChanged",
      payload: { nodeId: "c1", event: { type: "confirmStopped" } },
    });
  } else {
    // 統合済み・きれい（作った直後と同じ）で、検証済み
    add({ type: "node.stateChanged", payload: { nodeId: "c1", event: { type: "reportDone" } } });
    add({ type: "node.stateChanged", payload: { nodeId: "c1", event: { type: "accept" } } });
  }
  const counts = { lastCommit: 0 };
  const flags: { failLastCommit: boolean; failRemoveOnce: boolean; beforeRemove?: () => void } = {
    failLastCommit: false,
    failRemoveOnce: false,
  };
  const handlerLog = {
    state: () => log.state(),
    append: (r: Parameters<typeof log.append>[0]) => log.append(r),
    appendAll: (rs: Parameters<typeof log.appendAll>[0]) => {
      if (rs.some((r) => r.body.type === "node.lastCommit")) {
        if (flags.failLastCommit) {
          return { ok: false as const, error: failure("storeFailed", "書けない", "もう一度試す") };
        }
        counts.lastCommit += 1;
      }
      return log.appendAll(rs);
    },
  };
  const failures: string[] = [];
  const h = createReclaimHandlers({
    log: handlerLog,
    clock: () => "2026-10-20T00:00:00Z",
    onFailure: (id, cause) => failures.push(`${id}: ${cause}`),
    ports: {
      factsFor: (id) => ports.factsFor(id),
      lossFor: (id) => ports.lossFor(id),
      probe: async () => [],
      removeWorktree: (id, opts) => {
        flags.beforeRemove?.();
        if (flags.failRemoveOnce) {
          flags.failRemoveOnce = false;
          return Promise.resolve({
            ok: false as const,
            error: failure("removeFailed", "消せない", "もう一度試す"),
          });
        }
        return ports.removeWorktree(id, opts);
      },
      worktreeRoot,
    },
  });
  const call = async (op: "node.reclaim" | "node.reclaimInstruct", role: string, nodeId: string) =>
    // biome-ignore lint/suspicious/noExplicitAny: 操作ごとの型は呼び出し側で保証
    (await (h[op] as any)({
      requestId: `q-${++n}`,
      operation: op,
      role,
      caller: role === "human" ? undefined : { nodeId: "root" },
      params: { nodeId },
    } as unknown as HandlerRequest<never>)) as {
      ok: boolean;
      error?: { code: string };
      value?: unknown;
    };
  const humanPreview = async (nodeId: string) =>
    // biome-ignore lint/suspicious/noExplicitAny: 操作ごとの型は呼び出し側で保証
    (await (h["node.reclaimPreview"] as any)({
      requestId: `hp-${++n}`,
      operation: "node.reclaimPreview",
      role: "human",
      params: { nodeId },
    } as unknown as HandlerRequest<never>)) as {
      ok: boolean;
      // biome-ignore lint/suspicious/noExplicitAny: テスト用
      value?: any;
    };
  return { repoRoot, wt, log, call, counts, flags, failures, humanPreview };
};

describe("破棄の判断を経た停止ノードの回収（実際の git）", () => {
  it("判断がなければ、未追跡のファイル・未統合のコミットがあって回収できない。判断の後は、作業ツリーとブランチを強制して消し、アーカイブする", async () => {
    const s = await setup();
    const no = await s.call("node.reclaim", "integrator", "c1");
    expect(no.ok).toBe(false);
    expect(existsSync(join(s.wt, "src", "new.txt"))).toBe(true);
    expect((await s.call("node.reclaimInstruct", "human", "c1")).ok).toBe(true);
    const tip = git(s.wt, "rev-parse", "HEAD");
    const done = await s.call("node.reclaim", "integrator", "c1");
    expect(done.ok).toBe(true);
    expect(s.log.state().nodes.find((x) => x.id === "c1")?.lastCommit).toBe(tip); // 墓標の lastCommit の情報源
    expect(existsSync(s.wt)).toBe(false);
    expect(git(s.repoRoot, "branch", "--list", "cso/*")).toBe("");
    // T13f-r: 捨てた成果の先端は、refs/cso/discarded/<名前> に保管される（gc で消えない）
    const kept = git(
      s.repoRoot,
      "for-each-ref",
      "--format=%(refname) %(objectname)",
      "refs/cso/discarded/",
    );
    expect(kept.split("\n")).toHaveLength(1);
    expect(kept.endsWith(` ${tip}`)).toBe(true);
    expect(stateOf(s.log.state(), "c1")).toBe("archived");
  });

  it("作業ツリーが消えてブランチだけ残った後（強制の途中の失敗）も、ハンドラ経由でやり直せば、残りのブランチを消して最後まで進む", async () => {
    const s = await setup();
    expect((await s.call("node.reclaimInstruct", "human", "c1")).ok).toBe(true);
    git(s.repoRoot, "worktree", "remove", "--force", s.wt); // 強制の途中で、ブランチの削除だけ失敗した状態
    expect(git(s.repoRoot, "branch", "--list", "cso/*")).not.toBe("");
    const done = await s.call("node.reclaim", "integrator", "c1");
    expect(done.ok).toBe(true);
    expect(git(s.repoRoot, "branch", "--list", "cso/*")).toBe("");
    expect(stateOf(s.log.state(), "c1")).toBe("archived");
  });

  it("作業ツリーもブランチもないノードは、これまでどおり回収できない（消すものがない）", async () => {
    const s = await setup();
    expect((await s.call("node.reclaimInstruct", "human", "c1")).ok).toBe(true);
    git(s.repoRoot, "worktree", "remove", "--force", s.wt);
    git(
      s.repoRoot,
      "branch",
      "-D",
      ...git(s.repoRoot, "branch", "--list", "cso/*").replace("*", "").trim().split("\n"),
    );
    const r = await s.call("node.reclaim", "integrator", "c1");
    expect(r.ok).toBe(false);
  });

  it("統合済みの通常の回収（-d）でも、先端を node.lastCommit に記録して、作業ツリーとブランチを消す", async () => {
    const s = await setup("verified");
    const tip = git(s.wt, "rev-parse", "HEAD");
    expect((await s.call("node.reclaim", "integrator", "c1")).ok).toBe(true);
    expect(s.log.state().nodes.find((x) => x.id === "c1")?.lastCommit).toBe(tip);
    expect(existsSync(s.wt)).toBe(false);
    expect(git(s.repoRoot, "branch", "--list", "cso/*")).toBe("");
    expect(stateOf(s.log.state(), "c1")).toBe("archived");
  });

  it("削除に失敗して再試行しても、同じ最終コミットを二重に記録しない", async () => {
    const s = await setup("verified");
    s.flags.failRemoveOnce = true;
    expect((await s.call("node.reclaim", "integrator", "c1")).ok).toBe(false);
    expect(s.counts.lastCommit).toBe(1);
    expect((await s.call("node.reclaim", "integrator", "c1")).ok).toBe(true);
    expect(s.counts.lastCommit).toBe(1);
  });

  it("最終コミットの記録に失敗しても、回収は進み、note を残す", async () => {
    const s = await setup("verified");
    s.flags.failLastCommit = true;
    expect((await s.call("node.reclaim", "integrator", "c1")).ok).toBe(true);
    expect(existsSync(s.wt)).toBe(false);
    expect(s.log.state().nodes.find((x) => x.id === "c1")?.lastCommit).toBeUndefined();
    expect(s.failures.some((f) => f.includes("最終コミットを記録できなかった"))).toBe(true);
  });

  it("強制の直前に、判定のあとで先端が動いていたら、実際に消えたブランチの先端を記録する", async () => {
    const s = await setup();
    expect((await s.call("node.reclaimInstruct", "human", "c1")).ok).toBe(true);
    // 事実の取得（判定）のあと、ブランチを消す前に、人間が手でコミットを足した状態を作る
    let moved = "";
    s.flags.beforeRemove = () => {
      writeFileSync(join(s.wt, "late.txt"), "late\n");
      git(s.wt, "add", "late.txt");
      git(s.wt, "commit", "-q", "-m", "late");
      moved = git(s.wt, "rev-parse", "HEAD");
    };
    expect((await s.call("node.reclaim", "integrator", "c1")).ok).toBe(true);
    expect(s.log.state().nodes.find((x) => x.id === "c1")?.lastCommit).toBe(moved);
    // 保管も、実際に消えたブランチの先端（判定のあとで足されたコミットを含む）
    expect(git(s.repoRoot, "for-each-ref", "--format=%(objectname)", "refs/cso/discarded/")).toBe(
      moved,
    );
  });

  it("T21r: 破棄を指示する前に、実際の git で、失われるもの（統合されていないコミットの件名・未保存の変更・未追跡のファイル）を事前確認できる。何も変えない", async () => {
    const s = await setup();
    const before = s.log.state().lastSeq;
    const preview = await s.humanPreview("c1");
    expect(preview.ok).toBe(true);
    expect(preview.value.loss).toEqual([
      {
        nodeId: "c1",
        aheadCommits: 1,
        untrustedSubjects: ["work"],
        uncommitted: true, // a.txt を変更している
        untracked: 1, // src/new.txt
      },
    ]);
    expect(s.log.state().lastSeq).toBe(before); // 何も記録していない
    expect(existsSync(s.wt)).toBe(true);
  });

  it("T21r: 統合済み・きれいなノードは、失われるものがない（loss は空）", async () => {
    const s = await setup("verified");
    const preview = await s.humanPreview("c1");
    expect(preview.value.loss).toEqual([]);
  });
});
