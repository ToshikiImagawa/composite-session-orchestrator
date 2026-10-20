/**
 * 人間のトークンのファイル。なければ生成（`generateHumanToken`）して 0600 で作成し、あれば読む。
 * 置き場所のディレクトリ（グループ・他者から書き込める・リンク・所有者違い）、ファイル（権限が緩い・リンク・所有者違い・
 * 通常のファイルでない）、値の形（`TOKEN_SHAPE`・短すぎる・空）が不正なら失敗する（上書きしない。フェイルクローズ。Windows は対象外）。
 */

import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateHumanToken, TOKEN_SHAPE } from "./credentials.js";
import { assertSecureDirectory, assertSecureFile, processUid } from "./fs-safety.js";

const MIN_LENGTH = 32;

export function loadOrCreateHumanToken(
  path: string,
  options: { readonly getUid?: () => number | undefined } = {},
): { token: string; created: boolean } {
  const uid = (options.getUid ?? processUid)();
  const dir = dirname(path);
  let dirExists = true;
  try {
    lstatSync(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    dirExists = false;
  }
  if (!dirExists) mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertSecureDirectory(dir, uid);

  let exists = true;
  try {
    lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    exists = false;
  }
  if (!exists) {
    const token = generateHumanToken();
    // `wx`: 既にあれば失敗する（競合して他のトークンを上書きしない）。
    writeFileSync(path, `${token}\n`, { mode: 0o600, flag: "wx" });
    return { token, created: true };
  }
  assertSecureFile(path, uid);
  const token = readFileSync(path, "utf8").trim();
  if (!TOKEN_SHAPE.test(token) || token.length < MIN_LENGTH) {
    throw new Error(
      `人間のトークン ${path} の形が不正（${MIN_LENGTH} 文字以上の英数字と ._~+/=-）`,
    );
  }
  return { token, created: false };
}
