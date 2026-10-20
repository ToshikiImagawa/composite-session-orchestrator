/**
 * daemon 窓口の契約型と Result 型（NFR_003, NFR_004, NFR_010）。I/O を持たない型と純粋関数のみ。
 * `mcp`・`cli` は daemon に依存せず、この契約を通して 127.0.0.1 の窓口を呼ぶ（design 3 章）。
 *
 * 仮置きの範囲: 操作名は spec 4.1 の操作一覧に対応する仮の名前で、引数・結果の型は最小限
 * （識別子と主要な項目のみ）。各操作の実装タスクで確定する。境界での値の検証（zod など）は将来課題。
 */

import type { ReportEvidence, ReportKind } from "./events.js";
import type { InboxItem } from "./inbox.js";
import type { NodeState } from "./index.js";

/** 失敗。原因と次に取るべき操作を必ず持つ（NFR_010）。 */
export interface Failure {
  /** 機械可読な分類。 */
  readonly code: string;
  /** 原因（人が読める説明）。 */
  readonly cause: string;
  /** 次に取るべき操作の候補。1 件以上。 */
  readonly nextActions: readonly [string, ...string[]];
}

/** 失敗を作る。次の操作が 1 件もない失敗は作れない（型と実行時の両方で拒否する）。 */
export function failure(
  code: string,
  cause: string,
  ...nextActions: readonly [string, ...string[]]
): Failure {
  if (nextActions.length === 0) {
    throw new RangeError("Failure には次に取るべき操作が 1 件以上必要");
  }
  return { code, cause, nextActions };
}

/** 窓口から受け取った値が `Failure` か（境界での実行時検査）。 */
export function isFailure(x: unknown): x is Failure {
  if (typeof x !== "object" || x === null) return false;
  const f = x as Record<string, unknown>;
  return (
    typeof f.code === "string" &&
    typeof f.cause === "string" &&
    Array.isArray(f.nextActions) &&
    f.nextActions.length > 0 &&
    f.nextActions.every((a) => typeof a === "string")
  );
}

export type Result<T, E extends Failure = Failure> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E extends Failure>(error: E): Result<never, E> => ({ ok: false, error });
export const isOk = <T, E extends Failure>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E extends Failure>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

export const mapResult = <T, U, E extends Failure>(
  r: Result<T, E>,
  f: (value: T) => U,
): Result<U, E> => (r.ok ? ok(f(r.value)) : r);

/** 窓口を呼ぶ側のロール。各ロールには役割に応じた操作だけを公開する（NFR_004）。 */
export const CONTRACT_ROLES = ["integrator", "child", "human"] as const;
export type ContractRole = (typeof CONTRACT_ROLES)[number];

/**
 * 最終削除で墓標を残すかの既定（FR_031）。残す側を既定とする（監査 NFR_011 と誤削除の追跡のため安全側）。
 * daemon の保持ポリシーの設定で変えられる。`node.purge` の `tombstone` を省略したときにこの値を使う。
 */
export const DEFAULT_PURGE_TOMBSTONE = true;

