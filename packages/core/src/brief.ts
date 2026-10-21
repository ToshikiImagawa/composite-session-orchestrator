/**
 * ブリーフ（spec 5.2）: 子へ渡す作業指示。目的・受け入れ基準・作業範囲・依存関係。
 * 作業ツリーとブランチは含めない（アダプタが親ブランチから決める。spec 5.2）。
 * 作業範囲の中身（パスが絶対か、作業ツリーの内側か）は、作業ツリーが決まってから `validateScope(scope, cwd)` で検査する。
 * ここでは形・件数・長さ・文字・重複と、場所の `..`・`/` だけを検査する。**作業ツリー（cwd）が決まった後の `validateScope` は必須**
 * （この検査は、パスが作業ツリーの内側か・絶対か・書き込み可能な場所が根でないかを保証しない）。
 */

import { isSafeId } from "./ids.js";
import { isBoundedText, LIMITS } from "./limits.js";
import type { Scope } from "./scope.js";

export interface Brief {
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly scope: Scope;
  /** 先行ノードの ID。省略は依存なし。 */
  readonly dependsOn?: readonly string[];
}

const SCOPE_KEYS = ["writableLocations", "forbiddenLocations", "allowedCommands"] as const;

const isRec = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const nonBlank = (x: unknown, max: number): x is string => isBoundedText(x, max) && x.trim() !== "";
const hasDuplicate = (xs: readonly string[]): boolean => new Set(xs).size !== xs.length;
/** 場所として使えない値: `..` の区切りを含む（範囲の外へ抜けられる）、または `/` だけ（全体を指す）。 */
const badPath = (p: string): boolean =>
  p.split("/").some((seg) => seg === "..") || p.replace(/\/+/g, "/").trim() === "/";

/** ブリーフの最初の問題を、短い説明で返す。問題がなければ `undefined`。例外は出さない。 */
export function briefProblem(b: {
  readonly objective?: unknown;
  readonly acceptanceCriteria?: unknown;
  readonly scope?: unknown;
  readonly dependsOn?: unknown;
}): string | undefined {
  if (!isRec(b)) return "ブリーフがオブジェクトでない";
  if (!nonBlank(b.objective, LIMITS.objective)) {
    return `objective が不正（空でない ${LIMITS.objective} 文字以下の文字列。制御文字なし）`;
  }
  const c = b.acceptanceCriteria;
  if (
    !Array.isArray(c) ||
    c.length < 1 ||
    c.length > LIMITS.criteriaCount ||
    !c.every((x) => nonBlank(x, LIMITS.criterionLength)) ||
    hasDuplicate(c as string[])
  ) {
    return `acceptanceCriteria が不正（1〜${LIMITS.criteriaCount} 件、重複なし、各 ${LIMITS.criterionLength} 文字以下の空でない文字列）`;
  }
  const s = b.scope;
  if (!isRec(s)) return "scope がオブジェクトでない";
  if (Object.keys(s).some((k) => !(SCOPE_KEYS as readonly string[]).includes(k))) {
    return `scope に未知のキーがある（許可: ${SCOPE_KEYS.join("・")}）`;
  }
  for (const key of SCOPE_KEYS) {
    const list = s[key];
    if (
      !Array.isArray(list) ||
      list.length > LIMITS.scopeEntryCount ||
      !list.every((x) => nonBlank(x, LIMITS.scopeEntryLength))
    ) {
      return `scope.${key} が不正（${LIMITS.scopeEntryCount} 件以下、各 ${LIMITS.scopeEntryLength} 文字以下の空でない文字列）`;
    }
    if (hasDuplicate(list as string[])) return `scope.${key} に重複がある`;
    if (key !== "allowedCommands" && (list as string[]).some(badPath)) {
      return `scope.${key} に使えない場所がある（.. を含む、または / だけ）`;
    }
  }
  const d = b.dependsOn;
  if (d !== undefined) {
    if (
      !Array.isArray(d) ||
      d.length > LIMITS.dependsOnCount ||
      !d.every(isSafeId) ||
      new Set(d).size !== d.length
    ) {
      return `dependsOn が不正（重複なし、${LIMITS.dependsOnCount} 件以下の識別子）`;
    }
  }
  return undefined;
}
