/**
 * 作業範囲の違反判定（純粋関数）。フックの入力から呼ばれ、許可・拒否を決定的に返す。
 * PRD: FR_014, FR_015, IR_002 / spec 5.5, design 6.3
 *
 * - 読み込みは制限しない。
 * - 書き込みは、禁止場所に入らず、かつ許可場所の配下であること（禁止が優先）。
 * - コマンドは、全部分が許可コマンドに一致すること。
 * - 判定できないもの（コマンド置換、サブシェル、リダイレクト `<` `>`）とバックグラウンド起動（既定。ADR 未決）は拒否する。
 * - パスは正規化済みの入力を前提とする。シンボリックリンクの実パス解決は daemon のアダプタの責務で、ここでは行わない。
 * - 場所の比較は、大文字小文字の畳み込みと Unicode 正規化（NFC）を行ってから行う。大文字小文字を区別しない
 *   ファイルシステム（macOS の既定など）で `src/SECRET` が禁止場所 `src/secret` をすり抜けるのを防ぐ。
 *   Windows（バックスラッシュ区切り、ドライブ文字、予約名）は対象外で、POSIX 形式のパスだけを扱う。
 *   書式制御文字（Cf、ゼロ幅文字など）を含むパスは、HFS+ が無視して別名と同一視するため拒否する。
 *   区別するファイルシステムでは過剰に拒否するだけで、安全側に倒れる。
 * - 範囲の設定（場所・コマンドの一覧）が不正なときは、書き込みとコマンドをすべて拒否する（フェイルクローズ）。
 *
 * 構造上の限界: 許可したコマンドの中身（`pnpm test` が走らせるスクリプトなど）が行う書き込みは、この判定では
 * 見えない。コマンドの許可は「そのコマンドを信頼する」ことと同義であり、許可リストは最小にする。
 */

/** spec 4.2 の Scope。 */
export interface Scope {
  readonly writableLocations: readonly string[];
  readonly forbiddenLocations: readonly string[];
  /** 語の並びの前方一致（例: "git status" は `git status -s` に一致、`git push` には一致しない）。 */
  readonly allowedCommands: readonly string[];
}

export type ScopeOperation =
  | { readonly kind: "read"; readonly path: string }
  | { readonly kind: "write"; readonly path: string }
  | { readonly kind: "command"; readonly command: string };

export type ScopeViolationReason =
  | "forbiddenLocation"
  | "outsideWritable"
  | "commandNotAllowed"
  | "backgroundExecution"
  | "indirectExecution" // 別のコマンドを再解釈・実行するコマンド（固定リスト）
  | "unparsable"
  | "invalidPath" // 判定対象のパスが不正（空、NUL・書式制御文字を含む）
  | "invalidScope"; // 範囲の設定が不正（validateScope を参照）

export type ScopeDecision =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly reason: ScopeViolationReason;
      /** 違反した場所またはコマンド（記録用）。 */
      readonly subject: string;
    };

const ALLOW: ScopeDecision = { allowed: true };
const deny = (reason: ScopeViolationReason, subject: string): ScopeDecision => ({
  allowed: false,
  reason,
  subject,
});

