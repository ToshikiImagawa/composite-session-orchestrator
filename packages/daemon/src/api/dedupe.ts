/**
 * 同じ要求の処理中の重複（T10l-d）の判定に使う、本文の指紋。操作の名前と引数を、キーを並べ替えて正規化した JSON にして、SHA-256 にする
 * （空白・キーの並びに影響されない）。**値は区別する**: 有限でない数（JSON の `1e999` は `Infinity` になる）を `null` と同じ文字列にしない
 * （`JSON.stringify` は、どちらも `null` にする）。有限でない数は、JSON として不正な字面（`Infinity`・`NaN`）にして、文字列の値とも衝突させない。
 */

import { createHash } from "node:crypto";

export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(",")}}`;
  }
  if (typeof v === "number" && !Number.isFinite(v)) return String(v); // `Infinity`・`-Infinity`・`NaN`（JSON の文字列・数・null のどれとも、区別できる形）
  return JSON.stringify(v) ?? "null";
}

export const fingerprintOf = (operation: string, params: unknown): string =>
  createHash("sha256").update(stableStringify({ operation, params }), "utf8").digest("hex");
