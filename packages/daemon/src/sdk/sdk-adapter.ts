/**
 * `sdk` ランタイムアダプタ（CLI の子の起動・指示・2 段階停止・フック）。
 * PRD: FR_005, FR_009, FR_010, FR_033, IR_002 / design 6.1〜6.3
 *
 * 責務: 子の起動と操作の仕組み、停止の観測と確認、フックによる範囲外の操作の拒否と記録。
 * 停止の要求そのものの記録（`stop`・`retryStop` の状態遷移）は、要求を受けた daemon 側が先に行う。
 * ここでは、停止の仕組みを実行し、観測（`node.stopObserved`）と確認（`confirmStopped`・`stopTimeout`）を記録する。
 *
 * 停止（spec 5.3、T03）:
 * - 穏当: 停止指示のメッセージを入力へ送り、猶予（既定 60 秒、要求ごとに上書き可）内に result が来なければ
 *   `interrupt()` で打ち切る。猶予中に即時停止が来たら、すぐ `abort()` に切り替える。
 * - 即時: 猶予なしで `abort()`。
 * - 手段は例外・時間切れに備える: `interrupt()` が例外・時間切れ（既定 10 秒）なら `abort()`、`abort()` が例外でも検証へ進む。
 *   観測（`node.stopObserved`）は実際に行った手段で記録し、観測の記録に失敗しても警告として検証を続ける。
 *   `stop()` は reject せず、常に `Result` を返す。検証中に即時停止の要求が来たら `abort()` し、返す outcome も合わせる。
 * - 停止後は、作業ツリー配下のプロセスがいないことを確認できるまで、停止とは扱わない。一定の間隔で確認し、
 *   所定の時間（既定 30 秒）を超えても残っていれば `stopTimeout` を記録して停止未完了を返す。
 *   再試行（`retryStop` の後の即時停止）は、同じ手順をもう一度実行する。自動では再試行しない。
 */

import {
  type EventBody,
  type Failure,
  failure,
  findRunningProcesses,
  ID_MAX_LENGTH,
  LIMITS,
  MAX_GRACE_MS,
  ok,
  type Result,
  type Scope,
  type ScopeViolationReason,
  type StopOutcome,
  sanitizeText,
} from "@cso/core";
import type {
  AgentLauncher,
  AgentSession,
  HookInput,
  HookOutcome,
  McpServerConfig,
} from "./agent.js";
import { childEnv } from "./child-env.js";
import { decideToolUse, type ResolvePath, resolveScope } from "./hook-policy.js";
import type { ProcessProbe } from "./lsof-probe.js";
import type {
  Capabilities,
  DeliveryValue,
  EventSink,
  RuntimeAdapter,
  StartRequest,
  StartValue,
  StopRequest,
  StopValue,
  Timers,
} from "./runtime.js";

export interface SdkAdapterDeps {
  readonly launcher: AgentLauncher;
  /** 作業ツリー配下で動作中のプロセスの一覧。取得できなければ `null`。 */
  readonly probe: ProcessProbe;
  /** シンボリックリンクを解決した実パス。 */
  readonly realpath: (path: string) => Promise<string>;
  /** 書き込み先・範囲の場所の実パス化（最も深い既存の祖先を実パスにする。`resolveForWrite`）。 */
  readonly resolvePath: ResolvePath;
  readonly sink: EventSink;
  readonly timers: Timers;
  readonly newRequestId: () => string;
  /** 子の環境の元になる親の環境変数。 */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** 子に渡す環境変数の、既定に加える名前（完全一致。daemon の設定 `childEnvAllow`）。 */
  readonly childEnvAllow?: readonly string[];
  /** 穏当な停止の猶予の既定値（ミリ秒）。既定 60000。 */
  readonly defaultGraceMs?: number;
  /** 停止後のプロセス確認を続ける時間（ミリ秒）。既定 30000。 */
  readonly verifyTimeoutMs?: number;
  /** 停止後のプロセス確認の間隔（ミリ秒）。既定 1000。 */
  readonly verifyIntervalMs?: number;
  /** 起動（init）を待つ時間（ミリ秒）。既定 30000。 */
  readonly startTimeoutMs?: number;
  /** `interrupt()` を待つ時間（ミリ秒）。超えたら `abort()` に切り替える。既定 10000。 */
  readonly interruptTimeoutMs?: number;
  /** 稼働中の子が、停止の要求なしに終了したときの通知。アダプタは `node.exited` を記録した上で通知する。 */
  readonly onUnexpectedExit?: (nodeId: string, reason: string) => void;
}