/** `cwd` を基準に絶対化し、`.` と `..` を畳む（POSIX 区切り）。 */
function normalize(cwd: string, path: string): string {
  const parts: string[] = [];
  const full = path.startsWith("/") ? path : `${cwd}/${path}`;
  for (const seg of full.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join("/")}`;
}

/** 場所の比較用。大文字小文字と Unicode の正規形の違いを畳み込む。表示・記録には使わない。 */
const fold = (path: string): string => path.normalize("NFC").toLowerCase().normalize("NFC");

const isUnder = (path: string, dir: string): boolean => {
  const p = fold(path);
  const d = fold(dir);
  return d === "/" || p === d || p.startsWith(`${d}/`);
};

const hasNul = (s: string): boolean => s.includes("\0");

/** 書式制御文字（Cf）。ゼロ幅文字など、一部のファイルシステム（HFS+）が無視するため名前の比較を迂回できる。 */
const hasFormatChar = (s: string): boolean => /\p{Cf}/u.test(s);

export interface ScopeIssue {
  readonly field: "cwd" | "writableLocations" | "forbiddenLocations" | "allowedCommands";
  readonly value: string;
  readonly problem:
    | "empty"
    | "nul"
    | "formatChar"
    | "notAbsolute"
    | "writableIsRoot"
    | "writableOutsideCwd";
}

/** 範囲の設定を検査する。空の一覧は妥当（何も許可しない）。 */
export function validateScope(scope: Scope, cwd: string): ScopeIssue[] {
  const issues: ScopeIssue[] = [];
  if (!cwd.startsWith("/")) issues.push({ field: "cwd", value: cwd, problem: "notAbsolute" });
  if (hasNul(cwd)) issues.push({ field: "cwd", value: cwd, problem: "nul" });
  const base = cwd.startsWith("/") ? cwd : "/";
  const location = (field: "writableLocations" | "forbiddenLocations", value: string): void => {
    if (value.trim() === "") issues.push({ field, value, problem: "empty" });
    else if (hasNul(value)) issues.push({ field, value, problem: "nul" });
    else if (hasFormatChar(value)) issues.push({ field, value, problem: "formatChar" });
    else if (field === "writableLocations") {
      const resolved = normalize(base, value);
      if (resolved === "/") issues.push({ field, value, problem: "writableIsRoot" });
      else if (!isUnder(resolved, normalize(base, "."))) {
        issues.push({ field, value, problem: "writableOutsideCwd" });
      }
    }
  };
  for (const v of scope.writableLocations) location("writableLocations", v);
  for (const v of scope.forbiddenLocations) location("forbiddenLocations", v);
  for (const v of scope.allowedCommands) {
    if (v.trim() === "") issues.push({ field: "allowedCommands", value: v, problem: "empty" });
    else if (hasNul(v)) issues.push({ field: "allowedCommands", value: v, problem: "nul" });
  }
  return issues;
}

function checkWrite(scope: Scope, cwd: string, rawPath: string): ScopeDecision {
  if (rawPath.trim() === "" || hasNul(rawPath) || hasFormatChar(rawPath)) {
    return deny("invalidPath", rawPath);
  }
  const path = normalize(cwd, rawPath);
  if (scope.forbiddenLocations.some((d) => isUnder(path, normalize(cwd, d)))) {
    return deny("forbiddenLocation", path);
  }
  if (!scope.writableLocations.some((d) => isUnder(path, normalize(cwd, d)))) {
    return deny("outsideWritable", path);
  }
  return ALLOW;
}

interface Segment {
  words: string[];
}

type Parsed =
  | { readonly ok: true; readonly segments: Segment[]; readonly background: boolean }
  | { readonly ok: false };

/** 最小限のシェル字句解析。引用符、区切り、置換・サブシェル・リダイレクト（拒否）、`&` を扱う。 */
function parseCommand(input: string): Parsed {
  const segments: Segment[] = [];
  let seg: Segment = { words: [] };
  let word = "";
  let inWord = false;
  let quote: "'" | '"' | null = null;
  let background = false;

  const endWord = (): void => {
    if (!inWord) return;
    seg.words.push(word);
    word = "";
    inWord = false;
  };
  const endSegment = (): void => {
    endWord();
    segments.push(seg);
    seg = { words: [] };
  };

  // NUL・CR などの制御文字は、シェルとの解釈の差が出やすいので判定しない。
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字の検出が目的
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(input)) return { ok: false };

  for (let i = 0; i < input.length; i++) {
    const c = input.charAt(i);
    const next = input.charAt(i + 1);
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    // 変数展開・コマンド置換・算術展開・ANSI-C 引用・履歴展開は、引用符（'）の外では判定できない。
    if (c === "`" || c === "$" || c === "!") return { ok: false };
    if (c === "\\" && next === "\n") {
      i++; // 行継続は取り除かれる
      continue;
    }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === "\\" && next !== "") word += input.charAt(++i);
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      inWord = true;
    } else if (c === "\\" && next !== "") {
      word += input.charAt(++i);
      inWord = true;
    } else if (c === "<" || c === ">" || c === "(" || c === ")") {
      return { ok: false };
    } else if (c === "&" && next === ">") {
      return { ok: false }; // `&>`
    } else if (c === "&") {
      if (next === "&") i++;
      else background = true;
      endSegment();
    } else if (c === "|") {
      if (next === "|" || next === "&") i++; // `||`、`|&`
      endSegment();
    } else if (c === ";" || c === "\n") {
      endSegment();
    } else if (c === " " || c === "\t") {
      endWord();
    } else {
      word += c;
      inWord = true;
    }
  }
  if (quote !== null) return { ok: false };
  endSegment();
  return { ok: true, segments, background };
}

