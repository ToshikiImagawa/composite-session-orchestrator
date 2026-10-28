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
 * ファイルが読めない（権限が緩い・リンク・中身が壊れている）ときも、黙って新しいポートにせず、起動しない（フェイルクローズ。portFileInvalid）。
 * 新規のポートを保存できないとき、Desktop の子（childRuntime が desktop）では起動しない（portSaveFailed）。ほかは記録して続ける。
 * 同じ stateDir で、2 つの daemon を動かさない（ポートのファイルも、記録も、1 つの daemon のもの）。
 */

import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { type Failure, failure } from "@cso/core";
import { processUid } from "./api/fs-safety.js";

export const PORT_FILE = "port";

export type PortSource = "option" | "config" | "saved" | "new";

export interface PortChoice {
  /** 待ち受けるポート。`new` のときは 0（空いているものを選ぶ）。 */
  readonly port: number;
  readonly source: PortSource;
}

/** 起動を止める失敗（記号・原因・次の操作）。`main` が、そのまま出す。 */
export class StartFailure extends Error {
  constructor(readonly failure: Failure) {
    super(failure.cause);
  }
}

const isPort = (n: unknown): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 65535;

/** OS が選ぶポートの注意（保存したポートが、たまたま、ほかの接続に使われることがある）。 */
const EPHEMERAL_NOTE =
  "OS が選ぶポートは一時的なポートの範囲なので、まれにほかの接続が使う。止まったら --port で範囲外の番号（例: 1024〜32767 のうち空いているもの）を指定する";

const invalidFile = (cause: string): StartFailure =>
  new StartFailure(
    failure(
      "portFileInvalid",
      `保存したポートのファイル（stateDir の ${PORT_FILE}）が使えない（${cause}）。黙って新しいポートにはしない`,
      `ファイルの権限を 0600 にする（所有者はこのユーザー、通常のファイル）`,
      `ファイルを消して起動し直す（新しいポートになる。動いている Desktop の子は、新しいポートに報告できない）`,
      `--port か設定の port でポートを指定する`,
    ),
  );

/**
 * 保存したポート。ファイルがなければ `undefined`。リンクは開かず（O_NOFOLLOW）、開いたファイルを fstat で確かめてから読む
 * （確かめた時と読む時のずれをなくす）。使えないときは `StartFailure`（portFileInvalid）。
 */
export function readSavedPort(path: string): number | undefined {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "ELOOP") throw invalidFile("シンボリックリンク");
    throw invalidFile(String(e instanceof Error ? e.message : e));
  }
  let text: string;
  try {
    const st = fstatSync(fd);
    const uid = processUid();
    if (!st.isFile()) throw invalidFile("通常のファイルでない");
    if (uid !== undefined && st.uid !== uid)
      throw invalidFile("所有者が、このプロセスのユーザーと違う");
    if ((st.mode & 0o077) !== 0) throw invalidFile(`権限が緩い: ${(st.mode & 0o777).toString(8)}`);
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  const t = text.trim();
  const n = /^\d{1,5}$/.test(t) ? Number(t) : Number.NaN;
  if (!isPort(n)) throw invalidFile("中身が、1〜65535 の整数でない");
  return n;
}

/** ポートを保存する（一時ファイルに 0600 で書いてから置き換える。置き換えに失敗したら、一時ファイルを消す）。 */
export function writeSavedPort(path: string, port: number): void {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  writeFileSync(tmp, `${port}\n`, { mode: 0o600, flag: "wx" });
  try {
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/** 保存できなかったとき（Desktop の子では、起動を止める。次の再起動でポートが変わると、子の報告が届かなくなるため）。 */
export function portSaveFailed(port: number, cause: string): StartFailure {
  return new StartFailure(
    failure(
      "portSaveFailed",
      `選んだポート ${port} を、stateDir の ${PORT_FILE} に保存できない（${cause}）。Desktop の子は、次の再起動でポートが変わると報告できなくなるので、起動しない`,
      "stateDir の権限（0700。このユーザーが書ける）を確認する",
      "--port か設定の port でポートを指定する（保存は要らなくなる）",
    ),
  );
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
export function savedPortUnavailable(port: number, cause: string): StartFailure {
  return new StartFailure(
    failure(
      "savedPortUnavailable",
      `前回のポート ${port}（stateDir の ${PORT_FILE} に保存）で待ち受けられない（${cause}）。Desktop の子が古いポートに報告し続けないよう、別のポートには移らない。${EPHEMERAL_NOTE}`,
      "そのポートを使っているものを止めて、起動し直す",
      "--port か設定の port でポートを指定する",
      "保存したポートを捨てるなら、ファイルを消す（動いている Desktop の子は、新しいポートに報告できない）",
    ),
  );
}

export { isPort };
