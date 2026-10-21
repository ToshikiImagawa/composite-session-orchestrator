/**
 * daemon の組み立て（コンポジションルート）。設定（`DaemonConfig`）と、外部への口（git の作業ツリー・エージェントの起動）を受けて、
 * ストア・イベントログ・認証・アダプタ・ハンドラ・窓口を結ぶ。
 *
 * - 状態の置き場（`stateDir`）は 0700。SQLite（`state.db`）・ノードのトークン（`node-tokens.json`、ハッシュだけ）・人間のトークン
 *   （`human-token`）・根のトークン（`root-token`）は、置き場の中に 0600 で置く。
 * - 根のノード（`rootNodeId`。統合ノード）がなければ作って開始する。あれば、役割・親を確かめる（違えば起動を失敗させる）。
 *   根のトークンは、`root-token` がなければ発行して書く（あれば、保存済みのトークンが有効）。
 * - 起動に失敗する条件（置き場の権限・ストアの破損・根の不一致など）は、例外でなく `Failure` で返す（フェイルクローズ）。
 * - ポートの `cwdOf` は、根のノードだけ設定の `rootCwd` を返し、ほかはポートに任せる。
 */

import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_PURGE_TOMBSTONE,
  type EventBody,
  type Failure,
  failure,
  isPathUnder,
  type Result,
} from "@cso/core";
import { assertSecureDirectory, assertSecureFile, processUid } from "./api/fs-safety.js";
import { waitRequestKey } from "./api/handlers/context.js";
import {
  type ApiLogger,
  type BindCodes,
  createApiServer,
  createBindCodes,
  createCredentialStore,
  createHandlersWithScheduler,
  FileTokenRepository,
  loadOrCreateHumanToken,
  type ReclaimPorts,
  type SpawnPorts,
  type WorktreeFacts,
} from "./api/index.js";
import type { DaemonConfig } from "./config.js";
import { EventLog } from "./eventlog.js";
import { reconcileOnStartup } from "./reconcile.js";
import type { AgentLauncher } from "./sdk/agent.js";
import { createLsofProbe, nodeExec, type ProcessProbe } from "./sdk/lsof-probe.js";
import { nodeTimers } from "./sdk/node-timers.js";
import { nodeFsOps, resolveForWrite } from "./sdk/path-resolve.js";
import type { Timers } from "./sdk/runtime.js";
import { SdkRuntimeAdapter } from "./sdk/sdk-adapter.js";
import { openSqliteStore } from "./sqlite-store.js";

/** 最終削除の保持期間の既定（日。spec 5.8）。 */
const DEFAULT_RETENTION_DAYS = 90;

/** git の作業ツリーに関わる口（実装は git を呼ぶ。テストはフェイク）。 */
export interface WorktreePorts {
  factsFor(nodeId: string): Promise<WorktreeFacts | undefined>;
  removeWorktree(
    nodeId: string,
    opts: { expectedPath: string; force?: boolean; onTip?: (tip: string) => void },
  ): Promise<Result<undefined, Failure>>;
  provisionWorktree(req: {
    parentId: string;
    nodeId: string;
  }): Promise<Result<{ worktreePath: string }, Failure>>;
  /** 根以外のノードの作業ツリー（実パス）。 */
  cwdOf(nodeId: string): Promise<string | undefined>;
}

export interface DaemonDeps {
  readonly launcher: AgentLauncher;
  readonly worktree: WorktreePorts;
  /** プロセスの調査。既定は `lsof`。 */
  readonly probe?: ProcessProbe;
  readonly clock?: () => string;
  readonly timers?: Timers;
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /** 運用の記録（1 行の JSON。秘密を含めない）。既定は標準エラー。 */
  readonly logLine?: (line: string) => void;
  /**
   * 最終削除の後に、イベントログの追記のみの保証を確かめられなかったとき（以降の書き込みは拒否される）に呼ぶ。
   * 呼び出し側は daemon を止める（fail closed）。記録（`fatal`）は、これとは別に残す。
   */
  readonly onFatal?: (cause: string) => void;
  /** 試験用: SQLite のストアの試験用フック（最終削除の後のトリガーの確認の失敗を再現する）。 */
  readonly storeHooks?: Parameters<typeof openSqliteStore>[1];
}

export interface RunningDaemon {
  readonly port: number;
  readonly url: string;
  /** 人間のトークンのファイル（0600）。トークンそのものは、ログに出さない。 */
  readonly humanTokenPath: string;
  /** 根の統合ノードのトークンのファイル（0600）。 */
  readonly rootTokenPath: string;
}

