import { execFile } from "node:child_process";
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
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { digestOf, type Failure, ok, planPurge, type Result } from "@cso/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveId } from "../src/api/handlers/context.js";
import { parseIdentityFile, proofOf } from "../src/api/identity.js";
import { FileTokenRepository } from "../src/api/token-repository.js";
import {
  apiLimitsOf,
  createDaemon,
  type Daemon,
  type DaemonDeps,
  trackTimers,
  type WorktreePorts,
} from "../src/compose.js";
import type { DaemonConfig } from "../src/config.js";
import { EventLog } from "../src/eventlog.js";
import { EXTERNAL_CHECK_SUMMARY } from "../src/external-check.js";
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
    // 既定の childHome（isolated）では、子に認証の環境変数が要る（T22-auth）
    parentEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "test-key" },
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
    // 手元では全体で 100ms ほど（stop も数 ms）。5 秒の既定を超えたのは、CI の macOS が、git の試験と並んで重かったため（実際の遅れではない）。
    // 時間切れの切り分け用に、区間ごとの所要（ms）を測り、失敗したときだけ出力する。
    const marks: [string, number][] = [];
    let t = performance.now();
    const lap = (name: string) => {
      const n = performance.now();
      marks.push([name, Math.round(n - t)]);
      t = n;
    };
    try {
      const r = rig();
      lap("rig");
      const first = await boot(r);
      lap("1 回目の起動");
      await first.daemon.stop();
      lap("stop");
      cleanups.length = 0;
      const second = await boot(r);
      lap("2 回目の起動");
      expect(second.rootToken).toBe(first.rootToken);
      expect(second.daemon.log.state().nodes).toHaveLength(1);
      expect((await call(second.url, second.rootToken, "tree.list", {})).status).toBe(200);
      lap("tree.list");
    } catch (e) {
      console.error(`再起動の試験の区間（ms）: ${JSON.stringify(marks)}`);
      throw e;
    }
  }, 15_000);

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

describe("createDaemon（起動時の整合。待ち受けの前に reconcileOnStartup を呼ぶ）", () => {
  it("前回の実行中の子で、プロセスがもう無ければ、start の後には running のままではない", async () => {
    const r = rig();
    mkdirSync(r.config.stateDir, { mode: 0o700 });
    const store = openSqliteStore(join(r.config.stateDir, "state.db"));
    if (!store.ok) throw new Error("store");
    const log = EventLog.open(store.value, { clock: () => "2026-10-20T00:00:00Z" });
    if (!log.ok) throw new Error("log");
    const add = (requestId: string, body: Parameters<typeof log.value.append>[0]["body"]) =>
      log.value.append({ requestId, actor: { system: true }, body });
    add("seed-root", {
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    });
    add("seed-root-start", {
      type: "node.stateChanged",
      payload: { nodeId: "root", event: { type: "start" } },
    });
    add("seed-c1", {
      type: "node.created",
      payload: { nodeId: "c1", role: "implement", parentId: "root", dependsOn: [] },
    });
    add("seed-c1-start", {
      type: "node.stateChanged",
      payload: { nodeId: "c1", event: { type: "start" } },
    });
    store.value.close();
    const cwd = join(r.config.worktreeRoot, "c1");
    mkdirSync(cwd);
    r.deps = { ...r.deps, worktree: { ...r.deps.worktree, cwdOf: async () => cwd } };

    const d = await boot(r);
    const c1 = d.daemon.log.state().nodes.find((n) => n.id === "c1");
    expect(c1?.state).not.toBe("running");
  });
});

describe("createDaemon（起動時のスケジューラ）", () => {
  it("前回から残った、依存の揃った pending の子を、start の後に起動する", async () => {
    const r = rig();
    mkdirSync(r.config.stateDir, { mode: 0o700 });
    const store = openSqliteStore(join(r.config.stateDir, "state.db"));
    if (!store.ok) throw new Error("store");
    const log = EventLog.open(store.value, { clock: () => "2026-10-20T00:00:00Z" });
    if (!log.ok) throw new Error("log");
    const add = (requestId: string, body: Parameters<typeof log.value.append>[0]["body"]) =>
      log.value.append({ requestId, actor: { system: true }, body });
    add("seed-root", {
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    });
    add("seed-root-start", {
      type: "node.stateChanged",
      payload: { nodeId: "root", event: { type: "start" } },
    });
    add("seed-p1", {
      type: "node.created",
      payload: {
        nodeId: "p1",
        role: "implement",
        parentId: "root",
        dependsOn: [],
        objective: "目的",
        acceptanceCriteria: ["完了"],
        scope: r.config.rootScope,
      },
    });
    store.value.close();

    const d = await boot(r);
    await vi.waitFor(() => expect(r.launcher.sessions).toHaveLength(1));
    expect(d.daemon.log.state().nodes.find((n) => n.id === "p1")?.state).toBe("running");
  });
});

