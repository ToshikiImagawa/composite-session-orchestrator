/**
 * @cso/core
 *
 * 木構造・状態遷移・回収判定・受信箱の整列を扱う純粋なドメイン層。
 * I/O（ファイル、git、DB、ネットワーク）を持たないこと。
 * PRD: FR_001-003, FR_012, FR_026-028, NFR_007
 */

export type NodeRole = "integrator" | "implement" | "review" | "investigate" | "merge";

export const NODE_STATES = [
  "pending", // 依存先の完了待ち（FR_008）
  "running",
  "waiting", // 判断待ちで一時停止（FR_018）
  "done", // 完了報告済み（未検証）
  "verified", // 親が受理
  "stopping", // 停止要求済み。停止の確認前（猶予時間内を含む）
  "stopIncomplete", // 停止要求後もプロセスが残存。停止したとは扱わない
  "stopped",
  "reclaimable",
  "archived",
] as const;
export type NodeState = (typeof NODE_STATES)[number];

/** 受信箱の項目の種類（spec 4.2）。 */
export const INBOX_KINDS = [
  "decision",
  "answer",
  "violation",
  "failure",
  "stopIncomplete",
  "done",
  "progress",
  "info",
] as const;
export type InboxKind = (typeof INBOX_KINDS)[number];

/** 受信箱の優先度。高い順に並ぶ（FR_012）。 */
export const PRIORITIES = ["blocking", "failed", "completed", "progress", "info"] as const;

/**
 * 受信箱の優先度。高い順に blocking > failed > completed > progress > info（FR_012）。
 *
 * 項目の種類（InboxKind）との対応は INBOX_KIND_PRIORITY を参照:
 * - blocking: decision, answer
 * - failed: violation, failure, stopIncomplete（停止未完了は failed の帯）
 * - completed: done
 * - progress: progress
 * - info: info
 */
export type Priority = (typeof PRIORITIES)[number];

export const INBOX_KIND_PRIORITY: Readonly<Record<InboxKind, Priority>> = {
  decision: "blocking",
  answer: "blocking",
  violation: "failed",
  failure: "failed",
  stopIncomplete: "failed",
  done: "completed",
  progress: "progress",
  info: "info",
};
