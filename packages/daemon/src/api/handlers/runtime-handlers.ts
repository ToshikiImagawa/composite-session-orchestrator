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
  type EventBody,
  type Failure,
  failure,
  isDirectChild,
  isInSubtree,
  isStrictDescendant,
  type NodeEvent,
  type NodeRecord,
  type NodeState,
  type OperationMap,
  type OrchState,
  type Result,
  SUBTREE_RULES,
  type SubtreeOperation,
  type SubtreeRule,
  stateOf,
  transition,
} from "@cso/core";
import type { RuntimeAdapter, StopValue } from "../../sdk/runtime.js";
import type { HandlerRequest } from "../server.js";
import { appendAtomically, deriveId, fail, type LogPort, summarize } from "./context.js";

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

const ruleHolds = (
  rule: SubtreeRule,
  nodes: OrchState["nodes"],
  caller: string,
  target: string,
): boolean =>
  rule === "strictDescendant"
    ? isStrictDescendant(nodes, caller, target)
    : rule === "directChild"
      ? isDirectChild(nodes, caller, target)
      : isInSubtree(nodes, caller, target);

/**
 * ノードについて、呼び出した統合ノード（`caller`）が取れる操作を導く（FR_034）。次の 3 つで絞る:
 * (1) ノードの状態（core の遷移表）、(2) アダプタの能力表（アダプタがなければ、指示・停止・切り出し・子の生成は出さない。
 * 停止は、穏当か即時のどちらかが可能なときだけ。指示は `send` が unsupported でないときだけ）、
 * (3) 呼び出し元との関係（`SUBTREE_RULES`。例: 完了の判定は直接の親だけ、自分自身には何もない）。
 * `node.reclaimPreview`・`node.reclaim` は、回収の入口に立てる状態（verified・stopped）で出す。実際に回収できるかは、
 * `node.reclaimPreview` の判定（回収可能判定。条件 1〜6）で決まる。停止未完了（stopIncomplete）からの `node.stop` は、
 * 再試行（`retryStop`＝即時停止）として扱う。
 */
export function operationsFor(
  node: NodeRecord,
  adapter: RuntimeAdapter | undefined,
  caller: string,
  nodes: OrchState["nodes"],
): DaemonOperation[] {
  const s = node.state;
  const caps = adapter?.capabilities(node.id);
  const candidates: DaemonOperation[] = ["node.capabilities"];
  if (caps !== undefined) {
    if (SENDABLE.has(s) && caps.send !== "unsupported") candidates.push("node.send");
    const canStop = caps.stopGraceful || caps.stopImmediate;
    if (
      canStop &&
      (s === "stopIncomplete" ||
        (s !== "stopped" && transition(s, { type: "stop", mode: "immediate" }).ok))
    ) {
      candidates.push("node.stop");
    }
    if (s === "running") candidates.push("node.split");
    if ((s === "running" || s === "waiting") && node.role === "integrator")
      candidates.push("node.spawn");
  }
  if (s === "done") candidates.push("node.review");
  if (s === "verified" || s === "stopped") candidates.push("node.reclaimPreview", "node.reclaim");
  return candidates.filter((op) => {
    const rule = SUBTREE_RULES[op as SubtreeOperation];
    // node.spawn は、親にするノード（この node）が、自分か子孫のときに作れる。
    return rule === undefined || ruleHolds(rule, nodes, caller, node.id);
  });
}