describe("createDaemon（最終削除）", () => {
  /** 前回の実行から残った、アーカイブ済みの木 t（子 c）を、状態の置き場に用意する。 */
  const seedArchivedTree = (r: ReturnType<typeof rig>) => {
    mkdirSync(r.config.stateDir, { mode: 0o700 });
    const store = openSqliteStore(join(r.config.stateDir, "state.db"));
    if (!store.ok) throw new Error("store");
    const log = EventLog.open(store.value, { clock: () => new Date().toISOString() });
    if (!log.ok) throw new Error("log");
    let k = 0;
    const add = (body: Parameters<typeof log.value.append>[0]["body"]) => {
      const x = log.value.append({ requestId: `seed-${++k}`, actor: { system: true }, body });
      if (!x.ok) throw new Error(`${x.error.code}: ${x.error.cause}`);
    };
    const ev = (nodeId: string, event: { type: string; [k: string]: unknown }) =>
      add({ type: "node.stateChanged", payload: { nodeId, event } } as never);
    const node = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
      add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
    node("root", "integrator", null);
    ev("root", { type: "start" });
    node("t", "integrator", "root");
    ev("t", { type: "start" });
    node("c", "implement", "t");
    ev("c", { type: "start" });
    for (const id of ["c", "t"]) {
      ev(id, { type: "reportDone" });
      ev(id, { type: "accept" });
      ev(id, { type: "markReclaimable", discarded: false });
      ev(id, { type: "archive" });
    }
    store.value.close();
  };

  it("人間のトークンで、事前確認と最終削除ができる。根（統合）のトークンでは拒否される。墓標が残る", async () => {
    const r = rig({ retentionDays: 0 });
    seedArchivedTree(r);
    const d = await boot(r);
    const preview = await call(d.url, d.humanToken, "node.purgePreview", { nodeId: "t" });
    expect(preview.json.ok).toBe(true);
    expect(preview.json.value.nodeIds).toEqual(["c", "t"]);
    const denied = await call(d.url, d.rootToken, "node.purge", { nodeId: "t" });
    expect(denied.json.ok).toBe(false);
    expect(d.daemon.log.state().nodes.some((n) => n.id === "t")).toBe(true);
    const done = await call(d.url, d.humanToken, "node.purge", { nodeId: "t" });
    expect(done.json.ok).toBe(true);
    expect(done.json.value.purged).toEqual(["c", "t"]);
    const state = d.daemon.log.state();
    expect(state.nodes.map((n) => n.id)).toEqual(["root"]);
    expect(state.tombstones.map((x) => x.rootId)).toEqual(["t"]);
    expect(r.logs.join("\n")).toContain("purge.purged");
  });

  it("最終削除に成功したあとに、worktree の口の discardedDeleteFor を、消えた木のノードで呼ぶ（保管の掃除）。結果は記録に残る。失敗しても、最終削除は成功", async () => {
    for (const failing of [false, true]) {
      const r = rig({ retentionDays: 0 });
      seedArchivedTree(r);
      const deleted: string[][] = [];
      r.deps = {
        ...r.deps,
        worktree: {
          ...r.deps.worktree,
          discardedDeleteFor: async (ids: readonly string[]) => {
            deleted.push([...ids]);
            if (failing) throw new Error("消せない");
            return { deleted: [{ key: "k", tip: "a".repeat(40) }], failed: [] };
          },
        },
      };
      const d = await boot(r);
      const done = await call(d.url, d.humanToken, "node.purge", { nodeId: "t" });
      expect(done.json.ok).toBe(true);
      await vi.waitFor(() => expect(deleted).toEqual([["c", "t"]]));
      await vi.waitFor(() =>
        expect(r.logs.join("\n")).toContain(
          failing ? "purge.discardedRefsFailed" : "purge.discardedRefsDeleted",
        ),
      );
    }
  });

  it("保持期間（既定 90 日）の前は、拒否される", async () => {
    const r = rig();
    seedArchivedTree(r);
    const d = await boot(r);
    const res = await call(d.url, d.humanToken, "node.purge", { nodeId: "t" });
    expect(res.json.ok).toBe(false);
    expect(res.json.error?.code).toBe("retentionNotElapsed");
  });

  it("追記のみの保証を確かめられなければ、onFatal を呼び、以降の書き込みを拒否する（fail closed）", async () => {
    const r = rig({ retentionDays: 0 });
    seedArchivedTree(r);
    const fatal: string[] = [];
    r.deps = {
      ...r.deps,
      onFatal: (cause) => fatal.push(cause),
      storeHooks: { beforeTriggerCheck: (db) => db.exec("DROP TRIGGER events_no_update") },
    };
    const d = await boot(r);
    const res = await call(d.url, d.humanToken, "node.purge", { nodeId: "t" });
    expect(res.json.ok).toBe(false);
    expect(res.json.error?.code).toBe("storeIntegrity");
    expect(fatal).toHaveLength(1);
    expect(r.logs.join("\n")).toContain('"event":"fatal"');
    const write = d.daemon.log.append({
      requestId: "after",
      actor: { system: true },
      body: { type: "node.toolDenied", payload: { nodeId: "root", tool: "x" } },
    });
    expect(write.ok === false && write.error.code).toBe("logBroken");
  });
});

describe("createDaemon（起動時のトークンの掃除）", () => {
  it("ストアにないノードのトークンは、起動時に失効させる（最終削除の途中で止まったときの残り）", async () => {
    const r = rig();
    mkdirSync(r.config.stateDir, { mode: 0o700 });
    const repo = new FileTokenRepository(join(r.config.stateDir, "node-tokens.json"));
    repo.put({
      tokenHash: "a".repeat(64),
      role: "child",
      nodeId: "ghost",
      issuedAt: "2026-01-01T00:00:00Z",
    });
    await boot(r);
    expect(repo.load().map((x) => x.nodeId)).not.toContain("ghost");
    expect(r.logs.join("\n")).toContain("orphanTokenRevoked");
  });
});