const STOP_MESSAGE =
  "停止の要求です。区切りのよいところで、これまでの成果を保存して（書き込み済みの成果は残す）、作業を止めてください。";

interface StopCtx {
  escalated: boolean;
  /** `act`: 停止の手段を実行中。`verify`: プロセスの不在を確認中。 */
  phase: "act" | "verify";
  /** 検証中に即時停止へ切り替えたときの、最終の outcome。 */
  outcome?: StopOutcome;
  readonly warnings: string[];
  wake(): void;
  readonly woken: Promise<void>;
}

interface StopFlow {
  readonly mode: "graceful" | "immediate";
  readonly promise: Promise<Result<StopValue, Failure>>;
  /** 穏当な停止の猶予中・検証中に、即時停止へ切り替える。 */
  escalate(): void;
}

interface NodeEntry {
  readonly session: AgentSession;
  readonly cwd: string;
  /** フックが参照する範囲（`updateScope` で差し替える）。 */
  readonly state: { scope: Scope; violations: Set<string> };
  /** 停止を始めた（停止未完了のあとも真のまま。以後の指示は受け付けない）。 */
  stopping: boolean;
  flow?: StopFlow | undefined;
}

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const isGraceMs = (x: unknown): x is number =>
  typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= MAX_GRACE_MS;

const fail = (
  code: string,
  cause: string,
  ...next: [string, ...string[]]
): { ok: false; error: Failure } => ({
  ok: false,
  error: failure(code, cause, ...next),
});

export class SdkRuntimeAdapter implements RuntimeAdapter {
  readonly kind = "cli" as const;
  private readonly nodes = new Map<string, NodeEntry>();
  private readonly starting = new Set<string>();

  constructor(private readonly deps: SdkAdapterDeps) {}

  /** このアダプタが、そのノードの子を管理しているか（起動中を含む。停止の確認が済んだものは含まない）。 */
  has(nodeId: string): boolean {
    return this.nodes.has(nodeId) || this.starting.has(nodeId);
  }

  capabilities(_nodeId: string): Capabilities {
    return {
      send: "delayed",
      stopGraceful: true,
      stopImmediate: true,
      hooks: "ok",
      sessionId: true,
    };
  }

