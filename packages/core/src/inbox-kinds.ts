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
  /** 中間統合ノードの配下の要約（T24。FR_013）。システムが、決定的に作る。優先度は、項目の `priority` で決まる。 */
  "digest",
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
  // 要約の既定。実際の優先度は、項目の `priority`（配下の未解決の項目の最高の優先度）で決まる（`priorityOf`）。
  digest: "info",
};

/** 項目の優先度: `digest` は、項目の `priority`（あれば）。そのほかは、種類で決まる（`INBOX_KIND_PRIORITY`）。 */
export const priorityOf = (item: {
  readonly kind: InboxKind;
  readonly priority?: Priority;
}): Priority =>
  item.kind === "digest" && item.priority !== undefined
    ? item.priority
    : INBOX_KIND_PRIORITY[item.kind];

/** 受信箱の項目の要約（`summary`）の最大文字数。短い要約だけを載せ、全文は参照先（`ref`）で読む。 */
export const INBOX_SUMMARY_MAX = 200;
