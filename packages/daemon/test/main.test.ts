import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failure, ok } from "@cso/core";
import { afterEach, describe, expect, it } from "vitest";
import type { Daemon, WorktreePorts } from "../src/compose.js";
import { type MainDeps, main } from "../src/main.js";
import { FakeLauncher } from "./sdk/fakes.js";

const running: Daemon[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) await d.stop();
});

const worktree: WorktreePorts = {
  factsFor: async () => undefined,
  removeWorktree: async () => ok(undefined),
  provisionWorktree: async () => ok({ worktreePath: "/nowhere" }),
  cwdOf: async () => undefined,
};

const setup = (over: Record<string, unknown> = {}) => {
  const base = mkdtempSync(join(tmpdir(), "cso-main-"));
  mkdirSync(join(base, "repo"));
  mkdirSync(join(base, "worktrees"));
  const config = {
    stateDir: join(base, "state"),
    repoRoot: join(base, "repo"),
    worktreeRoot: join(base, "worktrees"),
    rootCwd: join(base, "repo"),
    rootScope: {
      writableLocations: ["src"],
      forbiddenLocations: [".git"],
      allowedCommands: ["pnpm test"],
    },
    mcpUrl: "http://127.0.0.1:7777/mcp",
    ...over,
  };
  const path = join(base, "daemon.json");
  writeFileSync(path, JSON.stringify(config));
  const out: string[] = [];
  const err: string[] = [];
  const deps: MainDeps = {
    loadLauncher: async () => ok(new FakeLauncher()),
    loadWorktreePorts: async () => ok(worktree),
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t),
  };
  return { path, out, err, deps, config };
};

describe("main（cso-daemon --config <設定>）", () => {
  it("--help は使い方を出して終了コード 0。引数の誤りは 2", async () => {
    const s = setup();
    expect((await main(["--help"], s.deps)).exitCode).toBe(0);
    expect(s.out.join("")).toContain("--config");
    for (const argv of [[], ["--config"], ["--config", s.path, "x"], ["x", "y"]]) {
      expect((await main(argv, s.deps)).exitCode, argv.join(" ")).toBe(2);
    }
  });

  it("設定がない・不正なら、起動せずに終了コード 1（原因と次の操作つき）", async () => {
    const s = setup();
    const missing = await main(["--config", join(tmpdir(), "no-such-cso-config.json")], s.deps);
    expect(missing.exitCode).toBe(1);
    expect(s.err.join("")).toContain("次の操作");
    const s2 = setup({ port: 99999 });
    const bad = await main(["--config", s2.path], s2.deps);
    expect(bad.exitCode).toBe(1);
    expect(s2.err.join("")).toContain("port");
    expect(bad.daemon).toBeUndefined();
  });

  it("launcher・作業ツリーの口が用意できなければ、起動せずに終了コード 1", async () => {
    const s = setup();
    const noLauncher = await main(["--config", s.path], {
      ...s.deps,
      loadLauncher: async () => ({
        ok: false,
        error: failure("notConfigured", "launcher がない", "実装を確認する"),
      }),
    });
    expect(noLauncher.exitCode).toBe(1);
    expect(s.err.join("")).toContain("launcher がない");
    const s2 = setup();
    const noPorts = await main(["--config", s2.path], {
      ...s2.deps,
      loadWorktreePorts: async () => ({
        ok: false,
        error: failure("notConfigured", "git の口がない", "実装を確認する"),
      }),
    });
    expect(noPorts.exitCode).toBe(1);
  });

  it("起動できたら、URL とトークンのファイルの場所だけを出す（トークンそのものは出さない）", async () => {
    const s = setup();
    const r = await main(["--config", s.path], s.deps);
    expect(r.exitCode).toBe(0);
    if (r.daemon) running.push(r.daemon);
    const text = s.out.join("");
    expect(text).toContain("http://127.0.0.1:");
    expect(text).toContain("human-token");
    const token = readFileSync(join(s.config.stateDir, "human-token"), "utf8").trim();
    expect(text).not.toContain(token);
  });

  it("ポートが使用中なら、終了コード 1", async () => {
    const blocker = createServer();
    await new Promise<void>((res) => blocker.listen(0, "127.0.0.1", res));
    const port = (blocker.address() as { port: number }).port;
    try {
      const s = setup({ port });
      const r = await main(["--config", s.path], s.deps);
      expect(r.exitCode).toBe(1);
      expect(s.err.join("")).toContain("listenFailed");
    } finally {
      await new Promise((res) => blocker.close(res));
    }
  });
});
