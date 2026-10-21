/**
 * 判断待ちの間に子を止める（`decision.present` の `pauseNodeIds`）と、回答での再開（`decision.answer`）。
 * 状態ハンドラ（`createStateHandlers`。`allowPause: true`）の `decision.present`・`decision.answer` を包む。
 * PRD: FR_018
 *
 * - 止める: 判断要求を記録したあと、各対象を `node.stop`（穏当。requestId は判断と対象から決める）で止める。止める操作の
 *   失敗は、判断要求の記録を妨げない（`onFailure` に記録）。動作中・待機中の子だけを対象にできる（終わった子・止まった子・
 *   依存待ち〔pending〕の子を指定したら、何も記録せずに失敗させる）。
 * - 再開: 回答が確定したあと（採用済みの回答と同じ内容の再送を含む）、対象のうち停止済み（stopped）で、**停止の要求が
 *   すべてこの判断が出したもの**（一時停止・再開の失敗の後始末）の子だけを再開する。人間などが止めた子は、再開せずに、
 *   判断を出した統合ノードの受信箱に載せる。再開は、トークンを発行して `adapter.start`（ブリーフと回答を渡す）に成功してから、
 *   `restart` を記録する。停止の途中（stopping・stopIncomplete）の子はまだ再開できないので、回答は記録済みのまま
 *   `resumePending` で失敗させ、同じ回答の再送で再開をやり直す。同じ判断・同じ子の再開は、同時に 1 つだけ走らせる。
 *   起動に失敗したら、トークンを失効して失敗を返す（失効に失敗したら、応答に警告を含める）。
 */

import {
  COMPLETED_STATES,
  effectiveScope,
  type Failure,
  type OperationMap,
  type OrchState,
  type Result,
  type Scope,
  stateOf,
} from "@cso/core";
import type { RuntimeAdapter } from "../../sdk/runtime.js";
import type { CredentialStore } from "../credentials.js";
import type { HandlerRequest } from "../server.js";
import {
  alreadyApplied,
  appendAtomically,
  derivedRequestId,
  deriveId,
  fail,
  type LogPort,
  summarize,
} from "./context.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;
type Async<Op extends keyof OperationMap> = R<Op> | Promise<R<Op>>;

export interface PauseHandlerDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  /** 包む対象（`allowPause: true` の状態ハンドラ）。 */
  readonly present: (req: HandlerRequest<"decision.present">) => Async<"decision.present">;
  readonly answer: (req: HandlerRequest<"decision.answer">) => Async<"decision.answer">;
  /** 止める操作（`node.stop` のハンドラ）。 */
  readonly stop: (req: HandlerRequest<"node.stop">) => Async<"node.stop">;
  readonly adapterFor: (nodeId: string) => RuntimeAdapter | undefined;
  readonly ports: {
    /** ノードの作業ツリー（実パス）。アダプタ側を正とする。取得できなければ `undefined`。 */
    cwdOf(nodeId: string): Promise<string | undefined>;
    /** 子に渡す MCP の接続先。 */
    readonly mcpUrl: string;
  };
  readonly credentials: Pick<CredentialStore, "issueNodeToken" | "revokeNode">;
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

const PAUSABLE = new Set(["running", "waiting"]);

const dependenciesDone = (state: OrchState, dependsOn: readonly string[]): boolean =>
  dependsOn.every((d) => COMPLETED_STATES.has(stateOf(state, d) ?? "pending"));

/** 再開した子への指示: ブリーフ（目的・受け入れ基準・範囲）と、判断の回答。 */
function instructionAfterAnswer(
  nodeId: string,
  state: OrchState,
  scope: Scope,
  answer: string,
): string {
  const n = state.nodes.find((x) => x.id === nodeId);
  return [
    `判断が出ました。回答: ${answer}`,
    "作業を再開してください。",
    ...(n?.objective === undefined ? [] : [`目的: ${n.objective}`]),
    ...(n?.acceptanceCriteria === undefined
      ? []
      : ["受け入れ基準:", ...n.acceptanceCriteria.map((c) => `- ${c}`)]),
    "範囲:",
    `- 書き込み可能な場所: ${scope.writableLocations.join("、") || "なし"}`,
    `- 禁止する場所: ${scope.forbiddenLocations.join("、") || "なし"}`,
    `- 許可するコマンド: ${scope.allowedCommands.join("、") || "なし"}`,
  ].join("\n");
}

