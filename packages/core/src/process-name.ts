/**
 * 停止を妨げているプロセスの表示（T24-sp）。
 *
 * - コマンドの名前は信頼しない入力として扱う。制御文字・書式文字を取り除き、長さを 32 文字（符号位置）までにする。
 *   受信箱の要約（イベントログに残る）・cli・画面のどれに出す前にも、ここで整える。
 * - 名前は lsof の `c` の欄（コマンドの名前だけ）から取る。引数・パス・環境変数は含まれないので、
 *   コマンドラインに渡した秘密が入ることはない。
 */

const MAX_NAME = 32;
const MAX_LIST = 10;

/** コマンドの名前を表示用に整える。空になれば `undefined`。 */
export function processCommandName(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const cleaned = raw.replace(/[\p{Cc}\p{Cf}]/gu, "").trim();
  if (cleaned === "") return undefined;
  const chars = [...cleaned];
  return chars.length > MAX_NAME ? `${chars.slice(0, MAX_NAME).join("")}…` : cleaned;
}

export interface ProcessLabel {
  readonly pid: number;
  readonly command?: string;
}

/** 「pid 123（zsh）、456」の形。10 件までで、残りは「ほか N 件」。空なら「不明」。 */
export function formatProcesses(list: readonly ProcessLabel[]): string {
  if (list.length === 0) return "不明";
  const shown = list.slice(0, MAX_LIST).map((p) => {
    const name = processCommandName(p.command);
    return name === undefined ? `${p.pid}` : `${p.pid}（${name}）`;
  });
  const rest = list.length > MAX_LIST ? `、ほか ${list.length - MAX_LIST} 件` : "";
  return `pid ${shown.join("、")}${rest}`;
}