  async start(request: StartRequest): Promise<Result<StartValue, Failure>> {
    const d = this.deps;
    if (
      !isRec(request) ||
      typeof request.nodeId !== "string" ||
      request.nodeId === "" ||
      typeof request.worktreePath !== "string" ||
      !request.worktreePath.startsWith("/") ||
      request.worktreePath.includes("\0") ||
      typeof request.instruction !== "string" ||
      !isRec(request.scope)
    ) {
      return fail(
        "invalidRequest",
        "起動の要求の形が不正",
        "nodeId・worktreePath（絶対）・scope・instruction を確認する",
      );
    }
    const { nodeId } = request;
    if (this.nodes.has(nodeId) || this.starting.has(nodeId)) {
      return fail(
        "alreadyStarted",
        `ノード ${nodeId} は既に起動している`,
        "追加の指示を送る",
        "停止してから起動し直す",
      );
    }
    this.starting.add(nodeId);
    try {
      let cwd: string;
      try {
        cwd = await d.realpath(request.worktreePath);
      } catch (e) {
        return fail(
          "worktreeInvalid",
          `作業ツリーを解決できない（${request.worktreePath}）: ${String(e)}`,
          "作業ツリーが存在するか確認する",
          "作業ツリーを作り直す",
        );
      }
      const { env, removed } = childEnv(d.parentEnv, d.childEnvAllow);
      const state = { scope: request.scope, violations: new Set<string>() };
      const mcpServers: Record<string, McpServerConfig> | undefined = request.mcp
        ? {
            node: {
              type: "http",
              url: request.mcp.url,
              headers: { Authorization: `Bearer ${request.mcp.token}` },
            },
          }
        : undefined;

      let session: AgentSession;
      try {
        session = d.launcher.launch({
          cwd,
          env,
          settingSources: [],
          ...(mcpServers ? { mcpServers } : {}),
          hooks: { preToolUse: (input) => this.onPreToolUse(nodeId, state, cwd, input) },
          initialPrompt: request.instruction,
        });
      } catch (e) {
        return fail(
          "startFailed",
          `子の起動に失敗: ${String(e)}`,
          "認証と環境を確認する",
          "もう一度起動する",
        );
      }

      const timer = d.timers.after(d.startTimeoutMs ?? 30_000);
      const winner = await Promise.race([
        session.ready().then(
          (v) => ({ kind: "ready" as const, v }),
          (e: unknown) => ({ kind: "error" as const, e }),
        ),
        timer.promise.then(() => ({ kind: "timeout" as const })),
      ]);
      timer.cancel();
      if (winner.kind !== "ready") {
        try {
          session.abort();
        } catch {
          // 打ち切れなくても、起動の失敗として返す。
        }
        return fail(
          "startFailed",
          winner.kind === "timeout"
            ? "子の起動（init）が時間内に完了しなかった"
            : `子の起動に失敗: ${String(winner.e)}`,
          "認証と環境を確認する",
          "もう一度起動する",
        );
      }
      const entry: NodeEntry = { session, cwd, state, stopping: false };
      this.nodes.set(nodeId, entry);
      this.watchFinished(nodeId, entry);
      return ok({ sessionId: winner.v.sessionId, cwd, removedEnv: removed });
    } finally {
      this.starting.delete(nodeId);
    }
  }

  async send(nodeId: string, text: string): Promise<Result<DeliveryValue, Failure>> {
    const entry = this.nodes.get(nodeId);
    if (entry === undefined) {
      return fail(
        "unknownNode",
        `ノード ${String(nodeId)} は稼働していない`,
        "ノードの状態を確認する",
      );
    }
    if (typeof text !== "string" || text.trim() === "") {
      return fail("invalidRequest", "指示が空", "指示の内容を確認する");
    }
    if (entry.stopping) {
      return fail(
        "stopping",
        `ノード ${nodeId} は停止中のため、指示を受け付けない`,
        "停止の完了を待つ",
        "停止後に再開してから指示する",
      );
    }
    try {
      entry.session.send(text);
    } catch (e) {
      return fail(
        "sendFailed",
        `指示を送れなかった: ${String(e)}`,
        "ノードの状態を確認する",
        "もう一度送る",
      );
    }
    return ok({ status: "queued" as const });
  }

  updateScope(nodeId: string, scope: Scope): Result<undefined, Failure> {
    const entry = this.nodes.get(nodeId);
    if (entry === undefined) {
      return fail(
        "unknownNode",
        `ノード ${String(nodeId)} は稼働していない`,
        "ノードの状態を確認する",
      );
    }
    if (
      !isRec(scope) ||
      !Array.isArray(scope.writableLocations) ||
      !Array.isArray(scope.forbiddenLocations) ||
      !Array.isArray(scope.allowedCommands)
    ) {
      return fail(
        "invalidRequest",
        "範囲の形が不正",
        "writable・forbidden・allowedCommands を確認する",
      );
    }
    entry.state.scope = scope;
    return ok(undefined);
  }

  /** 識別子（`isSafeId`）を満たす ID を作る。`newRequestId` が安全でない文字を返しても、記録できる形にする。 */
  private safeId(prefix: string): string {
    const raw = this.deps.newRequestId().replace(/[^A-Za-z0-9._:-]/g, "-");
    return `${prefix}-${raw}`.slice(0, ID_MAX_LENGTH);
  }

