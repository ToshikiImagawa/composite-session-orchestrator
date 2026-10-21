/**
 * 識別子（ノード・判断要求・報告・拡張要求など）の形式。窓口の入口（daemon の API、cli）で同じ規則を使う。
 * 英数字で始まり、英数字と `.` `_` `:` `-` だけの 128 文字以下。パスの区切り・空白・制御文字・先頭の記号・非 ASCII を
 * 含まない（ブランチ名・パス・ログ・コマンドへ渡しても安全な文字だけ）。
 */

import { LIMITS } from "./limits.js";

export const ID_MAX_LENGTH = 128;
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const isSafeId = (x: unknown): x is string => typeof x === "string" && ID_PATTERN.test(x);

/**
 * 判断要求（`decision.requested`・`decision.present`）の `pauseNodeIds` の形の問題を返す。問題がなければ `undefined`。
 * 識別子の重複なしの配列で、`LIMITS.pauseNodeCount` 以下。子孫であること・存在することは、木を見る側（fold）が確かめる。
 */
export function pauseNodeIdsProblem(x: unknown): string | undefined {
  if (
    !Array.isArray(x) ||
    x.length > LIMITS.pauseNodeCount ||
    !x.every(isSafeId) ||
    new Set(x).size !== x.length
  ) {
    return `pauseNodeIds が不正（重複なしの識別子、${LIMITS.pauseNodeCount} 件以下）`;
  }
  return undefined;
}
