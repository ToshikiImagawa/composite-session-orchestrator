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

export * from "./inbox.js";
export * from "./inbox-kinds.js";
export * from "./scope.js";
export * from "./tree.js";