  /**
   * 予期しない終了を記録する（1 トランザクション）: 終了、停止の要求と、停止の確認（作業ツリー配下にプロセスが残っていなければ
   * `confirmStopped` → stopped、残っている・調べられないなら `stopTimeout` → stopIncomplete。起動時の整合と同じ規則）、
   * 失敗の報告、受信箱の failure の項目（報告を `ref` で指す）。停止未完了のときは、受信箱に stopIncomplete の項目も出す。
   */
  private async recordExit(nodeId: string, cwd: string, rawReason: unknown): Promise<void> {
    const reason = sanitizeText(rawReason, LIMITS.reason);
    let pids: number[] | null = null;
    try {
      pids = await this.probeWithin(cwd, 5_000);
    } catch {
      pids = null;
    }
    const gone = pids !== null && pids.length === 0;
    const reportId = this.safeId("report");
    const stateEvent = (type: "stop" | "confirmStopped" | "stopTimeout"): EventBody => ({
      type: "node.stateChanged",
      payload: {
        nodeId,
        event: type === "stop" ? { type: "stop", mode: "immediate" } : { type },
      },
    });
    const bodies: EventBody[] = [
      { type: "node.exited", payload: { nodeId, reason } },
      stateEvent("stop"),
      stateEvent(gone ? "confirmStopped" : "stopTimeout"),
      { type: "report.added", payload: { reportId, nodeId, kind: "failure", text: reason } },
      {
        type: "inbox.added",
        payload: {
          id: this.safeId("inbox"),
          kind: "failure",
          nodeId,
          summary: sanitizeText(`子が予期せず終了した: ${reason}`, LIMITS.summary),
          ref: reportId,
        },
      },
    ];
    if (!gone) {
      bodies.push({
        type: "inbox.added",
        payload: {
          id: this.safeId("inbox"),
          kind: "stopIncomplete",
          nodeId,
          summary: sanitizeText(
            pids === null
              ? "子が予期せず終了した。作業ツリー配下のプロセスを調べられず、停止を確認できない"
              : `子が予期せず終了した。作業ツリー配下にプロセスが残っている（pid ${pids.join(", ")}）`,
            LIMITS.summary,
          ),
        },
      });
    }
    this.recordAll(bodies);
  }

  /** 複数のイベントを、1 トランザクションで記録する。失敗は、記録せずに握りつぶす（呼び出し側の処理は止めない）。 */
  private recordAll(bodies: readonly EventBody[]): Failure | undefined {
    try {
      const r = this.deps.sink.recordAll(
        bodies.map((body) => ({
          requestId: this.deps.newRequestId(),
          actor: { system: true } as const,
          body,
        })),
      );
      return r.ok ? undefined : r.error;
    } catch (e) {
      return failure("recordFailed", `記録に失敗: ${String(e)}`, "記録の口を確認する");
    }
  }

  /** 稼働中の子が、停止の要求なしに終了したら、通知して管理から外す。 */
  private watchFinished(nodeId: string, entry: NodeEntry): void {
    let finished: Promise<void>;
    try {
      finished = entry.session.finished();
    } catch {
      return;
    }
    void finished
      .then(
        () => "子が終了した",
        (e: unknown) => `子が異常終了した: ${String(e)}`,
      )
      .then(async (reason) => {
        if (this.nodes.get(nodeId) !== entry || entry.stopping) return;
        this.nodes.delete(nodeId);
        // 記録に失敗しても、通知と掃除は行う。理由は子の例外などの外部の値なので、記録できる形にする。
        await this.recordExit(nodeId, entry.cwd, reason);
        try {
          this.deps.onUnexpectedExit?.(nodeId, reason);
        } catch {
          // 通知の失敗で、掃除を止めない。
        }
      });
  }