const BACKGROUND_WORDS: ReadonlySet<string> = new Set(["nohup", "setsid", "disown"]);

/**
 * 別のコマンドを再解釈・実行するため、許可リストに入っていても拒否するコマンド（固定リスト）。
 * 先頭の語のベース名で照合する。許可リストでは範囲を絞れないものだけを入れる。
 */
const INDIRECT_EXECUTION: ReadonlySet<string> = new Set([
  "bash",
  "sh",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "eval",
  "exec",
  "source",
  ".",
  "xargs",
  "env",
  "command",
  "builtin",
  "sudo",
  "doas",
  "su",
  "time",
  "timeout",
  "nice",
  "ionice",
  "stdbuf",
  "script",
  "busybox",
  "chroot",
  "flock",
  "unshare",
  "nsenter",
  "strace",
  "watch",
]);

/** `find` は、別コマンドを実行・削除できる式を含むときだけ拒否する。 */
const FIND_EXECUTING = /^-(exec|execdir|ok|okdir|delete|fprint\w*|fls)$/;

const baseName = (word: string): string => word.slice(word.lastIndexOf("/") + 1).toLowerCase();

function checkCommand(scope: Scope, command: string): ScopeDecision {
  const parsed = parseCommand(command);
  if (!parsed.ok) return deny("unparsable", command);
  if (parsed.background) return deny("backgroundExecution", command);

  const nonEmpty = parsed.segments.filter((s) => s.words.length > 0);
  if (nonEmpty.length === 0) return deny("commandNotAllowed", command);

  for (const seg of nonEmpty) {
    const head = seg.words[0] ?? "";
    const name = baseName(head);
    if (BACKGROUND_WORDS.has(name)) return deny("backgroundExecution", command);
    if (
      INDIRECT_EXECUTION.has(name) ||
      (name === "find" && seg.words.some((w) => FIND_EXECUTING.test(w)))
    ) {
      return deny("indirectExecution", seg.words.join(" "));
    }
    const allowed = scope.allowedCommands.some((entry) => {
      const want = entry.trim().split(/\s+/);
      return want[0] !== "" && want.every((w, i) => seg.words[i] === w);
    });
    if (!allowed) return deny("commandNotAllowed", seg.words.join(" "));
  }
  return ALLOW;
}

/**
 * 操作が作業範囲に収まるかを判定する。
 * @param cwd 相対パスの基準（ノードの作業ツリー）。絶対パス。
 */
export function evaluateScope(scope: Scope, cwd: string, op: ScopeOperation): ScopeDecision {
  if (op.kind === "read") return ALLOW;
  const issue = validateScope(scope, cwd)[0];
  if (issue !== undefined) return deny("invalidScope", `${issue.field}: ${issue.problem}`);
  return op.kind === "write" ? checkWrite(scope, cwd, op.path) : checkCommand(scope, op.command);
}

/** 場所の判定（`normalize` と `isUnder`）を、他の判定（回収可能など）が同じ規則で使うための公開。 */
export { isUnder as isPathUnder, normalize as normalizePath };