export interface Daemon {
  start(): Promise<RunningDaemon>;
  stop(): Promise<void>;
  /** テスト・診断用: イベントログ。 */
  readonly log: EventLog;
}

const fail = (code: string, cause: string, ...next: [string, ...string[]]) => ({
  ok: false as const,
  error: failure(code, cause, ...next),
});

function prepareStateDir(dir: string): Failure | undefined {
  try {
    let exists = true;
    try {
      lstatSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      exists = false;
    }
    if (!exists) mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertSecureDirectory(dir, processUid());
    // 認証情報・状態を置くので、グループ・他者の権限を一切許さない（0700）。
    const mode = lstatSync(dir).mode;
    if ((mode & 0o077) !== 0) {
      throw new Error(`権限が緩い（${(mode & 0o777).toString(8)}）。0700 にする`);
    }
    return undefined;
  } catch (e) {
    return failure(
      "stateDirInvalid",
      `状態の置き場 ${dir} を使えない（${String(e instanceof Error ? e.message : e)}）`,
      "置き場を、自分だけが書ける 0700 のディレクトリにする",
    );
  }
}

/** 作ったタイマーを覚えておき、止めるときにまとめて取り消す。 */
export function trackTimers(base: Timers): { timers: Timers; cancelAll(): void } {
  const pending = new Set<() => void>();
  return {
    timers: {
      now: () => base.now(),
      sleep: (ms) => base.sleep(ms),
      after(ms) {
        const t = base.after(ms);
        const cancel = (): void => {
          pending.delete(cancel);
          t.cancel();
        };
        pending.add(cancel);
        void t.promise.then(() => pending.delete(cancel));
        return { promise: t.promise, cancel };
      },
    },
    cancelAll() {
      for (const c of [...pending]) c();
    },
  };
}

/** 置き場が、リンクを解決した実パスで、互いに重なっていないか。 */
function realOverlap(config: DaemonConfig): string | undefined {
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return p;
    }
  };
  const s = real(config.stateDir);
  const r = real(config.repoRoot);
  const w = real(config.worktreeRoot);
  const o = (a: string, b: string): boolean => isPathUnder(a, b) || isPathUnder(b, a);
  if (o(s, w) || o(s, r) || o(w, r)) {
    return "stateDir・repoRoot・worktreeRoot が、リンクを解決すると重なる";
  }
  return undefined;
}

