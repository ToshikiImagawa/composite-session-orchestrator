/**
 * 最終削除（FR_031）の、対象の木と事前確認、削除するイベントの特定（純粋関数）。
 * 最上位の木: 対象のノード N（`archived`）と全子孫。N の親が `archived` でないこと（親が `archived` なら、親を指定する）。
 * 削除できない理由は、失敗として返す: 存在しない（`notFound`）・最上位でない（`notTopOfTree`）・
 * 木にアーカイブでないノードがある（`notArchived`）・木の外のノードが木のノードに依存している（`dependedOn`。
 * 依存先が欠けると、残りのログの `node.created` が `unknownDependency` で畳み込めなくなる。依存する側を先に削除する）。
 * 保持期間（90 日）の判定は、呼び出し側（daemon の設定）が `elapsedDays` で行う。
 */

import { type Failure, failure, type Result } from "./contract.js";
import type { NodeRecord, OrchEvent, OrchState } from "./events.js";

export interface PurgePlan {
  /** 削除する木のノード。配下から先（後順）。 */
  readonly nodeIds: readonly string[];
  /** 木全体のアーカイブ日（木のノードの `archivedAt` の最大。ISO 8601）。 */
  readonly archivedAt: string;
  /** `archivedAt` からの経過日数（切り捨て。`now` が前なら 0）。 */
  readonly elapsedDays: number;
}

const DAY_MS = 86_400_000;

const fail = (code: string, cause: string, next: string): Result<never, Failure> => ({
  ok: false,
  error: failure(code, cause, next),
});

export function planPurge(
  state: OrchState,
  nodeId: string,
  nowMs: number,
): Result<PurgePlan, Failure> {
  const byId = new Map(state.nodes.map((n) => [n.id, n]));
  const target = byId.get(nodeId);
  if (target === undefined)
    return fail("notFound", `ノード ${nodeId} が見つからない`, "ID を確認する");
  if (target.parentId !== null && byId.get(target.parentId)?.state === "archived") {
    return fail(
      "notTopOfTree",
      `親 ${target.parentId} もアーカイブ済みで、${nodeId} は最上位の木ではない`,
      `最上位の木（${target.parentId} 側）を指定する`,
    );
  }
  const children = new Map<string, string[]>();
  for (const n of state.nodes) {
    if (n.parentId === null) continue;
    const list = children.get(n.parentId) ?? [];
    list.push(n.id);
    children.set(n.parentId, list);
  }
  const order: string[] = [];
  const visit = (id: string, seen: Set<string>): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const c of children.get(id) ?? []) visit(c, seen);
    order.push(id);
  };
  visit(nodeId, new Set());
  const inTree = new Set(order);
  for (const id of order) {
    const node = byId.get(id);
    if (node?.state !== "archived") {
      return fail(
        "notArchived",
        `ノード ${id} がアーカイブ済みでない（${node?.state ?? "不明"}）`,
        "木全体がアーカイブされてから削除する",
      );
    }
  }
  for (const n of state.nodes) {
    if (inTree.has(n.id)) continue;
    const dep = n.dependsOn.find((d) => inTree.has(d));
    if (dep !== undefined) {
      return fail(
        "dependedOn",
        `木の外のノード ${n.id} が、木のノード ${dep} に依存している`,
        `依存する側（${n.id}）を先に最終削除する`,
      );
    }
  }
  let archivedAt = "";
  for (const id of order) {
    const at = byId.get(id)?.archivedAt;
    if (at === undefined) {
      return fail("notArchived", `ノード ${id} のアーカイブ日が記録されていない`, "記録を確認する");
    }
    if (at > archivedAt) archivedAt = at;
  }
  const elapsed = Math.floor((nowMs - Date.parse(archivedAt)) / DAY_MS);
  return {
    ok: true,
    value: {
      nodeIds: order,
      archivedAt,
      elapsedDays: Number.isFinite(elapsed) && elapsed > 0 ? elapsed : 0,
    },
  };
}

