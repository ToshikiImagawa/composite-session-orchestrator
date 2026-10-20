/**
 * 木の構造と親子の不変条件（純粋関数）。
 * PRD: FR_001, FR_002, FR_028, NFR_007
 *
 * 木は TreeNode の配列で表す。配列の順序は兄弟の順序であり、走査結果の順序を決定する。
 */

import type { NodeRole, NodeState } from "./index.js";

export interface TreeNode {
  readonly id: string;
  readonly role: NodeRole;
  /** 根は null。 */
  readonly parentId: string | null;
}

export type TreeViolation =
  | { readonly kind: "duplicateId"; readonly nodeId: string }
  | { readonly kind: "multipleRoots"; readonly nodeIds: readonly string[] }
  | { readonly kind: "noRoot" }
  | { readonly kind: "rootNotIntegrator"; readonly nodeId: string }
  | { readonly kind: "missingParent"; readonly nodeId: string; readonly parentId: string }
  | { readonly kind: "parentNotIntegrator"; readonly nodeId: string; readonly parentId: string }
  | { readonly kind: "cycle"; readonly nodeId: string };

const byId = (nodes: readonly TreeNode[]): Map<string, TreeNode> => {
  const map = new Map<string, TreeNode>();
  for (const node of nodes) if (!map.has(node.id)) map.set(node.id, node);
  return map;
};

/** 木の不変条件を検査する。空の木は妥当。違反は入力順で返す。 */
export function validateTree(nodes: readonly TreeNode[]): TreeViolation[] {
  const out: TreeViolation[] = [];
  if (nodes.length === 0) return out;
  const map = byId(nodes);
  const seen = new Set<string>();
  for (const node of nodes) {
    if (seen.has(node.id)) out.push({ kind: "duplicateId", nodeId: node.id });
    seen.add(node.id);
  }

  const roots = nodes.filter((x) => x.parentId === null);
  if (roots.length === 0) out.push({ kind: "noRoot" });
  else if (roots.length > 1) out.push({ kind: "multipleRoots", nodeIds: roots.map((x) => x.id) });
  for (const root of roots) {
    if (root.role !== "integrator") out.push({ kind: "rootNotIntegrator", nodeId: root.id });
  }

  for (const node of nodes) {
    if (node.parentId === null) continue;
    const parent = map.get(node.parentId);
    if (parent === undefined) {
      out.push({ kind: "missingParent", nodeId: node.id, parentId: node.parentId });
    } else if (parent.role !== "integrator") {
      out.push({ kind: "parentNotIntegrator", nodeId: node.id, parentId: node.parentId });
    }
    if (reachesItself(map, node)) out.push({ kind: "cycle", nodeId: node.id });
  }
  return out;
}

function reachesItself(map: ReadonlyMap<string, TreeNode>, start: TreeNode): boolean {
  const visited = new Set<string>();
  let cur: TreeNode | undefined = start;
  while (cur?.parentId != null) {
    if (cur.parentId === start.id) return true;
    if (visited.has(cur.id)) return false; // 別の循環に入っている（start は含まれない）
    visited.add(cur.id);
    cur = map.get(cur.parentId);
  }
  return false;
}

export function childrenOf(nodes: readonly TreeNode[], id: string): TreeNode[] {
  return nodes.filter((x) => x.parentId === id);
}

/** 親の ID から子（入力順）への索引。 */
function childIndex(nodes: readonly TreeNode[]): Map<string, TreeNode[]> {
  const index = new Map<string, TreeNode[]>();
  for (const node of nodes) {
    if (node.parentId === null) continue;
    const list = index.get(node.parentId);
    if (list === undefined) index.set(node.parentId, [node]);
    else list.push(node);
  }
  return index;
}

/** 自身を含まない子孫を、入力順の深さ優先（先行順）で返す。索引を一度作るので O(n)。 */
export function descendantsOf(nodes: readonly TreeNode[], id: string): TreeNode[] {
  const index = childIndex(nodes);
  const out: TreeNode[] = [];
  const visited = new Set<string>([id]);
  const walk = (cur: string): void => {
    for (const child of index.get(cur) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      out.push(child);
      walk(child.id);
    }
  };
  walk(id);
  return out;
}

/** 親から根の順。存在しない ID と根は空。 */
export function ancestors(nodes: readonly TreeNode[], id: string): TreeNode[] {
  const map = byId(nodes);
  const out: TreeNode[] = [];
  const visited = new Set<string>([id]);
  let cur = map.get(id);
  while (cur?.parentId != null) {
    const parent = map.get(cur.parentId);
    if (parent === undefined || visited.has(parent.id)) break;
    visited.add(parent.id);
    out.push(parent);
    cur = parent;
  }
  return out;
}

