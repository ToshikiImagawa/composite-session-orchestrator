/**
 * 作業範囲の違反判定（純粋関数）。フックの入力から呼ばれ、許可・拒否を決定的に返す。
 * PRD: FR_014, FR_015, IR_002 / spec 5.5, design 6.3
 *
 * - 読み込みは制限しない。
 * - 書き込みは、禁止場所に入らず、かつ許可場所の配下であること（禁止が優先）。
 * - コマンドは、全部分が許可コマンドに一致すること。
 * - 判定できないもの（コマンド置換、サブシェル、リダイレクト `<` `>`）とバックグラウンド起動（既定。ADR 未決）は拒否する。
 * - パスは正規化済みの入力を前提とする。シンボリックリンクの実パス解決は daemon のアダプタの責務で、ここでは行わない。
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
  | "unparsable";

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

const isUnder = (path: string, dir: string): boolean =>
  dir === "/" || path === dir || path.startsWith(`${dir}/`);

function checkWrite(scope: Scope, cwd: string, rawPath: string): ScopeDecision {
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

  for (let i = 0; i < input.length; i++) {
    const c = input.charAt(i);
    const next = input.charAt(i + 1);
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (c === "`" || (c === "$" && next === "(")) return { ok: false };
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
    } else if (c === "&") {
      if (next === "&") i++;
      else background = true;
      endSegment();
    } else if (c === "|") {
      if (next === "|") i++;
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

function checkCommand(scope: Scope, cwd: string, command: string): ScopeDecision {
  const parsed = parseCommand(command);
  if (!parsed.ok) return deny("unparsable", command);
  if (parsed.background) return deny("backgroundExecution", command);

  const nonEmpty = parsed.segments.filter((s) => s.words.length > 0);
  if (nonEmpty.length === 0) return deny("commandNotAllowed", command);

  for (const seg of nonEmpty) {
    const head = seg.words[0];
    if (head !== undefined && BACKGROUND_WORDS.has(head)) {
      return deny("backgroundExecution", command);
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
  switch (op.kind) {
    case "read":
      return ALLOW;
    case "write":
      return checkWrite(scope, cwd, op.path);
    case "command":
      return checkCommand(scope, cwd, op.command);
  }
}