describe("createDaemon（自動の最終削除。設定 autoPurge）", () => {
  /** 保持期間を過ぎた、アーカイブ済みの木（t ─ tc）を、前回の実行から残す。 */
  const seedArchivedTree = (
    r: ReturnType<typeof rig>,
    opts: { staleNotice?: boolean; readyNotices?: boolean; trees?: string[] } = {},
  ) => {
    mkdirSync(r.config.stateDir, { mode: 0o700 });
    const store = openSqliteStore(join(r.config.stateDir, "state.db"));
    if (!store.ok) throw new Error("store");
    let at = "2026-01-01T00:00:00Z";
    const log = EventLog.open(store.value, { clock: () => at });
    if (!log.ok) throw new Error("log");
    let n = 0;
    const add = (body: Parameters<typeof log.value.append>[0]["body"]) => {
      const res = log.value.append({ requestId: `seed-${++n}`, actor: { system: true }, body });
      if (!res.ok) throw new Error(res.error.cause);
    };
    const ev = (nodeId: string, event: { type: string; discarded?: boolean }) =>
      add({ type: "node.stateChanged", payload: { nodeId, event } } as never);
    const node = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
      add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
    node("root", "integrator", null);
    ev("root", { type: "start" });
    const trees = opts.trees ?? ["t"];
    for (const id of trees) {
      node(id, "integrator", "root");
      ev(id, { type: "start" });
      node(`${id}c`, "implement", id);
      ev(`${id}c`, { type: "start" });
      for (const x of [`${id}c`, id]) {
        ev(x, { type: "reportDone" });
        ev(x, { type: "accept" });
        ev(x, { type: "markReclaimable", discarded: false });
        ev(x, { type: "archive" });
      }
    }
    if (opts.readyNotices === true) {
      // 前回の実行で出した予告（保持期間のあとに出し、7 日以上たっている）。最後の記録は現在に近い（止まっていない）
      at = "2026-05-20T00:00:00Z";
      for (const id of trees) {
        const plan = planPurge(log.value.state(), id, Date.parse("2026-06-01T00:00:00Z"));
        if (!plan.ok) throw new Error("plan");
        add({
          type: "inbox.added",
          payload: {
            id: deriveId("apn", "system", `${id}:${plan.value.archivedAt}:0`, "notice"),
            kind: "info",
            nodeId: "root",
            summary: "予告",
          },
        });
      }
      at = "2026-05-31T23:30:00Z";
      add({ type: "node.toolDenied", payload: { nodeId: "root", tool: "x" } });
    } else if (opts.staleNotice === true) {
      // 前回の実行で出した予告（有効）と、その後 11 日間の停止（最後の記録は 2026-05-21）
      const plan = planPurge(log.value.state(), "t", Date.parse("2026-06-01T00:00:00Z"));
      if (!plan.ok) throw new Error("plan");
      at = "2026-05-20T00:00:00Z";
      add({
        type: "inbox.added",
        payload: {
          id: deriveId("apn", "system", `t:${plan.value.archivedAt}:0`, "notice"),
          kind: "info",
          nodeId: "root",
          summary: "予告",
        },
      });
      at = "2026-05-21T00:00:00Z";
      add({ type: "node.toolDenied", payload: { nodeId: "root", tool: "x" } });
    } else {
      // 直近の記録（時計の異常の検知: ログの最後の記録が、現在に近いこと）
      at = "2026-05-31T23:30:00Z";
      add({ type: "node.toolDenied", payload: { nodeId: "root", tool: "x" } });
    }
    store.value.close();
  };

  /** 手動で進めるタイマー。`after` の数（取り消されていないもの）も数える。 */
  const manual = () => {
    let nowMs = Date.parse("2026-06-01T00:00:00Z");
    const waiting: { at: number; resolve: () => void; cancelled: boolean }[] = [];
    const timers = {
      now: () => nowMs,
      sleep: async () => undefined,
      after: (ms: number) => {
        const w = { at: nowMs + ms, resolve: () => {}, cancelled: false };
        const promise = new Promise<void>((res) => {
          w.resolve = res;
        });
        waiting.push(w);
        return { promise, cancel: () => (w.cancelled = true) };
      },
    };
    return {
      timers,
      advance: async (ms: number) => {
        nowMs += ms;
        for (const w of waiting) {
          if (!w.cancelled && w.at <= nowMs) {
            w.cancelled = true;
            w.resolve();
          }
        }
        await new Promise((res) => setImmediate(res));
      },
      /** 時刻を進めて、期限が来たタイマーを発火するだけ（その後の処理を待たない）。 */
      fire: (ms: number) => {
        nowMs += ms;
        for (const w of waiting) {
          if (!w.cancelled && w.at <= nowMs) {
            w.cancelled = true;
            w.resolve();
          }
        }
      },
      clock: () => new Date(nowMs).toISOString(),
    };
  };

  const hasTree = (d: Daemon) => d.log.state().nodes.some((n) => n.id === "t");

  it("設定がなければ（既定）、保持期間を過ぎた木があっても、自動では消さない", async () => {
    const r = rig();
    seedArchivedTree(r);
    const m = manual();
    r.deps = { ...r.deps, timers: m.timers, clock: m.clock, monotonicMs: () => m.timers.now() };
    const d = await boot(r);
    await m.advance(24 * 60 * 60_000);
    expect(hasTree(d.daemon)).toBe(true);
  });

  it("enabled: false なら、周期を作らず、消さない", async () => {
    const r = rig({ autoPurge: { enabled: false } });
    seedArchivedTree(r);
    const m = manual();
    r.deps = { ...r.deps, timers: m.timers, clock: m.clock, monotonicMs: () => m.timers.now() };
    const d = await boot(r);
    await m.advance(24 * 60 * 60_000);
    expect(hasTree(d.daemon)).toBe(true);
  });

  it("有効なら、起動直後は何もせず、1 周期後（既定 60 分）に予告を出し、予告から 7 日後（既定）に、保持期間を過ぎた木を消す。記録に残る", async () => {
    const r = rig({ autoPurge: { enabled: true } });
    seedArchivedTree(r);
    const m = manual();
    r.deps = { ...r.deps, timers: m.timers, clock: m.clock, monotonicMs: () => m.timers.now() };
    const d = await boot(r);
    expect(hasTree(d.daemon)).toBe(true);
    await m.advance(30 * 60_000);
    expect(d.daemon.log.state().inbox.some((i) => i.id.startsWith("apn-"))).toBe(false);
    await m.advance(30 * 60_000); // 1 周期: 予告
    expect(hasTree(d.daemon)).toBe(true);
    expect(d.daemon.log.state().inbox.some((i) => i.id.startsWith("apn-"))).toBe(true);
    await m.advance(6 * 24 * 60 * 60_000); // 予告から 6 日: まだ消さない
    expect(hasTree(d.daemon)).toBe(true);
    await m.advance(2 * 24 * 60 * 60_000); // 予告から 8 日
    expect(hasTree(d.daemon)).toBe(false);
    expect(r.logs.some((l) => l.includes("autoPurge.purged"))).toBe(true);
    expect(d.daemon.log.state().tombstones[0]?.rootId).toBe("t");
  });

  it("止まっていた時間は、予告の期間に数えない: 前回の予告から 11 日たった起動で、予告を出し直し、すぐには消さない", async () => {
    const r = rig({ autoPurge: { enabled: true } });
    seedArchivedTree(r, { staleNotice: true });
    const m = manual();
    r.deps = { ...r.deps, timers: m.timers, clock: m.clock, monotonicMs: () => m.timers.now() };
    const d = await boot(r);
    const notices = () => d.daemon.log.state().inbox.filter((i) => i.id.startsWith("apn-"));
    expect(notices()).toHaveLength(2); // 起動のときに、出し直した
    await m.advance(60 * 60_000); // 1 周期
    expect(hasTree(d.daemon)).toBe(true); // 前回の予告からは 11 日たつが、すぐには消さない
    await m.advance(8 * 24 * 60 * 60_000); // 出し直した予告から 8 日
    expect(hasTree(d.daemon)).toBe(false);
  });

  it("自動の削除の実行中に stop() を呼んでも、stop() が終わるまで、ストアは閉じられず、残りの木は消されず、閉じたあとのログへの書き込みも起きない", async () => {
    const r = rig({ autoPurge: { enabled: true } });
    seedArchivedTree(r, { trees: ["t", "u", "v"], readyNotices: true });
    const m = manual();
    r.deps = { ...r.deps, timers: m.timers, clock: m.clock, monotonicMs: () => m.timers.now() };
    const d = await boot(r);
    expect(d.daemon.log.state().nodes.some((n) => n.id === "u")).toBe(true);
    m.fire(60 * 60_000); // 1 周期: 予告済みの 3 本が対象（1 回に最大 2 本）
    // 1 本目を消し、イベントループに譲っている最中（setImmediate の前）に、stop() を呼ぶ
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(d.daemon.log.state().nodes.some((n) => n.id === "t")).toBe(false);
    const stopping = d.daemon.stop();
    await stopping;
    const state = d.daemon.log.state();
    expect(state.nodes.some((n) => n.id === "u")).toBe(true); // 2 本目以降は、消されない
    expect(state.nodes.some((n) => n.id === "v")).toBe(true);
    const logs = r.logs.join("\n");
    expect(logs).not.toContain("autoPurge.error"); // 閉じたあとのログへの書き込みの失敗が、起きていない
    expect(logs).not.toContain("autoPurge.failed");
    expect(logs).toContain("autoPurge.purged");
    expect(logs.indexOf("autoPurge.purged")).toBeLessThan(logs.lastIndexOf('"event":"stopped"'));
  });

  it("実 HTTP（T23-d3）: 同じ requestId の days を、時計を進めて 2 回送っても、最初の期限が返り、記録は増えない（requestIdConflict にならない）", async () => {
    const r = rig();
    seedArchivedTree(r);
    const m = manual();
    r.deps = { ...r.deps, timers: m.timers, clock: m.clock, monotonicMs: () => m.timers.now() };
    const d = await boot(r);
    const first = await call(
      d.url,
      d.humanToken,
      "node.purgeHold",
      { nodeId: "t", days: 30 },
      "hold-days-1",
    );
    expect(first.status).toBe(200);
    expect(first.json.value.until).toBe("2026-07-01T00:00:00Z"); // 2026-06-01 + 30 日
    const seq = d.daemon.log.state().lastSeq;
    m.fire(10 * 24 * 60 * 60_000); // 10 日後に、同じ requestId で再送する
    const again = await call(
      d.url,
      d.humanToken,
      "node.purgeHold",
      { nodeId: "t", days: 30 },
      "hold-days-1",
    );
    expect(again.status).toBe(200);
    expect(again.json.value.until).toBe(first.json.value.until);
    expect(d.daemon.log.state().lastSeq).toBe(seq);
    // 別の requestId の days は、いまの時計で決め直す
    const next = await call(d.url, d.humanToken, "node.purgeHold", { nodeId: "t", days: 30 });
    expect(next.json.value.until).toBe("2026-07-11T00:00:00Z");
  });

  it("intervalMinutes を指定できる。stop の後は、周期が来ても消さない", async () => {
    const r = rig({ autoPurge: { enabled: true, intervalMinutes: 5 } });
    seedArchivedTree(r);
    const m = manual();
    r.deps = { ...r.deps, timers: m.timers, clock: m.clock, monotonicMs: () => m.timers.now() };
    const d = await boot(r);
    await d.daemon.stop();
    await m.advance(10 * 60_000);
    expect(d.daemon.log.state().nodes.some((n) => n.id === "t")).toBe(true);
  });
});