  async stop(nodeId: string, request: StopRequest): Promise<Result<StopValue, Failure>> {
    const entry = this.nodes.get(nodeId);
    if (entry === undefined) {
      return fail(
        "unknownNode",
        `ノード ${String(nodeId)} は稼働していない`,
        "ノードの状態を確認する",
      );
    }
    const grace =
      isRec(request) && request.mode === "graceful"
        ? (request.graceMs ?? this.deps.defaultGraceMs ?? 60_000)
        : undefined;
    if (
      !isRec(request) ||
      (request.mode !== "graceful" && request.mode !== "immediate") ||
      !Number.isInteger(request.stopSeq) ||
      (request.stopSeq as number) < 1 ||
      (request.graceMs !== undefined &&
        (request.mode !== "graceful" || !isGraceMs(request.graceMs))) ||
      (request.mode === "graceful" && !isGraceMs(grace))
    ) {
      return fail(
        "invalidRequest",
        "停止の要求の形が不正",
        "mode（graceful か immediate）、stopSeq（正の整数）、graceMs（1 以上 3,600,000 以下の整数。穏当な停止のみ）を確認する",
      );
    }
    const running = entry.flow;
    if (running !== undefined) {
      // 進行中の停止を共有する。猶予中・検証中の即時停止の要求は、すぐ abort へ切り替える。
      if (request.mode === "immediate" && running.mode === "graceful") running.escalate();
      return running.promise;
    }
    entry.stopping = true;
    let wake!: () => void;
    const woken = new Promise<void>((r) => {
      wake = r;
    });
    const ctx: StopCtx = { escalated: false, phase: "act", warnings: [], wake, woken };
    const promise = this.runStop(nodeId, entry, request.mode, grace, request.stopSeq, ctx)
      .catch(
        (e: unknown): Result<StopValue, Failure> =>
          fail(
            "stopFailed",
            `停止の処理中に想定外の例外: ${String(e)}`,
            "ノードの状態とプロセスを確認する",
            "停止をもう一度要求する",
          ),
      )
      .finally(() => {
        entry.flow = undefined;
      });
    const escalate = (): void => {
      if (ctx.escalated) return;
      ctx.escalated = true;
      ctx.wake();
      if (ctx.phase === "verify") this.abortNow(entry.session, ctx);
    };
    entry.flow = { mode: request.mode, promise, escalate };
    return promise;
  }

  private async onPreToolUse(
    nodeId: string,
    state: { scope: Scope; violations: Set<string> },
    cwd: string,
    input: HookInput,
  ): Promise<HookOutcome> {
    try {
      if (!isRec(input) || typeof input.toolName !== "string") {
        return { allow: false, reason: "フックの入力が不正なため拒否した。" };
      }
      const d = this.deps;
      const scope = await resolveScope(state.scope, cwd, d.resolvePath);
      const decision = await decideToolUse(
        scope,
        cwd,
        input.toolName,
        input.toolInput,
        d.resolvePath,
      );
      if (decision.allow) return { allow: true };
      // 拒否した範囲違反も記録する（NFR_011）。記録に失敗しても拒否は変えない。
      // 未知のツールの拒否は範囲違反ではないので、scope.violation（受信箱に載る）にせず、node.toolDenied で記録する。
      if (decision.unknownTool !== undefined) {
        this.record({
          type: "node.toolDenied",
          payload: { nodeId, tool: sanitizeText(decision.unknownTool, LIMITS.tool) },
        });
      }
      if (decision.violation !== undefined) {
        this.recordViolation(nodeId, state, decision.violation.reason, decision.violation.subject);
      }
      return { allow: false, reason: decision.reason };
    } catch {
      return { allow: false, reason: "フックの判定に失敗したため拒否した。" };
    }
  }

  /** ノードごとの、受信箱に出す範囲違反の項目の上限（同じ違反は、1 度だけ）。 */
  private static readonly VIOLATION_INBOX_MAX = 20;