/**
 * 木のノードを主語とするイベントの `seq`（昇順）。主語が payload の `nodeId` でないイベントは、前のイベントの記録から導く:
 * `scope.extensionDecided`（要求の `nodeId`）・`inbox.resolved`（項目の `nodeId`）・`node.instructionDelivered`
 * （指示の `nodeId`）・`decision.answered`（判断の `nodeId`）。導けないものは含めない（削除しない側に倒す）。
 */
export function purgeEventSeqs(
  events: readonly OrchEvent[],
  nodeIds: ReadonlySet<string>,
): number[] {
  const extension = new Map<string, string>();
  const inbox = new Map<string, string>();
  const instructed = new Map<number, string>();
  const decision = new Map<string, string>();
  const out: number[] = [];
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const e of sorted) {
    let subject: string | undefined;
    switch (e.type) {
      case "node.created":
      case "node.stateChanged":
      case "scope.violation":
      case "node.stopObserved":
      case "node.stopDeclared":
      case "node.toolDenied":
      case "node.exited":
      case "node.discardDecided":
      case "node.lastCommit":
      case "node.purgeHeld":
      case "node.purgeHoldReleased":
        subject = e.payload.nodeId;
        break;
      case "inbox.added":
        inbox.set(e.payload.id, e.payload.nodeId);
        subject = e.payload.nodeId;
        break;
      case "report.added":
        subject = e.payload.nodeId;
        break;
      case "decision.requested":
        decision.set(e.payload.decisionId, e.payload.nodeId);
        subject = e.payload.nodeId;
        break;
      case "scope.extensionRequested":
        extension.set(e.payload.extensionId, e.payload.nodeId);
        subject = e.payload.nodeId;
        break;
      case "node.instructed":
        instructed.set(e.seq, e.payload.nodeId);
        subject = e.payload.nodeId;
        break;
      case "scope.extensionDecided":
        subject = extension.get(e.payload.extensionId);
        break;
      case "inbox.resolved":
        subject = inbox.get(e.payload.itemId);
        break;
      case "node.instructionDelivered":
        subject = instructed.get(e.payload.instructedSeq);
        break;
      case "decision.answered":
        subject = decision.get(e.payload.decisionId);
        break;
      default:
        break;
    }
    if (subject !== undefined && nodeIds.has(subject)) out.push(e.seq);
  }
  return out;
}

/**
 * 自動の最終削除の保留が有効か（T13f-h）。無期限、または期限（`until`）が現在より後。期限を読めなければ有効（迷ったら保留のまま）。
 * `nowMs` は、呼び出し側の時計（自動の最終削除は、時計の異常の検知を通ったもの）。
 */
export function purgeHoldActive(node: NodeRecord, nowMs: number): boolean {
  const hold = node.purgeHold;
  if (hold === undefined) return false;
  if (hold.until === undefined) return true;
  // 期限を読めない（壊れた記録）・時計が不明なときは、保留のままにする（迷ったら消さない側に倒す）。
  const until = Date.parse(hold.until);
  return !Number.isFinite(until) || !Number.isFinite(nowMs) || nowMs < until;
}

/**
 * 木（`nodeIds`）の中に、有効な保留があるノードを返す（T13f-h）。木の中のどのノードの保留でも、その木全体を自動の削除の対象から外す
 * （保留をかけたあとで、親がアーカイブされ、外側の新しい木に吸収されても、すり抜けない）。複数あれば、最も長く続くもの（無期限が先）。
 */
export function activePurgeHold(
  state: OrchState,
  nodeIds: readonly string[],
  nowMs: number,
): NodeRecord | undefined {
  const ids = new Set(nodeIds);
  const untilOf = (n: NodeRecord): number => {
    const u = n.purgeHold?.until;
    if (u === undefined) return Number.POSITIVE_INFINITY;
    const t = Date.parse(u);
    return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
  };
  let best: NodeRecord | undefined;
  for (const n of state.nodes) {
    if (!ids.has(n.id) || !purgeHoldActive(n, nowMs)) continue;
    if (best === undefined || untilOf(n) > untilOf(best)) best = n;
  }
  return best;
}