describe("apiLimitsOf（設定から窓口の制限・接続・処理中の重複の deps。T10l-f）", () => {
  const cfg = (over: Partial<DaemonConfig> = {}): DaemonConfig => rig(over).config;

  it("設定がなければ、いまの既定と同じ（connection・inProgress・maxInFlightPerPrincipal は渡さない。窓口の既定が働く）", () => {
    const l = apiLimitsOf(cfg());
    expect(l.rateLimit).toEqual({
      perPrincipal: { burst: 60, perSecond: 20 },
      authFailures: { burst: 20, perSecond: 0.5 },
    });
    expect(l).not.toHaveProperty("connection");
    expect(l).not.toHaveProperty("inProgress");
  });

  it("設定した値は、そのまま渡る（同時数・接続・処理中の重複。省略した項目は、足さない）", () => {
    const l = apiLimitsOf(
      cfg({
        rateLimit: { maxInFlightPerPrincipal: 3 },
        connection: { requestTimeoutMs: 5000, headersTimeoutMs: 4000, maxConnections: 64 },
        inProgress: { waitMs: 2000, maxEntries: 100 },
      }),
      () => 7,
    );
    expect(l.rateLimit).toMatchObject({
      maxInFlightPerPrincipal: 3,
      monotonicMs: expect.any(Function),
    });
    expect(l.connection).toEqual({
      requestTimeoutMs: 5000,
      headersTimeoutMs: 4000,
      maxConnections: 64,
    });
    expect(l.inProgress).toEqual({ waitMs: 2000, maxEntries: 100 });
  });
});

