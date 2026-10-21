/**
 * 窓口の認可。認証した主体（ロール・ノード）と操作・引数から、許可するかを決める。
 * PRD: NFR_004, DC_003 / spec 4.1
 *
 * 判定の順序（server.ts）: 認証 → `checkPrincipal`（主体の検査）→ `authorizeRole`（ロール）→ 引数の検証 →
 * `authorizeScope`（部分木）。ロールの持たない操作に、引数の形を教えない。
 *
 * - `checkPrincipal`: ノードのトークンは、ノードが木にあり、トークンのロールが `NodeRecord.role` と合い、停止後
 *   （stopIncomplete・stopped）・回収可能・アーカイブでないときだけ有効（無効なら 401）。停止要求中（stopping）は、
 *   成果の保存の報告のため有効。
 * - `authorizeRole`: 申告（封筒の `role`・`caller`）は、認証した主体と食い違えば拒否する（判定には使わない）。
 *   操作は `ROLE_OPERATIONS` にあるものだけ。
 * - `authorizeScope`: 統合ノードの操作は `INTEGRATOR_OPERATION_CLASS` で分類する。`subtree` は `SUBTREE_RULES` の規則
 *   （strictDescendant・directChild・selfOrDescendant）で対象を判定し、`denied`（`scope.decide`）は拒否、
 *   `callerFiltered` は通す（結果を呼び出し側の部分木に絞るのはハンドラの責務。`visibleState`）。
 *   判断・報告は記録のノードで判定し、範囲外と未知を区別しない（存在を漏らさない）。
 * 引数は検証済み（`validateParams`）の値を渡す。
 */

import {
  type DaemonOperation,
  failure,
  INTEGRATOR_OPERATION_CLASS,
  isDirectChild,
  isInSubtree,
  isStrictDescendant,
  type NodeState,
  type OperationMap,
  type OrchState,
  type Result,
  ROLE_OPERATIONS,
  SUBTREE_RULES,
  type SubtreeOperation,
  type SubtreeRule,
} from "@cso/core";
import type { Principal } from "./credentials.js";

type Failure = ReturnType<typeof failure>;
type Params = OperationMap[DaemonOperation]["params"];

export interface Claims {
  readonly claimedRole?: string;
  readonly claimedCaller?: string;
}

const OK = { ok: true, value: undefined } as const;
const forbidden = (cause: string): { ok: false; error: Failure } => ({
  ok: false,
  error: failure(
    "forbidden",
    cause,
    "この操作を持つロールで呼び出す",
    "親（統合ノード）に依頼する",
  ),
});
const notFound = (cause: string): { ok: false; error: Failure } => ({
  ok: false,
  error: failure("notFound", cause, "ID を確認する", "受信箱の参照 ID（ref）を確認する"),
});
const unauthenticated = (cause: string): { ok: false; error: Failure } => ({
  ok: false,
  error: failure("unauthenticated", cause, "正しい資格情報で呼び出す", "資格情報を再発行する"),
});

/** トークンを無効にするノードの状態（子のプロセスが止まった後）。stopping は成果の保存の報告のため有効。 */
const REVOKED_STATES: ReadonlySet<NodeState> = new Set([
  "stopIncomplete",
  "stopped",
  "reclaimable",
  "archived",
]);

export function checkPrincipal(principal: Principal, state: OrchState): Result<undefined, Failure> {
  if (principal.role === "human") return OK;
  const node = state.nodes.find((n) => n.id === principal.nodeId);
  if (node === undefined) return unauthenticated(`ノード ${principal.nodeId} は木にない`);
  if ((principal.role === "integrator") !== (node.role === "integrator")) {
    return unauthenticated("トークンのロールが、ノードのロールと一致しない");
  }
  if (REVOKED_STATES.has(node.state)) {
    return unauthenticated(`状態 ${node.state} のノードの資格情報は無効`);
  }
  return OK;
}

export function authorizeRole(
  principal: Principal,
  operation: DaemonOperation,
  claims: Claims,
): Result<undefined, Failure> {
  if (claims.claimedRole !== undefined && claims.claimedRole !== principal.role) {
    return forbidden("申告のロールが、認証したロールと一致しない");
  }
  if (claims.claimedCaller !== undefined) {
    if (principal.role === "human" || claims.claimedCaller !== principal.nodeId) {
      return forbidden("申告の caller が、認証したノードと一致しない");
    }
  }
  if (!(ROLE_OPERATIONS[principal.role] as readonly string[]).includes(operation)) {
    return forbidden(`ロール ${principal.role} は操作 ${operation} を持たない`);
  }
  return OK;
}

const satisfies = (
  rule: SubtreeRule,
  nodes: OrchState["nodes"],
  caller: string,
  target: unknown,
): boolean => {
  if (typeof target !== "string") return false;
  switch (rule) {
    case "strictDescendant":
      return isStrictDescendant(nodes, caller, target);
    case "directChild":
      return isDirectChild(nodes, caller, target);
    case "selfOrDescendant":
      return isInSubtree(nodes, caller, target);
  }
};

export function authorizeScope(
  principal: Principal,
  operation: DaemonOperation,
  params: Params,
  state: OrchState,
): Result<undefined, Failure> {
  if (principal.role === "human") return OK;
  const nodes = state.nodes;
  if (!nodes.some((n) => n.id === principal.nodeId)) {
    return forbidden(`ノード ${principal.nodeId} は木にない`);
  }
  if (principal.role !== "integrator") return OK;

  const op = operation as keyof typeof INTEGRATOR_OPERATION_CLASS;
  const cls = INTEGRATOR_OPERATION_CLASS[op];
  if (cls === undefined || cls === "denied") {
    return forbidden(`操作 ${operation} は、統合ロールからは（発生元の記録ができるまで）使えない`);
  }
  if (cls === "callerFiltered") return OK;

  const caller = principal.nodeId;
  const rule = SUBTREE_RULES[op as SubtreeOperation];
  const p = params as Record<string, unknown>;
  const outside = forbidden("対象のノードが、自分の部分木の規則を満たさない");
  switch (op) {
    case "node.spawn":
      return satisfies(rule, nodes, caller, p.parentId) ? OK : outside;
    case "decision.present": {
      const ids = p.pauseNodeIds;
      if (ids === undefined) return OK;
      return Array.isArray(ids) && ids.every((id) => satisfies(rule, nodes, caller, id))
        ? OK
        : outside;
    }
    case "decision.get": {
      const owner = state.decisions.find((d) => d.decisionId === p.decisionId)?.nodeId;
      return satisfies(rule, nodes, caller, owner) ? OK : notFound("判断要求が見つからない");
    }
    case "scope.decide": {
      // 対象は、拡張の発生元のノード（拡張要求の nodeId）。
      const owner = state.extensions.find((x) => x.extensionId === p.extensionId)?.nodeId;
      return satisfies(rule, nodes, caller, owner) ? OK : notFound("拡張要求が見つからない");
    }
    case "report.get": {
      const owner = state.reports.find((r) => r.reportId === p.reportId)?.nodeId;
      return satisfies(rule, nodes, caller, owner) ? OK : notFound("報告が見つからない");
    }
    default:
      return satisfies(rule, nodes, caller, p.nodeId) ? OK : outside;
  }
}

/** ロール → 部分木の順で判定する（引数の検証は間に入れる。server.ts）。 */
export function authorize(
  principal: Principal,
  operation: DaemonOperation,
  params: Params,
  state: OrchState,
  claims: Claims,
): Result<undefined, Failure> {
  const role = authorizeRole(principal, operation, claims);
  return role.ok ? authorizeScope(principal, operation, params, state) : role;
}
