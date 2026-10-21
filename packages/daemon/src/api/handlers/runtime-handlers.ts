/**
 * アダプタ（ランタイム）を伴う操作の実体: 追加指示（`node.send`）、停止（`node.stop`）、可能な操作の参照
 * （`node.capabilities`）。権限と部分木の判定は、認可（`authorize`）で済んでいる前提。
 * PRD: FR_009, FR_010, FR_034
 *
 * - `node.send`: 動作中（running・waiting）のノードの指示を、アダプタへ渡す。
 * - `node.stop`: 先に、停止要求（`stop`・停止未完了からは `retryStop`）をイベントログに記録し、そのイベントの `seq`
 *   （core の停止の試行）を `stopSeq` として、アダプタの 2 段階停止を始める。応答は要求を受け付けた時点（`stopping`）で返し、
 *   停止の進行（観測・確認・`stopTimeout`）は、アダプタがイベントログへ記録する。起動前（pending）の停止は、取り消し
 *   （`stopped`）でアダプタを呼ばない。停止の対象でない状態・アダプタがない動作中のノードは、何も書かずに失敗する。
 * - `node.capabilities`: ノードの状態（core の遷移表）と、アダプタの能力表から、統合ノードが取れる操作を導く。
 * 同じ requestId の再試行は、停止要求を重複して記録しない（冪等）。
 */

import {
  type DaemonOperation,
  type Failure,
  failure,
  type NodeEvent,
  type NodeRecord,
  type NodeState,
  type OperationMap,
  type OrchState,
  type Result,
  stateOf,
  transition,
} from "@cso/core";
import type { RuntimeAdapter, StopValue } from "../../sdk/runtime.js";
import type { HandlerRequest } from "../server.js";
import { appendAtomically, fail, type LogPort } from "./context.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

export interface RuntimeHandlerDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  /** ノードのランタイム（アダプタ）。なければ `undefined`。 */
  readonly adapterFor: (nodeId: string) => RuntimeAdapter | undefined;
  /** バックグラウンドの停止が終わったときの通知（結果の記録はアダプタが済ませている。ログ用）。 */
  readonly onStopSettled?: (nodeId: string, result: Result<StopValue, Failure>) => void;
}

const callerOf = (req: HandlerRequest): string => req.caller?.nodeId ?? "";
const nodeOf = (state: OrchState, nodeId: string): NodeRecord | undefined =>
  state.nodes.find((n) => n.id === nodeId);

const SENDABLE: ReadonlySet<NodeState> = new Set(["running", "waiting"]);

const noRuntime = (nodeId: string) =>
  fail(
    "noRuntime",
    `ノード ${nodeId} のランタイム（アダプタ）が見つからない`,
    "ノードの状態を確認する",
    "ノードを起動し直す",
  );

/** ノードの状態とアダプタの能力表から、統合ノードが取れる操作を導く。 */
export function operationsFor(
  node: NodeRecord,
  adapter: RuntimeAdapter | undefined,
): DaemonOperation[] {
  const ops: DaemonOperation[] = ["node.capabilities"];
  const s = node.state;
  if (
    SENDABLE.has(s) &&
    adapter !== undefined &&
    adapter.capabilities(node.id).send !== "unsupported"
  ) {
    ops.push("node.send");
  }
  const stoppable = s === "stopIncomplete" || transition(s, { type: "stop", mode: "immediate" }).ok;
  if (stoppable && s !== "stopped") ops.push("node.stop");
  if (s === "running") ops.push("node.split");
  if ((s === "running" || s === "waiting") && node.role === "integrator") ops.push("node.spawn");
  if (s === "done") ops.push("node.review");
  if (s === "verified" || s === "stopped") ops.push("node.reclaimPreview", "node.reclaim");
  return ops;
}

export function createRuntimeHandlers(deps: RuntimeHandlerDeps) {
  const { log, clock, adapterFor } = deps;

  return {
    "node.send": async (req: HandlerRequest<"node.send">): Promise<R<"node.send">> => {
      const { nodeId, text } = req.params;
      const state = stateOf(log.state(), nodeId);
      if (state === undefined) {
        return fail("notFound", "ノードが見つからない", "ID を確認する");
      }
      if (!SENDABLE.has(state)) {
        return fail(
          "notActive",
          `ノード ${nodeId} は ${state} で、指示を送れない（running・waiting のとき）`,
          "状態を確認する",
          "再開してから指示する",
        );
      }
      const adapter = adapterFor(nodeId);
      if (adapter === undefined) return noRuntime(nodeId);
      const r = await adapter.send(nodeId, text);
      return r.ok ? { ok: true, value: { delivered: true } } : r;
    },

    "node.stop": (req: HandlerRequest<"node.stop">): R<"node.stop"> => {
      const { nodeId, mode } = req.params;
      const before = log.state();
      const node = nodeOf(before, nodeId);
      if (node === undefined) return fail("notFound", "ノードが見つからない", "ID を確認する");
      // 停止未完了からの要求は、再試行（即時停止）として記録する。
      const event: NodeEvent =
        node.state === "stopIncomplete" ? { type: "retryStop" } : { type: "stop", mode };
      const t = transition(node.state, event);
      if (!t.ok)
        return { ok: false, error: failure(t.error.code, t.error.cause, ...t.error.nextActions) };
      const effect = t.value.effect;
      const adapter = adapterFor(nodeId);
      if (effect !== "cancelStart" && adapter === undefined) return noRuntime(nodeId);

      const r = appendAtomically(log, clock, req.requestId, { nodeId: callerOf(req) }, [
        { type: "node.stateChanged", payload: { nodeId, event } },
      ]);
      if (!r.ok) return r;
      const after = r.value.state;

      // 停止の進行はアダプタが行う。起動前の取り消し・進行中の穏当な停止の再送（効果なし）は、アダプタを呼ばない。
      if (adapter !== undefined && (effect === "gracefulStop" || effect === "immediateStop")) {
        const attempt = [...after.stopRequests].reverse().find((q) => q.nodeId === nodeId);
        if (attempt !== undefined) {
          const adapterMode = effect === "immediateStop" ? "immediate" : "graceful";
          void adapter
            .stop(nodeId, {
              mode: adapterMode,
              stopSeq: attempt.seq,
              ...(adapterMode === "graceful" && attempt.graceMs !== undefined
                ? { graceMs: attempt.graceMs }
                : {}),
            })
            .then(
              (result) => deps.onStopSettled?.(nodeId, result),
              (error: unknown) =>
                deps.onStopSettled?.(nodeId, {
                  ok: false,
                  error: failure(
                    "stopFailed",
                    `停止の処理が例外: ${String(error)}`,
                    "ノードの状態を確認する",
                  ),
                }),
            );
        }
      }
      return { ok: true, value: { state: stateOf(after, nodeId) as NodeState } };
    },

    "node.capabilities": (req: HandlerRequest<"node.capabilities">): R<"node.capabilities"> => {
      const node = nodeOf(log.state(), req.params.nodeId);
      if (node === undefined) return fail("notFound", "ノードが見つからない", "ID を確認する");
      return { ok: true, value: { operations: operationsFor(node, adapterFor(node.id)) } };
    },
  };
}