/** 操作の引数と結果（spec 4.1。仮置き、最小限）。 */
export interface OperationMap {
  // 統合
  "node.spawn": { params: { brief: string; parentId: string }; result: { nodeId: string } };
  "node.send": { params: { nodeId: string; text: string }; result: { delivered: boolean } };
  "node.stop": {
    params: { nodeId: string; mode: "graceful" | "immediate" };
    result: { state: NodeState };
  };
  "inbox.fetch": { params: { sinceSeq?: number }; result: { items: readonly InboxItem[] } };
  "tree.list": { params: Record<string, never>; result: { table: string } };
  "decision.present": {
    params: { question: string; options: readonly string[]; pauseNodeIds?: readonly string[] };
    result: { decisionId: string };
  };
  "node.split": {
    params: { nodeId: string; brief: string; keep: "mainline" | "stop" };
    result: { newNodeId: string };
  };
  "scope.decide": {
    params: { extensionId: string; decision: "approve" | "reject" | "split" };
    result: { state: NodeState };
  };
  "node.review": {
    params: { nodeId: string; verdict: "accept" | "reject" };
    result: { state: NodeState };
  };
  "node.reclaimPreview": { params: { nodeId: string }; result: { reclaimable: boolean } };
  "node.reclaim": { params: { nodeId: string }; result: { reclaimed: readonly string[] } };
  "node.capabilities": {
    params: { nodeId: string };
    result: { operations: readonly DaemonOperation[] };
  };
  /** 受信箱の項目（`ref`）の判断要求の内容を読む。 */
  "decision.get": {
    params: { decisionId: string };
    result: {
      decisionId: string;
      nodeId: string;
      status: "open" | "answered";
      question?: string;
      options?: readonly string[];
      answer?: string;
    };
  };
  /** 受信箱の項目（`ref`）の報告の内容を読む。 */
  "report.get": {
    params: { reportId: string };
    result: {
      reportId: string;
      nodeId: string;
      kind: ReportKind;
      text: string;
      evidence?: readonly ReportEvidence[];
    };
  };
  // 子（報告は親へのみ）
  "report.progress": { params: { text: string }; result: { accepted: true } };
  "report.decision": {
    params: { question: string; options: readonly string[] };
    result: { decisionId: string };
  };
  "report.outOfScope": { params: { text: string }; result: { accepted: true } };
  "report.done": {
    params: { evidence: readonly { criterion: string; evidence: string }[] };
    result: { accepted: true };
  };
  "scope.extend": { params: { target: string; reason: string }; result: { extensionId: string } };
  "node.bind": { params: { bindCode: string }; result: { nodeId: string } };
  // 人間（画面・コマンド）
  "decision.answer": {
    params: { decisionId: string } & ({ choice: string } | { text: string });
    result: { accepted: true };
  };
  "node.reclaimInstruct": { params: { nodeId: string }; result: { accepted: true } };
  /**
   * 最終削除（FR_031）。最上位の木単位。`tombstone`: 削除後に 1 行の墓標（タイトル、結果、最終コミット、日付）を残すか。
   * 省略時は保持ポリシーの既定に従う（`DEFAULT_PURGE_TOMBSTONE` = 残す。daemon の設定で変えられる）。
   */
  "node.purge": {
    params: { nodeId: string; tombstone?: boolean };
    result: { purged: readonly string[] };
  };
  /** `node.purge` の事前確認。削除される木（ノード ID）、木全体のアーカイブ日、経過日数を返す。何も変えない。 */
  "node.purgePreview": {
    params: { nodeId: string };
    result: { nodeIds: readonly string[]; archivedAt: string; elapsedDays: number };
  };
}

export type DaemonOperation = keyof OperationMap;

/** ロールごとに公開する操作（NFR_004）。`node.purge`・`node.purgePreview` は人間のコマンドだけ（DC_003）。 */
export const ROLE_OPERATIONS = {
  integrator: [
    "node.spawn",
    "node.send",
    "node.stop",
    "inbox.fetch",
    "tree.list",
    "decision.present",
    "node.split",
    "scope.decide",
    "node.review",
    "node.reclaimPreview",
    "node.reclaim",
    "node.capabilities",
    "decision.get",
    "report.get",
  ],
  child: [
    "report.progress",
    "report.decision",
    "report.outOfScope",
    "report.done",
    "scope.extend",
    "node.bind",
  ],
  human: ["decision.answer", "node.reclaimInstruct", "node.purge", "node.purgePreview"],
} as const satisfies Record<ContractRole, readonly DaemonOperation[]>;

export type RoleOperation<R extends ContractRole> = (typeof ROLE_OPERATIONS)[R][number];

/** 操作の一覧（重複なし）。 */
export const DAEMON_OPERATIONS: readonly RoleOperation<ContractRole>[] = CONTRACT_ROLES.flatMap(
  (r) => ROLE_OPERATIONS[r],
);

/**
 * 統合ノードの操作のうち、ノード（または、それを持つ判断・報告）を指すもの。呼び出した統合ノード（`caller`）の
 * 部分木（`isInSubtree`）に限る（spec 4.1）。`decision.get`・`report.get` は、記録の `nodeId` で判定する。
 * 適用は窓口（T13 以降）。ここでは判定の対象の操作を固定する。
 */
export const SUBTREE_SCOPED_OPERATIONS = [
  "node.send",
  "node.stop",
  "node.split",
  "node.review",
  "node.reclaimPreview",
  "node.reclaim",
  "node.capabilities",
  "decision.get",
  "report.get",
] as const satisfies readonly RoleOperation<"integrator">[];

/** 窓口への要求の封筒。`requestId` で冪等にする（NFR_003）。ロールが持たない操作は型で表せない。 */
export type DaemonRequest<R extends ContractRole = ContractRole> = {
  [Role in R]: {
    [Op in RoleOperation<Role>]: {
      readonly requestId: string;
      readonly role: Role;
      /** 呼び出したノード。クライアントは指定せず、daemon が認証（ノード専用の資格情報）で決めて付ける。 */
      readonly caller?: { readonly nodeId: string };
      readonly operation: Op;
      readonly params: OperationMap[Op]["params"];
    };
  }[RoleOperation<Role>];
}[R];

/** 窓口からの応答。成功も失敗も Result にそろえる。 */
export type DaemonResponse<Op extends DaemonOperation = DaemonOperation> = Result<
  OperationMap[Op]["result"]
>;
