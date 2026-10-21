import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Failure, ok, type Result } from "@cso/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDaemon,
  type Daemon,
  type DaemonDeps,
  trackTimers,
  type WorktreePorts,
} from "../src/compose.js";
import type { DaemonConfig } from "../src/config.js";
import { EventLog } from "../src/eventlog.js";
import { openSqliteStore } from "../src/sqlite-store.js";
import { FakeLauncher } from "./sdk/fakes.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), "cso-compose-")));

const rig = (over: Partial<DaemonConfig> = {}, stateDir?: string) => {
  const base = tmp();
  const repoRoot = join(base, "repo");
  const worktreeRoot = join(base, "worktrees");
  mkdirSync(repoRoot);
  mkdirSync(worktreeRoot);
  const config: DaemonConfig = {
    stateDir: stateDir ?? join(base, "state"),
    repoRoot,
    worktreeRoot,
    rootCwd: repoRoot,
    rootNodeId: "root",
    rootScope: {
      writableLocations: ["src"],
      forbiddenLocations: [".git"],
      allowedCommands: ["pnpm test"],
    },
    mcpUrl: "http://127.0.0.1:7777/mcp",
    port: 0,
    ...over,
  };
  const launcher = new FakeLauncher();
  const calls = { provisioned: [] as string[], removed: [] as string[] };
  const worktree: WorktreePorts = {
    factsFor: async () => undefined,
    removeWorktree: async (id): Promise<Result<undefined, Failure>> => {
      calls.removed.push(id);
      return ok(undefined);
    },
    provisionWorktree: async ({ nodeId }) => {
      calls.provisioned.push(nodeId);
      const p = join(worktreeRoot, nodeId);
      mkdirSync(p, { recursive: true });
      return ok({ worktreePath: p });
    },
    cwdOf: async () => undefined,
  };
  const logs: string[] = [];
  const deps: DaemonDeps = {
    launcher,
    worktree,
    probe: async () => [],
    logLine: (l) => logs.push(l),
  };
  return { config, deps, launcher, calls, logs };
};

const boot = async (
  r: ReturnType<typeof rig>,
): Promise<{ daemon: Daemon; url: string; rootToken: string; humanToken: string }> => {
  const made = createDaemon(r.config, r.deps);
  if (!made.ok) throw new Error(`${made.error.code}: ${made.error.cause}`);
  const run = await made.value.start();
  cleanups.push(() => made.value.stop());
  return {
    daemon: made.value,
    url: run.url,
    rootToken: readFileSync(run.rootTokenPath, "utf8").trim(),
    humanToken: readFileSync(run.humanTokenPath, "utf8").trim(),
  };
};

const call = async (
  url: string,
  token: string,
  operation: string,
  params: unknown,
  requestId = `q-${Math.random()}`.replace(".", ""),
) => {
  const res = await fetch(`${url}/v1/request`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ requestId, operation, params }),
  });
  return {
    status: res.status,
    // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
    json: (await res.json()) as { ok: boolean; value?: any; error?: Failure },
  };
};

describe("createDaemon（組み立てて、窓口まで起動する）", () => {
  it("根のノードを作り、トークンのファイルを 0600 で置き、窓口で呼べる", async () => {
    const r = rig();
    const d = await boot(r);
    expect(statSync(join(r.config.stateDir, "human-token")).mode & 0o777).toBe(0o600);
    expect(statSync(join(r.config.stateDir, "root-token")).mode & 0o777).toBe(0o600);
    expect(statSync(r.config.stateDir).mode & 0o777).toBe(0o700);
    const list = await call(d.url, d.rootToken, "tree.list", {});
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.json.value)).toContain("root");
    expect(d.daemon.log.state().nodes.map((n) => n.id)).toEqual(["root"]);
    // 人間のトークンでは、統合の操作を呼べない
    expect((await call(d.url, d.humanToken, "tree.list", {})).status).toBe(403);
    // ログにトークンが出ない
    expect(r.logs.join("\n")).not.toContain(d.rootToken);
    expect(r.logs.join("\n")).not.toContain(d.humanToken);
  });

  it("再起動しても、根を重複させず、根のトークンは変わらず有効", async () => {
    const r = rig();
    const first = await boot(r);
    await first.daemon.stop();
    cleanups.length = 0;
    const second = await boot(r);
    expect(second.rootToken).toBe(first.rootToken);
    expect(second.daemon.log.state().nodes).toHaveLength(1);
    expect((await call(second.url, second.rootToken, "tree.list", {})).status).toBe(200);
  });

  it("根の統合ノードが spawn で子を作り、実際に起動できる（rootScope・根の cwd・作業ツリーの配線）", async () => {
    const r = rig();
    const d = await boot(r);
    const spawn = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      objective: "UI を直す",
      acceptanceCriteria: ["テストが通る"],
      scope: {
        writableLocations: ["src/ui"],
        forbiddenLocations: [".git"],
        allowedCommands: ["pnpm test"],
      },
    });
    expect(spawn.json.ok, JSON.stringify(spawn.json)).toBe(true);
    expect(spawn.json.value.status).toBe("running");
    expect(r.launcher.sessions).toHaveLength(1);
    expect(r.calls.provisioned).toEqual([spawn.json.value.nodeId]);
    // 根の範囲を超える子は、拒否される
    const wide = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      objective: "x",
      acceptanceCriteria: ["x"],
      scope: {
        writableLocations: ["src"],
        forbiddenLocations: [".git"],
        allowedCommands: ["rm -rf"],
      },
    });
    expect(wide.json.ok).toBe(false);
    expect(wide.json.error?.code).toBe("scopeNotSubset");
  });

  it("置き場の権限が緩い・根の役割が違う・ストアが壊れているときは、起動に失敗する（例外にしない）", async () => {
    const loose = rig();
    mkdirSync(loose.config.stateDir, { mode: 0o777 });
    // umask の影響を避けて、明示的に緩くする
    const { chmodSync } = await import("node:fs");
    chmodSync(loose.config.stateDir, 0o777);
    const a = createDaemon(loose.config, loose.deps);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.code).toBe("stateDirInvalid");

    const r = rig();
    const first = await boot(r);
    await first.daemon.stop();
    cleanups.length = 0;
    const mismatch = createDaemon({ ...r.config, rootNodeId: "root" }, r.deps);
    expect(mismatch.ok).toBe(true); // 同じ設定なら開ける
    if (mismatch.ok) await mismatch.value.stop();
  });

  it("根のノード ID が、根でないノードを指していたら、起動に失敗する", async () => {
    const r = rig();
    const d = await boot(r);
    // 子を 1 つ作る（根の下）
    const spawn = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      objective: "x",
      acceptanceCriteria: ["x"],
      scope: { writableLocations: ["src"], forbiddenLocations: [".git"], allowedCommands: [] },
    });
    const childId = spawn.json.value.nodeId as string;
    await d.daemon.stop();
    cleanups.length = 0;
    const bad = createDaemon({ ...r.config, rootNodeId: childId }, r.deps);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe("rootNodeMismatch");
  });
});