describe("createDaemon（窓口の回数の制限。T10l）", () => {
  it("既定で有効: 設定で小さくした容量を超えると、実 HTTP で 429 と Retry-After。429 の要求は実行されていない。人間は影響されない", async () => {
    const r = rig({ rateLimit: { perPrincipal: { burst: 10, perSecond: 1 } } });
    const d = await boot(r);
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      statuses.push((await call(d.url, d.rootToken, "tree.list", {})).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
    expect(statuses.slice(10)).toEqual([429, 429]);
    const res = await fetch(`${d.url}/v1/request`, {
      method: "POST",
      headers: { authorization: `Bearer ${d.rootToken}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "q-limited", operation: "tree.list", params: {} }),
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    // 人間は、別の主体なので、影響されない
    const human = await call(d.url, d.humanToken, "node.purgePreview", { nodeId: "root" });
    expect(human.status).not.toBe(429);
  });

  it("T10l-f（R4）: 設定の maxInFlightPerPrincipal が、窓口に届いている（1 にすると、同時の 2 つ目の要求が 429。1 つ目は、終われば成功する）", async () => {
    const r = rig({ rateLimit: { maxInFlightPerPrincipal: 1 } });
    let release: () => void = () => {};
    const gate = new Promise<void>((res) => {
      release = res;
    });
    let entered: () => void = () => {};
    const started = new Promise<void>((res) => {
      entered = res;
    });
    r.deps = {
      ...r.deps,
      worktree: {
        ...r.deps.worktree,
        lossFor: async () => {
          entered();
          await gate;
          return undefined;
        },
      },
    };
    const d = await boot(r);
    const first = call(d.url, d.humanToken, "node.reclaimPreview", { nodeId: "root" });
    await started; // 1 つ目が、ハンドラの中で止まっている
    const second = await call(d.url, d.humanToken, "node.reclaimPreview", { nodeId: "root" });
    expect(second.status).toBe(429);
    release();
    expect((await first).status).toBe(200);
    // 枠は、1 つ目の処理が終わったとき返る（もう一度通る）
    expect(
      (await call(d.url, d.humanToken, "node.reclaimPreview", { nodeId: "root" })).status,
    ).toBe(200);
  });

  it("T10l-f PR-B: 認証の失敗が閾値を超えた窓のあと、根の受信箱に info が出る。窓の終わりの予約で、静かになっても出し損ねない（次の記録を待たない）。本文にトークンを出さず、窓の時刻を出す", async () => {
    const r = rig({ rateLimit: { alert: { threshold: 5, minIntervalMinutes: 10 } } });
    let mono = 1_000;
    const windows: (() => void)[] = [];
    r.deps = {
      ...r.deps,
      monotonicMs: () => mono,
      summaryScheduler: (fn) => {
        windows.push(fn);
        return { cancel: () => undefined };
      },
    };
    const d = await boot(r);
    const bogus = "z".repeat(43);
    const tick = () => new Promise((res) => setImmediate(res));
    const alerts = () => d.daemon.log.state().inbox.filter((i) => i.id.startsWith("api-alert-"));
    for (let i = 0; i < 8; i++) await call(d.url, bogus, "tree.list", {});
    await tick();
    expect(alerts()).toEqual([]); // 窓が終わるまでは、まとめは出ない
    expect(windows).toHaveLength(1);
    windows[0]?.(); // 窓の終わり。このあと、窓口には、何の要求も来ない
    await tick();
    await tick();
    expect(alerts()).toHaveLength(1);
    const item = alerts()[0];
    expect(item).toMatchObject({ kind: "info", nodeId: "root" });
    expect(item?.summary).toContain("認証の失敗");
    expect(item?.summary).toMatch(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}〜\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2} UTC/,
    );
    expect(item?.summary).not.toContain("直近");
    expect(JSON.stringify(item)).not.toContain(bogus);
    // 間隔（10 分）の内の、次の窓では、出さない
    for (let i = 0; i < 8; i++) await call(d.url, bogus, "tree.list", {});
    windows.at(-1)?.();
    await tick();
    await tick();
    expect(alerts().filter((i) => i.resolved === undefined)).toHaveLength(1);
    expect(alerts()).toHaveLength(1);
    // 間隔のあと: 新しい警告が出て、前の警告は system が解決済みにする（未解決は 1 件のまま）
    mono += 600_000;
    for (let i = 0; i < 8; i++) await call(d.url, bogus, "tree.list", {});
    windows.at(-1)?.();
    await tick();
    await tick();
    expect(alerts()).toHaveLength(2);
    const open = alerts().filter((i) => i.resolved === undefined);
    expect(open).toHaveLength(1);
    const old = alerts().find((i) => i.resolved !== undefined);
    expect(old?.resolved?.by).toEqual({ system: true });
  });

  it("T10l-f PR-B: alert.enabled が false なら、閾値を超えても、受信箱に出さない（件数のまとめは、記録に出る）", async () => {
    const r = rig({ rateLimit: { alert: { enabled: false, threshold: 5 } } });
    let mono = 1_000;
    r.deps = { ...r.deps, monotonicMs: () => mono };
    const d = await boot(r);
    for (let i = 0; i < 8; i++) await call(d.url, "z".repeat(43), "tree.list", {});
    mono += 61_000;
    await call(d.url, "z".repeat(43), "tree.list", {});
    expect(d.daemon.log.state().inbox.filter((i) => i.id.startsWith("api-alert-"))).toEqual([]);
    expect(r.logs.join("\n")).toContain("apiSummary");
  });

  it("設定を省かなければ、既定（容量 60）で動く: 通常の操作の頻度では、制限に当たらない", async () => {
    const r = rig();
    const d = await boot(r);
    for (let i = 0; i < 50; i++) {
      expect((await call(d.url, d.rootToken, "tree.list", {})).status).toBe(200);
    }
  });

  it("認証の失敗が続いても 401 のまま（Retry-After 付き）で、記録には、理由の種類だけが出る（トークンは出ない）", async () => {
    const r = rig({ rateLimit: { authFailures: { burst: 5, perMinute: 5 } } });
    const d = await boot(r);
    const bogus = "z".repeat(43);
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++) statuses.push((await call(d.url, bogus, "tree.list", {})).status);
    expect(statuses.every((s) => s === 401)).toBe(true); // 失敗の制限が尽きても、401（Retry-After 付き）
    const logs = r.logs.join("\n");
    expect(logs).toContain("apiAuthFailed");
    expect(logs).toContain("apiRateLimited");
    expect(logs).not.toContain(bogus);
    expect((await call(d.url, d.rootToken, "tree.list", {})).status).toBe(200); // 有効なトークンは通る
  });
});

describe("createDaemon（回収の事前確認の loss。T21r）", () => {
  it("人間のトークンで、実 HTTP から node.reclaimPreview を呼べて、失われるものが返る。ワーカーの lossFor が配線されている", async () => {
    const r = rig();
    r.deps = {
      ...r.deps,
      worktree: {
        ...r.deps.worktree,
        lossFor: async () => ({
          aheadCommits: 3,
          subjects: ["一つ目", "二つ目\u001b[2J"],
          uncommitted: true,
          untracked: 2,
        }),
      },
    };
    const d = await boot(r);
    const res = await call(d.url, d.humanToken, "node.reclaimPreview", { nodeId: "root" });
    expect(res.status).toBe(200);
    expect(res.json.value.loss).toEqual([
      {
        nodeId: "root",
        aheadCommits: 3,
        untrustedSubjects: ["一つ目", "二つ目�[2J"],
        uncommitted: true,
        untracked: 2,
      },
    ]);
    // 統合ノード（根）は、自分自身を事前確認できない（部分木の制限は変わらない）
    const own = await call(d.url, d.rootToken, "node.reclaimPreview", { nodeId: "root" });
    expect(own.status).toBe(403);
    // 存在しないノード（人間）は notFound
    const none = await call(d.url, d.humanToken, "node.reclaimPreview", { nodeId: "no-such" });
    expect(none.json.error?.code).toBe("notFound");
  });

  it("worktree に lossFor がなければ、loss を出さない（情報なし）", async () => {
    const r = rig();
    const d = await boot(r);
    const res = await call(d.url, d.humanToken, "node.reclaimPreview", { nodeId: "root" });
    expect(res.status).toBe(200);
    expect(res.json.value.loss).toBeUndefined();
  });
});

describe("createDaemon（自動の最終削除の保留。T13f-h）", () => {
  it("実 HTTP: 人間だけが node.purgeHold・node.purgeRelease を呼べる（配線され、統合ノードは 403）。木の根でなければ失敗する", async () => {
    const r = rig();
    const d = await boot(r);
    const human = await call(d.url, d.humanToken, "node.purgeHold", { nodeId: "root" });
    expect(human.status).toBe(422);
    expect(human.json.error?.code).toBe("notPurgeRoot"); // 操作は配線されている（notSupported でない）
    const none = await call(d.url, d.humanToken, "node.purgeHold", { nodeId: "no-such" });
    expect(none.json.error?.code).toBe("notFound");
    expect(
      (await call(d.url, d.humanToken, "node.purgeRelease", { nodeId: "no-such" })).json.error
        ?.code,
    ).toBe("notFound");
    expect((await call(d.url, d.rootToken, "node.purgeHold", { nodeId: "root" })).status).toBe(403);
    expect((await call(d.url, d.rootToken, "node.purgeRelease", { nodeId: "root" })).status).toBe(
      403,
    );
    const bad = await call(d.url, d.humanToken, "node.purgeHold", {
      nodeId: "root",
      until: "明日",
    });
    expect(bad.status).toBe(400);
  });
});

describe("createDaemon（daemon の身元確認。T10m-i）", () => {
  const identityOf = (url: string, nonce: string, init: RequestInit = {}) =>
    fetch(`${url}/v1/identity?nonce=${nonce}`, init);
  const NONCE = "0123456789abcdef0123456789abcdef";

  it("起動すると、秘密のファイル（0600）が作られ、認証なしの /v1/identity が、その秘密で作った proof を返す（秘密は返さない）。停止で消える", async () => {
    const r = rig();
    const made = createDaemon(r.config, r.deps);
    if (!made.ok) throw new Error(made.error.code);
    const run = await made.value.start();
    const text = readFileSync(run.identityPath, "utf8");
    expect(statSync(run.identityPath).mode & 0o777).toBe(0o600);
    const id = parseIdentityFile(text);
    expect(id).toBeDefined();
    const res = await identityOf(run.url, NONCE);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json();
    expect(body).toEqual({
      ok: true,
      value: {
        daemonId: id?.daemonId,
        proof: proofOf(id as never, `127.0.0.1:${run.port}`, NONCE),
      },
    });
    expect(JSON.stringify(body)).not.toContain(id?.secret);
    // nonce が違えば、proof も違う
    const other = await (await identityOf(run.url, "ab".repeat(16))).json();
    expect(other.value.proof).not.toBe(body.value.proof);
    await made.value.stop();
    expect(existsSync(run.identityPath)).toBe(false);
  });

  it("異常終了で古いファイルが残っていても、次の起動で必ず作り直される。再起動のたびに、身元（daemonId・秘密）が変わる", async () => {
    const r = rig();
    mkdirSync(r.config.stateDir, { recursive: true, mode: 0o700 });
    const path = join(r.config.stateDir, "daemon-identity");
    writeFileSync(path, "古い内容", { mode: 0o600 });
    const a = createDaemon(r.config, r.deps);
    if (!a.ok) throw new Error(a.error.code);
    const runA = await a.value.start();
    const idA = parseIdentityFile(readFileSync(path, "utf8"));
    expect(idA).toBeDefined();
    await a.value.stop();
    const b = createDaemon(r.config, r.deps);
    if (!b.ok) throw new Error(b.error.code);
    await b.value.start();
    cleanups.push(() => b.value.stop());
    const idB = parseIdentityFile(readFileSync(path, "utf8"));
    expect(idB?.daemonId).not.toBe(idA?.daemonId);
    expect(idB?.secret).not.toBe(idA?.secret);
    expect(runA.identityPath).toBe(path);
  });

  it("古いファイルが残っているままでも、起動前の（古い秘密の）proof は通用しない: 新しい秘密で作った proof だけが返る", async () => {
    const r = rig();
    const d = await boot(r);
    const path = join(r.config.stateDir, "daemon-identity");
    const id = parseIdentityFile(readFileSync(path, "utf8"));
    const stale = { daemonId: id?.daemonId as string, secret: "00".repeat(32) };
    const body = await (await identityOf(d.url, NONCE)).json();
    expect(body.value.proof).not.toBe(proofOf(stale, `127.0.0.1:${new URL(d.url).port}`, NONCE));
    expect(body.value.proof).toBe(proofOf(id as never, `127.0.0.1:${new URL(d.url).port}`, NONCE));
  });

  it("nonce が不正（ない・短い・長い・大文字・重複・余計なパラメータ）なら 400。GET 以外は 405。Host が違えば 403", async () => {
    const r = rig();
    const d = await boot(r);
    for (const q of [
      "",
      "?nonce=",
      `?nonce=${"a".repeat(30)}`,
      `?nonce=${"a".repeat(130)}`,
      `?nonce=${"A".repeat(32)}`,
      `?nonce=${NONCE}&nonce=${NONCE}`,
      `?nonce=${NONCE}&x=1`,
    ]) {
      const res = await fetch(`${d.url}/v1/identity${q}`);
      expect(res.status, q).toBe(400);
    }
    expect((await fetch(`${d.url}/v1/identity?nonce=${NONCE}`, { method: "POST" })).status).toBe(
      405,
    );
    const status = await new Promise<number>((resolve, reject) => {
      const u = new URL(d.url);
      const req = httpRequest(
        {
          host: u.hostname,
          port: u.port,
          path: `/v1/identity?nonce=${NONCE}`,
          headers: { host: "evil.example" },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(status).toBe(403);
  });
});

describe("createDaemon（保管した成果の操作。T13f-r）", () => {
  it("worktree の口が保管の操作を持てば、人間だけが実 HTTP から呼べる（統合ノードは 403）。持たなければ、操作は有効にならない", async () => {
    const r = rig();
    const calls: string[] = [];
    r.deps = {
      ...r.deps,
      worktree: {
        ...r.deps.worktree,
        discardedKeyOf: (id: string) => `k-${id}`,
        discardedList: async () =>
          ok({ max: 5, items: [{ key: "k-x", tip: "a".repeat(40), subject: "件名\u001b[2J" }] }),
        discardedRestore: async (q: { key: string; branch?: string }) => {
          calls.push(`restore:${q.key}`);
          return ok({ branch: q.branch ?? "b", tip: "a".repeat(40) });
        },
        discardedDrop: async (key: string) => {
          calls.push(`drop:${key}`);
          return ok({ key, tip: "a".repeat(40) });
        },
      },
    };
    const d = await boot(r);
    const list = await call(d.url, d.humanToken, "node.discardedList", {});
    expect(list.status).toBe(200);
    expect(list.json.value.max).toBe(5);
    expect(list.json.value.items[0]).toMatchObject({ key: "k-x", orphan: true });
    expect(list.json.value.items[0].untrustedSubject).not.toContain("\u001b");
    expect(
      (await call(d.url, d.humanToken, "node.discardedRestore", { target: "k-x", branch: "nb" }))
        .json.value,
    ).toEqual({ branch: "nb", tip: "a".repeat(40) });
    expect(
      (
        await call(d.url, d.humanToken, "node.discardedDrop", {
          target: "k-x",
          expectTip: "a".repeat(40),
        })
      ).status,
    ).toBe(200);
    expect(calls).toEqual(["restore:k-x", "drop:k-x"]);
    for (const op of ["node.discardedList", "node.discardedRestore", "node.discardedDrop"]) {
      expect(
        (await call(d.url, d.rootToken, op, op === "node.discardedList" ? {} : { target: "x" }))
          .status,
      ).toBe(403);
    }
    expect((await call(d.url, d.humanToken, "node.discardedDrop", { target: "a b" })).status).toBe(
      400,
    );
  });
});

describe("createDaemon（配下の要約の発行。T24-d）", () => {
  /** 起動のあと（起動時の整合が済んだあと）に、動作中の中間統合ノード m1 と、配下 a の失敗の項目を、ログに足す。 */
  const seed = (d: Daemon) => {
    let k = 0;
    const add = (body: Parameters<Daemon["log"]["append"]>[0]["body"]) => {
      const x = d.log.append({ requestId: `seed-${++k}`, actor: { system: true }, body });
      if (!x.ok) throw new Error(`${x.error.code}: ${x.error.cause}`);
    };
    const ev = (nodeId: string, event: { type: string }) =>
      add({ type: "node.stateChanged", payload: { nodeId, event } } as never);
    const node = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
      add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
    node("m1", "integrator", "root");
    ev("m1", { type: "start" });
    node("a", "implement", "m1");
    ev("a", { type: "start" });
    add({ type: "inbox.added", payload: { id: "f1", kind: "failure", nodeId: "a" } });
  };
  const manual = () => {
    let nowMs = Date.parse("2026-06-01T00:00:00Z");
    const waiting: { at: number; resolve: () => void; cancelled: boolean }[] = [];
    const timers = {
      now: () => nowMs,
      sleep: async () => undefined,
      after: (ms: number) => {
        const w = { at: nowMs + ms, resolve: () => {}, cancelled: false };
        const promise = new Promise<void>((res) => {
          w.resolve = res;
        });
        waiting.push(w);
        return { promise, cancel: () => (w.cancelled = true) };
      },
    };
    return {
      timers,
      advance: async (ms: number) => {
        nowMs += ms;
        for (const w of waiting) {
          if (!w.cancelled && w.at <= nowMs) {
            w.cancelled = true;
            w.resolve();
          }
        }
        for (let i = 0; i < 5; i++) await new Promise((res) => setImmediate(res));
      },
      clock: () => new Date(nowMs).toISOString(),
    };
  };
  const digests = (d: Daemon) => d.log.state().inbox.filter((i) => i.kind === "digest");

  it("設定がなくても（既定で有効）、1 周期（既定 30 秒）後に、中間統合ノードの要約を出す。文面は digestOf と同じ。記録に残る", async () => {
    const r = rig();
    const m = manual();
    r.deps = { ...r.deps, timers: m.timers, clock: m.clock, monotonicMs: () => m.timers.now() };
    const d = await boot(r);
    seed(d.daemon);
    expect(digests(d.daemon)).toHaveLength(0); // 起動直後は出さない
    await m.advance(29_000);
    expect(digests(d.daemon)).toHaveLength(0);
    await m.advance(2_000);
    const out = digests(d.daemon);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ nodeId: "m1", priority: "failed" });
    expect(out[0]?.summary).toBe(digestOf(d.daemon.log.state(), "m1", m.timers.now())?.summary);
    expect(r.logs.some((l) => l.includes("digest.issued"))).toBe(true);
    // 事実が同じなら、周期が来ても、出し直さない
    await m.advance(5 * 60_000);
    expect(digests(d.daemon)).toHaveLength(1);
  });

  it("digest.enabled: false なら、出さない。intervalSec を設定すれば、その周期になる", async () => {
    const off = rig({ digest: { enabled: false } });
    const m1 = manual();
    off.deps = {
      ...off.deps,
      timers: m1.timers,
      clock: m1.clock,
      monotonicMs: () => m1.timers.now(),
    };
    const d1 = await boot(off);
    seed(d1.daemon);
    await m1.advance(10 * 60_000);
    expect(digests(d1.daemon)).toHaveLength(0);
    const fast = rig({ digest: { intervalSec: 5 } });
    const m2 = manual();
    fast.deps = {
      ...fast.deps,
      timers: m2.timers,
      clock: m2.clock,
      monotonicMs: () => m2.timers.now(),
    };
    const d2 = await boot(fast);
    seed(d2.daemon);
    await m2.advance(6_000);
    expect(digests(d2.daemon)).toHaveLength(1);
  });

  const instructions = (d: Daemon) => d.log.state().instructions;

  it("wake（T24-w）は、既定で無効。有効にしても、アダプタが管理していないノードは起こさない。stop で周期が止まる", async () => {
    const off = rig();
    const m1 = manual();
    off.deps = {
      ...off.deps,
      timers: m1.timers,
      clock: m1.clock,
      monotonicMs: () => m1.timers.now(),
    };
    const d1 = await boot(off);
    seed(d1.daemon);
    await m1.advance(10 * 60_000);
    expect(instructions(d1.daemon)).toHaveLength(0);
    expect(off.logs.some((l) => l.includes("wake."))).toBe(false);

    const on = rig({ wake: { enabled: true, intervalSec: 5, minIntervalSec: 10 } });
    const m2 = manual();
    on.deps = {
      ...on.deps,
      timers: m2.timers,
      clock: m2.clock,
      monotonicMs: () => m2.timers.now(),
    };
    const d2 = await boot(on);
    seed(d2.daemon);
    await m2.advance(60_000);
    // seed の m1 は、アダプタが管理していない（起動していない）ので、起こさない。
    expect(instructions(d2.daemon)).toHaveLength(0);
    await d2.daemon.stop();
    await m2.advance(60_000); // 止めたあとは、何も起きない（例外にならない）
  });
});

describe("子に渡す skill（T22-c）", () => {
  const PLUGIN = fileURLToPath(new URL("../../../plugin", import.meta.url));
  const brief = {
    objective: "x",
    acceptanceCriteria: ["x"],
    scope: {
      writableLocations: ["src"],
      forbiddenLocations: [".git"],
      allowedCommands: ["pnpm test"],
    },
  };

  it("childPluginDir があれば、skill だけの plugin を stateDir に作り、role に応じた skill を子に渡す", async () => {
    const r = rig({ childPluginDir: PLUGIN });
    const d = await boot(r);
    const dest = join(r.config.stateDir, "child-plugin");
    expect(existsSync(join(dest, "skills", "cso-child", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dest, "hooks"))).toBe(false);
    for (const role of ["implement", "integrator"]) {
      const res = await call(d.url, d.rootToken, "node.spawn", {
        parentId: "root",
        role,
        ...brief,
      });
      expect(res.json.ok, JSON.stringify(res.json)).toBe(true);
    }
    const [impl, integ] = r.launcher.sessions.map((x) => x.options);
    expect(impl?.plugin).toEqual({ path: dest, skill: "cso-child-skills:cso-child" });
    expect(integ?.plugin).toEqual({ path: dest, skill: "cso-child-skills:cso-integrator" });
    expect(impl?.initialPrompt).toContain("skill「cso-child-skills:cso-child」に従う");
    expect(impl?.settingSources).toEqual([]);
  });

  it("childPluginDir がなければ、plugin を渡さず、起動時に一言記録する", async () => {
    const r = rig();
    const d = await boot(r);
    expect(r.logs.some((l) => l.includes("childPluginSkipped"))).toBe(true);
    await call(d.url, d.rootToken, "node.spawn", { parentId: "root", role: "implement", ...brief });
    expect(r.launcher.sessions[0]?.options.plugin).toBeUndefined();
    expect(r.launcher.sessions[0]?.options.initialPrompt).not.toContain("skill「");
  });

  it("plugin のディレクトリが不正なら、起動しない（フェイルクローズ）", () => {
    const r = rig({ childPluginDir: join(tmp(), "nothing") });
    const made = createDaemon(r.config, r.deps);
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.error.code).toBe("childPluginInvalid");
  });
});

describe("Desktop の子（childRuntime: desktop。T21・仮置き）", () => {
  const brief = {
    objective: "x",
    acceptanceCriteria: ["x"],
    scope: {
      writableLocations: ["src"],
      forbiddenLocations: [".git"],
      allowedCommands: ["pnpm test"],
    },
  };

  it("フックのゲートが有効（既定）なら、子は起動しない（起動の失敗）", async () => {
    const r = rig({ childRuntime: "desktop" });
    const d = await boot(r);
    const res = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      ...brief,
    });
    expect(res.json.ok).toBe(false);
    expect(res.json.error?.code).toBe("startFailed");
    // 原因（ゲート）は、記録（logLine）に残る
    expect(r.logs.join("\n")).toContain("hooksUnverified");
    expect(r.launcher.sessions).toHaveLength(0);
  });

  it("再起動のあとの依頼（C2-4）: 1 件 → 再起動しても 1 件 → 子を宣言すると解決済み → 新しい子がいれば、次の再起動で新しい依頼", async () => {
    const r = rig({ childRuntime: "desktop", desktopRequireVerifiedHooks: false });
    const open = (d: { daemon: Daemon }) =>
      d.daemon.log
        .state()
        .inbox.filter(
          (i) => i.resolved === undefined && i.summary?.startsWith(EXTERNAL_CHECK_SUMMARY) === true,
        );
    const restart = async (d: { daemon: Daemon }) => {
      await d.daemon.stop();
      cleanups.length = 0;
      return boot(r);
    };
    let d = await boot(r);
    const spawned = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      ...brief,
    });
    expect(spawned.json.ok, JSON.stringify(spawned.json)).toBe(true);
    const a = spawned.json.value.nodeId as string;
    expect(open(d)).toHaveLength(0);
    d = await restart(d);
    expect(open(d)).toHaveLength(1);
    expect(open(d)[0]?.summary).toContain(a);
    d = await restart(d);
    expect(open(d)).toHaveLength(1);
    // 子を止めて（代行依頼）、止めたと宣言すると、動いているかもしれない子がいなくなるので、根の依頼も解決済みになる
    expect(
      (await call(d.url, d.rootToken, "node.stop", { nodeId: a, mode: "immediate" })).json.ok,
    ).toBe(true);
    for (
      let k = 0;
      k < 50 && d.daemon.log.state().nodes.find((n) => n.id === a)?.state !== "stopIncomplete";
      k++
    )
      await new Promise((res) => setTimeout(res, 10));
    expect(open(d)).toHaveLength(1); // 停止未完了は、まだ動いているかもしれない
    const declared = await call(d.url, d.humanToken, "node.confirmStopped", {
      nodeId: a,
      note: "確かめた",
    });
    expect(declared.json.ok, JSON.stringify(declared.json)).toBe(true);
    expect(open(d)).toHaveLength(0);
    // 解決済みのあとは、再起動しても、対象がいなければ出さない
    d = await restart(d);
    expect(open(d)).toHaveLength(0);
    // 新しい子がいれば、次の再起動で、新しい依頼が出る（残った依頼に止められない）
    const next = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      ...brief,
    });
    expect(next.json.ok, JSON.stringify(next.json)).toBe(true);
    const b = next.json.value.nodeId as string;
    d = await restart(d);
    expect(open(d)).toHaveLength(1);
    expect(open(d)[0]?.summary).toContain(b);
    expect(open(d)[0]?.summary).not.toContain(a);
  }, 20_000);

  it("紐付けの通し: spawn → node.bindCode → POST /v1/bind → トークン → POST /v1/request。コードはログ・記録に残らない", async () => {
    const r = rig({ childRuntime: "desktop", desktopRequireVerifiedHooks: false });
    const d = await boot(r);
    const spawned = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      ...brief,
    });
    expect(spawned.json.ok, JSON.stringify(spawned.json)).toBe(true);
    const nodeId = spawned.json.value.nodeId as string;
    expect(r.launcher.sessions).toHaveLength(0); // SDK では起動しない
    const bc = await call(d.url, d.rootToken, "node.bindCode", { nodeId });
    expect(bc.json.ok, JSON.stringify(bc.json)).toBe(true);
    const instruction = bc.json.value.instruction as string;
    expect(instruction).toContain(`${d.url}/v1/bind`);
    const code = (/"bindCode":"([0-9A-Z-]+)"/.exec(instruction) as RegExpExecArray)[1] as string;
    // 子: 文面のコマンドを、そのままシェルで実行する（トークンは変数に入れ、標準入力から渡す。コマンドの引数に置かない）
    const lines = instruction.split("\n");
    const bindLine = lines.find((l) => l.startsWith("CSO_TOKEN=")) as string;
    const reportLine = (lines.find((l) => l.startsWith("printf 'authorization")) as string)
      .replace("<一意な ID>", "p1")
      .replace("<進捗>", "進んだ");
    expect(bindLine).toContain("-d @-");
    expect(reportLine).toContain("-H @-");
    expect(reportLine).not.toContain('Bearer $CSO_TOKEN"');
    // 同じプロセスの daemon が応答できるよう、非同期で実行する。プロキシの環境変数は外す（ループバックへ直接）。
    const env = { ...process.env };
    for (const k of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
    ])
      delete env[k];
    const { stdout: out } = await promisify(execFile)(
      "bash",
      ["-c", `${bindLine}\ntest -n "$CSO_TOKEN" || exit 3\n${reportLine}`],
      { encoding: "utf8", env, timeout: 20_000 },
    );
    expect(JSON.parse(out).ok, out).toBe(true);
    const reports = await call(d.url, d.rootToken, "inbox.fetch", {});
    expect(JSON.stringify(reports.json)).toContain("進んだ");
    // 使ったコードは、もう使えない
    const again = await fetch(`${d.url}/v1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId, bindCode: code }),
    });
    expect(again.status).toBe(401);
    // コード（区切りあり・なし）は、イベントログ（SQLite のファイル）・記録（logLine）・受信箱に残らない
    const raw = code.replace(/-/g, "");
    for (const f of ["state.db", "state.db-wal"]) {
      const p = join(r.config.stateDir, f);
      if (!existsSync(p)) continue;
      const bytes = readFileSync(p).toString("latin1");
      expect(bytes.includes(raw), f).toBe(false);
      expect(bytes.includes(code), f).toBe(false);
    }
    expect(r.logs.join("\n").includes(raw)).toBe(false);
    const inbox = await call(d.url, d.rootToken, "inbox.fetch", {});
    expect(JSON.stringify(inbox.json).includes(raw)).toBe(false);
  });

  it("画面の表示モデルで、Desktop の子は stopDelegated（停止の宣言を出せる）", async () => {
    const r = rig({ childRuntime: "desktop", desktopRequireVerifiedHooks: false });
    const d = await boot(r);
    const spawned = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      ...brief,
    });
    const nodeId = spawned.json.value.nodeId as string;
    const ui = await fetch(`${d.url}/v1/ui/state`, {
      headers: { authorization: `Bearer ${d.humanToken}` },
    });
    const nodes = (
      (await ui.json()) as { value: { nodes: { id: string; stopDelegated?: boolean }[] } }
    ).value.nodes;
    expect(nodes.find((x) => x.id === nodeId)?.stopDelegated).toBe(true);
  });
});

