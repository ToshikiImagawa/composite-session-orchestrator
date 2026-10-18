/**
 * @cso/core
 *
 * 木構造・状態遷移・回収判定・受信箱の整列を扱う純粋なドメイン層。
 * I/O（ファイル、git、DB、ネットワーク）を持たないこと。
 * PRD: FR_001-003, FR_012, FR_026-028, NFR_007
 */

export type NodeRole = "integrator" | "implement" | "review" | "investigate" | "merge";

export type NodeStatus =
  | "queued" // 起動前。依存先の完了待ちもここに含める（FR_008）
  | "running"
  | "paused" // 判断待ちなどで一時停止中（FR_018）
  | "completed" // 子が完了報告済み（未検証）
  | "verified" // 親が受理
  | "merged"
  | "stopped"
  | "reclaimable"
  | "archived";

/**
 * 受信箱の優先度。高い順に blocking > failed > completed > progress > info（FR_012）。
 *
 * 項目の種類との対応:
 * - blocking: 判断要求、人間の回答
 * - failed: 範囲違反、子の失敗報告
 * - completed: 子の完了報告
 * - progress: 子の進捗報告
 * - info: 回収可能化の通知
 */
export type Priority = "blocking" | "failed" | "completed" | "progress" | "info";
