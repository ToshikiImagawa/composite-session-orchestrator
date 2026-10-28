import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
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

describe("窓口のポートの決め方（課題 3。port-file.ts）", () => {
  const portOf = (out: string[]): number =>
    Number(/http:\/\/127\.0\.0\.1:(\d+)/.exec(out.join(""))?.[1]);
  const start = async (s: ReturnType<typeof setup>, argv: string[] = ["--config", s.path]) => {
    s.out.length = 0;
    s.err.length = 0;
    const r = await main(argv, s.deps);
    if (r.daemon) running.push(r.daemon);
    return r;
  };
  const stopAll = async () => {
    for (const d of running.splice(0)) await d.stop();
  };
  const listenOn = async (port: number) => {
    const blocker = createServer();
    await new Promise<void>((res, rej) => {
      blocker.once("error", rej);
      blocker.listen(port, "127.0.0.1", () => res());
    });
    return blocker;
  };

  it("新規: どちらも指定がなければ、空いているポートを選び、stateDir の port（0600）に保存する。次の起動は、保存したポートを使う", async () => {
    const s = setup();
    expect((await start(s)).exitCode).toBe(0);
    const first = portOf(s.out);
    const file = join(s.config.stateDir, "port");
    expect(readFileSync(file, "utf8").trim()).toBe(String(first));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    await stopAll();
    expect((await start(s)).exitCode).toBe(0);
    expect(portOf(s.out)).toBe(first);
  });

  it("起動オプション --port と設定の port が、保存したポートより優先する（保存は書き換えない）", async () => {
    const s = setup();
    expect((await start(s)).exitCode).toBe(0);
    const saved = portOf(s.out);
    await stopAll();
    const free = await listenOn(0);
    const other = (free.address() as { port: number }).port;
    await new Promise((res) => free.close(res));
    expect((await start(s, ["--port", String(other), "--config", s.path])).exitCode).toBe(0);
    expect(portOf(s.out)).toBe(other);
    await stopAll();
    expect(readFileSync(join(s.config.stateDir, "port"), "utf8").trim()).toBe(String(saved));
    const c = setup({ port: other });
    writeFileSync(c.path, JSON.stringify({ ...c.config, stateDir: s.config.stateDir }));
    expect((await start(c)).exitCode).toBe(0);
    expect(portOf(c.out)).toBe(other);
  });

  it("保存したポートが使われていれば、別のポートに逃げず、理由と直し方を出して起動しない（終了コード 1）", async () => {
    const s = setup();
    expect((await start(s)).exitCode).toBe(0);
    const saved = portOf(s.out);
    await stopAll();
    const blocker = await listenOn(saved);
    try {
      const r = await start(s);
      expect(r.exitCode).toBe(1);
      const err = s.err.join("");
      expect(err).toContain(`前回のポート ${saved}`);
      expect(err).toContain("別のポートには移らない");
      expect(err).toContain("--port");
      expect(err).toContain("savedPortUnavailable");
      expect(err).toContain("一時的なポートの範囲");
      expect(s.out.join("")).not.toContain("起動した");
    } finally {
      await new Promise((res) => blocker.close(res));
    }
  });

  it("保存したポートのファイルが壊れている・権限が緩いなら、起動しない（新しいポートにしない）", async () => {
    const s = setup();
    expect((await start(s)).exitCode).toBe(0);
    await stopAll();
    const file = join(s.config.stateDir, "port");
    writeFileSync(file, "abc\n", { mode: 0o600 });
    expect((await start(s)).exitCode).toBe(1);
    expect(s.err.join("")).toContain("portFileInvalid");
    expect(s.err.join("")).toContain("1〜65535 の整数でない");
    expect(s.err.join("")).toContain("0600");
    writeFileSync(file, "40000\n");
    chmodSync(file, 0o644);
    expect((await start(s)).exitCode).toBe(1);
    expect(s.err.join("")).toContain("権限が緩い");
  });

  it("--port の誤り（0・範囲外・数字でない・重複・値なし）は、終了コード 2", async () => {
    const s = setup();
    for (const argv of [
      ["--config", s.path, "--port", "0"],
      ["--config", s.path, "--port", "65536"],
      ["--config", s.path, "--port", "8x"],
      ["--config", s.path, "--port", "1", "--port", "2"],
      ["--config", s.path, "--port"],
      ["--port", "4000"],
      ["--config", "--port", "4000"],
      ["--config", s.path, "--port", "--config"],
    ]) {
      expect((await main(argv, s.deps)).exitCode, argv.join(" ")).toBe(2);
    }
  });

  it("ポートのファイルがシンボリックリンクなら、起動しない（portFileInvalid。リンク先は読まない）", async () => {
    const s = setup();
    expect((await start(s)).exitCode).toBe(0);
    await stopAll();
    const file = join(s.config.stateDir, "port");
    const target = join(s.config.stateDir, "elsewhere");
    writeFileSync(target, "40001\n", { mode: 0o600 });
    unlinkSync(file);
    symlinkSync(target, file);
    expect((await start(s)).exitCode).toBe(1);
    expect(s.err.join("")).toContain("portFileInvalid");
    expect(s.err.join("")).toContain("シンボリックリンク");
  });
});