describe("cso（cli の実行ファイル）で、実際の daemon を呼ぶ（T22-cli）", () => {
  const BIN = fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url));
  const brief = {
    objective: "x",
    acceptanceCriteria: ["x"],
    scope: {
      writableLocations: ["src"],
      forbiddenLocations: [".git"],
      allowedCommands: ["pnpm test"],
    },
  };

  it("窓口・トークン・設定を環境変数で渡し、身元を確かめてから操作する。引数にトークンを置かない", async () => {
    const r = rig();
    const d = await boot(r);
    const spawned = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      ...brief,
    });
    const nodeId = spawned.json.value.nodeId as string;
    const configPath = join(r.config.stateDir, "..", "config.json");
    writeFileSync(configPath, JSON.stringify({ stateDir: r.config.stateDir }));
    const env = { ...process.env };
    for (const k of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
      "ALL_PROXY",
      "all_proxy",
      "CSO_CLI_ALLOW_UNVERIFIED",
    ])
      delete env[k];
    Object.assign(env, {
      CSO_DAEMON_URL: d.url,
      CSO_HUMAN_TOKEN: d.humanToken,
      CSO_DAEMON_CONFIG: configPath,
    });
    const args = [BIN, "hook-unbind", nodeId, "--request-id", "cli-e2e-1"];
    expect(args.join(" ")).not.toContain(d.humanToken); // トークンは、プロセスの引数に出ない（環境変数だけ）
    const { stdout, stderr } = await promisify(execFile)(process.execPath, args, {
      encoding: "utf8",
      env,
      timeout: 20_000,
    });
    expect(stdout).toContain("cli-e2e-1");
    expect(stdout + stderr).not.toContain(d.humanToken);
    // 記録に残る（外した者は人間）
    expect(r.logs.join("\n")).not.toContain(d.humanToken);
    // 身元の秘密が違えば（偽の daemon）、トークンを送らずに失敗する
    writeFileSync(configPath, JSON.stringify({ stateDir: join(r.config.stateDir, "..") }));
    const bad = await promisify(execFile)(process.execPath, [BIN, "hook-unbind", nodeId], {
      encoding: "utf8",
      env,
      timeout: 20_000,
    }).then(
      () => ({ code: 0, stderr: "" }),
      (e: { code: number; stderr: string }) => ({ code: e.code, stderr: e.stderr }),
    );
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain("daemon_identity_failed");
  });
});

