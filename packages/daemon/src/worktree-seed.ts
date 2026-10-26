/**
 * 作業ツリーに写すファイル（`.envrc`・`.claude/settings.local.json` など、gitignore の対象で、チェックアウトでは来ないもの）。
 *
 * - 一覧は、`<repoRoot>/.claude/cso-worktree-files.json` に、ユーザーが明記する: `{ "files": [".envrc", ".claude/settings.local.json"] }`。
 *   ファイルがなければ、何も写さない。
 * - 写すのは**コピー**（リンクにしない）。子が書き換えても、元のファイルは変わらない。
 * - 作業ツリーを作る**前**に、一覧と元のファイルを確かめる（不正なら、作業ツリーを作らずに失敗する）:
 *   一覧の形が不正・repoRoot の外を指す（`..`・絶対パス・リンク経由）・通常のファイルでない → 失敗。元のファイルがない → 記録してスキップ。
 * - 作業ツリー側にすでにある（追跡されているファイル）ものは、上書きしない（スキップ）。
 */
import { copyFileSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, sep } from "node:path";
import { type Failure, failure, isPathUnder, type Result } from "@cso/core";

export const SEED_LIST_FILE = join(".claude", "cso-worktree-files.json");
export const SEED_MAX_FILES = 50;

export interface SeedPlan {
  /** 写すファイル（repoRoot からの相対パス）。 */
  readonly copy: readonly string[];
  /** 元のファイルがなくて、写さなかったもの。 */
  readonly missing: readonly string[];
}

const fail = (code: string, cause: string, ...next: [string, ...string[]]) => ({
  ok: false as const,
  error: failure(code, cause, ...next),
});

const isFileNotFound = (e: unknown): boolean => (e as NodeJS.ErrnoException)?.code === "ENOENT";

/** 一覧を読む。ファイルがなければ空。形が不正なら失敗（相対パス・`..` なし・重複なし・50 件以下）。 */
export function readSeedList(repoRoot: string): Result<readonly string[], Failure> {
  const file = join(repoRoot, SEED_LIST_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    if (isFileNotFound(e)) return { ok: true, value: [] };
    return fail(
      "seedListInvalid",
      `${SEED_LIST_FILE} を読めない`,
      `${SEED_LIST_FILE} の権限と種類を確認する`,
    );
  }
  const bad = (cause: string) =>
    fail(
      "seedListInvalid",
      `${SEED_LIST_FILE}: ${cause}`,
      `${SEED_LIST_FILE} を、{ "files": ["相対パス", ...] } の形に直す`,
    );
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return bad("JSON として読めない");
  }
  const files = (raw as { files?: unknown } | null)?.files;
  if (!Array.isArray(files)) return bad("files が配列でない");
  if (files.length > SEED_MAX_FILES) return bad(`files が ${SEED_MAX_FILES} 件を超えている`);
  const seen = new Set<string>();
  for (const f of files) {
    if (typeof f !== "string" || f === "") return bad("files に、空でない文字列でないものがある");
    const n = normalize(f);
    if (isAbsolute(f) || n === ".." || n.startsWith(`..${sep}`) || n === ".") {
      return bad("files に、repoRoot の外を指すもの（絶対パス・..）がある");
    }
    if (n === ".git" || n.startsWith(`.git${sep}`))
      return bad("files に、.git の中を指すものがある");
    if (seen.has(n)) return bad("files に、重複がある");
    seen.add(n);
  }
  return { ok: true, value: [...seen] };
}

/** 元のファイルを確かめる（副作用なし）。repoRoot の外・通常のファイルでないものは失敗。ないものは `missing`。 */
export function planSeed(repoRoot: string, files: readonly string[]): Result<SeedPlan, Failure> {
  const copy: string[] = [];
  const missing: string[] = [];
  for (const rel of files) {
    const abs = join(repoRoot, rel);
    let real: string;
    try {
      lstatSync(abs);
      real = realpathSync(abs);
    } catch (e) {
      if (isFileNotFound(e)) {
        missing.push(rel);
        continue;
      }
      return fail("seedSourceInvalid", `${rel} を調べられない`, `${rel} の状態を確認する`);
    }
    if (!isPathUnder(real, repoRoot)) {
      return fail(
        "seedOutsideRepo",
        `${rel} が、repoRoot の外を指している（リンク経由を含む）`,
        `${SEED_LIST_FILE} から外すか、リンクを直す`,
      );
    }
    if (!statSync(real).isFile()) {
      return fail("seedNotFile", `${rel} が、通常のファイルでない`, `${SEED_LIST_FILE} から外す`);
    }
    copy.push(rel);
  }
  return { ok: true, value: { copy, missing } };
}

/** 作業ツリーに写す。すでにあるもの・作業ツリーの外に出てしまうもの（追跡されたリンクのディレクトリ経由）は、スキップする。 */
export function copySeed(
  repoRoot: string,
  worktreePath: string,
  plan: SeedPlan,
): { copied: string[]; skipped: string[] } {
  const copied: string[] = [];
  const skipped: string[] = [];
  const realWorktree = realpathSync(worktreePath);
  for (const rel of plan.copy) {
    const dest = join(worktreePath, rel);
    try {
      mkdirSync(dirname(dest), { recursive: true });
      if (!isPathUnder(realpathSync(dirname(dest)), realWorktree)) {
        skipped.push(rel);
        continue;
      }
      try {
        lstatSync(dest);
        skipped.push(rel); // すでにある（追跡されているファイル。上書きしない）
        continue;
      } catch (e) {
        if (!isFileNotFound(e)) throw e;
      }
      copyFileSync(join(repoRoot, rel), dest); // 権限（0600 など）も写る
      copied.push(rel);
    } catch {
      skipped.push(rel);
    }
  }
  return { copied, skipped };
}
