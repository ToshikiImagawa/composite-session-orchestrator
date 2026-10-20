/**
 * 識別子（ノード・判断要求・報告・拡張要求など）の形式。窓口の入口（daemon の API、cli）で同じ規則を使う。
 * 英数字で始まり、英数字と `.` `_` `:` `-` だけの 128 文字以下。パスの区切り・空白・制御文字・先頭の記号・非 ASCII を
 * 含まない（ブランチ名・パス・ログ・コマンドへ渡しても安全な文字だけ）。
 */

export const ID_MAX_LENGTH = 128;
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export const isSafeId = (x: unknown): x is string => typeof x === "string" && ID_PATTERN.test(x);