export function createRuntimeHandlers(deps: RuntimeHandlerDeps) {
  const { log, clock, adapterFor } = deps;

  /** 認可（`SUBTREE_RULES`）の二重の備え: 対象は、呼び出した統合ノードの、自分を含まない子孫だけ。 */
  const outsideSubtree = (caller: string, nodeId: string) =>
    isStrictDescendant(log.state().nodes, caller, nodeId)
      ? undefined
      : fail(
          "forbidden",
          "対象のノードが、自分の部分木の規則（自分を含まない子孫）を満たさない",
          "親（統合ノード）に依頼する",
        );

  /**
   * 停止の結果を、イベントログへ反映する（アダプタが記録しない分）。停止の試行（`stopSeq`）ごとに 1 回（冪等）。
   * - 停止を確認した（stopped）: 受信箱に info。
   * - 停止未完了（stopIncomplete。残っているプロセスの pid つき）: 受信箱に stopIncomplete。
   * - アダプタの失敗: まだ stopping なら、`stopTimeout` を記録して stopIncomplete にし、受信箱に stopIncomplete。
   */
  const settle = (nodeId: string, stopSeq: number, result: Result<StopValue, Failure>): void => {
    const bodies: EventBody[] = [];
    const inbox = (kind: "info" | "stopIncomplete", text: string): EventBody => ({
      type: "inbox.added",
      payload: {
        id: deriveId("inbox", "system", `stop-${stopSeq}`, "settled"),
        kind,
        nodeId,
        summary: summarize(text),
      },
    });
    if (result.ok && result.value.state === "stopped") {
      bodies.push(inbox("info", `停止を確認した（${result.value.outcome}）`));
    } else if (result.ok) {
      bodies.push(
        inbox(
          "stopIncomplete",
          `停止未完了: 残っているプロセス pid ${result.value.blockers.join(", ") || "不明"}`,
        ),
      );
    } else {
      if (stateOf(log.state(), nodeId) === "stopping") {
        bodies.push({
          type: "node.stateChanged",
          payload: { nodeId, event: { type: "stopTimeout" } },
        });
      }
      bodies.push(inbox("stopIncomplete", `停止に失敗: ${result.error.cause}`));
    }
    appendAtomically(log, clock, `stop-settled-${stopSeq}`, { system: true }, bodies);
  };

  /** 停止の結果の通知。どこで例外が出ても、unhandledRejection にしない。 */
  const notifySettled = (
    nodeId: string,
    stopSeq: number,
    result: Result<StopValue, Failure>,
  ): void => {
    try {
      settle(nodeId, stopSeq, result);
    } catch {
      // 反映に失敗しても、次の停止要求（再試行）で整合を取れる。
    }
    try {
      deps.onStopSettled?.(nodeId, result);
    } catch {
      // 通知の失敗で、停止の処理を止めない。
    }
  };

  return {
    "node.send": async (req: HandlerRequest<"node.send">): Promise<R<"node.send">> => {
      const { nodeId, text } = req.params;
      const outside = outsideSubtree(callerOf(req), nodeId);
      if (outside) return outside;
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
      return r.ok ? { ok: true, value: { status: "queued", duplicate: false } } : r;
    },

    "node.stop": (req: HandlerRequest<"node.stop">): R<"node.stop"> => {
      const { nodeId, mode } = req.params;
      const outside = outsideSubtree(callerOf(req), nodeId);
      if (outside) return outside;
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
              (result) => notifySettled(nodeId, attempt.seq, result),
              (error: unknown) =>
                notifySettled(
                  nodeId,
                  attempt.seq,
                  fail(
                    "stopFailed",
                    `停止の処理が例外: ${String(error)}`,
                    "ノードの状態を確認する",
                  ),
                ),
            )
            .catch(() => undefined);
        }
      }
      return { ok: true, value: { state: stateOf(after, nodeId) as NodeState } };
    },

    "node.capabilities": (req: HandlerRequest<"node.capabilities">): R<"node.capabilities"> => {
      const outside = outsideSubtree(callerOf(req), req.params.nodeId);
      if (outside) return outside;
      const state = log.state();
      const node = nodeOf(state, req.params.nodeId);
      if (node === undefined) return fail("notFound", "ノードが見つからない", "ID を確認する");
      return {
        ok: true,
        value: { operations: operationsFor(node, adapterFor(node.id), callerOf(req), state.nodes) },
      };
    },
  };
}
