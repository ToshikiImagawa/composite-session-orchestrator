/**
 * 人間のトークンのファイル。なければ生成（`generateHumanToken`）して 0600 で作成し、あれば読む。
 * 権限が緩い（グループ・他者が読める）・短すぎる・空・ファイルでないものは失敗する（上書きしない。フェイルクローズ）。
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { generateHumanToken } from "./credentials.js";
import { isLoosePermission } from "./token-repository.js";

const MIN_LENGTH = 32;

export function loadOrCreateHumanToken(path: string): { token: string; created: boolean } {
  let mode: number | undefined;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error(`人間のトークン ${path} がファイルでない`);
    mode = st.mode;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (mode === undefined) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const token = generateHumanToken();
    // `wx`: 既にあれば失敗する（競合して他のトークンを上書きしない）。
    writeFileSync(path, `${token}\n`, { mode: 0o600, flag: "wx" });
    return { token, created: true };
  }
  if (isLoosePermission(mode)) {
    throw new Error(
      `人間のトークン ${path} の権限が緩い（0600 にする）: ${(mode & 0o777).toString(8)}`,
    );
  }
  const token = readFileSync(path, "utf8").trim();
  if (token.length < MIN_LENGTH)
    throw new Error(`人間のトークン ${path} が短すぎる（${MIN_LENGTH} 文字以上）`);
  return { token, created: false };
}
