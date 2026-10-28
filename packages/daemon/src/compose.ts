/**
 * daemon の組み立て（コンポジションルート）。設定（`DaemonConfig`）と、外部への口（git の作業ツリー・エージェントの起動）を受けて、
 * ストア・イベントログ・認証・アダプタ・ハンドラ・窓口を結ぶ。
 *
 * - 状態の置き場（`stateDir`）は 0700。SQLite（`state.db`）・ノードのトークン（`node-tokens.json`、ハッシュだけ）・人間のトークン
 *   （`human-token`）・根のトークン（`root-token`）は、置き場の中に 0600 で置く。
 * - 身元の秘密（`daemon-identity`。T10m-i）は、`start()` のたびに作り直して、待ち受けの前に 0600 で書き、`stop()` で消す。窓口の `GET /v1/identity` が、
 *   秘密と待ち受けのポートから作った `proof` だけを返す（`docs/daemon-identity.md`）。
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
import { createConfirmationGate } from "./api/confirmation-gate.js";
import { assertSecureDirectory, assertSecureFile, processUid } from "./api/fs-safety.js";
import { recoverAnswerDeliveries } from "./api/handlers/answer-delivery.js";
import { createBindHandlers } from "./api/handlers/bind-handlers.js";
import { waitRequestKey } from "./api/handlers/context.js";
import { createHookHandlers } from "./api/handlers/hook-handlers.js";
import { createInstructionDelivery } from "./api/handlers/instruction-delivery.js";
import { createPurger, type PurgeHandlerDeps } from "./api/handlers/purge-handlers.js";
import { createHookTokens, createSessionBinder } from "./api/hook.js";
import {
  createIdentity,
  IDENTITY_FILE,
  type Identity,
  removeIdentityFile,
  writeIdentityFile,
} from "./api/identity.js";
import {
  type ApiLogger,
  type BindCodes,
  createApiServer,
  createBindCodes,
  createCredentialStore,
  createDiscardedHandlers,
  createHandlersWithScheduler,
  DEFAULT_AUTH_FAILURE_BURST,
  DEFAULT_AUTH_FAILURE_PER_MINUTE,
  DEFAULT_PRINCIPAL_SPEC,
  FileTokenRepository,
  loadOrCreateHumanToken,
  type ReclaimPorts,
  type SpawnPorts,
  type SummaryScheduler,
  type WorktreeFacts,
} from "./api/index.js";
import type { Handlers } from "./api/server.js";
import {
  ALERT_ID_PREFIX,
  createApiAlert,
  DEFAULT_ALERT_INTERVAL_MINUTES,
  DEFAULT_ALERT_THRESHOLD,
} from "./api-alert.js";
import { createAutoPurger } from "./auto-purge.js";
import type { DaemonConfig } from "./config.js";
import { createDigestIssuer } from "./digest-issuer.js";
import { ownedBy } from "./discarded-keys.js";
import { EventLog } from "./eventlog.js";
import { withExternalCheckResolution } from "./external-check.js";
import type { GitPorts, LossFacts } from "./git-ports.js";
import {
  choosePort,
  PORT_FILE,
  portSaveFailed,
  readSavedPort,
  savedPortUnavailable,
  writeSavedPort,
} from "./port-file.js";
import { reconcileOnStartup } from "./reconcile.js";
import type { AgentLauncher } from "./sdk/agent.js";
import { buildChildPlugin, CHILD_PLUGIN_DIR } from "./sdk/child-plugin.js";
import { DesktopRuntimeAdapter } from "./sdk/desktop-adapter.js";
import { createLsofProbe, nodeExec, type ProcessProbe } from "./sdk/lsof-probe.js";
import { nodeTimers } from "./sdk/node-timers.js";
import { nodeFsOps, resolveForWrite } from "./sdk/path-resolve.js";
import type { RuntimeAdapter, Timers } from "./sdk/runtime.js";
import { SdkRuntimeAdapter } from "./sdk/sdk-adapter.js";
import { openSqliteStore } from "./sqlite-store.js";
import { createWaker } from "./wake.js";

/** 最終削除の保持期間の既定（日。spec 5.8）。 */
const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_DIGEST_INTERVAL_SEC = 30;
const DEFAULT_DIGEST_MIN_INTERVAL_SEC = 60;
const DEFAULT_DIGEST_MAX_PER_RUN = 20;
const DEFAULT_WAKE_INTERVAL_SEC = 15;
const DEFAULT_WAKE_MIN_INTERVAL_SEC = 60;
const DEFAULT_WAKE_MAX_PER_RUN = 10;
const DEFAULT_AUTO_PURGE_INTERVAL_MINUTES = 60;
const DEFAULT_AUTO_PURGE_MAX_TREES = 2;
const DEFAULT_AUTO_PURGE_NOTICE_DAYS = 7;

