import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ok } from "@cso/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Daemon } from "../src/compose.js";
import { loadLauncher, loadWorktreePorts } from "../src/loaders.js";
import { main } from "../src/main.js";
import { FakeLauncher } from "./sdk/fakes.js";

const running: Daemon[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const d of running.splice(0)) await d.stop();
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@e.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@e.com",
    },
  }).trim();

const setup = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "cso-start-")));
  const repoRoot = join(base, "repo");
  const worktreeRoot = join(base, "worktrees");
  mkdirSync(repoRoot);
  mkdirSync(worktreeRoot);
  git(repoRoot, "init", "-q", "-b", "main");
  writeFileSync(join(repoRoot, "a.txt"), "a\n");
  git(repoRoot, "add", ".");
  git(repoRoot, "commit", "-q", "-m", "init");
  const config = {
    stateDir: join(base, "state"),
    repoRoot,
    worktreeRoot,
    rootCwd: repoRoot,
    rootScope: {
      writableLocations: ["src"],
      forbiddenLocations: [".git"],
      allowedCommands: ["pnpm test"],
    },
    mcpUrl: "http://127.0.0.1:7777/mcp",
  };
  const path = join(base, "daemon.json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return { base, config, path };
};

describe("起動を、実物の git の口（loadWorktreePorts）を通して確かめる", () => {
  it("cso-daemon の読み込みで git の口を得て、根が spawn した子の作業ツリーが、実際の git に作られる", async () => {
    const s = setup();
    // 既定の childHome（isolated）では、子に認証の環境変数が要る（T22-auth）
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const launcher = new FakeLauncher();
    const out: string[] = [];
    const err: string[] = [];
    const r = await main(["--config", s.path], {
      loadLauncher: async () => ok(launcher),
      loadWorktreePorts, // 実物の git の口（./git-ports.js を読み込む）
      stdout: (t) => out.push(t),
      stderr: (t) => err.push(t),
    });
    expect(r.exitCode, err.join("")).toBe(0);
    if (r.daemon) running.push(r.daemon);
    const url = /(http:\/\/127\.0\.0\.1:\d+)/.exec(out.join(""))?.[1] as string;
    const rootToken = readFileSync(join(s.config.stateDir, "root-token"), "utf8").trim();
    const res = await fetch(`${url}/v1/request`, {
      method: "POST",
      headers: { authorization: `Bearer ${rootToken}`, "content-type": "application/json" },
      body: JSON.stringify({
        requestId: "sp-real-1",
        operation: "node.spawn",
        params: {
          parentId: "root",
          role: "implement",
          objective: "UI を直す",
          acceptanceCriteria: ["テストが通る"],
          scope: {
            writableLocations: ["src/ui"],
            forbiddenLocations: [".git"],
            allowedCommands: ["pnpm test"],
          },
        },
      }),
    });
    const json = (await res.json()) as { ok: boolean; value?: { nodeId: string; status: string } };
    expect(json.ok, JSON.stringify(json)).toBe(true);
    expect(json.value?.status).toBe("running");
    expect(launcher.sessions).toHaveLength(1);
    const cwd = launcher.sessions[0]?.options.cwd as string;
    expect(cwd.startsWith(`${s.config.worktreeRoot}/`)).toBe(true);
    expect(existsSync(join(cwd, "a.txt"))).toBe(true);
    expect(git(s.config.repoRoot, "worktree", "list")).toContain(cwd);
    expect(git(s.config.repoRoot, "branch", "--list", "cso/*")).not.toBe("");
  });

  it("git の口が失敗したら、notConfigured ではなく、原因つきの失敗で起動しない。実 SDK の launcher は読み込める（起動はしない）", async () => {
    const s = setup();
    // repoRoot をリンク経由にして、createGitPorts を失敗させる
    const link = join(s.base, "repo-link");
    symlinkSync(s.config.repoRoot, link);
    writeFileSync(s.path, JSON.stringify({ ...s.config, repoRoot: link, rootCwd: link }), {
      mode: 0o600,
    });
    const err: string[] = [];
    const r = await main(["--config", s.path], {
      loadLauncher: async () => ok(new FakeLauncher()),
      loadWorktreePorts,
      stdout: () => undefined,
      stderr: (t) => err.push(t),
    });
    expect(r.exitCode).toBe(1);
    expect(err.join("")).toContain("invalidConfig");
    expect(err.join("")).not.toContain("notConfigured");

    const launcher = await loadLauncher(s.config as never);
    // 実 SDK のモジュールを読み込むだけで、セッションは起動しない（認証情報は要らない）。
    expect(launcher.ok).toBe(true);
    if (launcher.ok) expect(typeof launcher.value.launch).toBe("function");
  });
});
