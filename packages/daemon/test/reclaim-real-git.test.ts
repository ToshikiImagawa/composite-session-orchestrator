import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventBody, stateOf } from "@cso/core";
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
const setup = async () => {
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
  add({ type: "node.stateChanged", payload: { nodeId: "c1", event: { type: "confirmStopped" } } });
  const h = createReclaimHandlers({
    log,
    clock: () => "2026-10-20T00:00:00Z",
    ports: {
      factsFor: (id) => ports.factsFor(id),
      probe: async () => [],
      removeWorktree: (id, opts) => ports.removeWorktree(id, opts),
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
  return { repoRoot, wt, log, call };
};

describe("破棄の判断を経た停止ノードの回収（実際の git）", () => {
  it("判断がなければ、未追跡のファイル・未統合のコミットがあって回収できない。判断の後は、作業ツリーとブランチを強制して消し、アーカイブする", async () => {
    const s = await setup();
    const no = await s.call("node.reclaim", "integrator", "c1");
    expect(no.ok).toBe(false);
    expect(existsSync(join(s.wt, "src", "new.txt"))).toBe(true);
    expect((await s.call("node.reclaimInstruct", "human", "c1")).ok).toBe(true);
    const done = await s.call("node.reclaim", "integrator", "c1");
    expect(done.ok).toBe(true);
    expect(existsSync(s.wt)).toBe(false);
    expect(git(s.repoRoot, "branch", "--list", "cso/*")).toBe("");
    expect(stateOf(s.log.state(), "c1")).toBe("archived");
  });
});
