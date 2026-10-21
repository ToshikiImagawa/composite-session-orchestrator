/**
 * 認証情報を置く場所の検査（フェイルクローズ）。Windows は対象外（POSIX のモードと所有者を前提にする）。
 *
 * - ディレクトリ: シンボリックリンクでない実のディレクトリで、所有者がこのプロセスと同じで、グループ・他者から書き込めない。
 *   （書き込めると、ファイルの差し替え・一時ファイルの細工ができる）
 * - ファイル: シンボリックリンクでない通常のファイルで、所有者がこのプロセスと同じで、グループ・他者に権限がない（0600）。
 */

import { lstatSync } from "node:fs";

/** このプロセスのユーザー ID。取得できない環境では `undefined`（所有者は確かめない）。 */
export const processUid = (): number | undefined => process.getuid?.();

const octal = (mode: number): string => (mode & 0o777).toString(8);

export function assertSecureDirectory(dir: string, uid: number | undefined): void {
  const st = lstatSync(dir);
  if (!st.isDirectory()) {
    throw new Error(`認証情報のディレクトリ ${dir} が実のディレクトリでない（リンクなどは不可）`);
  }
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`認証情報のディレクトリ ${dir} の所有者が、このプロセスのユーザーと違う`);
  }
  if ((st.mode & 0o022) !== 0) {
    throw new Error(
      `認証情報のディレクトリ ${dir} が、グループ・他者から書き込める（0700 にする）: ${octal(st.mode)}`,
    );
  }
}

export function assertSecureFile(path: string, uid: number | undefined): void {
  const st = lstatSync(path);
  if (!st.isFile())
    throw new Error(`認証情報のファイル ${path} が通常のファイルでない（リンクなどは不可）`);
  if (uid !== undefined && st.uid !== uid) {
    throw new Error(`認証情報のファイル ${path} の所有者が、このプロセスのユーザーと違う`);
  }
  if ((st.mode & 0o077) !== 0) {
    throw new Error(`認証情報のファイル ${path} の権限が緩い（0600 にする）: ${octal(st.mode)}`);
  }
}
