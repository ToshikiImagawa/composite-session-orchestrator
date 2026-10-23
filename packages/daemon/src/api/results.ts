/**
 * 応答の結果を、`OperationMap` の `result` のキーだけに写す。ハンドラが誤って内部の値（状態の一部、資格情報など）を
 * 返しても、契約にないキーは応答に出さない。キーの表は型で網羅される（操作を足す・結果のキーを変えると、
 * ここを直すまでコンパイルできない）。
 */

import type { DaemonOperation, OperationMap } from "@cso/core";

type ResultKeys = {
  readonly [Op in DaemonOperation]: readonly (keyof OperationMap[Op]["result"] & string)[];
};

export const RESULT_KEYS: ResultKeys = {
  "node.spawn": ["nodeId", "status", "waitingFor"],
  "node.send": ["status", "duplicate"],
  "node.stop": ["state"],
  "inbox.fetch": ["items"],
  "tree.list": ["table"],
  "decision.present": ["decisionId"],
  "node.split": ["newNodeId"],
  "scope.decide": ["state"],
  "node.review": ["state"],
  "node.reclaimPreview": ["reclaimable", "unmet", "blockers", "loss", "tips"],
  "node.reclaim": ["reclaimed"],
  "node.capabilities": ["operations"],
  "decision.get": ["decisionId", "nodeId", "status", "question", "options", "answer"],
  "report.get": ["reportId", "nodeId", "kind", "text", "evidence"],
  "report.progress": ["accepted"],
  "report.decision": ["decisionId"],
  "report.outOfScope": ["accepted"],
  "report.done": ["accepted"],
  "scope.extend": ["extensionId"],
  "decision.answer": ["accepted"],
  "node.reclaimInstruct": ["accepted"],
  "node.purge": ["purged"],
  "node.purgePreview": [
    "nodeIds",
    "archivedAt",
    "elapsedDays",
    "retentionDays",
    "tombstoneTitle",
    "purgeable",
    "blockers",
    "hold",
    "discardedRefs",
  ],
  "node.purgeHold": ["held", "until"],
  "node.purgeRelease": ["released"],
  "node.discardedList": ["items", "max"],
  "node.discardedRestore": ["branch", "tip"],
  "node.discardedDrop": ["dropped", "key", "tip"],
};

/** 結果のキーだけを写す。結果がオブジェクトでなければ `undefined`（ハンドラの不具合として扱う）。 */
export function pickResult(
  operation: DaemonOperation,
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of RESULT_KEYS[operation]) {
    if (Object.hasOwn(src, key) && src[key] !== undefined) out[key] = src[key];
  }
  return out;
}
