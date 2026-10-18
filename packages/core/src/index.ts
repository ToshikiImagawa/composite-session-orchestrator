/**
 * @cso/core
 *
 * 木構造・状態遷移・回収判定・受信箱の整列を扱う純粋なドメイン層。
 * I/O（ファイル、git、DB、ネットワーク）を持たないこと。
 * PRD: FR_001-003, FR_012, FR_026-028, NFR_007
 */

export type NodeRole = "integrator" | "implement" | "review" | "investigate" | "merge";

export type NodeStatus =
  | "queued"
  | "running"
  | "completed" // 子が完了報告済み（未検証）
  | "verified" // 親が受理
  | "merged"
  | "stopped"
  | "reclaimable"
  | "archived";

export type Priority = "blocking" | "failed" | "completed" | "progress" | "info";
