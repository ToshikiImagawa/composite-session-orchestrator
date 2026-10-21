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
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { type Failure, failure, type Result } from "@cso/core";
import { assertSecureDirectory, processUid } from "./api/fs-safety.js";
import {
  type ApiLogger,
  type BindCodes,
  createApiServer,
  createBindCodes,
  createCredentialStore,
  createHandlers,
  FileTokenRepository,
  loadOrCreateHumanToken,
  type ReclaimPorts,
  type SpawnPorts,
  type WorktreeFacts,
} from "./api/index.js";
import type { DaemonConfig } from "./config.js";
import { EventLog } from "./eventlog.js";
import type { AgentLauncher } from "./sdk/agent.js";
import { createLsofProbe, nodeExec, type ProcessProbe } from "./sdk/lsof-probe.js";
import { nodeTimers } from "./sdk/node-timers.js";
import { nodeFsOps, resolveForWrite } from "./sdk/path-resolve.js";
import type { Timers } from "./sdk/runtime.js";
import { SdkRuntimeAdapter } from "./sdk/sdk-adapter.js";
import { openSqliteStore } from "./sqlite-store.js";

/** git の作業ツリーに関わる口（実装は git を呼ぶ。テストはフェイク）。 */
export interface WorktreePorts {
  factsFor(nodeId: string): Promise<WorktreeFacts | undefined>;
  removeWorktree(
    nodeId: string,
    opts: { expectedPath: string },
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
    return undefined;
  } catch (e) {
    return failure(
      "stateDirInvalid",
      `状態の置き場 ${dir} を使えない（${String(e instanceof Error ? e.message : e)}）`,
      "置き場を、自分だけが書ける 0700 のディレクトリにする",
    );
  }
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

  const opened = openSqliteStore(join(config.stateDir, "state.db"));
  if (!opened.ok) return opened;
  const store = opened.value;
  const logOpened = EventLog.open(store, { clock, verifySnapshot: true });
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

  // 根のノード: なければ作って開始する。あれば、役割・親を確かめる。
  const existing = log.state().nodes.find((n) => n.id === config.rootNodeId);
  if (existing === undefined) {
    const created = log.append({
      requestId: `bootstrap-root-created`,
      actor: { system: true },
      body: {
        type: "node.created",
        payload: { nodeId: config.rootNodeId, role: "integrator", parentId: null, dependsOn: [] },
      },
    });
    const started = created.ok
      ? log.append({
          requestId: `bootstrap-root-started`,
          actor: { system: true },
          body: {
            type: "node.stateChanged",
            payload: { nodeId: config.rootNodeId, event: { type: "start" } },
          },
        })
      : created;
    if (!started.ok) {
      closeAll();
      return fail(
        "bootstrapFailed",
        `根のノード ${config.rootNodeId} を作れない（${started.error.code}）`,
        "ストアの状態を確認する",
      );
    }
  } else if (existing.role !== "integrator" || existing.parentId !== null) {
    closeAll();
    return fail(
      "rootNodeMismatch",
      `ノード ${config.rootNodeId} は、根の統合ノードではない（役割: ${existing.role}）`,
      "rootNodeId を、根のノードの ID にする",
      "別の置き場（stateDir）を使う",
    );
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
    let rootTokenExists = true;
    try {
      lstatSync(rootTokenPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      rootTokenExists = false;
    }
    if (!rootTokenExists) {
      const token = credentials.issueNodeToken(config.rootNodeId, "integrator");
      writeFileSync(rootTokenPath, `${token}\n`, { mode: 0o600, flag: "wx" });
    }
  } catch (e) {
    closeAll();
    return fail(
      "credentialsFailed",
      `認証情報を用意できない（${String(e instanceof Error ? e.message : e)}）`,
      "stateDir のファイルの権限・内容を確認する",
    );
  }

  const probe = deps.probe ?? createLsofProbe(nodeExec);
  const timers = deps.timers ?? nodeTimers;
  const adapter = new SdkRuntimeAdapter({
    launcher: deps.launcher,
    probe,
    realpath: (p) => realpath(p),
    resolvePath: (p) => resolveForWrite(p, nodeFsOps),
    sink: { record: (r) => log.append(r) },
    timers,
    newRequestId: () => `adp-${randomBytes(12).toString("hex")}`,
    parentEnv: deps.parentEnv ?? process.env,
    onUnexpectedExit: (nodeId, reason) => note("unexpectedExit", { nodeId, reason }),
  });

  const cwdOf = async (nodeId: string): Promise<string | undefined> =>
    nodeId === config.rootNodeId ? config.rootCwd : deps.worktree.cwdOf(nodeId);
  const reclaim: ReclaimPorts = {
    factsFor: (id) => deps.worktree.factsFor(id),
    probe,
    removeWorktree: (id, opts) => deps.worktree.removeWorktree(id, opts),
    worktreeRoot: config.worktreeRoot,
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
  const handlers = createHandlers(
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
    { ports: spawn, credentials, rootScope: config.rootScope, onFailure },
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
        const { port, url } = await server.listen(config.port);
        running = { port, url, humanTokenPath, rootTokenPath };
        note("started", { port, rootNodeId: config.rootNodeId });
        return running;
      },
      async stop() {
        await server.close();
        running = undefined;
        closeAll();
        note("stopped");
      },
    },
  };
}