export function createPauseHandlers(deps: PauseHandlerDeps) {
  const { log, ports, credentials } = deps;
  const note = (nodeId: string, cause: string): void => {
    try {
      deps.onFailure?.(nodeId, cause);
    } catch {
      // 記録先の失敗は、処理を止めない
    }
  };

  const pauseRequestId = (decisionId: string, target: string): string =>
    `pause-${decisionId}-${target}`;
  const cleanupRequestId = (decisionId: string, target: string, episode: number): string =>
    `resume-${decisionId}-${target}-${episode}-cleanup`;

  /**
   * 判断による一時停止だけが、停止の最後の要求か。判断の要求より後の、このノードの停止要求（停止・再試行）が、
   * すべてこの判断が出したもの（一時停止、または再開の失敗の後始末）なら true。人間などが止めた子は false。
   */
  function pausedOnlyByDecision(
    state: OrchState,
    decision: { decisionId: string; nodeId: string },
    target: string,
  ): boolean {
    const actor = { nodeId: decision.nodeId };
    const mine = (requestId: string) =>
      Object.hasOwn(state.requests, derivedRequestId(actor, requestId, 0));
    // 一時停止（この判断が出した）か、判断を待っていた子が、再起動の整合で停止済みにされたもの（システムの記録）。
    const reconciled =
      target === decision.nodeId &&
      Object.hasOwn(
        state.requests,
        derivedRequestId({ system: true }, `reconcile-wait-${decision.decisionId}`, 0),
      );
    if (!mine(pauseRequestId(decision.decisionId, target)) && !reconciled) return false;
    const since =
      state.inbox.find((i) => i.kind === "decision" && i.ref === decision.decisionId)?.seq ?? 0;
    const stops = state.stopRequests.filter((q) => q.nodeId === target && q.seq > since).length;
    let own = 1;
    for (let k = 0; k <= stops; k++)
      if (mine(cleanupRequestId(decision.decisionId, target, k))) own++;
    return stops === own;
  }

  /** 同じ判断・同じ子の再開を、同時に 1 つだけ走らせる（同じ Promise を共有する）。 */
  const resuming = new Map<string, Promise<ResumeOutcome>>();

  interface ResumeOutcome {
    readonly kind: "resumed" | "skipped" | "notStopped" | "failed";
    /** 失敗の短い説明、または警告。 */
    readonly message?: string;
  }

  /** 再開 1 件。 */
  function resumeOne(
    decision: { decisionId: string; nodeId: string },
    target: string,
    answer: string,
  ): Promise<ResumeOutcome> {
    const key = `${decision.decisionId}\0${target}`;
    const running = resuming.get(key);
    if (running !== undefined) return running;
    const promise = resumeExclusive(decision, target, answer).finally(() => resuming.delete(key));
    resuming.set(key, promise);
    return promise;
  }

  async function resumeExclusive(
    decision: { decisionId: string; nodeId: string },
    target: string,
    answer: string,
  ): Promise<ResumeOutcome> {
    const actor = { nodeId: decision.nodeId };
    const before = log.state();
    const node = before.nodes.find((n) => n.id === target);
    const now = node?.state;
    if (now === "stopping" || now === "stopIncomplete") {
      return { kind: "failed", message: `${target}（停止の途中）` };
    }
    if (node === undefined || now !== "stopped") return { kind: "notStopped" }; // 動作中・終了済みなど
    if (node.discarded !== undefined) return { kind: "skipped" }; // 破棄の判断（人間）を経た子は、再開しない
    if (!pausedOnlyByDecision(before, decision, target)) return { kind: "skipped" }; // 人間などが止めた子
    const episode = before.stopRequests.filter((q) => q.nodeId === target).length;
    const cwd = await ports.cwdOf(target).catch(() => undefined);
    const scope = effectiveScope(before, target);
    const adapter = deps.adapterFor(target);
    if (cwd === undefined || scope === undefined || adapter === undefined) {
      return { kind: "failed", message: `${target}（作業ツリー・範囲・ランタイムを確認できない）` };
    }
    const warnings: string[] = [];
    const abort = (cause: string): ResumeOutcome => {
      note(target, cause);
      try {
        credentials.revokeNode(target);
      } catch (e) {
        note(target, `トークンを失効できない: ${String(e)}`);
        warnings.push(`${target} のトークンを失効できなかった（要確認）`);
      }
      if (stateOf(log.state(), target) === "running") {
        const back = appendAtomically(
          log,
          deps.clock,
          cleanupRequestId(decision.decisionId, target, episode),
          actor,
          [
            {
              type: "node.stateChanged",
              payload: { nodeId: target, event: { type: "stop", mode: "immediate" } },
            },
            {
              type: "node.stateChanged",
              payload: { nodeId: target, event: { type: "confirmStopped" } },
            },
          ],
        );
        if (!back.ok) note(target, `停止を記録できない: ${back.error.code}: ${back.error.cause}`);
      }
      return { kind: "failed", message: [`${target}（起動できなかった）`, ...warnings].join("。") };
    };
    // 起動してから、再開を記録する（起動の失敗で、動作中なのにプロセスがない状態を作らない）。
    let token: string;
    try {
      token = credentials.issueNodeToken(target, "child");
    } catch (e) {
      return abort(`トークンを発行できない: ${String(e)}`);
    }
    try {
      const started = await adapter.start({
        nodeId: target,
        worktreePath: cwd,
        scope,
        instruction: instructionAfterAnswer(node.id, before, scope, answer),
        mcp: { url: ports.mcpUrl, token },
      });
      if (!started.ok) return abort(`起動に失敗: ${started.error.code}: ${started.error.cause}`);
    } catch (e) {
      return abort(`起動が例外: ${String(e)}`);
    }
    const restarted = appendAtomically(
      log,
      deps.clock,
      `resume-${decision.decisionId}-${target}-${episode}`,
      actor,
      [
        {
          type: "node.stateChanged",
          payload: {
            nodeId: target,
            event: { type: "restart", dependenciesDone: dependenciesDone(before, node.dependsOn) },
          },
        },
      ],
    );
    if (!restarted.ok) {
      note(target, `再開を記録できない: ${restarted.error.code}: ${restarted.error.cause}`);
      try {
        await adapter.stop(target, { mode: "immediate", stopSeq: log.state().lastSeq });
      } catch (e) {
        note(target, `起動した子を止められない: ${String(e)}`);
      }
      return abort("再開を記録できない");
    }
    return { kind: "resumed" };
  }

  return {
    "decision.present": async (
      req: HandlerRequest<"decision.present">,
    ): Promise<R<"decision.present">> => {
      const targets = req.params.pauseNodeIds ?? [];
      const caller = req.caller?.nodeId ?? "";
      const state = log.state();
      // 再送のときは、すでに止めた子を拒否しない（止める操作をやり直すだけ）。
      const retry = alreadyApplied(state, { nodeId: caller }, req.requestId);
      for (const t of targets) {
        const st = stateOf(state, t);
        if (!retry && st !== undefined && !PAUSABLE.has(st)) {
          return fail(
            "notActive",
            `ノード ${t} は ${st} で、一時停止の対象にできない（running・waiting のとき）`,
            "止める対象から外す",
          );
        }
      }
      const r = await deps.present(req);
      if (!r.ok) return r;
      for (const t of targets) {
        if (!PAUSABLE.has(stateOf(log.state(), t) ?? "")) continue; // 再送で、すでに止めている
        const stopped = await deps.stop({
          requestId: pauseRequestId(r.value.decisionId, t),
          operation: "node.stop",
          role: "integrator",
          caller: { nodeId: caller },
          params: { nodeId: t, mode: "graceful" },
        });
        if (!stopped.ok) note(t, `一時停止できない: ${stopped.error.code}: ${stopped.error.cause}`);
      }
      return r;
    },

    "decision.answer": async (
      req: HandlerRequest<"decision.answer">,
    ): Promise<R<"decision.answer">> => {
      const r = await deps.answer(req);
      if (!r.ok) return r;
      const params = req.params as { decisionId: string; choice?: string; text?: string };
      const d = log.state().decisions.find((x) => x.decisionId === params.decisionId);
      // 止めた子に加えて、判断を出した子自身も対象にする（再起動の整合で、待ちの途中に停止済みにされたかもしれない）。
      const targets = d === undefined ? [] : [...new Set([...(d.pauseNodeIds ?? []), d.nodeId])];
      if (d === undefined || targets.length === 0) return r;
      const answer = d.answer ?? params.choice ?? params.text ?? "";
      const failed: string[] = [];
      const skipped: string[] = [];
      for (const t of targets) {
        const o = await resumeOne(d, t, answer);
        if (o.kind === "failed") failed.push(o.message ?? t);
        else if (o.kind === "skipped") skipped.push(t);
      }
      // 再開しなかった子（人間などが止めた子）は、判断を出した統合ノードの受信箱に載せる。
      if (skipped.length > 0) {
        const listed = appendAtomically(
          log,
          deps.clock,
          `resume-${d.decisionId}-skipped`,
          { nodeId: d.nodeId },
          [
            {
              type: "inbox.added",
              payload: {
                id: deriveId("inbox", d.nodeId, d.decisionId, "resume-skipped"),
                kind: "info",
                nodeId: d.nodeId,
                summary: summarize(
                  `判断 ${d.decisionId} の回答で、再開しなかった子（人間などが止めたため）: ${skipped.join("、")}`,
                ),
              },
            },
          ],
        );
        if (!listed.ok) note(d.nodeId, `再開しなかった子を記録できない: ${listed.error.code}`);
      }
      if (failed.length === 0) return r;
      return fail(
        "resumePending",
        `回答は記録した。再開できなかった子: ${failed.join("、")}`,
        "少し待って、同じ回答をもう一度送ると、再開をやり直す",
      );
    },
  };
}