/** 根が 0。存在しない ID は undefined。 */
export function depthOf(nodes: readonly TreeNode[], id: string): number | undefined {
  return nodes.some((x) => x.id === id) ? ancestors(nodes, id).length : undefined;
}

export type AddChildResult =
  | { readonly ok: true; readonly nodes: readonly TreeNode[] }
  | { readonly ok: false; readonly violation: TreeViolation };

const violationKey = (v: TreeViolation): string => JSON.stringify(v);

/**
 * ノードを追加する。追加によって新たに生じた違反（追加前の木にはなかった違反）があれば、
 * 木を変えずその最初の違反を返す。追加前から壊れている木でも、新たな違反を生まない追加は受け付ける。
 */
export function addChild(nodes: readonly TreeNode[], node: TreeNode): AddChildResult {
  const next = [...nodes, node];
  const known = new Map<string, number>();
  for (const v of validateTree(nodes)) {
    const k = violationKey(v);
    known.set(k, (known.get(k) ?? 0) + 1);
  }
  for (const v of validateTree(next)) {
    const k = violationKey(v);
    const left = known.get(k) ?? 0;
    if (left > 0) known.set(k, left - 1);
    else return { ok: false, violation: v };
  }
  return { ok: true, nodes: next };
}

// index.ts との循環 import を避けるため、状態の一覧は型で網羅を保証して持つ。
const ZERO_COUNTS = {
  pending: 0,
  running: 0,
  waiting: 0,
  done: 0,
  verified: 0,
  stopping: 0,
  stopIncomplete: 0,
  stopped: 0,
  reclaimable: 0,
  archived: 0,
} as const satisfies Record<NodeState, 0>;

/** 部分木（自身を含む）の状態別の数。すべての状態をキーに持つ。 */
export function countByState(
  nodes: readonly TreeNode[],
  rootId: string,
  stateOf: (id: string) => NodeState,
): Record<NodeState, number> {
  const counts: Record<NodeState, number> = { ...ZERO_COUNTS };
  const self = nodes.find((x) => x.id === rootId);
  if (self === undefined) return counts;
  for (const node of [self, ...descendantsOf(nodes, rootId)]) counts[stateOf(node.id)] += 1;
  return counts;
}

/**
 * 親子の回収不変条件（FR_028）の違反を返す。
 * 親が回収可能なのに回収可能でない配下のノード ID を、入力順で返す。
 */
export function reclaimInvariantViolations(
  nodes: readonly TreeNode[],
  reclaimable: ReadonlySet<string>,
): string[] {
  const bad = new Set<string>();
  for (const node of nodes) {
    if (!reclaimable.has(node.id)) continue;
    for (const d of descendantsOf(nodes, node.id)) if (!reclaimable.has(d.id)) bad.add(d.id);
  }
  return nodes.filter((x) => bad.has(x.id)).map((x) => x.id);
}

/**
 * `targetId` が `callerId` の部分木（自分自身とその子孫）にあるか。統合ノードの読み取り・操作の範囲（spec 4.1）の判定。
 * どちらかが木にない・不正な入力のときは偽（フェイルクローズ）。例外は出さない。
 */
export function isInSubtree(
  nodes: readonly TreeNode[],
  callerId: string,
  targetId: string,
): boolean {
  if (!Array.isArray(nodes) || typeof callerId !== "string" || typeof targetId !== "string")
    return false;
  if (callerId === "" || targetId === "") return false;
  if (!nodes.some((n) => n?.id === callerId)) return false;
  if (callerId === targetId) return true;
  return descendantsOf(nodes, callerId).some((n) => n.id === targetId);
}

/** `targetId` が `callerId` の、自分自身を含まない子孫か。自分自身への操作を許さない規則（停止・指示など）に使う。 */
export function isStrictDescendant(
  nodes: readonly TreeNode[],
  callerId: string,
  targetId: string,
): boolean {
  return callerId !== targetId && isInSubtree(nodes, callerId, targetId);
}

/** `targetId` が `callerId` の直接の子か（完了の判定は親だけ、など）。不正な入力は偽。 */
export function isDirectChild(
  nodes: readonly TreeNode[],
  callerId: string,
  targetId: string,
): boolean {
  if (!Array.isArray(nodes) || typeof callerId !== "string" || typeof targetId !== "string")
    return false;
  if (callerId === "" || targetId === "") return false;
  if (!nodes.some((n) => n?.id === callerId)) return false;
  return nodes.some((n) => n?.id === targetId && n.parentId === callerId);
}
