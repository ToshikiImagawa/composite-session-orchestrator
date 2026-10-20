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
 * - 停止後は、作業ツリー配下のプロセスがいないことを確認できるまで、停止とは扱わない。一定の間隔で確認し、
 *   所定の時間（既定 30 秒）を超えても残っていれば `stopTimeout` を記録して停止未完了を返す。
 *   再試行（`retryStop` の後の即時停止）は、同じ手順をもう一度実行する。自動では再試行しない。
 */

import {
  type Failure,
  failure,
  findRunningProcesses,
  ok,
  type Result,
  type StopOutcome,
} from "@cso/core";
import type {
  AgentLauncher,
  AgentSession,
  HookInput,
  HookOutcome,
  McpServerConfig,
} from "./agent.js";
import { childEnv } from "./child-env.js";
import { decideToolUse } from "./hook-policy.js";
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
  readonly sink: EventSink;
  readonly timers: Timers;
  readonly newRequestId: () => string;
  /** 子の環境の元になる親の環境変数。 */
  readonly parentEnv: Readonly<Record<string, string | undefined>>;
  /** 穏当な停止の猶予の既定値（ミリ秒）。既定 60000。 */
  readonly defaultGraceMs?: number;
  /** 停止後のプロセス確認を続ける時間（ミリ秒）。既定 30000。 */
  readonly verifyTimeoutMs?: number;
  /** 停止後のプロセス確認の間隔（ミリ秒）。既定 1000。 */
  readonly verifyIntervalMs?: number;
  /** 起動（init）を待つ時間（ミリ秒）。既定 30000。 */
  readonly startTimeoutMs?: number;
}

const STOP_MESSAGE =
  "停止の要求です。区切りのよいところで、これまでの成果を保存して（書き込み済みの成果は残す）、作業を止めてください。";

interface StopFlow {
  readonly mode: "graceful" | "immediate";
  readonly promise: Promise<Result<StopValue, Failure>>;
  /** 穏当な停止の猶予中に、即時停止へ切り替える。 */
  escalate(): void;
}

interface NodeEntry {
  readonly session: AgentSession;
  readonly cwd: string;
  flow?: StopFlow | undefined;
}

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const isPositive = (x: unknown): x is number =>
  typeof x === "number" && Number.isFinite(x) && x > 0;

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
      const { env, removed } = childEnv(d.parentEnv);
      const scope = request.scope;
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
          hooks: { preToolUse: (input) => this.onPreToolUse(nodeId, scope, cwd, input) },
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
        session.abort();
        return fail(
          "startFailed",
          winner.kind === "timeout"
            ? "子の起動（init）が時間内に完了しなかった"
            : `子の起動に失敗: ${String(winner.e)}`,
          "認証と環境を確認する",
          "もう一度起動する",
        );
      }
      this.nodes.set(nodeId, { session, cwd });
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
    entry.session.send(text);
    return ok({ status: "queued" as const });
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
    if (
      !isRec(request) ||
      (request.mode !== "graceful" && request.mode !== "immediate") ||
      (request.graceMs !== undefined && !isPositive(request.graceMs))
    ) {
      return fail(
        "invalidRequest",
        "停止の要求の形が不正",
        "mode（graceful か immediate）と graceMs（正の数）を確認する",
      );
    }
    const running = entry.flow;
    if (running !== undefined) {
      // 進行中の停止を共有する。猶予中の即時停止の要求は、すぐ打ち切りへ切り替える。
      if (request.mode === "immediate" && running.mode === "graceful") running.escalate();
      return running.promise;
    }
    let escalate!: () => void;
    const escalated = new Promise<void>((r) => {
      escalate = r;
    });
    const promise = this.runStop(nodeId, entry, request.mode, request.graceMs, escalated).finally(
      () => {
        entry.flow = undefined;
      },
    );
    entry.flow = { mode: request.mode, promise, escalate };
    return promise;
  }

  private async onPreToolUse(
    nodeId: string,
    scope: StartRequest["scope"],
    cwd: string,
    input: HookInput,
  ): Promise<HookOutcome> {
    try {
      if (!isRec(input) || typeof input.toolName !== "string") {
        return { allow: false, reason: "フックの入力が不正なため拒否した。" };
      }
      const decision = decideToolUse(scope, cwd, input.toolName, input.toolInput);
      if (decision.allow) return { allow: true };
      // 拒否した操作も、範囲違反として記録する（NFR_011）。記録に失敗しても拒否は変えない。
      this.deps.sink.record({
        requestId: this.deps.newRequestId(),
        actor: { system: true },
        body: {
          type: "scope.violation",
          payload: {
            nodeId,
            reason: decision.violation.reason,
            subject: decision.violation.subject,
          },
        },
      });
      return { allow: false, reason: decision.reason };
    } catch {
      return { allow: false, reason: "フックの判定に失敗したため拒否した。" };
    }
  }

  private record(body: Parameters<EventSink["record"]>[0]["body"]): Failure | undefined {
    const r = this.deps.sink.record({
      requestId: this.deps.newRequestId(),
      actor: { system: true },
      body,
    });
    return r.ok ? undefined : r.error;
  }

  private async runStop(
    nodeId: string,
    entry: NodeEntry,
    mode: "graceful" | "immediate",
    graceMs: number | undefined,
    escalated: Promise<void>,
  ): Promise<Result<StopValue, Failure>> {
    const d = this.deps;
    const session = entry.session;
    let outcome: StopOutcome;

    if (mode === "immediate") {
      session.abort();
      outcome = "aborted";
    } else {
      const result = session.nextResult();
      session.send(STOP_MESSAGE);
      const timer = d.timers.after(graceMs ?? d.defaultGraceMs ?? 60_000);
      const winner = await Promise.race([
        result.then(() => "result" as const),
        timer.promise.then(() => "timeout" as const),
        escalated.then(() => "escalate" as const),
      ]);
      timer.cancel();
      if (winner === "result") {
        session.close();
        outcome = "withinGrace";
      } else if (winner === "timeout") {
        await session.interrupt();
        session.close();
        outcome = "interrupted";
      } else {
        session.abort();
        outcome = "aborted";
      }
    }

    const recorded = this.record({ type: "node.stopObserved", payload: { nodeId, outcome } });
    if (recorded)
      return fail(
        "recordFailed",
        `停止の観測を記録できなかった: ${recorded.cause}`,
        "ログの状態を確認する",
        "停止をもう一度要求する",
      );

    // 作業ツリー配下にプロセスがいないことを確認できるまで、停止とは扱わない。
    const timeoutMs = d.verifyTimeoutMs ?? 30_000;
    const intervalMs = d.verifyIntervalMs ?? 1000;
    let elapsed = 0;
    let remaining: number[] = [];
    for (;;) {
      let pids: number[] | null;
      try {
        const list = await d.probe(entry.cwd);
        pids = list === null ? null : findRunningProcesses(entry.cwd, list);
      } catch {
        pids = null;
      }
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
        return ok({ state: "stopped" as const, outcome, blockers: [] });
      }
      if (elapsed >= timeoutMs) break;
      await d.timers.sleep(intervalMs);
      elapsed += intervalMs;
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
    return ok({ state: "stopIncomplete" as const, outcome, blockers: remaining });
  }
}
