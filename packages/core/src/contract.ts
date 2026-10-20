/**
 * daemon 窓口の契約型と Result 型（NFR_001, NFR_010）。I/O を持たない型と純粋関数のみ。
 * `mcp`・`cli` は daemon に依存せず、この契約を通して 127.0.0.1 の窓口を呼ぶ（design 3 章）。
 */

/** 失敗。原因と次に取るべき操作を必ず持つ（NFR_010）。 */
export interface Failure {
  /** 機械可読な分類。 */
  readonly code: string;
  /** 原因（人が読める説明）。 */
  readonly cause: string;
  /** 次に取るべき操作の候補。1 件以上。 */
  readonly nextActions: readonly [string, ...string[]];
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

/** 操作の名前（spec 4.1）。引数と結果の詳細は各操作の実装タスクで定める。 */
export const DAEMON_OPERATIONS = [
  "node.spawn",
  "node.send",
  "node.stop",
  "inbox.fetch",
  "tree.list",
  "decision.request",
  "node.split",
  "scope.decide",
  "node.review",
  "node.reclaim",
  "node.capabilities",
  "report.submit",
  "scope.extend",
  "node.bind",
  "decision.answer",
  "node.purge",
] as const;
export type DaemonOperation = (typeof DAEMON_OPERATIONS)[number];

/** 窓口への要求の封筒。`requestId` で冪等にする（NFR_003）。 */
export interface DaemonRequest<P = unknown> {
  readonly requestId: string;
  readonly role: ContractRole;
  readonly operation: DaemonOperation;
  readonly params: P;
}

/** 窓口からの応答。成功も失敗も Result にそろえる。 */
export type DaemonResponse<T = unknown> = Result<T>;
