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
import { type Failure, ok, planPurge, type Result } from "@cso/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveId } from "../src/api/handlers/context.js";
import { parseIdentityFile, proofOf } from "../src/api/identity.js";
import { FileTokenRepository } from "../src/api/token-repository.js";
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
