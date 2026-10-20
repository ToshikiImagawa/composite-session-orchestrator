/**
 * 呼び出した統合ノードが読める状態（自分の部分木）。受信箱・一覧など、呼び出し側で絞る操作（`callerFiltered`）の入力。
 * 純粋関数。部分木のノードと、その記録（受信箱・判断・報告・違反・停止・ツール拒否・終了）だけを残す。要求識別子の索引は
 * 他の部分木の要求を漏らさないよう空にする。木にいない呼び出し元・壊れた入力は空の状態（フェイルクローズ）。
 */

import { initialState, type OrchState } from "./events.js";
import { isInSubtree } from "./tree.js";

export function visibleState(state: OrchState, callerId: string): OrchState {
  try {
    if (typeof callerId !== "string" || !Array.isArray(state?.nodes)) return initialState();
    const nodes = state.nodes;
    const visible = new Set<string>();
    for (const n of nodes) if (isInSubtree(nodes, callerId, n.id)) visible.add(n.id);
    const mine = <T extends { nodeId: string }>(xs: readonly T[] | undefined): T[] =>
      (xs ?? []).filter((x) => visible.has(x.nodeId));
    return Object.freeze({
      nodes: Object.freeze(nodes.filter((n) => visible.has(n.id))),
      inbox: Object.freeze(mine(state.inbox)),
      decisions: Object.freeze(mine(state.decisions)),
      violations: Object.freeze(mine(state.violations)),
      stopRequests: Object.freeze(mine(state.stopRequests)),
      stopObservations: Object.freeze(mine(state.stopObservations)),
      toolDenials: Object.freeze(mine(state.toolDenials)),
      exits: Object.freeze(mine(state.exits)),
      reports: Object.freeze(mine(state.reports)),
      lastSeq: state.lastSeq,
      requests: Object.freeze({}),
    });
  } catch {
    return initialState();
  }
}