export function createDaemon(config: DaemonConfig, deps: DaemonDeps): Result<Daemon, Failure> {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const logLine = deps.logLine ?? ((line: string) => process.stderr.write(`${line}\n`));
  const note = (event: string, fields: Record<string, unknown> = {}): void => {
    try {
      logLine(JSON.stringify({ at: clock(), event, ...fields }));
    } catch {
      // 記録先の失敗は、処理を止めない
    }
  };

  const dirProblem = prepareStateDir(config.stateDir);
  if (dirProblem !== undefined) return { ok: false, error: dirProblem };
  const overlap = realOverlap(config);
  if (overlap !== undefined) {
    return fail("invalidConfig", `設定が不正: ${overlap}`, "置き場を、重ならない別の場所にする");
  }

  // SQLite のファイル（state.db・-wal・-shm）が、他のユーザーから読めないよう、作る間は umask を 077 にする。
  const previousUmask = process.umask(0o077);
  let opened: ReturnType<typeof openSqliteStore>;
  try {
    opened = openSqliteStore(join(config.stateDir, "state.db"), deps.storeHooks);
  } finally {
    process.umask(previousUmask);
  }
  if (!opened.ok) return opened;
  const store = opened.value;
  const logOpened = EventLog.open(store, {
    clock,
    verifySnapshot: true,
    onSnapshotMismatch: () => note("snapshotMismatch"),
    onFatal: (cause) => {
      note("fatal", { cause });
      deps.onFatal?.(cause);
    },
  });
  if (!logOpened.ok) {
    store.close();
    return logOpened;
  }
  const log = logOpened.value;
  const closeAll = (): void => {
    try {
      store.close();
    } catch {
      // すでに閉じている
    }
  };

  // 根のノード: なければ作って開始し、起動前（pending）なら開始を記録する。起動できない状態・根でないノードなら失敗する。
  const rootMismatch = (why: string) => {
    closeAll();
    return fail(
      "rootNodeMismatch",
      `ノード ${config.rootNodeId} を、根の統合ノードとして使えない（${why}）`,
      "rootNodeId を、根のノードの ID にする",
      "別の置き場（stateDir）を使う",
    );
  };
  const rootEvent = (requestId: string, body: EventBody): Failure | undefined => {
    const r = log.append({ requestId, actor: { system: true }, body });
    return r.ok ? undefined : r.error;
  };
  const existing = log.state().nodes.find((n) => n.id === config.rootNodeId);
  if (existing === undefined) {
    const err =
      rootEvent("bootstrap-root-created", {
        type: "node.created",
        payload: { nodeId: config.rootNodeId, role: "integrator", parentId: null, dependsOn: [] },
      }) ??
      rootEvent("bootstrap-root-started", {
        type: "node.stateChanged",
        payload: { nodeId: config.rootNodeId, event: { type: "start" } },
      });
    if (err !== undefined) {
      closeAll();
      return fail(
        "bootstrapFailed",
        `根のノード ${config.rootNodeId} を作れない（${err.code}）`,
        "ストアの状態を確認する",
      );
    }
  } else if (existing.role !== "integrator" || existing.parentId !== null) {
    return rootMismatch(`役割: ${existing.role}`);
  } else if (existing.state === "pending") {
    // 作成の記録のあと、開始の前に止まっていた。
    const err = rootEvent("bootstrap-root-started", {
      type: "node.stateChanged",
      payload: { nodeId: config.rootNodeId, event: { type: "start" } },
    });
    if (err !== undefined) return rootMismatch(`開始を記録できない: ${err.code}`);
  } else if (existing.state !== "running" && existing.state !== "waiting") {
    return rootMismatch(`状態: ${existing.state}`);
  }

  // 認証。
  let humanToken: string;
  let credentials: ReturnType<typeof createCredentialStore>;
  const rootTokenPath = join(config.stateDir, "root-token");
  const humanTokenPath = join(config.stateDir, "human-token");
  try {
    humanToken = loadOrCreateHumanToken(humanTokenPath).token;
    credentials = createCredentialStore({
      humanToken,
      repository: new FileTokenRepository(join(config.stateDir, "node-tokens.json")),
      clock,
    });
    // 根のトークン: ファイルがあり、認証に通るならそのまま。なければ・通らなければ、発行し直して、一時ファイルに書いてから置き換える。
    let current: string | undefined;
    try {
      assertSecureFile(rootTokenPath, processUid());
      current = readFileSync(rootTokenPath, "utf8").trim();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
        // 権限が緩い・リンクなど。信用せず、発行し直す（古いトークンは無効になる）。
        note("rootTokenReissued", { reason: "ファイルが使えない" });
      }
    }
    const who = current === undefined ? undefined : credentials.authenticate(current);
    const valid =
      who !== undefined &&
      who.role === "integrator" &&
      "nodeId" in who &&
      who.nodeId === config.rootNodeId;
    if (!valid) {
      const token = credentials.issueNodeToken(config.rootNodeId, "integrator");
      const tmp = `${rootTokenPath}.tmp-${randomBytes(6).toString("hex")}`;
      writeFileSync(tmp, `${token}\n`, { mode: 0o600, flag: "wx" });
      renameSync(tmp, rootTokenPath);
    }
  } catch (e) {
    closeAll();
    return fail(
      "credentialsFailed",
      `認証情報を用意できない（${String(e instanceof Error ? e.message : e)}）`,
      "stateDir のファイルの権限・内容を確認する",
    );
  }

  // ストアにないノード（最終削除で消えた木など）のトークンは、無効にする（削除の途中で止まったときの残りを含む）。
  const known = new Set(log.state().nodes.map((n) => n.id));
  for (const id of credentials.nodeIds()) {
    if (known.has(id)) continue;
    try {
      credentials.revokeNode(id);
      note("orphanTokenRevoked", { nodeId: id });
    } catch (e) {
      note("orphanTokenRevokeFailed", { nodeId: id, cause: String(e) });
    }
  }

  const probe = deps.probe ?? createLsofProbe(nodeExec);
  const tracked = trackTimers(deps.timers ?? nodeTimers);
  const timers = tracked.timers;
  const adapter = new SdkRuntimeAdapter({
    launcher: deps.launcher,
    probe,
    realpath: (p) => realpath(p),
    resolvePath: (p) => resolveForWrite(p, nodeFsOps),
    sink: { record: (r) => log.append(r), recordAll: (rs) => log.appendAll(rs) },
    timers,
    newRequestId: () => `adp-${randomBytes(12).toString("hex")}`,
    parentEnv: deps.parentEnv ?? process.env,
    ...(config.childEnvAllow === undefined ? {} : { childEnvAllow: config.childEnvAllow }),
    onUnexpectedExit: (nodeId, reason) => note("unexpectedExit", { nodeId, reason }),
    onFailure: (nodeId, cause) => note("handlerFailure", { nodeId, cause }),
    waitKeyOf: (nodeId) => {
      const st = log.state();
      if (st.nodes.find((n) => n.id === nodeId)?.state !== "waiting") return undefined;
      const open = st.decisions.find((d) => d.nodeId === nodeId && d.status === "open");
      return open === undefined ? undefined : waitRequestKey(open.decisionId);
    },
    ...(config.childHome === "inherit"
      ? {}
      : {
          homeFor: (nodeId: string): string => {
            const dir = join(config.stateDir, "homes", nodeId);
            mkdirSync(dir, { recursive: true, mode: 0o700 });
            return dir;
          },
        }),
  });

  const cwdOf = async (nodeId: string): Promise<string | undefined> =>
    nodeId === config.rootNodeId ? config.rootCwd : deps.worktree.cwdOf(nodeId);
  const reclaim: ReclaimPorts = {
    factsFor: (id) => deps.worktree.factsFor(id),
    probe,
    removeWorktree: (id, opts) => deps.worktree.removeWorktree(id, opts),
    worktreeRoot: config.worktreeRoot,
    onForced: (nodeId, tip) => note("reclaimForced", { nodeId, tip }),
  };
  const spawn: SpawnPorts = {
    cwdOf,
    provisionWorktree: (req) => deps.worktree.provisionWorktree(req),
    removeWorktree: (id, opts) => deps.worktree.removeWorktree(id, opts),
    worktreeRoot: config.worktreeRoot,
    mcpUrl: config.mcpUrl,
  };
  const onFailure = (nodeId: string, cause: string): void =>
    note("handlerFailure", { nodeId, cause });
  const {
    handlers,
    tick: schedule,
    close: closeScheduler,
  } = createHandlersWithScheduler(
    { log, clock },
    {
      adapterFor: () => adapter,
      onStopSettled: (nodeId, result) =>
        note("stopSettled", {
          nodeId,
          ok: result.ok,
          ...(result.ok ? { state: result.value.state } : {}),
        }),
    },
    reclaim,
    {
      ports: spawn,
      credentials,
      rootScope: config.rootScope,
      onFailure,
      ...(config.startLimits === undefined ? {} : { startLimits: config.startLimits }),
    },
    {
      nowMs: () => Date.parse(clock()),
      retentionDays: config.retentionDays ?? DEFAULT_RETENTION_DAYS,
      defaultTombstone: config.purgeTombstone ?? DEFAULT_PURGE_TOMBSTONE,
      revokeNode: (id) => credentials.revokeNode(id),
      audit: (event, data) => note(`purge.${event}`, data),
      onFailure,
    },
  );

  const logger: ApiLogger = (e) => {
    // 秘密（コード・トークン）は、イベントに含まれない（`ApiLogEvent` の規則）。
    if (e.event === "internalError")
      note("apiInternalError", {
        operation: e.operation,
        requestId: e.requestId,
        error: String(e.error),
      });
    else note(e.event, e as unknown as Record<string, unknown>);
  };
  const bind: BindCodes = createBindCodes();
  const server = createApiServer({
    credentials,
    getState: () => log.state(),
    handlers,
    logger,
    bind,
    clock,
  });

  let running: RunningDaemon | undefined;
  return {
    ok: true,
    value: {
      log,
      async start() {
        if (running !== undefined) return running;
        // 待ち受けの前に、前回の実行から残った子（記録は動作中だが、アダプタは管理していない）を、記録とプロセスに合わせる。
        const outcomes = await reconcileOnStartup({
          log,
          clock,
          cwdOf,
          probe,
          worktreeRoot: config.worktreeRoot,
          has: (id) => adapter.has(id),
          onFailure: (nodeId, cause) => note("reconcileFailure", { nodeId, cause }),
        });
        for (const o of outcomes) note("reconciled", { ...o });
        const { port, url } = await server.listen(config.port);
        running = { port, url, humanTokenPath, rootTokenPath };
        // 待ち受けの後で、前回から残った、依存の揃った pending の子を起動する（子が窓口へ接続できるように）。
        void schedule();
        note("started", { port, rootNodeId: config.rootNodeId });
        return running;
      },
      async stop() {
        await server.close();
        await closeScheduler(); // 起動の途中の tick が終わるのを待つ（終わる前に、タイマー・DB を閉じない）
        tracked.cancelAll(); // アダプタが作った、残りのタイマーを止める
        running = undefined;
        closeAll();
        note("stopped");
      },
    },
  };
}
