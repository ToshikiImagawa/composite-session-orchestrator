/**
 * 子が入れる文字列・配列の上限と、文字列の検査（NFR_011, DC_003）。長さはコードポイントで数える。
 * 上限を超える・禁止された文字を含む値は、イベントの検査（`events.ts`）で `invalidPayload` として拒否する。
 */

import { INBOX_SUMMARY_MAX } from "./inbox-kinds.js";

export const LIMITS = {
  /** 報告の本文（`report.added` の `text`）。 */
  reportText: 64 * 1024,
  /** 判断要求の問い（`decision.requested` の `question`）。 */
  question: 8 * 1024,
  /** 判断要求の選択肢の件数と、1 件あたりの長さ。 */
  optionCount: 20,
  optionLength: 500,
  /** 完了報告の根拠の件数と、`criterion`・`evidence` それぞれの長さ。 */
  evidenceCount: 50,
  evidenceLength: 4 * 1024,
  /** `node.exited` の理由、`node.toolDenied` のツール名。 */
  reason: 1024,
  tool: 1024,
  /** 受信箱の項目の要約。 */
  summary: INBOX_SUMMARY_MAX,
  /** ブリーフ（spec 5.2）: 目的、受け入れ基準の件数と 1 件の長さ、作業範囲の各一覧の件数と 1 件の長さ、依存先の件数。 */
  objective: 8 * 1024,
  criteriaCount: 50,
  criterionLength: 1024,
  scopeEntryCount: 100,
  scopeEntryLength: 4096,
  dependsOnCount: 50,
  /** 判断要求（`decision.requested`）で、判断待ちの間に止める子の件数。 */
  pauseNodeCount: 100,
  /** 完了の判定（`node.review`）の差し戻し理由・コメント。 */
  feedback: 8 * 1024,
} as const;

/** タブ・改行（LF）以外の制御文字（C0・DEL・C1）と、書式制御文字（Cf。U+202E、ゼロ幅文字など）。 */
const FORBIDDEN_CHAR = /(?![\t\n])[\p{Cc}\p{Cf}]/u;

/** コードポイントの数。上限の判定に使うため、極端に長い文字列は数えずに打ち切る。 */
export function codePointLength(s: string, stopAfter: number): number {
  if (s.length > stopAfter * 2) return stopAfter + 1;
  let n = 0;
  for (const _ of s) {
    n += 1;
    if (n > stopAfter) break;
  }
  return n;
}

/** 文字列で、コードポイント数が `max` 以下、かつ禁止された文字を含まないか。 */
export const isBoundedText = (x: unknown, max: number): x is string =>
  typeof x === "string" && codePointLength(x, max) <= max && !FORBIDDEN_CHAR.test(x);

/**
 * 外部（子・SDK の例外など）由来の値を、記録できる文字列にする。文字列でなければ `String` にし、禁止された文字を
 * U+FFFD に置き換え、`max` コードポイントを超えたら末尾を「…」にして収める。結果は常に `isBoundedText(_, max)` を満たす。
 */
export function sanitizeText(x: unknown, max: number): string {
  let s: string;
  try {
    s = typeof x === "string" ? x : String(x);
  } catch {
    s = "(文字列にできない値)";
  }
  const clean = Array.from(s.length > max * 4 ? s.slice(0, max * 4) : s, (ch) =>
    FORBIDDEN_CHAR.test(ch) ? "�" : ch,
  );
  return clean.length <= max && s.length <= max * 4
    ? clean.join("")
    : `${clean.slice(0, Math.max(0, max - 1)).join("")}…`;
}