  /**
   * 範囲違反を記録する。違反の記録は、毎回残す。親の受信箱に出す項目（violation）は、同じ違反（種類と対象）につき
   * 1 度だけ、ノードごとに上限まで。出すときは、違反の記録と同じトランザクションで記録する（T10v）。
   */
  private recordViolation(
    nodeId: string,
    state: { violations: Set<string> },
    reason: ScopeViolationReason,
    subject: string,
  ): void {
    const violation: EventBody = { type: "scope.violation", payload: { nodeId, reason, subject } };
    const key = `${reason}\0${subject}`;
    if (
      state.violations.has(key) ||
      state.violations.size >= SdkRuntimeAdapter.VIOLATION_INBOX_MAX
    ) {
      this.record(violation);
      return;
    }
    const failed = this.recordAll([
      violation,
      {
        type: "inbox.added",
        payload: {
          id: this.safeId("inbox"),
          kind: "violation",
          nodeId,
          summary: sanitizeText(`範囲違反（${reason}）: ${subject}`, LIMITS.summary),
        },
      },
    ]);
    if (failed === undefined) state.violations.add(key);
  }

  private record(body: Parameters<EventSink["record"]>[0]["body"]): Failure | undefined {
    try {
      const r = this.deps.sink.record({
        requestId: this.deps.newRequestId(),
        actor: { system: true },
        body,
      });
      return r.ok ? undefined : r.error;
    } catch (e) {
      return failure("recordFailed", `記録口が例外: ${String(e)}`, "ログの状態を確認する");
    }
  }

  /** 操作を実行し、例外は警告にする。成功したら真。 */
  private attempt(label: string, ctx: StopCtx, fn: () => unknown): boolean {
    try {
      fn();
      return true;
    } catch (e) {
      ctx.warnings.push(`${label} が例外: ${String(e)}`);
      return false;
    }
  }

  private abortNow(session: AgentSession, ctx: StopCtx): void {
    this.attempt("abort", ctx, () => session.abort());
    ctx.outcome = "aborted";
  }

  /** `interrupt()` を、時間制限と即時停止の要求と競合させて待つ。 */
  private async interruptLimited(
    session: AgentSession,
    ctx: StopCtx,
  ): Promise<"ok" | "failed" | "timeout" | "escalate"> {
    let pending: Promise<void>;
    try {
      pending = Promise.resolve(session.interrupt());
    } catch (e) {
      ctx.warnings.push(`interrupt が例外: ${String(e)}`);
      return "failed";
    }
    const timer = this.deps.timers.after(this.deps.interruptTimeoutMs ?? 10_000);
    const winner = await Promise.race([
      pending.then(
        () => "ok" as const,
        (e: unknown) => {
          ctx.warnings.push(`interrupt が失敗: ${String(e)}`);
          return "failed" as const;
        },
      ),
      timer.promise.then(() => "timeout" as const),
      ctx.woken.then(() => "escalate" as const),
    ]);
    timer.cancel();
    if (winner === "timeout") ctx.warnings.push("interrupt が時間内に戻らなかった");
    return winner;
  }

  /** 作業ツリー配下のプロセスの一覧。例外・時間切れ（`maxMs`）は `null`（取得できない）。 */
  private async probeWithin(cwd: string, maxMs: number): Promise<number[] | null> {
    const d = this.deps;
    const timer = d.timers.after(Math.max(1, maxMs));
    try {
      const list = await Promise.race([
        d.probe(cwd).then((l) => ({ l })),
        timer.promise.then(() => undefined),
      ]);
      if (list === undefined || list.l === null) return null;
      return findRunningProcesses(cwd, list.l);
    } catch {
      return null;
    } finally {
      timer.cancel();
    }
  }

