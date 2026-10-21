/**
 * 判断待ちの間に子を止める（`decision.present` の `pauseNodeIds`）と、回答での再開（`decision.answer`）。
 * 状態ハンドラ（`createStateHandlers`。`allowPause: true`）の `decision.present`・`decision.answer` を包む。
 * PRD: FR_018
 *
 * - 止める: 判断要求を記録したあと、各対象を `node.stop`（穏当）で止める。止める操作の失敗は、判断要求の記録を妨げない
 *   （`onFailure` に記録）。起動前（pending）・動作中・待機中の子だけを対象にできる（終わった子・止まった子を指定したら、
 *   何も記録せずに失敗させる。回答のときに、意図しない子を再開しないため）。
 * - 再開: 回答が確定したあと（採用済みの回答と同じ内容の再送を含む）、対象のうち停止済み（stopped）の子を再開する
 *   （`restart` を記録し、動作中になったら、作業ツリー・範囲・回答を渡して `adapter.start`）。停止の途中（stopping・
 *   stopIncomplete）の子はまだ再開できないので、回答は記録済みのまま `resumePending` で失敗させる。同じ回答を再送すると、
 *   再開をやり直す（冪等。起動済みの子を二重に起動しない）。起動に失敗したら、トークンを失効して停止済みに戻し、失敗を返す。
 * - 判断待ちの間に人間が止めた子も、回答で再開される（止めた主体は区別しない）。
 */

import { effectiveScope, type Failure, type OperationMap, type Result, stateOf } from "@cso/core";
import type { RuntimeAdapter } from "../../sdk/runtime.js";
import type { CredentialStore } from "../credentials.js";
import type { HandlerRequest } from "../server.js";
import { alreadyApplied, appendAtomically, fail, type LogPort } from "./context.js";

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

const PAUSABLE = new Set(["pending", "running", "waiting"]);

export function createPauseHandlers(deps: PauseHandlerDeps) {
  const { log, ports, credentials } = deps;
  const note = (nodeId: string, cause: string): void => {
    try {
      deps.onFailure?.(nodeId, cause);
    } catch {
      // 記録先の失敗は、処理を止めない
    }
  };

  /** 再開 1 件。成功したら undefined、失敗なら原因（応答に出す短い説明）。 */
  async function resumeOne(
    decision: { decisionId: string; nodeId: string },
    target: string,
    answer: string,
  ): Promise<string | undefined> {
    const actor = { nodeId: decision.nodeId };
    const before = log.state();
    const now = stateOf(before, target);
    if (now === "stopping" || now === "stopIncomplete") return `${target}（停止の途中）`;
    if (now !== "stopped") return undefined; // 動作中・終了済みなど。再開するものがない
    // 停止の試行ごとに別の番号にする（起動の失敗で止め直した後の再試行が、重複として無視されないように）。
    const episode = before.stopRequests.filter((q) => q.nodeId === target).length;
    const cwd = await ports.cwdOf(target).catch(() => undefined);
    const scope = effectiveScope(before, target);
    const adapter = deps.adapterFor(target);
    if (cwd === undefined || scope === undefined || adapter === undefined) {
      return `${target}（作業ツリー・範囲・ランタイムを確認できない）`;
    }
    const restartId = `resume-${decision.decisionId}-${target}-${episode}`;
    const already = alreadyApplied(before, actor, restartId);
    const restarted = appendAtomically(
      log,
      deps.clock,
      `resume-${decision.decisionId}-${target}-${episode}`,
      actor,
      [
        {
          type: "node.stateChanged",
          payload: { nodeId: target, event: { type: "restart", dependenciesDone: true } },
        },
      ],
    );
    if (!restarted.ok) {
      note(target, `再開を記録できない: ${restarted.error.code}: ${restarted.error.cause}`);
      return `${target}（再開を記録できない）`;
    }
    if (already) return undefined; // 記録済み（起動済み）。二重に起動しない
    if (stateOf(restarted.value.state, target) !== "running") return undefined; // 依存待ち（pending）。起動は別
    const abort = (cause: string): string => {
      note(target, cause);
      try {
        credentials.revokeNode(target);
      } catch (e) {
        note(target, `トークンを失効できない: ${String(e)}`);
      }
      const back = appendAtomically(
        log,
        deps.clock,
        `resume-${decision.decisionId}-${target}-${episode}-cleanup`,
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
      return `${target}（起動できなかった）`;
    };
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
        instruction: `判断が出ました。回答: ${answer}\n作業を再開してください。`,
        mcp: { url: ports.mcpUrl, token },
      });
      if (!started.ok) return abort(`起動に失敗: ${started.error.code}: ${started.error.cause}`);
    } catch (e) {
      return abort(`起動が例外: ${String(e)}`);
    }
    return undefined;
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
            `ノード ${t} は ${st} で、一時停止の対象にできない（pending・running・waiting のとき）`,
            "止める対象から外す",
          );
        }
      }
      const r = await deps.present(req);
      if (!r.ok) return r;
      for (const t of targets) {
        if (!PAUSABLE.has(stateOf(log.state(), t) ?? "")) continue; // 再送で、すでに止めている
        const stopped = await deps.stop({
          requestId: `pause-${r.value.decisionId}-${t}`,
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
      const targets = d?.pauseNodeIds ?? [];
      if (d === undefined || targets.length === 0) return r;
      const answer = d.answer ?? params.choice ?? params.text ?? "";
      const failed: string[] = [];
      for (const t of targets) {
        const why = await resumeOne(d, t, answer);
        if (why !== undefined) failed.push(why);
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