describe("子の認証がない（T22-auth）", () => {
  const brief = {
    objective: "x",
    acceptanceCriteria: ["x"],
    scope: {
      writableLocations: ["src"],
      forbiddenLocations: [".git"],
      allowedCommands: ["pnpm test"],
    },
  };

  it("既定（isolated）で認証の環境変数がなければ、spawn は childAuthMissing（原因と対処）を返し、作業ツリーを後始末する", async () => {
    const r = rig();
    r.deps = { ...r.deps, parentEnv: { PATH: process.env.PATH, GH_TOKEN: "ghp-secret-value" } };
    const d = await boot(r);
    const res = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      ...brief,
    });
    expect(res.json.ok).toBe(false);
    expect(res.json.error?.code).toBe("childAuthMissing");
    expect(res.json.error?.nextActions.join()).toContain("claude setup-token");
    expect(r.launcher.sessions).toHaveLength(0);
    expect(r.calls.removed).toEqual(r.calls.provisioned); // 作った作業ツリーは消した
    expect(r.calls.provisioned).toHaveLength(1);
    expect(JSON.stringify(res.json) + r.logs.join("\n")).not.toContain("ghp-secret-value");
  });

  it("childHome: inherit なら、確かめずに起動する", async () => {
    const r = rig({ childHome: "inherit" });
    r.deps = { ...r.deps, parentEnv: { PATH: process.env.PATH } };
    const d = await boot(r);
    const res = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      ...brief,
    });
    expect(res.json.ok, JSON.stringify(res.json)).toBe(true);
    expect(r.launcher.sessions).toHaveLength(1);
  });
});
