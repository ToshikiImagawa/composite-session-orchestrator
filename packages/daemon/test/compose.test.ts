import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
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
import { FakeLauncher, type FakeSession } from "./sdk/fakes.js";

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
  const terminal: string[] = [];
  const deps: DaemonDeps = {
    launcher,
    worktree,
    probe: async () => [],
    logLine: (l) => logs.push(l),
    confirmationOut: (l) => terminal.push(l),
    // 既定の childHome（isolated）では、子に認証の環境変数が要る（T22-auth）
    parentEnv: { PATH: process.env.PATH, ANTHROPIC_API_KEY: "test-key" },
  };
  return { config, deps, launcher, calls, logs, terminal };
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
  const send = () =>
    fetch(`${url}/v1/request`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId, operation, params }),
    });
  // 同じポートで起動し直すと（保存したポート）、fetch が前の daemon への使い回しの接続（keep-alive。前の daemon の stop で
  // 閉じられている）で送ることがある。閉じられ方は OS で違い、Linux では FIN で「other side closed」（UND_ERR_SOCKET）、
  // macOS では RST で「read ECONNRESET」になる。どちらも、要求が新しい daemon に届く前の失敗なので、1 回だけ送り直す
  // （同じ requestId なので、届いていても重複して実行されない）。
  const stale = (e: unknown): boolean => {
    const cause = (e as { cause?: { code?: unknown } }).cause;
    return (
      e instanceof TypeError &&
      (cause?.code === "UND_ERR_SOCKET" || cause?.code === "ECONNRESET" || cause?.code === "EPIPE")
    );
  };
  const res = await send().catch((e: unknown) => {
    if (stale(e)) return send();
    throw e;
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

  it("ポートのファイルが使えなければ、照合などの記録を何も書く前に止める（portFileInvalid）", async () => {
    const r = rig({ childRuntime: "desktop", desktopRequireVerifiedHooks: false });
    const d = await boot(r);
    const spawned = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      objective: "x",
      acceptanceCriteria: ["x"],
      scope: {
        writableLocations: ["src"],
        forbiddenLocations: [".git"],
        allowedCommands: ["pnpm test"],
      },
    });
    expect(spawned.json.ok, JSON.stringify(spawned.json)).toBe(true);
    await d.daemon.stop();
    cleanups.length = 0;
    writeFileSync(join(r.config.stateDir, "port"), "x\n", { mode: 0o600 });
    const made = createDaemon(r.config, r.deps);
    if (!made.ok) throw new Error(made.error.code);
    cleanups.push(() => made.value.stop());
    const seq = made.value.log.state().lastSeq;
    // 照合が先に走っていたら、根の「daemon 再起動後」の依頼が記録に足される
    await expect(made.value.start()).rejects.toMatchObject({
      failure: { code: "portFileInvalid" },
    });
    expect(made.value.log.state().lastSeq).toBe(seq);
  });

  it("新規のポートを保存できないとき: Desktop の子なら起動を止める（portSaveFailed）。ほかは記録して続ける", async () => {
    const bad = () => {
      throw new Error("書けない");
    };
    const desk = rig({ childRuntime: "desktop", desktopRequireVerifiedHooks: false });
    const madeD = createDaemon(desk.config, { ...desk.deps, savePort: bad });
    if (!madeD.ok) throw new Error(madeD.error.code);
    cleanups.push(() => madeD.value.stop());
    await expect(madeD.value.start()).rejects.toMatchObject({
      failure: { code: "portSaveFailed" },
    });
    const cli = rig();
    const madeC = createDaemon(cli.config, { ...cli.deps, savePort: bad });
    if (!madeC.ok) throw new Error(madeC.error.code);
    cleanups.push(() => madeC.value.stop());
    await expect(madeC.value.start()).resolves.toMatchObject({
      url: expect.stringContaining("127.0.0.1"),
    });
    expect(cli.logs.some((l) => l.includes("portSaveFailed"))).toBe(true);
  });

  it("起動の記録に、ポートがどこから決まったか（portSource）を出す: 初回は new、次は saved", async () => {
    const r = rig();
    const first = await boot(r);
    expect(r.logs.some((l) => l.includes('"started"') && l.includes('"portSource":"new"'))).toBe(
      true,
    );
    await first.daemon.stop();
    cleanups.length = 0;
    r.logs.length = 0;
    const second = await boot(r);
    expect(second.url).toBe(first.url);
    expect(r.logs.some((l) => l.includes('"started"') && l.includes('"portSource":"saved"'))).toBe(
      true,
    );
  }, 15_000);

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

  it("子の作業ツリーの置き場が、リンクを解決すると stateDir の中にある設定も、起動に失敗する（T21-pr）", () => {
    const r = rig();
    mkdirSync(r.config.stateDir, { recursive: true, mode: 0o700 });
    const inside = join(r.config.stateDir, "wt");
    mkdirSync(inside);
    const link = join(tmp(), "wtlink");
    symlinkSync(inside, link);
    const made = createDaemon({ ...r.config, worktreeRoot: link }, r.deps);
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.error.code).toBe("invalidConfig");
  });

  it("まだないパスでも、最も深い既存の祖先を実パスにして重なりを確かめる（リンクの先の、まだない作業ツリーの置き場。T21-pr R3）", () => {
    const r = rig();
    mkdirSync(r.config.stateDir, { recursive: true, mode: 0o700 });
    const link = join(tmp(), "statelink");
    symlinkSync(r.config.stateDir, link);
    const made = createDaemon({ ...r.config, worktreeRoot: join(link, "not-yet", "wt") }, r.deps);
    expect(made.ok).toBe(false);
    if (!made.ok) expect(made.error.code).toBe("invalidConfig");
  });

  it("起動時に子の引き出しの置き場（0700）を作り、要る子の鍵でない引き出しを消す（T21-d・M9）", async () => {
    const r = rig();
    r.deps = { ...r.deps, excludeFromBackup: async () => undefined };
    const first = await boot(r); // 1 回目: 秘密を作る（この起動では掃除しない）
    await first.daemon.stop();
    cleanups.length = 0;
    const root = join(r.config.stateDir, "children.noindex");
    expect(lstatSync(root).mode & 0o777).toBe(0o700);
    mkdirSync(join(root, "0".repeat(32)), { mode: 0o700 });
    await boot(r);
    expect(existsSync(join(root, "0".repeat(32)))).toBe(false);
    expect(r.logs.join("\n")).toContain("childrenDirSwept");
  });

  it("鍵のファイルがないのに、鍵の形の引き出しが残っていれば、起動を止める（T21-d・M1。実パスを出さない）", () => {
    const r = rig();
    mkdirSync(r.config.stateDir, { recursive: true, mode: 0o700 });
    const root = join(r.config.stateDir, "children.noindex");
    mkdirSync(join(root, "0".repeat(32)), { recursive: true, mode: 0o700 });
    chmodSync(root, 0o700);
    const made = createDaemon(r.config, r.deps);
    expect(made.ok).toBe(false);
    if (!made.ok) {
      expect(made.error.code).toBe("stateDirInvalid");
      expect(made.error.cause).not.toContain(r.config.stateDir);
      expect(made.error.nextActions.join("")).toContain("空にして");
    }
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

  it("Desktop の木（T24-cf）: 人間のトークンの最終削除は確認待ち。画面に確認待ち（コードなし）。端末のコードで確認すると 1 回だけ実行", async () => {
    const r = rig({ retentionDays: 0, childRuntime: "desktop" });
    seedArchivedTree(r);
    const d = await boot(r);
    const asked = await call(d.url, d.humanToken, "node.purge", { nodeId: "t" }, "purge-1");
    expect(asked.json.ok).toBe(false);
    expect(asked.json.error?.code).toBe("confirmationRequired");
    expect(d.daemon.log.state().nodes.some((n) => n.id === "t")).toBe(true);
    expect(r.terminal).toHaveLength(1);
    const m = r.terminal[0]?.match(/確認コード ([0-9A-Z]{4})-([0-9A-Z]{4})/);
    const code = `${m?.[1]}${m?.[2]}`;
    const ui = await fetch(`${d.url}/v1/ui/state`, {
      headers: { authorization: `Bearer ${d.humanToken}` },
    });
    const body = await ui.text();
    expect(body).not.toContain(code);
    const view = JSON.parse(body) as {
      value: { confirmations: { confirmationId: string; operation: string }[] };
    };
    expect(view.value.confirmations).toHaveLength(1);
    expect(view.value.confirmations[0]?.operation).toBe("node.purge");
    const confirmationId = view.value.confirmations[0]?.confirmationId ?? "";
    // 根（統合）のトークンでは、確認できない
    const byRoot = await call(d.url, d.rootToken, "confirm.approve", { confirmationId, code });
    expect(byRoot.json.ok).toBe(false);
    const done = await call(d.url, d.humanToken, "confirm.approve", { confirmationId, code });
    expect(done.json.ok, JSON.stringify(done.json)).toBe(true);
    expect(done.json.value.result.purged).toEqual(["c", "t"]);
    expect(d.daemon.log.state().nodes.map((n) => n.id)).toEqual(["root"]);
    const again = await call(d.url, d.humanToken, "confirm.approve", { confirmationId, code });
    expect(again.json.ok).toBe(false);
    // 同じ要求の再送は、前の結果を返す（二重に実行しない）
    const resent = await call(d.url, d.humanToken, "node.purge", { nodeId: "t" }, "purge-1");
    expect(resent.json.ok).toBe(true);
    // コード・確認の番号は、構造化のログ・記録に出ない
    const all = `${r.logs.join("\n")}${JSON.stringify(d.daemon.log.state())}`;
    expect(all).not.toContain(code);
    expect(all).not.toContain(confirmationId);
  });

  it("CLI の子だけの木（T24-cf）: 最終削除は今までどおり、すぐ実行される（確認待ちにしない）", async () => {
    const r = rig({ retentionDays: 0 });
    seedArchivedTree(r);
    const d = await boot(r);
    const done = await call(d.url, d.humanToken, "node.purge", { nodeId: "t" });
    expect(done.json.ok).toBe(true);
    expect(r.terminal).toHaveLength(0);
  });

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

  /** 根から CLI の子を 1 つ起動し、そのノード ID と、子の MCP のトークン（子の環境変数）を返す。 */
  const spawnChild = async (d: Awaited<ReturnType<typeof boot>>, r: ReturnType<typeof rig>) => {
    const spawn = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      objective: "x",
      acceptanceCriteria: ["x"],
      scope: { writableLocations: ["src"], forbiddenLocations: [".git"], allowedCommands: [] },
    });
    expect(spawn.json.ok, JSON.stringify(spawn.json)).toBe(true);
    const session = r.launcher.sessions[r.launcher.sessions.length - 1];
    return {
      nodeId: spawn.json.value.nodeId as string,
      token: session?.options.env.CSO_MCP_TOKEN ?? "",
    };
  };

  it("期限の切れたトークン（T21-te）: 401 tokenExpired。受信箱への知らせは、動いている子について同じトークンで 1 回だけ。根は切れない", async () => {
    let mono = 0;
    const r = rig();
    const d = await boot({ ...r, deps: { ...r.deps, monoMs: () => mono } });
    const c = await spawnChild(d, r);
    expect(c.token).not.toBe("");
    expect((await call(d.url, c.token, "node.get", { nodeId: c.nodeId })).status).not.toBe(401);
    mono += 6 * 3_600_000; // 最後に使ってから 6 時間（CLI の子の既定）
    for (let i = 0; i < 2; i++) {
      const res = await call(d.url, c.token, "node.get", { nodeId: c.nodeId });
      expect(res.status).toBe(401);
      expect(res.json.error?.code).toBe("tokenExpired");
    }
    const notices = d.daemon.log
      .state()
      .inbox.filter((x) => x.nodeId === c.nodeId && x.summary?.includes("期限"));
    expect(notices).toHaveLength(1);
    expect(r.logs.join("\n")).not.toContain(c.token);
    expect((await call(d.url, d.rootToken, "node.get", { nodeId: c.nodeId })).status).not.toBe(401);
  });

  /** 再開できる rig（作業ツリーの場所を返す。既定の rig は返さない）。 */
  const resumable = () => {
    const r = rig();
    const worktree = {
      ...r.deps.worktree,
      cwdOf: async (id: string) => join(r.config.worktreeRoot, id),
    };
    return { ...r, deps: { ...r.deps, worktree } };
  };

  /** 根の判断で子を止める（pauseNodeIds）。判断の ID を返す。 */
  const pauseChild = async (
    d: Awaited<ReturnType<typeof boot>>,
    nodeId: string,
    sessions: readonly FakeSession[],
  ) => {
    const p = await call(d.url, d.rootToken, "decision.present", {
      question: "どちらにする？",
      options: ["a", "b"],
      pauseNodeIds: [nodeId],
    });
    expect(p.json.ok, JSON.stringify(p.json)).toBe(true);
    await vi.waitFor(() => {
      // 子のセッションを終わらせる（偽の子は、止める要求のあと、自分では終わらない）
      for (const x of sessions) x.emitResult();
      expect(d.daemon.log.state().nodes.find((n) => n.id === nodeId)?.state).toBe("stopped");
    });
    return p.json.value.decisionId as string;
  };

  it("再開（T21-te M1）: 新しいトークンの発行から running までのあいだに、別のコミットと見回りが走っても、新しいトークンは生きていて、running のあとに報告が通る。止まる前のトークンは 401", async () => {
    const r = resumable();
    const d = await boot(r);
    const c = await spawnChild(d, r);
    const decisionId = await pauseChild(d, c.nodeId, r.launcher.sessions);
    expect((await call(d.url, c.token, "report.progress", { text: "x" })).json.error?.code).toBe(
      "tokenExpired",
    );
    r.launcher.autoInit = false; // 起動を init で止め、running を記録する前のあいだを作る
    const before = r.launcher.sessions.length;
    const answering = call(d.url, d.humanToken, "decision.answer", { decisionId, choice: "a" });
    await vi.waitFor(() => expect(r.launcher.sessions.length).toBe(before + 1));
    const session = r.launcher.sessions[before];
    const fresh = session?.options.env.CSO_MCP_TOKEN ?? "";
    expect(fresh).not.toBe("");
    expect(fresh).not.toBe(c.token);
    expect(d.daemon.log.state().nodes.find((n) => n.id === c.nodeId)?.state).toBe("stopped");
    // あいだに、別のコミット（根の判断の提示）と、見回り
    const other = await call(d.url, d.rootToken, "decision.present", {
      question: "別の判断",
      options: ["x", "y"],
    });
    expect(other.json.ok, JSON.stringify(other.json)).toBe(true);
    expect(d.daemon.sweepTokens()).not.toContain(c.nodeId);
    session?.init();
    const answered = await answering;
    expect(answered.json.ok, JSON.stringify(answered.json)).toBe(true);
    expect(answered.json.value.notResumed).toBeUndefined();
    expect(d.daemon.log.state().nodes.find((n) => n.id === c.nodeId)?.state).toBe("running");
    const report = await call(d.url, fresh, "report.progress", { text: "再開した" });
    expect(report.json.ok, JSON.stringify(report.json)).toBe(true);
    const old = await call(d.url, c.token, "report.progress", { text: "古い" });
    expect(old.status).toBe(401);
    expect(old.json.error?.code).toBe("tokenExpired");
  });

  it("再開の途中で daemon が再起動したら（T21-te M1）: 止まったままの子に発行したトークンは、起動時に失効させる。子は止まったままで、もう一度再開すると、新しいトークンで動く", async () => {
    const r = resumable();
    const first = await boot(r);
    const c = await spawnChild(first, r);
    const decisionId = await pauseChild(first, c.nodeId, r.launcher.sessions);
    r.launcher.autoInit = false;
    const before = r.launcher.sessions.length;
    // 再開を始め、新しいトークンを発行して起動を待っているあいだに、daemon を止める
    const answering = call(first.url, first.humanToken, "decision.answer", {
      decisionId,
      choice: "a",
    }).catch(() => undefined);
    await vi.waitFor(() => expect(r.launcher.sessions.length).toBe(before + 1));
    const inFlight = r.launcher.sessions[before]?.options.env.CSO_MCP_TOKEN ?? "";
    expect(inFlight).not.toBe("");
    await first.daemon.stop();
    await answering;
    cleanups.length = 0;
    r.launcher.autoInit = true;
    const second = await boot(r);
    expect(second.daemon.log.state().nodes.find((n) => n.id === c.nodeId)?.state).toBe("stopped");
    const res = await call(second.url, inFlight, "report.progress", { text: "x" });
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe("tokenExpired");
    // 同じ回答を送り直すと、再開をやり直す（新しいトークンを発行する）
    const n = r.launcher.sessions.length;
    const again = await call(second.url, second.humanToken, "decision.answer", {
      decisionId,
      choice: "a",
    });
    expect(again.json.ok, JSON.stringify(again.json)).toBe(true);
    expect(second.daemon.log.state().nodes.find((x) => x.id === c.nodeId)?.state).toBe("running");
    const fresh = r.launcher.sessions[n]?.options.env.CSO_MCP_TOKEN ?? "";
    expect(fresh).not.toBe(inFlight);
    expect((await call(second.url, fresh, "report.progress", { text: "再開した" })).json.ok).toBe(
      true,
    );
  });

  it("子が止まったら、見回りを待たずに、その場でトークンを失効させる（T21-te M1）。知らせは出さない", async () => {
    const r = rig();
    const d = await boot(r);
    const c = await spawnChild(d, r);
    const stop = await call(d.url, d.rootToken, "node.stop", {
      nodeId: c.nodeId,
      mode: "immediate",
    });
    expect(stop.json.ok, JSON.stringify(stop.json)).toBe(true);
    await vi.waitFor(() =>
      expect(d.daemon.log.state().nodes.find((n) => n.id === c.nodeId)?.state).toBe("stopped"),
    );
    const res = await call(d.url, c.token, "node.get", { nodeId: c.nodeId });
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe("tokenExpired");
    expect(d.daemon.log.state().inbox.some((x) => x.summary?.includes("期限"))).toBe(false);
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

  // 通しの試験は、build した本物の cso（cli の dist）をシェルで実行する。`pnpm check`（scripts/check.sh）は、test の前に build する
  const cliBin = fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url));
  const shEnv = (() => {
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
    return env;
  })();
  /** シェルで実行する。失敗（終了コードが 0 でない）でも、stdout・stderr・終了コードを返す。 */
  const sh = async (script: string) => {
    try {
      const o = await promisify(execFile)("bash", ["-c", script], {
        encoding: "utf8",
        env: shEnv,
        timeout: 20_000,
      });
      return { ...o, code: 0 };
    } catch (e) {
      const x = e as { stdout: string; stderr: string; code: number };
      return { stdout: x.stdout, stderr: x.stderr, code: x.code };
    }
  };
  const desktopRig = (over: Partial<DaemonConfig> = {}) => {
    if (!existsSync(cliBin)) {
      throw new Error(
        `cli の dist（${cliBin}）がない。先に pnpm build を実行する（pnpm check は test の前に build する）`,
      );
    }
    const r = rig({
      childRuntime: "desktop",
      desktopRequireVerifiedHooks: false,
      csoCommand: [process.execPath, cliBin],
      ...over,
    });
    // 再開できるように、作業ツリーの場所を返す（既定の rig は返さない）
    const worktree = {
      ...r.deps.worktree,
      cwdOf: async (id: string) => join(r.config.worktreeRoot, id),
    };
    r0 = { ...r, deps: { ...r.deps, worktree } };
    return r0;
  };
  const spawnDesktop = async (d: Awaited<ReturnType<typeof boot>>) => {
    const spawned = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      ...brief,
    });
    expect(spawned.json.ok, JSON.stringify(spawned.json)).toBe(true);
    return spawned.json.value.nodeId as string;
  };
  /** node.bindCode の文面のとおりに、子が紐付ける（Write の代わりに code を書き、bind の行を実行する）。 */
  /** フックのコマンドを、フック入力を標準入力に渡して実行する（Claude Code がするのと同じ）。 */
  const runHook = async (line: string, payload: unknown) => {
    const { spawn } = await import("node:child_process");
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const c = spawn("bash", ["-c", line], { env: shEnv });
      let stdout = "";
      let stderr = "";
      c.stdout.on("data", (b) => {
        stdout += b;
      });
      c.stderr.on("data", (b) => {
        stderr += b;
      });
      c.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
      c.stdin.end(JSON.stringify(payload));
    });
  };
  let r0: ReturnType<typeof rig>;
  const r0Logs = (r: { logs: string[] }) => r.logs.join("\n");
  const bindByInstruction = async (d: Awaited<ReturnType<typeof boot>>, nodeId: string) => {
    const bc = await call(d.url, d.rootToken, "node.bindCode", { nodeId });
    expect(bc.json.ok, JSON.stringify(bc.json)).toBe(true);
    const instruction = bc.json.value.instruction as string;
    const lines = instruction.split("\n").map((l) => l.replace(/^ {3}/, ""));
    const codePath = (lines.find((l) => l.startsWith("ファイル: ")) as string).slice(
      "ファイル: ".length,
    );
    const drawer = codePath.replace(/\/code$/, "");
    const code = (lines.find((l) => l.startsWith("中身: ")) as string).slice("中身: ".length);
    const bindLine = lines.find((l) => l.includes(" child bind ")) as string;
    const reportLine = lines.find((l) => l.includes(" child report ")) as string;
    const worktree = join(r0.config.worktreeRoot, nodeId);
    /** Claude Code の代わりに、PreToolUse のフック（cso child hook）を、Bash の道具の呼び出しとして実行する。 */
    const hook = (command: string, cwd = worktree) =>
      runHook(bindLine.replace(" child bind ", " child hook "), {
        hook_event_name: "PreToolUse",
        session_id: "desktop-session-1",
        tool_name: "Bash",
        tool_input: { command },
        cwd,
      });
    writeFileSync(codePath, `${code}\n`, { mode: 0o644 });
    const hooked = await hook(bindLine);
    expect(hooked.code, hooked.stderr).toBe(0);
    const bound = await sh(bindLine);
    expect(bound.stdout, bound.stderr).toBe("bound\n");
    /** 文面のとおりに報告する（Write の代わりに report を書き、report の行を実行する）。 */
    const report = async (text: string, kind = "progress", withHook = true) => {
      writeFileSync(join(drawer, "report"), text, { mode: 0o644 });
      const line = reportLine.replace(/ progress$/, ` ${kind}`);
      if (withHook) await hook(line);
      return sh(line);
    };
    return { instruction, drawer, code, bindLine, reportLine, report, bound, hook, worktree };
  };
  const stateOfNode = (d: Awaited<ReturnType<typeof boot>>, id: string) =>
    d.daemon.log.state().nodes.find((n) => n.id === id)?.state;

  it("紐付けの通し（T21-cc）: spawn で引き出しと node → node.bindCode → code を書く → cso child bind → report を書いて cso child report。コード・トークンはログ・記録・出力に残らない。止めの宣言で中のファイルが消える", async () => {
    const r = desktopRig();
    const d = await boot(r);
    const nodeId = await spawnDesktop(d);
    expect(r.launcher.sessions).toHaveLength(0); // SDK では起動しない
    const b = await bindByInstruction(d, nodeId);
    // spawn のときに、daemon が引き出し（0700）と node（0600）を作っている
    expect(lstatSync(b.drawer).mode & 0o777).toBe(0o700);
    expect(readFileSync(join(b.drawer, "node"), "utf8").trim()).toBe(nodeId);
    expect(lstatSync(join(b.drawer, "node")).mode & 0o777).toBe(0o600);
    for (const c of [b.bindLine, b.reportLine]) expect(c).not.toContain(b.code);
    expect(existsSync(join(b.drawer, "code"))).toBe(false);
    expect(lstatSync(join(b.drawer, "token")).mode & 0o777).toBe(0o600);
    const token = readFileSync(join(b.drawer, "token"), "utf8").trim();
    const reported = await b.report("進んだ\n");
    expect(JSON.parse(reported.stdout).ok, reported.stdout + reported.stderr).toBe(true);
    expect(existsSync(join(b.drawer, "report"))).toBe(false); // 本文は cso が読んで消す
    for (const o of [b.bound, reported]) {
      expect(o.stdout + o.stderr).not.toContain(token);
      expect(o.stdout + o.stderr).not.toContain(b.code);
    }
    const reports = await call(d.url, d.rootToken, "inbox.fetch", {});
    expect(JSON.stringify(reports.json)).toContain("進んだ");
    // 使ったコードは、もう使えない
    const again = await fetch(`${d.url}/v1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId, bindCode: b.code }),
    });
    expect(again.status).toBe(401);
    // コード（区切りあり・なし）・トークンは、イベントログ（SQLite のファイル）・記録（logLine）・受信箱に残らない
    const raw = b.code.replace(/-/g, "");
    for (const f of ["state.db", "state.db-wal"]) {
      const p = join(r.config.stateDir, f);
      if (!existsSync(p)) continue;
      const bytes = readFileSync(p).toString("latin1");
      for (const secret of [raw, b.code, token]) expect(bytes.includes(secret), f).toBe(false);
    }
    for (const secret of [raw, token]) expect(r.logs.join("\n").includes(secret)).toBe(false);
    const inbox = await call(d.url, d.rootToken, "inbox.fetch", {});
    expect(JSON.stringify(inbox.json).includes(raw)).toBe(false);
    // 止める → 止めたと宣言（stopped）: token・url・code・report を消す。引き出しと node は残す（再開で結び直す）
    const stop = await call(d.url, d.rootToken, "node.stop", { nodeId, mode: "graceful" });
    expect(stop.json.ok, JSON.stringify(stop.json)).toBe(true);
    writeFileSync(join(b.drawer, "code"), "STALE\n", { mode: 0o644 });
    const confirmed = await call(d.url, d.humanToken, "node.confirmStopped", { nodeId });
    expect(confirmed.json.ok, JSON.stringify(confirmed.json)).toBe(true);
    expect(stateOfNode(d, nodeId)).toBe("stopped");
    for (const f of ["token", "url", "code", "report"])
      expect(existsSync(join(b.drawer, f)), f).toBe(false);
    expect(existsSync(join(b.drawer, "node"))).toBe(true);
    // 止まったあとの報告は、通らない（トークンは失効済み・ファイルもない）
    expect((await b.report("x")).stdout).toBe("urlMissing\n");
  });

  it("Desktop の子のフック（T21-ch）: spawn で hook-token（0600）を置く。cso child hook で、禁じる場所の Read は拒否・作業ツリーの外の cwd は拒否", async () => {
    const r = desktopRig();
    const d = await boot(r);
    const nodeId = await spawnDesktop(d);
    const b = await bindByInstruction(d, nodeId);
    expect(lstatSync(join(b.drawer, "hook-token")).mode & 0o777).toBe(0o600);
    const hookLine = b.bindLine.replace(" child bind ", " child hook ");
    const read = (file: string, cwd = b.worktree) =>
      runHook(hookLine, {
        hook_event_name: "PreToolUse",
        session_id: "desktop-session-1",
        tool_name: "Read",
        tool_input: { file_path: file },
        cwd,
      });
    const denied = await read(join(r.config.stateDir, "human-token"));
    expect(denied.code).toBe(2);
    expect(denied.stderr).toContain("読み取りもできません");
    expect((await read(join(b.drawer, "token"))).code).toBe(2);
    expect((await read(join(b.worktree, "README.md"))).code).toBe(0);
    // daemon の作業ツリーの外（チップで作った子など）は、拒否
    const elsewhere = await read(join(b.worktree, "README.md"), r.config.repoRoot);
    expect(elsewhere.code).toBe(2);
    const token = readFileSync(join(b.drawer, "hook-token"), "utf8").trim();
    expect(denied.stdout + denied.stderr).not.toContain(token);
  });

  it("T21-cs: spawn で作業ツリーに見張りの設定（PreToolUse は || exit 2、PostToolUse・Stop は || true、timeout 90）を置き、git の info/exclude に足す。文面にローカルで始める手順", async () => {
    const base = desktopRig();
    // 作業ツリーを git の作業ツリーにする（info/exclude を確かめる）
    const worktree = {
      ...base.deps.worktree,
      provisionWorktree: async ({ nodeId }: { nodeId: string }) => {
        const p = join(base.config.worktreeRoot, nodeId);
        mkdirSync(p, { recursive: true });
        await promisify(execFile)("git", ["init", "-q", p]);
        return ok({ worktreePath: p });
      },
    };
    const r = { ...base, deps: { ...base.deps, worktree } };
    r0 = r;
    const d = await boot(r);
    const nodeId = await spawnDesktop(d);
    const wt = join(r.config.worktreeRoot, nodeId);
    const settings = JSON.parse(readFileSync(join(wt, ".claude", "settings.json"), "utf8"));
    const pre = settings.hooks.PreToolUse[0].hooks[0];
    expect(pre.command).toMatch(
      / child hook --dir .* --url http:\/\/127\.0\.0\.1:\d+ \|\| exit 2$/,
    );
    expect(pre.timeout).toBe(90);
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toMatch(/ \|\| true$/);
    expect(settings.hooks.Stop[0].hooks[0].command).toMatch(/ \|\| true$/);
    expect(JSON.stringify(settings)).not.toMatch(/token/i);
    expect(readFileSync(join(wt, ".git", "info", "exclude"), "utf8")).toContain(
      "/.claude/settings.json",
    );
    const bc = await call(d.url, d.rootToken, "node.bindCode", { nodeId });
    expect(bc.json.value.instruction).toContain("「ローカル」");
    expect(bc.json.value.instruction).toContain(
      `作業ツリー: ${await (await import("node:fs/promises")).realpath(wt)}`,
    );
  });

  it("T21-cs: 作業ツリーに、違う中身の .claude/settings.json がすでにあれば、spawn は失敗する", async () => {
    const base = desktopRig();
    const worktree = {
      ...base.deps.worktree,
      provisionWorktree: async ({ nodeId }: { nodeId: string }) => {
        const p = join(base.config.worktreeRoot, nodeId);
        mkdirSync(join(p, ".claude"), { recursive: true });
        writeFileSync(join(p, ".claude", "settings.json"), "{}");
        return ok({ worktreePath: p });
      },
    };
    const d = await boot({ ...base, deps: { ...base.deps, worktree } });
    const res = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      ...brief,
    });
    expect(res.json.ok).toBe(false);
    expect(r0Logs(base)).toContain("hookSettingsExists");
  });

  it("T21-cs: 見張りの設定・利用者の設定・info/exclude への書き込みは拒否。設定を書き換えたら、以後はすべて拒否し、受信箱に 1 度知らせる。範囲違反は scope.violation に記録", async () => {
    const home = mkdtempSync(join(tmpdir(), "cso-home-"));
    const r = desktopRig();
    r.deps = { ...r.deps, parentEnv: { ...r.deps.parentEnv, HOME: home } } as typeof r.deps;
    r0 = r;
    const d = await boot(r);
    const nodeId = await spawnDesktop(d);
    const b = await bindByInstruction(d, nodeId);
    const hookLine = b.bindLine.replace(" child bind ", " child hook ");
    const write = (file_path: string) =>
      runHook(hookLine, {
        hook_event_name: "PreToolUse",
        session_id: "desktop-session-1",
        tool_name: "Write",
        tool_input: { file_path, content: "{}" },
        cwd: b.worktree,
      });
    for (const f of [
      join(b.worktree, ".claude", "settings.json"),
      join(b.worktree, ".claude", "settings.local.json"),
      join(home, ".claude", "settings.json"),
    ]) {
      const w = await write(f);
      expect(w.code, f).toBe(2);
      expect(w.stderr).toContain("見張り（フック）の設定");
    }
    const state = d.daemon.log.state();
    expect(state.inbox.some((x) => x.kind === "violation" && x.nodeId === nodeId)).toBe(true);
    // 子がスクリプトなどで書き換えた形
    writeFileSync(join(b.worktree, ".claude", "settings.json"), "{}");
    const after = await b.hook("pnpm test");
    expect(after.code).toBe(2);
    expect(after.stderr).toContain("変わっている");
    await b.hook("pnpm test");
    const notices = d.daemon.log
      .state()
      .inbox.filter((x) =>
        x.summary?.includes("見張り（フック）の設定が、置いたときから変わっている"),
      );
    expect(notices).toHaveLength(1);
    rmSync(home, { recursive: true, force: true });
  });

  it("T21-cs: Desktop の木では cso hook-env（node.hookToken）を拒否する（desktopHookEnvNotAllowed。次の操作は node.bindCode）", async () => {
    const r = desktopRig();
    const d = await boot(r);
    const nodeId = await spawnDesktop(d);
    const res = await call(d.url, d.humanToken, "node.hookToken", { nodeId });
    expect(res.json.error?.code).toBe("desktopHookEnvNotAllowed");
    expect(res.json.error?.nextActions?.join("")).toContain("node.bindCode");
  });

  it("M1: 作業ツリーの配下に cd しても通り、下位からの cd .. も通る。作業ツリーの中のリンクで外に出たら拒否", async () => {
    const r = desktopRig();
    const d = await boot(r);
    const nodeId = await spawnDesktop(d);
    const b = await bindByInstruction(d, nodeId);
    mkdirSync(join(b.worktree, "src", "deep"), { recursive: true });
    symlinkSync(r.config.stateDir, join(b.worktree, "out"));
    const ls = "pnpm test"; // 範囲で許されたコマンド
    const sub = await b.hook(ls, join(b.worktree, "src", "deep"));
    expect(sub.code, sub.stderr).toBe(0);
    // 下位からの cd ..: cwd（下位）の照合では止めない。止まるとすれば、範囲のコマンドの許可だけ（この試験の範囲には cd がない）
    const up = await b.hook("cd ..", join(b.worktree, "src", "deep"));
    expect(up.stderr).not.toContain("作業ツリーの外");
    expect(up.stderr).toContain("commandNotAllowed");
    const back = await b.hook(ls, join(b.worktree, "src"));
    expect(back.code, back.stderr).toBe(0);
    expect((await b.hook(ls, join(b.worktree, "out"))).code).toBe(2);
    expect((await b.hook(ls, r.config.worktreeRoot)).code).toBe(2);
  });

  it("R2: Desktop の子の /v1/hook は、フック専用のトークンだけ（ノードのトークンは 401）。拒否された呼び出しは、窓を満たさない", async () => {
    const r = desktopRig();
    const d = await boot(r);
    const nodeId = await spawnDesktop(d);
    const b = await bindByInstruction(d, nodeId);
    const nodeToken = readFileSync(join(b.drawer, "token"), "utf8").trim();
    const viaNode = await fetch(`${d.url}/v1/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${nodeToken}` },
      body: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "desktop-session-1",
        tool_name: "Bash",
        tool_input: { command: "ls" },
        cwd: b.worktree,
      }),
    });
    expect(viaNode.status).toBe(401);
  });

  it("R2: 拒否された呼び出しだけでは、bind は hooksNotActive のまま", async () => {
    const r = desktopRig();
    const d = await boot(r);
    const nodeId = await spawnDesktop(d);
    const bc = await call(d.url, d.rootToken, "node.bindCode", { nodeId });
    const lines = (bc.json.value.instruction as string)
      .split("\n")
      .map((l) => l.replace(/^ {3}/, ""));
    const codePath = (lines.find((l) => l.startsWith("ファイル: ")) as string).slice(
      "ファイル: ".length,
    );
    const code = (lines.find((l) => l.startsWith("中身: ")) as string).slice("中身: ".length);
    const bindLine = lines.find((l) => l.includes(" child bind ")) as string;
    const denied = await runHook(bindLine.replace(" child bind ", " child hook "), {
      hook_event_name: "PreToolUse",
      session_id: "desktop-session-1",
      tool_name: "Read",
      tool_input: { file_path: join(r.config.stateDir, "human-token") },
      cwd: join(r.config.worktreeRoot, nodeId),
    });
    expect(denied.code).toBe(2);
    writeFileSync(codePath, `${code}\n`, { mode: 0o644 });
    expect((await sh(bindLine)).stdout).toBe("hooksNotActive\n");
  });

  it("R1・R4: daemon の再起動のあと、フックは拒否（再起動と分かる言葉）。hook-token は 24 時間で切れる", async () => {
    let mono = 0;
    const r = desktopRig();
    const first = await boot({ ...r, deps: { ...r.deps, monoMs: () => mono } });
    const nodeId = await spawnDesktop(first);
    const b = await bindByInstruction(first, nodeId);
    mono += 24 * 3_600_000 - 1;
    expect((await b.hook("pnpm test")).code).toBe(0);
    mono += 1;
    const expired = await b.hook("pnpm test");
    expect(expired.code).toBe(2);
    expect(expired.stderr).toContain("node.bindCode");
    await first.daemon.stop();
    cleanups.length = 0;
    await boot(r);
    const after = await b.hook("pnpm test");
    expect(after.code).toBe(2);
    expect(after.stderr).toContain("再起動");
  });

  it("フックが直前に動いていなければ（hookFreshSeconds。既定 30 秒）、bind・report は hooksNotActive。bind のコードは使われずに残る", async () => {
    let mono = 0;
    const r = desktopRig();
    const d = await boot({ ...r, deps: { ...r.deps, monoMs: () => mono } });
    const nodeId = await spawnDesktop(d);
    const bc = await call(d.url, d.rootToken, "node.bindCode", { nodeId });
    const lines = (bc.json.value.instruction as string)
      .split("\n")
      .map((l) => l.replace(/^ {3}/, ""));
    const codePath = (lines.find((l) => l.startsWith("ファイル: ")) as string).slice(
      "ファイル: ".length,
    );
    const code = (lines.find((l) => l.startsWith("中身: ")) as string).slice("中身: ".length);
    const bindLine = lines.find((l) => l.includes(" child bind ")) as string;
    writeFileSync(codePath, `${code}\n`, { mode: 0o644 });
    // フックなしで bind（チップで作った子・フックを外した子の形）→ 断る。コードは cso が消すが、daemon の側では使っていない
    const noHook = await sh(bindLine);
    expect(noHook.stdout).toBe("hooksNotActive\n");
    const again = await fetch(`${d.url}/v1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId, bindCode: code }),
    });
    expect(again.status).toBe(403); // フックがまだないので、コードを使わずに断る
    const b = await bindByInstruction(d, nodeId);
    expect(JSON.parse((await b.report("x\n")).stdout).ok).toBe(true);
    mono += 31_000;
    const stale = await b.report("y\n", "progress", false);
    expect(stale.stdout).toBe("hooksNotActive\n");
    expect(JSON.parse((await b.report("z\n")).stdout).ok).toBe(true);
  });

  it("文面の bind・report の行と、Write で書く code・report は、作業範囲の判定（decideToolUse）を通る（Desktop の子にフックが効くようになったときの形。R1）", async () => {
    const r = desktopRig();
    const d = await boot(r);
    const nodeId = await spawnDesktop(d);
    const b = await bindByInstruction(d, nodeId);
    const { decideToolUse } = await import("../src/sdk/hook-policy.js");
    const { csoChildCommands } = await import("../src/sdk/desktop-adapter.js");
    const { realpath } = await import("node:fs/promises");
    const scope = {
      ...brief.scope,
      allowedCommands: [
        ...brief.scope.allowedCommands,
        ...csoChildCommands([process.execPath, cliBin]),
      ],
    };
    const cwd = await realpath(r.config.worktreeRoot);
    const prot = {
      roots: [{ path: await realpath(r.config.stateDir), kind: "stateDir" as const }],
      allow: [],
      drawer: await realpath(b.drawer),
      csoCommand: [process.execPath, cliBin],
    };
    // daemon と同じ解決（まだない場所は、いちばん深い既存の祖先を実パスにする）
    const { resolveForWrite, nodeFsOps } = await import("../src/sdk/path-resolve.js");
    const resolve = (p: string) => resolveForWrite(p, nodeFsOps);
    const decide = (tool: string, input: unknown) =>
      decideToolUse(scope, cwd, tool, input, resolve, prot);
    expect(await decide("Bash", { command: b.bindLine }), b.bindLine).toEqual({ allow: true });
    expect(await decide("Bash", { command: b.reportLine }), b.reportLine).toEqual({ allow: true });
    expect(await decide("Write", { file_path: join(b.drawer, "code"), content: "X" })).toEqual({
      allow: true,
    });
    expect(await decide("Write", { file_path: join(b.drawer, "report"), content: "X" })).toEqual({
      allow: true,
    });
    expect((await decide("Read", { file_path: join(b.drawer, "token") })).allow).toBe(false);
  });

  it("止めたあとで再開し、もう一度 bind してから report できる。止める前のトークンは通らない（R5）", async () => {
    const r = desktopRig();
    const d = await boot(r);
    const nodeId = await spawnDesktop(d);
    const b = await bindByInstruction(d, nodeId);
    const oldToken = readFileSync(join(b.drawer, "token"), "utf8").trim();
    const p = await call(d.url, d.rootToken, "decision.present", {
      question: "どちら？",
      options: ["a", "b"],
      pauseNodeIds: [nodeId],
    });
    expect(p.json.ok, JSON.stringify(p.json)).toBe(true);
    const confirmed = await call(d.url, d.humanToken, "node.confirmStopped", { nodeId });
    expect(confirmed.json.ok, JSON.stringify(confirmed.json)).toBe(true);
    expect(stateOfNode(d, nodeId)).toBe("stopped");
    const answered = await call(d.url, d.humanToken, "decision.answer", {
      decisionId: p.json.value.decisionId,
      choice: "a",
    });
    expect(answered.json.ok, JSON.stringify(answered.json)).toBe(true);
    expect(stateOfNode(d, nodeId)).toBe("running");
    const old = await fetch(`${d.url}/v1/whoami`, {
      headers: { authorization: `Bearer ${oldToken}` },
    });
    expect(old.status).toBe(401);
    const again = await bindByInstruction(d, nodeId);
    const res = await again.report("再開した\n");
    expect(JSON.parse(res.stdout).ok, res.stdout + res.stderr).toBe(true);
  });

  it("tokenExpired からの結び直し: 期限が切れたら report は終了コード 3。node.bindCode を出し直して bind すると、報告できる（R5）", async () => {
    let mono = 0;
    const r = desktopRig();
    const d = await boot({ ...r, deps: { ...r.deps, monoMs: () => mono } });
    const nodeId = await spawnDesktop(d);
    const b = await bindByInstruction(d, nodeId);
    mono += 61 * 60_000; // 使わなければ切れる期限（bind。既定 1 時間）
    const expired = await b.report("x\n");
    expect(expired.code).toBe(3);
    expect(expired.stdout).toBe("tokenExpired\n");
    expect(existsSync(join(b.drawer, "token"))).toBe(false);
    const again = await bindByInstruction(d, nodeId);
    const res = await again.report("結び直した\n");
    expect(JSON.parse(res.stdout).ok, res.stdout + res.stderr).toBe(true);
  });

  it("R2: node.bindCode を出し直すと、前の token・url を消す（新しい文面で 1 からやり直す）", async () => {
    const r = desktopRig();
    const d = await boot(r);
    const nodeId = await spawnDesktop(d);
    const b = await bindByInstruction(d, nodeId);
    writeFileSync(join(b.drawer, "report"), "残り", { mode: 0o644 });
    const bc = await call(d.url, d.rootToken, "node.bindCode", { nodeId });
    expect(bc.json.ok).toBe(true);
    for (const f of ["token", "url", "code", "report"])
      expect(existsSync(join(b.drawer, f)), f).toBe(false);
    expect(existsSync(join(b.drawer, "node"))).toBe(true);
  });

  it("R3: 起動したときに stopped の子の引き出しに token・url が残っていたら、消す", async () => {
    const r = desktopRig();
    const first = await boot(r);
    const nodeId = await spawnDesktop(first);
    const b = await bindByInstruction(first, nodeId);
    await call(first.url, first.rootToken, "node.stop", { nodeId, mode: "graceful" });
    const confirmed = await call(first.url, first.humanToken, "node.confirmStopped", { nodeId });
    expect(confirmed.json.ok, JSON.stringify(confirmed.json)).toBe(true);
    await first.daemon.stop();
    cleanups.length = 0;
    // 前回、消す前に daemon が止まった形を作る
    writeFileSync(join(b.drawer, "token"), "stale-token\n", { mode: 0o600 });
    writeFileSync(join(b.drawer, "url"), "http://127.0.0.1:1\n", { mode: 0o600 });
    const second = await boot(r);
    expect(stateOfNode(second, nodeId)).toBe("stopped");
    for (const f of ["token", "url"]) expect(existsSync(join(b.drawer, f)), f).toBe(false);
    expect(existsSync(join(b.drawer, "node"))).toBe(true);
  });

  it("csoCommand がなければ、node.bindCode は csoCommandMissing", async () => {
    const r = rig({ childRuntime: "desktop", desktopRequireVerifiedHooks: false });
    const d = await boot(r);
    const spawned = await call(d.url, d.rootToken, "node.spawn", {
      parentId: "root",
      role: "implement",
      ...brief,
    });
    const nodeId = spawned.json.value.nodeId as string;
    const bc = await call(d.url, d.rootToken, "node.bindCode", { nodeId });
    expect(bc.json.error?.code).toBe("csoCommandMissing");
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