  private async runStop(
    nodeId: string,
    entry: NodeEntry,
    mode: "graceful" | "immediate",
    graceMs: number | undefined,
    stopSeq: number,
    ctx: StopCtx,
  ): Promise<Result<StopValue, Failure>> {
    const d = this.deps;
    const session = entry.session;
    let outcome: StopOutcome;

    if (mode === "immediate") {
      this.attempt("abort", ctx, () => session.abort());
      outcome = "aborted";
    } else {
      let result: Promise<"result"> | undefined;
      try {
        result = session.nextResult().then(
          () => "result" as const,
          () => "result" as const, // 子が終わって result が来ない。止まったものとして検証へ進む
        );
      } catch (e) {
        ctx.warnings.push(`nextResult が例外: ${String(e)}`);
      }
      const sent = this.attempt("send（停止指示）", ctx, () => session.send(STOP_MESSAGE));
      let winner: "result" | "timeout" | "escalate";
      if (result === undefined || !sent) {
        winner = "timeout"; // 停止指示を届けられない。猶予を待たず打ち切りへ
      } else {
        const timer = d.timers.after(graceMs as number);
        winner = await Promise.race([
          result,
          timer.promise.then(() => "timeout" as const),
          ctx.woken.then(() => "escalate" as const),
        ]);
        timer.cancel();
      }
      if (winner === "result") {
        this.attempt("close", ctx, () => session.close());
        outcome = "withinGrace";
      } else if (winner === "timeout") {
        const i = await this.interruptLimited(session, ctx);
        if (i === "ok") {
          this.attempt("close", ctx, () => session.close());
          outcome = "interrupted";
        } else {
          this.attempt("abort", ctx, () => session.abort());
          outcome = "aborted";
        }
      } else {
        this.attempt("abort", ctx, () => session.abort());
        outcome = "aborted";
      }
    }

    // 観測は停止要求の seq と、そのとき有効だった猶予（穏当な停止のみ）に結び付ける。実際に行った手段で記録する。
    // 記録に失敗しても、警告として検証を続ける（停止の確認を止めない）。
    const recorded = this.record({
      type: "node.stopObserved",
      payload: {
        nodeId,
        outcome,
        stopSeq,
        ...(mode === "graceful" && graceMs !== undefined ? { graceMs } : {}),
      },
    });
    if (recorded) ctx.warnings.push(`停止の観測を記録できなかった: ${recorded.cause}`);

    ctx.phase = "verify";
    if (ctx.escalated && ctx.outcome !== "aborted" && outcome !== "aborted")
      this.abortNow(session, ctx);
    const finalOutcome = (): StopOutcome => ctx.outcome ?? outcome;
    const warnings = (): { warnings?: readonly string[] } =>
      ctx.warnings.length > 0 ? { warnings: [...ctx.warnings] } : {};

    // 作業ツリー配下にプロセスがいないことを確認できるまで、停止とは扱わない。経過は実時間で数える。
    const timeoutMs = d.verifyTimeoutMs ?? 30_000;
    const intervalMs = d.verifyIntervalMs ?? 1000;
    const deadline = d.timers.now() + timeoutMs;
    let remaining: number[] = [];
    for (;;) {
      const pids = await this.probeWithin(entry.cwd, deadline - d.timers.now());
      remaining = pids ?? [];
      if (pids !== null && pids.length === 0) {
        const err = this.record({
          type: "node.stateChanged",
          payload: { nodeId, event: { type: "confirmStopped" } },
        });
        if (err)
          return fail(
            "recordFailed",
            `停止の確認を記録できなかった: ${err.cause}`,
            "ログの状態を確認する",
          );
        this.nodes.delete(nodeId);
        return ok({
          state: "stopped" as const,
          outcome: finalOutcome(),
          blockers: [],
          ...warnings(),
        });
      }
      const left = deadline - d.timers.now();
      if (left <= 0) break;
      await d.timers.sleep(Math.min(intervalMs, left));
    }
    const err = this.record({
      type: "node.stateChanged",
      payload: { nodeId, event: { type: "stopTimeout" } },
    });
    if (err)
      return fail(
        "recordFailed",
        `停止未完了を記録できなかった: ${err.cause}`,
        "ログの状態を確認する",
      );
    return ok({
      state: "stopIncomplete" as const,
      outcome: finalOutcome(),
      blockers: remaining,
      ...warnings(),
    });
  }
}
