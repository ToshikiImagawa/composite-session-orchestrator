/** 受信箱の項目の種類と優先度（spec 4.2）。inbox.ts との循環 import を避けるため分離。 */
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

export const PRIORITIES = ["blocking", "failed", "completed", "progress", "info"] as const;

/**
 * 受信箱の優先度。PRIORITIES は高い順に並ぶ: blocking > failed > completed > progress > info（FR_012）。
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