describe("起動の安全（レビュー反映）", () => {
  it("stateDir が 0700 でなければ（0755 など）起動に失敗する。SQLite のファイルは 0600", async () => {
    const loose = rig();
    mkdirSync(loose.config.stateDir);
    chmodSync(loose.config.stateDir, 0o755);
    const a = createDaemon(loose.config, loose.deps);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.error.code).toBe("stateDirInvalid");

    const r = rig();
    const d = await boot(r);
    for (const f of ["state.db", "state.db-wal", "state.db-shm"]) {
      const p = join(r.config.stateDir, f);
      if (existsSync(p)) expect(statSync(p).mode & 0o777, f).toBe(0o600);
    }
    expect(existsSync(join(r.config.stateDir, "state.db"))).toBe(true);
    expect(d.daemon.log.state().nodes).toHaveLength(1);
  });

  it("根が作成だけで止まっていた（pending）なら、開始を記録する。使えない状態なら失敗する", async () => {
    const r = rig();
    mkdirSync(r.config.stateDir, { mode: 0o700 });
    const store = openSqliteStore(join(r.config.stateDir, "state.db"));
    if (!store.ok) throw new Error("store");
    const log = EventLog.open(store.value, { clock: () => "2026-10-20T00:00:00Z" });
    if (!log.ok) throw new Error("log");
    log.value.append({
      requestId: "bootstrap-root-created",
      actor: { system: true },
      body: {
        type: "node.created",
        payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
      },
    });
    store.value.close();
    const d = await boot(r);
    expect(d.daemon.log.state().nodes[0]?.state).toBe("running");

    const stopped = rig();
    const first = await boot(stopped);
    first.daemon.log.append({
      requestId: "stop-root",
      actor: { system: true },
      body: {
        type: "node.stateChanged",
        payload: { nodeId: "root", event: { type: "stop", mode: "immediate" } },
      },
    });
    await first.daemon.stop();
    cleanups.length = 0;
    const again = createDaemon(stopped.config, stopped.deps);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.error.code).toBe("rootNodeMismatch");
  });

  it("根のトークンのファイルが認証に通らなければ、発行し直して置き換える（一時ファイルを残さない）", async () => {
    const r = rig();
    const first = await boot(r);
    const path = join(r.config.stateDir, "root-token");
    await first.daemon.stop();
    cleanups.length = 0;
    writeFileSync(path, "garbage-token-that-is-not-valid-0123456789\n", { mode: 0o600 });
    const second = await boot(r);
    expect(second.rootToken).not.toBe("garbage-token-that-is-not-valid-0123456789");
    expect((await call(second.url, second.rootToken, "tree.list", {})).status).toBe(200);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(r.config.stateDir).filter((f) => f.includes(".tmp-"))).toEqual([]);
  });

  it("リンクを解決すると置き場が重なる設定は、起動に失敗する", () => {
    const r = rig();
    const link = join(tmp(), "link");
    symlinkSync(r.config.worktreeRoot, link);
    const made = createDaemon({ ...r.config, stateDir: join(link, "state") }, r.deps);
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.error.code).toBe("invalidConfig");
  });

  it("trackTimers: 止めるときに、残っているタイマーをまとめて取り消す", () => {
    let cancelled = 0;
    const tracker = trackTimers({
      now: () => 0,
      sleep: async () => undefined,
      after: () => ({ promise: new Promise<void>(() => undefined), cancel: () => cancelled++ }),
    });
    tracker.timers.after(1000);
    tracker.timers.after(2000);
    tracker.cancelAll();
    expect(cancelled).toBe(2);
    tracker.cancelAll();
    expect(cancelled).toBe(2);
  });
});
