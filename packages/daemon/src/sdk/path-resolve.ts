/**
 * 書き込み先のパスの実パス化（シンボリックリンク対策）。PRD: FR_014 / design 6.3, 9.1
 *
 * 書き込み先はまだ存在しないことがある。「最も深い既存の祖先」を `realpath` にして、残りの部分を結合する。
 * 存在しない部分に `..` があるもの、先が無いリンク（dangling）、その他の解決の失敗（権限など）は、例外にして
 * 呼び出し側（フック）が拒否する。外部（ファイルシステム）は `FsOps` に抽象化する。
 */

import { lstat, realpath } from "node:fs/promises";

export interface FsOps {
  realpath(path: string): Promise<string>;
  /** 存在しなければ `ENOENT`・`ENOTDIR` で reject する。リンクはたどらない。 */
  lstat(path: string): Promise<unknown>;
}

export const nodeFsOps: FsOps = { realpath, lstat };

const missing = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** 絶対パスを、最も深い既存の祖先の実パス＋残りにする。解決できなければ reject する。 */
export async function resolveForWrite(absPath: string, fs: FsOps): Promise<string> {
  if (!absPath.startsWith("/") || absPath.includes("\0")) throw new Error("絶対パスでない");
  const segments = absPath.split("/").filter((s) => s !== "" && s !== ".");
  for (let i = segments.length; i >= 0; i--) {
    const prefix = `/${segments.slice(0, i).join("/")}`;
    let real: string;
    try {
      real = await fs.realpath(prefix);
    } catch (e) {
      if (!missing(e)) throw e;
      // 存在しない。ただし先の無いリンクなら、書き込みでリンク先が作られるため拒否する。
      try {
        await fs.lstat(prefix);
        throw new Error(`先の無いリンク: ${prefix}`);
      } catch (e2) {
        if (!missing(e2)) throw e2;
      }
      continue;
    }
    const rest = segments.slice(i);
    if (rest.includes("..")) throw new Error("存在しない部分に .. がある");
    return rest.length === 0 ? real : `${real === "/" ? "" : real}/${rest.join("/")}`;
  }
  throw new Error("解決できるパスがない");
}