/** git の作業ツリーに関わる口（実装は git を呼ぶ。テストはフェイク）。 */
export interface WorktreePorts {
  factsFor(nodeId: string): Promise<WorktreeFacts | undefined>;
  /** 強制の回収で失われるもの（T21r。省略すると、回収の事前確認に `loss` を出さない）。 */
  lossFor?(nodeId: string): Promise<LossFacts | undefined>;
  removeWorktree(
    nodeId: string,
    opts: {
      expectedPath: string;
      force?: boolean;
      onTip?: (tip: string, ref?: string) => void;
    },
  ): Promise<Result<undefined, Failure>>;
  /** 保管している、破棄した成果（T13f-r）。省略すると、保管の操作（`node.discarded*`）と最終削除での掃除は無効（`notSupported`）。 */
  discardedList?: GitPorts["discardedList"];
  discardedKeyOf?: GitPorts["discardedKeyOf"];
  discardedRestore?: GitPorts["discardedRestore"];
  discardedDrop?: GitPorts["discardedDrop"];
  discardedDeleteFor?: GitPorts["discardedDeleteFor"];
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
  /** 起動オプション `--port` の値（1〜65535）。設定の `port` より優先する（`port-file.ts`）。 */
  readonly port?: number;
  /** 新規のポートの保存（既定は `writeSavedPort`。試験で、保存の失敗を差し替える）。 */
  readonly savePort?: (path: string, port: number) => void;
  /** 単調時計（ミリ秒）。既定は `process.hrtime`。自動の最終削除が、時計が飛んだことを検知するのに使う（試験で差し替える）。 */
  readonly monotonicMs?: () => number;
  /** 窓口の件数のまとめを、窓の終わりに出す予約（試験で差し替える。既定は、`unref` したタイマー）。 */
  readonly summaryScheduler?: SummaryScheduler | null;
  readonly parentEnv?: Readonly<Record<string, string | undefined>>;
  /** 運用の記録（1 行の JSON。秘密を含めない）。既定は標準エラー。 */
  readonly logLine?: (line: string) => void;
  /**
   * 取り消せない操作の確認コードを書く先（T24-cf。Desktop の木だけ）。既定は標準エラー。構造化のログ（`logLine`）とは別に、
   * 1 行だけ書く。記録・ファイルには書かない（試験で差し替える）。
   */
  readonly confirmationOut?: (line: string) => void;
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
  /** 身元の秘密のファイル（0600。起動ごとに作り直す。停止で消える。`docs/daemon-identity.md`）。 */
  readonly identityPath: string;
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

/**
 * 設定から、窓口の回数の制限・接続・処理中の重複の扱い（T10l・T10l-f）の deps を作る。省略した項目は、窓口の既定のまま
 * （`connection`・`inProgress` は、設定にあるときだけ渡す）。
 */
export function apiLimitsOf(
  config: DaemonConfig,
  monotonicMs?: () => number,
  summaryScheduler?: SummaryScheduler | null,
): Pick<Parameters<typeof createApiServer>[0], "rateLimit" | "connection" | "inProgress"> {
  return {
    rateLimit: {
      perPrincipal: {
        burst: config.rateLimit?.perPrincipal?.burst ?? DEFAULT_PRINCIPAL_SPEC.burst,
        perSecond: config.rateLimit?.perPrincipal?.perSecond ?? DEFAULT_PRINCIPAL_SPEC.perSecond,
      },
      authFailures: {
        burst: config.rateLimit?.authFailures?.burst ?? DEFAULT_AUTH_FAILURE_BURST,
        perSecond:
          (config.rateLimit?.authFailures?.perMinute ?? DEFAULT_AUTH_FAILURE_PER_MINUTE) / 60,
      },
      ...(config.rateLimit?.maxKeys === undefined ? {} : { maxKeys: config.rateLimit.maxKeys }),
      ...(config.rateLimit?.maxInFlightPerPrincipal === undefined
        ? {}
        : { maxInFlightPerPrincipal: config.rateLimit.maxInFlightPerPrincipal }),
      ...(monotonicMs === undefined ? {} : { monotonicMs }),
      ...(summaryScheduler === undefined ? {} : { summaryScheduler }),
    },
    ...(config.connection === undefined ? {} : { connection: config.connection }),
    ...(config.inProgress === undefined ? {} : { inProgress: config.inProgress }),
  };
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
  let fatalSeen = false;
  const logOpened = EventLog.open(store, {
    clock,
    verifySnapshot: true,
    onSnapshotMismatch: () => note("snapshotMismatch"),
    onFatal: (cause) => {
      fatalSeen = true;
      note("fatal", { cause });
      deps.onFatal?.(cause);
    },
  });
  if (!logOpened.ok) {
    store.close();
    return logOpened;
  }
  const log = logOpened.value;
  /** 起動の時点（整合などでログに書く前）の、最後の記録の時刻。自動の最終削除が、止まっていた時間を検知する。 */
  const startupLastEventAt = log.lastEventAt();
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

  // フックの受け口の session_id の結び付け（T22-hu）。トークンを発行し直した・失効させたら外す。
  const hookSessions = createSessionBinder();
  // 手動の CLI セッション用の、フック専用のトークン（T22-ht）。CLI の子のときだけ。ノードのトークンが変わったら、一緒に無効にする。
  const hookTokens = config.childRuntime === "desktop" ? undefined : createHookTokens();
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
      onNodeTokenChanged: (nodeId) => {
        hookTokens?.revoke(nodeId);
        if (hookSessions.unbind(nodeId)) note("hookUnbound", { reason: "tokenReissued" });
      },
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

  // 子に渡す skill だけの plugin（T22-c）。起動のたびに作り直す。作れなければ、起動しない（フェイルクローズ）。
  let childPluginPath: string | undefined;
  if (config.childPluginDir === undefined) {
    note("childPluginSkipped", {
      reason: "childPluginDir の設定がないので、子に skill を渡していない",
    });
  } else {
    const built = buildChildPlugin(
      config.childPluginDir,
      join(config.stateDir, CHILD_PLUGIN_DIR),
      config.stateDir,
    );
    if (!built.ok) {
      closeAll();
      return built;
    }
    childPluginPath = built.value.path;
  }

  const probe = deps.probe ?? createLsofProbe(nodeExec);
  const tracked = trackTimers(deps.timers ?? nodeTimers);
  const timers = tracked.timers;
  const sdkAdapter = new SdkRuntimeAdapter({
    launcher: deps.launcher,
    probe,
    realpath: (p) => realpath(p),
    resolvePath: (p) => resolveForWrite(p, nodeFsOps),
    sink: { record: (r) => log.append(r), recordAll: (rs) => log.appendAll(rs) },
    timers,
    newRequestId: () => `adp-${randomBytes(12).toString("hex")}`,
    parentEnv: deps.parentEnv ?? process.env,
    ...(config.childEnvAllow === undefined ? {} : { childEnvAllow: config.childEnvAllow }),
    ...(childPluginPath === undefined ? {} : { childPluginPath }),
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

  // Desktop の子（daemon の外で動く子）か。起動時の照合と、根の「daemon 再起動後」の依頼の解決で、同じ判定を使う（T21・C2-4）。
  const isExternal: ((nodeId: string) => boolean) | undefined =
    config.childRuntime === "desktop" ? () => true : undefined;
  // Desktop の子のときは、追記が成功したあとに、動いているかもしれない子がいなくなっていれば、根の依頼を解決済みにする
  // （操作のハンドラと、Desktop のアダプタの記録口に使う。`external-check.ts`）。
  const resolvingLog =
    isExternal === undefined
      ? log
      : withExternalCheckResolution(log, isExternal, (cause) =>
          note("externalCheckFailure", { cause }),
        );
  // Desktop の子（設定 childRuntime が desktop。T21・仮置き）。木全体で 1 つのアダプタ。フックのゲート（T20）は既定で有効。
  const desktopAdapter =
    config.childRuntime === "desktop"
      ? new DesktopRuntimeAdapter({
          sink: {
            record: (r) => resolvingLog.append(r),
            recordAll: (rs) => resolvingLog.appendAll(rs),
          },
          requireVerifiedHooks: config.desktopRequireVerifiedHooks ?? true,
          onWarning: (nodeId, text) => note("desktopHooksGateDisabled", { nodeId, text }),
        })
      : undefined;
  const adapter: RuntimeAdapter & { has(nodeId: string): boolean } = desktopAdapter ?? sdkAdapter;

  const cwdOf = async (nodeId: string): Promise<string | undefined> =>
    nodeId === config.rootNodeId ? config.rootCwd : deps.worktree.cwdOf(nodeId);
  const reclaim: ReclaimPorts = {
    factsFor: (id) => deps.worktree.factsFor(id),
    ...(deps.worktree.lossFor === undefined
      ? {}
      : {
          lossFor: (id: string) =>
            (deps.worktree.lossFor as NonNullable<WorktreePorts["lossFor"]>)(id),
        }),
    probe,
    removeWorktree: (id, opts) => deps.worktree.removeWorktree(id, opts),
    worktreeRoot: config.worktreeRoot,
    onForced: (nodeId, tip, ref) =>
      note("reclaimForced", { nodeId, tip, ...(ref === undefined ? {} : { ref }) }),
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
  const purgeDeps: PurgeHandlerDeps = {
    log,
    nowMs: () => Date.parse(clock()),
    retentionDays: config.retentionDays ?? DEFAULT_RETENTION_DAYS,
    defaultTombstone: config.purgeTombstone ?? DEFAULT_PURGE_TOMBSTONE,
    revokeNode: (id) => credentials.revokeNode(id),
    audit: (event, data) => note(`purge.${event}`, data),
    onFailure,
    discardedFor: async (nodeIds) => {
      const list = deps.worktree.discardedList;
      const keyOf = deps.worktree.discardedKeyOf;
      if (list === undefined || keyOf === undefined) throw new Error("保管の口がない");
      const listed = await list.call(deps.worktree);
      if (!listed.ok) throw new Error(listed.error.cause);
      const bases = new Set(nodeIds.map((id) => keyOf.call(deps.worktree, id)));
      return listed.value.items.filter((i) => ownedBy(i.key, bases)).length;
    },
    // 最終削除で、その木のノードの、保管している破棄した成果（refs/cso/discarded/*）も消す（T13f-r）。最終削除の成否には影響させない。
    onPurged: (nodeIds) => {
      const del = deps.worktree.discardedDeleteFor;
      if (del === undefined) return;
      void del
        .call(deps.worktree, nodeIds)
        .then((r) => {
          if (r.deleted.length > 0) note("purge.discardedRefsDeleted", { refs: r.deleted });
          if (r.failed.length > 0) note("purge.discardedRefsFailed", { refs: r.failed });
        })
        .catch((e) => note("purge.discardedRefsFailed", { cause: String(e) }));
    },
  };
  const {
    handlers,
    tick: schedule,
    close: closeScheduler,
  } = createHandlersWithScheduler(
    {
      // Desktop の子のときは、根の「daemon 再起動後」の依頼を、状態が変わったあとに判断する（上の resolvingLog）。
      log: resolvingLog,
      clock,
    },
    {
      adapterFor: () => adapter,
      managed: (id) => adapter.has(id),
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
    purgeDeps,
  );
  // 自動の最終削除（設定で有効にしたときだけ）。人間のコマンドと同じ関数を通る。
  const autoPurger =
    config.autoPurge?.enabled === true
      ? createAutoPurger({
          state: () => log.state(),
          nowMs: purgeDeps.nowMs,
          retentionDays: purgeDeps.retentionDays,
          intervalMs:
            (config.autoPurge.intervalMinutes ?? DEFAULT_AUTO_PURGE_INTERVAL_MINUTES) * 60_000,
          maxTreesPerRun: config.autoPurge.maxTreesPerRun ?? DEFAULT_AUTO_PURGE_MAX_TREES,
          noticeDays: config.autoPurge.noticeDays ?? DEFAULT_AUTO_PURGE_NOTICE_DAYS,
          record: (requestId, body) => log.append({ requestId, actor: { system: true }, body }),
          purgeTreeOf: createPurger(purgeDeps).purgeTreeOf,
          timers,
          note,
          isStopped: () => fatalSeen,
          lastEventAt: () => log.lastEventAt(),
          monoMs: deps.monotonicMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n)),
          lastEventAtAtStartup: startupLastEventAt,
        })
      : undefined;

  // 配下の要約（T24-d。既定で有効。`digest.enabled: false` で無効）。文面は、core の `digestOf` の結果だけ。
  const digestIssuer =
    config.digest?.enabled === false
      ? undefined
      : createDigestIssuer({
          state: () => log.state(),
          nowMs: purgeDeps.nowMs,
          monoMs: deps.monotonicMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n)),
          intervalMs: (config.digest?.intervalSec ?? DEFAULT_DIGEST_INTERVAL_SEC) * 1000,
          minIntervalMs: (config.digest?.minIntervalSec ?? DEFAULT_DIGEST_MIN_INTERVAL_SEC) * 1000,
          maxPerRun: config.digest?.maxPerRun ?? DEFAULT_DIGEST_MAX_PER_RUN,
          record: (requestId, body) => log.append({ requestId, actor: { system: true }, body }),
          timers,
          note,
          isStopped: () => fatalSeen,
        });

  // 中間統合ノードを起こす（T24-w。**既定で無効**。`wake.enabled: true` で有効）。固定の 1 行の指示を、`node.send` と同じ配送で送る。
  const waker =
    config.wake?.enabled === true
      ? createWaker({
          log,
          clock,
          monoMs: deps.monotonicMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n)),
          intervalMs: (config.wake.intervalSec ?? DEFAULT_WAKE_INTERVAL_SEC) * 1000,
          minIntervalMs: (config.wake.minIntervalSec ?? DEFAULT_WAKE_MIN_INTERVAL_SEC) * 1000,
          maxPerRun: config.wake.maxPerRun ?? DEFAULT_WAKE_MAX_PER_RUN,
          ...(config.wake.maxPerHour === undefined ? {} : { maxPerHour: config.wake.maxPerHour }),
          deliver: createInstructionDelivery({
            log,
            clock,
            adapterFor: () => adapter,
            onFailure: (nodeId, cause) => note("handlerFailure", { nodeId, cause }),
          }).deliver,
          canDeliver: (id) => adapter.has(id),
          timers,
          note,
          isStopped: () => fatalSeen,
        })
      : undefined;

  // 窓口の 429・401 の件数の見える化（T10l-f PR-B。既定で有効）。件数のまとめ（apiSummary）が閾値以上なら、根の受信箱に info を 1 件出す。
  const apiAlert =
    config.rateLimit?.alert?.enabled === false
      ? undefined
      : createApiAlert({
          threshold: config.rateLimit?.alert?.threshold ?? DEFAULT_ALERT_THRESHOLD,
          minIntervalMs:
            (config.rateLimit?.alert?.minIntervalMinutes ?? DEFAULT_ALERT_INTERVAL_MINUTES) *
            60_000,
          rootNodeId: config.rootNodeId,
          monoMs: deps.monotonicMs ?? (() => Number(process.hrtime.bigint() / 1_000_000n)),
          record: (requestId, body) => log.append({ requestId, actor: { system: true }, body }),
          openAlertIds: () =>
            log
              .state()
              .inbox.filter((i) => i.id.startsWith(ALERT_ID_PREFIX) && i.resolved === undefined)
              .map((i) => i.id),
          note,
        });
  const logger: ApiLogger = (e) => {
    // 秘密（コード・トークン）は、イベントに含まれない（`ApiLogEvent` の規則）。
    if (e.event === "internalError")
      note("apiInternalError", {
        operation: e.operation,
        requestId: e.requestId,
        error: String(e.error),
      });
    else note(e.event, e as unknown as Record<string, unknown>);
    apiAlert?.(e);
  };
  const bind: BindCodes = createBindCodes();
  // 取り消せない操作の確認（T24-cf）。Desktop の木だけ（子が人間のトークンを読めてしまうため）。CLI の子だけの木は今までどおり。
  const confirmGate =
    desktopAdapter === undefined
      ? undefined
      : createConfirmationGate({
          log,
          clock,
          writeTerminal:
            deps.confirmationOut ?? ((line: string) => process.stderr.write(`${line}\n`)),
        });
  const wrapConfirm = (h: Handlers): Handlers =>
    confirmGate === undefined ? h : confirmGate.wrap(h);
  const identityPath = join(config.stateDir, IDENTITY_FILE);
  let currentIdentity: Identity | undefined;
  const server = createApiServer({
    identity: () => currentIdentity,
    credentials,
    // ファイルで設定するフック（plugin の hooks.json。T22-h）。SDK のコールバックと同じ判定・同じ記録。
    // Desktop の子のフックの継承は未確認（Spike 01 の項目 4）。確認までは、受け口では許可しない（仮置き）。
    hook: (nodeId, toolName, toolInput) =>
      desktopAdapter === undefined
        ? sdkAdapter.decideHook(nodeId, toolName, toolInput)
        : Promise.resolve({
            allow: false as const,
            reason: "Desktop の子のフックの受け口は、実機確認までは使わない（仮置き）",
          }),
    hookSessions,
    ...(hookTokens === undefined ? {} : { hookTokens }),
    getState: () => log.state(),
    // 画面の停止の宣言（T22d）。ハンドラ（node.confirmStopped）と同じく、能力表の stopDelegated だけで決める（管理しているか
    // は見ない。再起動の後も出す）。childRuntime が desktop のとき、Desktop のアダプタの能力表から真になる（T21）。
    stopDelegated: stopDelegatedOf(adapter),
    ...(confirmGate === undefined
      ? {}
      : {
          confirmations: () => confirmGate.pending(),
          confirmationsVersion: () => confirmGate.version(),
        }),
    handlers: wrapConfirm({
      ...handlers,
      // フックの結び付けを外す（人間・祖先の統合ノード。T22-hu）。
      ...createHookHandlers({
        log,
        sessions: hookSessions,
        ...(hookTokens === undefined ? {} : { hookTokens }),
        managed: (id) => adapter.has(id),
        baseUrl: () => running?.url,
      }),
      // Desktop の子の紐付けの文面（T21・仮置き）。コードは記録しない（応答だけ）。
      ...createBindHandlers({
        log,
        bind,
        ...(desktopAdapter === undefined ? {} : { desktop: desktopAdapter }),
        baseUrl: () => running?.url,
      }),
      // 保管している、破棄した成果の操作（人間のみ。T13f-r）。git の口が、保管の操作を持つときだけ有効。
      ...(deps.worktree.discardedList === undefined ||
      deps.worktree.discardedKeyOf === undefined ||
      deps.worktree.discardedRestore === undefined ||
      deps.worktree.discardedDrop === undefined
        ? {}
        : createDiscardedHandlers({
            state: () => log.state(),
            ports: {
              discardedList: () => (deps.worktree.discardedList as GitPorts["discardedList"])(),
              discardedKeyOf: (id) =>
                (deps.worktree.discardedKeyOf as GitPorts["discardedKeyOf"])(id),
              discardedRestore: (r) =>
                (deps.worktree.discardedRestore as GitPorts["discardedRestore"])(r),
              discardedDrop: (k, tip) =>
                (deps.worktree.discardedDrop as GitPorts["discardedDrop"])(k, tip),
            },
            audit: (event, data) => note(`discarded.${event}`, data),
          })),
    }),
    logger,
    bind,
    clock,
    ...apiLimitsOf(config, deps.monotonicMs, deps.summaryScheduler),
  });

  let running: RunningDaemon | undefined;
  return {
    ok: true,
    value: {
      log,
      async start() {
        if (running !== undefined) return running;
        // 窓口のポート（課題 3）: 起動オプション → 設定 → 保存したポート → 新規（保存する）の順。`port-file.ts`。
        // 照合・配送し直しより前に決める（ファイルの誤りは、記録を何も書く前に止める）。
        const portPath = join(config.stateDir, PORT_FILE);
        const choice = choosePort({
          ...(deps.port === undefined ? {} : { option: deps.port }),
          configPort: config.port,
          saved: () => readSavedPort(portPath),
        });
        // 待ち受けの前に、前回の実行から残った子（記録は動作中だが、アダプタは管理していない）を、記録とプロセスに合わせる。
        const outcomes = await reconcileOnStartup({
          log,
          clock,
          cwdOf,
          probe,
          worktreeRoot: config.worktreeRoot,
          has: (id) => adapter.has(id),
          // Desktop の子は、daemon の外で動くので、プロセスで照合せず、受信箱で人に確かめてもらう（T21）。
          ...(isExternal === undefined ? {} : { external: isExternal }),
          onFailure: (nodeId, cause) => note("reconcileFailure", { nodeId, cause }),
        });
        for (const o of outcomes) note("reconciled", { ...o });
        // 判断の回答の指示が、記録と配送の間で途切れていたら、配送し直す（届けられなければ、受信箱に failure を出す）。
        const delivery = createInstructionDelivery({ log, clock, adapterFor: () => adapter });
        const recovered = await recoverAnswerDeliveries({
          log,
          clock,
          deliver: delivery.deliver,
          canDeliver: (id) => adapter.has(id),
          onFailure: (nodeId, cause) => note("answerDeliveryFailure", { nodeId, cause }),
        });
        for (const o of recovered) note("answerRecovered", { ...o });
        // 身元確認（T10m-i）: 起動ごとに、新しい秘密を作り、待ち受けの前に、ファイルへ書く（異常終了で残った古いファイルは、上書きされる）。
        const identity = createIdentity();
        try {
          writeIdentityFile(identityPath, identity);
        } catch (e) {
          throw new Error(
            `身元の秘密のファイルを書けない（${String(e instanceof Error ? e.message : e)}）。stateDir の権限を確認する`,
          );
        }
        currentIdentity = identity;
        let listened: { port: number; url: string };
        try {
          listened = await server.listen(choice.port);
        } catch (e) {
          currentIdentity = undefined;
          removeIdentityFile(identityPath, identity);
          if (choice.source === "saved") {
            const cause = String(
              (e as NodeJS.ErrnoException).code ?? (e instanceof Error ? e.message : e),
            );
            note("portUnavailable", { port: choice.port, source: choice.source, cause });
            throw savedPortUnavailable(choice.port, cause);
          }
          throw e;
        }
        if (choice.source === "new") {
          try {
            (deps.savePort ?? writeSavedPort)(portPath, listened.port);
          } catch (e) {
            const cause = String(e instanceof Error ? e.message : e);
            note("portSaveFailed", { port: listened.port, cause });
            // Desktop の子は、次の再起動でポートが変わると報告できなくなるので、起動を止める（呼び出し側が stop する）。
            // ほかは、保存できなくても起動は続ける（次回は、また新しいポートになる）。
            if (config.childRuntime === "desktop") throw portSaveFailed(listened.port, cause);
          }
        }
        const { port, url } = listened;
        running = { port, url, humanTokenPath, rootTokenPath, identityPath };
        // 待ち受けの後で、前回から残った、依存の揃った pending の子を起動する（子が窓口へ接続できるように）。
        void schedule();
        autoPurger?.start();
        digestIssuer?.start();
        waker?.start();
        note("started", { port, portSource: choice.source, rootNodeId: config.rootNodeId });
        return running;
      },
      async stop() {
        await waker?.stop(); // 実行中の 1 回が終わるのを待つ
        await digestIssuer?.stop(); // 実行中の 1 回が終わるのを待つ（終わる前に、ストアを閉じない）
        await autoPurger?.stop(); // 実行中の 1 回が終わるのを待つ（終わる前に、ストアを閉じない）
        await server.close();
        if (currentIdentity !== undefined) removeIdentityFile(identityPath, currentIdentity);
        currentIdentity = undefined;
        await closeScheduler(); // 起動の途中の tick が終わるのを待つ（終わる前に、タイマー・DB を閉じない）
        tracked.cancelAll(); // アダプタが作った、残りのタイマーを止める
        running = undefined;
        closeAll();
        note("stopped");
      },
    },
  };
}

/**
 * 画面に停止の宣言を出すかの判定（T22d）。ハンドラ（`node.confirmStopped`）と同じく、能力表の `stopDelegated` だけで決める
 * （アダプタが子を管理しているかは見ない。daemon の再起動の後、管理が空でも、停止未完了のノードに出す）。
 */
export const stopDelegatedOf =
  (adapter: Pick<RuntimeAdapter, "capabilities">) =>
  (nodeId: string): boolean =>
    adapter.capabilities(nodeId).stopDelegated === true;
