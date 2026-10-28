/**
 * 窓口のポートの決め方（課題 3。Desktop の子の `instruction` の URL が、daemon の再起動のあとも使えるように）。
 *
 * 次の順で決める（どこから決まったかを、起動の記録に出す）。
 * 1. 起動オプション `--port`（`option`）、または設定の `port` が 0 以外（`config`）なら、それを使う。
 * 2. どちらもなければ、stateDir の `port` のファイル（権限 0600。前回のポート）があれば、それを使う（`saved`）。
 * 3. それもなければ、空いているポートを選び（0 で待ち受ける）、そのファイルに保存する（`new`。次回から同じポート）。
 * 4. 2 で、保存したポートがほかに使われていて待ち受けられないときは、別のポートに黙って逃げず、理由と直し方を出して起動しない
 *    （Desktop の子が、古いポートに報告し続けるのを防ぐ）。
 *
 * ファイルが読めない（権限が緩い・リンク・中身が壊れている）ときも、黙って新しいポートにせず、起動しない（フェイルクローズ）。
 */

import { randomBytes } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { assertSecureFile, processUid } from "./api/fs-safety.js";

export const PORT_FILE = "port";

export type PortSource = "option" | "config" | "saved" | "new";

export interface PortChoice {
  /** 待ち受けるポート。`new` のときは 0（空いているものを選ぶ）。 */
  readonly port: number;
  readonly source: PortSource;
}

const isPort = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535;

/** 保存したポート。ファイルがなければ `undefined`。読めない・壊れているときは例外（理由つき）。 */
export function readSavedPort(path: string): number | undefined {
  let text: string;
  try {
    assertSecureFile(path, processUid());
    text = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `保存したポートのファイル（stateDir の ${PORT_FILE}）を読めない（${String(e instanceof Error ? e.message : e)}）。権限を 0600 にするか、ファイルを消して起動し直す（新しいポートになる）`,
    );
  }
  const t = text.trim();
  const n = /^\d{1,5}$/.test(t) ? Number(t) : Number.NaN;
  if (!isPort(n)) {
    throw new Error(
      `保存したポートのファイル（stateDir の ${PORT_FILE}）の中身が、1〜65535 の整数でない。ファイルを消して起動し直す（新しいポートになる）か、--port・設定の port で指定する`,
    );
  }
  return n;
}

/** ポートを保存する（一時ファイルに 0600 で書いてから置き換える）。 */
export function writeSavedPort(path: string, port: number): void {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, `${port}\n`, { mode: 0o600, flag: "wx" });
  renameSync(tmp, path);
}

/** 1〜3 の順で、待ち受けるポートを決める。 */
export function choosePort(input: {
  readonly option?: number;
  readonly configPort: number;
  readonly saved: () => number | undefined;
}): PortChoice {
  if (input.option !== undefined) return { port: input.option, source: "option" };
  if (input.configPort !== 0) return { port: input.configPort, source: "config" };
  const saved = input.saved();
  if (saved !== undefined) return { port: saved, source: "saved" };
  return { port: 0, source: "new" };
}

/** 保存したポートで待ち受けられなかったときの、理由と直し方（4）。 */
export function savedPortUnavailable(port: number, cause: string): string {
  return `前回のポート ${port}（stateDir の ${PORT_FILE} に保存）で待ち受けられない（${cause}）。Desktop の子が古いポートに報告し続けないよう、別のポートには移らない。直し方: そのポートを使っているものを止めて起動し直す、または --port か設定の port でポートを指定する（保存したポートを捨てるなら、ファイルを消す）`;
}

export { isPort };
