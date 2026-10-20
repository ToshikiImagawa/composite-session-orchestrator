/**
 * 窓口の認可。認証した主体（ロール・ノード）と操作・引数から、許可するかを決める。
 * PRD: NFR_004, DC_003 / spec 4.1
 *
 * 1. 申告（封筒の `role`・`caller`）は、認証した主体と食い違えば拒否する（判定には使わない）。
 * 2. 操作は、ロールの操作表（`ROLE_OPERATIONS`）にあるものだけ。
 * 3. ノードのトークンは、ノードが木にあるときだけ有効（フェイルクローズ）。
 * 4. 統合ノードの、ノード・判断・報告を指す操作（`SUBTREE_SCOPED_OPERATIONS`）は、自分の部分木に限る（`isInSubtree`）。
 *    判断・報告は記録のノードで判定し、範囲外と未知は区別しない（存在を漏らさない）。
 * 引数は検証済み（`validateParams`）の値を渡す。
 */

import {
  type DaemonOperation,
  failure,
  isInSubtree,
  type OperationMap,
  type OrchState,
  type Result,
  ROLE_OPERATIONS,
  SUBTREE_SCOPED_OPERATIONS,
} from "@cso/core";
import type { Principal } from "./credentials.js";

type Failure = ReturnType<typeof failure>;

export interface Claims {
  readonly claimedRole?: string;
  readonly claimedCaller?: string;
}

const SCOPED: ReadonlySet<string> = new Set(SUBTREE_SCOPED_OPERATIONS);
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

export function authorize(
  principal: Principal,
  operation: DaemonOperation,
  params: OperationMap[DaemonOperation]["params"],
  state: OrchState,
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
  if (principal.role === "human") return { ok: true, value: undefined };

  const nodes = state.nodes;
  if (!nodes.some((n) => n.id === principal.nodeId)) {
    return forbidden(`ノード ${principal.nodeId} は木にない`);
  }
  if (principal.role !== "integrator" || !SCOPED.has(operation))
    return { ok: true, value: undefined };

  const p = params as Record<string, unknown>;
  if (operation === "decision.get") {
    const owner = state.decisions.find((d) => d.decisionId === p.decisionId)?.nodeId;
    return owner !== undefined && isInSubtree(nodes, principal.nodeId, owner)
      ? { ok: true, value: undefined }
      : notFound("判断要求が見つからない");
  }
  if (operation === "report.get") {
    const owner = state.reports.find((r) => r.reportId === p.reportId)?.nodeId;
    return owner !== undefined && isInSubtree(nodes, principal.nodeId, owner)
      ? { ok: true, value: undefined }
      : notFound("報告が見つからない");
  }
  const target = p.nodeId;
  return typeof target === "string" && isInSubtree(nodes, principal.nodeId, target)
    ? { ok: true, value: undefined }
    : forbidden("対象のノードが、自分の部分木にない");
}
