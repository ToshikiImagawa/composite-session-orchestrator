/**
 * フック（PreToolUse）の判定。ツール呼び出しを、core の `evaluateScope`（作業範囲の判定）に対応づける純粋関数。
 * PRD: FR_014, IR_002 / design 6.3
 *
 * - 読み込み系（Read・Glob・Grep・NotebookRead）と、読み取りのみで無害なツール（LS・TodoWrite・ToolSearch・BashOutput）は
 *   許可（FR_014: 読み込みは制限しない）。**例外**: 禁じる場所（stateDir・daemon の設定ファイル。`ProtectedPaths`）は、読み取りも
 *   拒否する（T21-pr）。Bash は、語のうちパスに見えるものだけを見る歯止めで、確実ではない（`docs/desktop-runtime.md`）。許可するツール名は T10b の実機確認で固定する。
 * - 書き込み系（Write・Edit・MultiEdit・NotebookEdit）は、対象のパス（絶対にして、最も深い既存の祖先を実パスにしたもの。
 *   リンク経由の範囲外への書き込みを防ぐ）を書き込みとして判定する。解決に失敗したら拒否する。
 *   フック入力の `cwd`（`HookInput.cwd`）は使わない。基準は、起動時に実パスにした作業ツリー。
 * - Bash は、コマンドとして判定する。`run_in_background` が `undefined`・`false` 以外、
 *   `dangerouslyDisableSandbox` が `true` なら拒否する（ADR 未決の既定）。
 * - 自ノードの MCP ツール（`mcp__node__*`）は許可する。権限の絞り込みは窓口のロール別の操作表（NFR_004）の責務。
 * - それ以外（別の MCP サーバー、サブエージェント、ウェブ、未知のツール）は拒否する（フェイルクローズ）。
 *   範囲の違反ではないため `violation` は持たず（`unknownTool`）、`scope.violation` として記録しない（受信箱に載せない）。
 * 例外を出さない: 入力の形が不正なら拒否する。
 */

import { commandWords, evaluateScope, type Scope, type ScopeViolationReason } from "@cso/core";

/** パスの実パス化（書き込み先の判定用）。解決できなければ reject する。 */
export type ResolvePath = (absPath: string) => Promise<string>;

export interface ToolViolation {
  readonly reason: ScopeViolationReason;
  /** 違反した場所またはコマンド（記録用）。 */
  readonly subject: string;
}

export type ToolDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      /** 範囲の違反（記録する）。未知のツールの拒否では持たない。 */
      readonly violation?: ToolViolation;
      /** 許可していないツールの名前（範囲の違反ではない）。 */
      readonly unknownTool?: string;
      /** モデルへ伝える理由（フックの拒否の理由）。 */
      readonly reason: string;
    };

const ALLOW: ToolDecision = { allow: true };

/**
 * 読み取りも禁じる場所（FR_014 の例外。T21-pr）。daemon が起動時に実パスにしたものを、全ノードで共通に使う。
 * `allow` は、禁じる場所の中で、そのノードに読み取りを許す場所（自分の HOME・子に渡す skill の写し）。
 */
export interface ProtectedPaths {
  readonly roots: readonly { readonly path: string; readonly kind: ProtectedKind }[];
  readonly allow: readonly string[];
  /** 子のシェルが `~` を展開する先（子の HOME）。なければ `~` で始まる語は禁じる場所の判定から外れない（拒否する）。 */
  readonly home?: string | undefined;
}
/** 禁じる場所の種類（拒否の文面と記録には、種類だけを出す。実パスは出さない）。 */
export type ProtectedKind = "stateDir" | "daemonConfig";
const KIND_TEXT: Readonly<Record<ProtectedKind, string>> = {
  stateDir: "daemon の状態の置き場",
  daemonConfig: "daemon の設定ファイル",
};

// APFS は大文字小文字・Unicode の正規化（NFD/NFC）の違いを区別しないので、比べる前にそろえる（区別する FS では、厳しめに倒れる）。
const fold = (x: string): string => x.normalize("NFC").toLowerCase();
const under = (p: string, root: string): boolean => {
  const a = fold(p);
  const b = fold(root);
  return a === b || a.startsWith(`${b}/`);
};
/** グロブ・波括弧・拡張グロブ（`@( +( !( ?( *(`）の文字。 */
const GLOB = /[*?[{]|[@+!?*]\(/;
/** 波括弧の展開の候補の上限（超えたら確かめきれないので拒否する）。 */
const BRACE_MAX = 64;

/**
 * 実パス `real` が、禁じる場所の中（`ancestorToo` なら、禁じる場所を含む祖先も）なら、その種類。許された場所の中なら undefined。
 * 祖先も禁じるのは、再帰的に読む道具（Glob・Grep・Bash の grep -r など）で、禁じる場所の中まで読まれるため。
 */
function protectedKind(
  real: string,
  p: ProtectedPaths,
  ancestorToo: boolean,
): ProtectedKind | undefined {
  if (p.allow.some((a) => under(real, a))) return undefined;
  for (const r of p.roots) {
    if (under(real, r.path)) return r.kind;
    if (ancestorToo && (real === "/" || fold(r.path).startsWith(`${fold(real)}/`))) return r.kind;
  }
  return undefined;
}

const denyProtected = (kind: ProtectedKind): ToolDecision => ({
  allow: false,
  violation: { reason: "forbiddenLocation", subject: `protected:${kind}` },
  reason: `作業範囲の外の操作です（${KIND_TEXT[kind]}は、読み取りもできません）。この場所は、作業に使いません。`,
});

/**
 * 波括弧を展開する（入れ子・カンマ・`a..b` の並びを含む）。候補が多すぎる・対応が取れないときは undefined（確かめきれない）。
 * 展開できない形の `{`（`{}` など）は、そのまま残る。
 */
export function expandBraces(word: string): string[] | undefined {
  let out = [word];
  for (let guard = 0; guard < 16; guard++) {
    const next: string[] = [];
    let changed = false;
    for (const w of out) {
      const e = expandOnce(w);
      if (e === "bad") return undefined;
      if (e === null) next.push(w);
      else {
        changed = true;
        next.push(...e);
      }
      if (next.length > BRACE_MAX) return undefined;
    }
    out = next;
    if (!changed) return out;
  }
  return undefined;
}

/** いちばん外側の、最初の展開できる `{…}` を 1 つ展開する。なければ null。 */
function expandOnce(w: string): string[] | null | "bad" {
  for (let i = 0; i < w.length; i++) {
    if (w[i] !== "{") continue;
    let depth = 0;
    const commas: number[] = [];
    let j = i;
    for (; j < w.length; j++) {
      const c = w[j];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      } else if (c === "," && depth === 1) commas.push(j);
    }
    if (j >= w.length) return "bad"; // 閉じていない
    const body = w.slice(i + 1, j);
    const pre = w.slice(0, i);
    const post = w.slice(j + 1);
    if (commas.length > 0) {
      const parts: string[] = [];
      let k = i + 1;
      for (const c of commas) {
        parts.push(w.slice(k, c));
        k = c + 1;
      }
      parts.push(w.slice(k, j));
      return parts.map((x) => pre + x + post);
    }
    const range = /^(-?\d+|[A-Za-z])\.\.(-?\d+|[A-Za-z])(\.\.-?\d+)?$/.exec(body);
    if (range !== null) return "bad"; // 並びの展開は、候補が多くなりうるので確かめない（拒否）
    // `{}`・`{x}` は展開されない。次の `{` を探す
    i = j;
  }
  return null;
}

/** 語の固定の部分（最初のグロブの文字を含む段より前）。 */
const fixedPrefix = (word: string): string => {
  if (!GLOB.test(word)) return word;
  const parts = word.split("/");
  const i = parts.findIndex((x) => GLOB.test(x));
  const head = parts.slice(0, i).join("/");
  return head === "" ? (word.startsWith("/") ? "/" : ".") : head;
};

/**
 * パスを、禁じる場所と照らす。波括弧は展開して、候補をすべて確かめる。`~` と `~/…` は子の HOME で展開し、それ以外の `~`
 * で始まる形（`~root`・`~+`・`~-` など）は確かめきれないので拒否する。実パスにできなければ拒否する（フェイルクローズ）。
 */
async function checkProtectedPath(
  raw: string,
  cwds: readonly string[],
  p: ProtectedPaths,
  resolve: ResolvePath,
  ancestorToo: boolean,
): Promise<ProtectedKind | "unresolvable" | undefined> {
  const candidates = expandBraces(raw);
  if (candidates === undefined) return "unresolvable";
  for (const c of candidates) {
    let path = fixedPrefix(c);
    const glob = path !== c;
    if (path.startsWith("~")) {
      if (!(path === "~" || path.startsWith("~/")) || p.home === undefined) return "unresolvable";
      path = p.home + path.slice(1);
    }
    for (const cwd of path.startsWith("/") ? [cwds[0] ?? "/"] : cwds) {
      const abs = path.startsWith("/") ? path : `${cwd}/${path}`;
      let real: string;
      try {
        real = await resolve(abs);
      } catch {
        return "unresolvable";
      }
      const k = protectedKind(real, p, ancestorToo || glob);
      if (k !== undefined) return k;
    }
  }
  return undefined;
}

/** 語がパスに見えるか（/ を含む・~ で始まる・. と ..）。 */
const pathLike = (x: string): boolean =>
  x === "." || x === ".." || x.includes("/") || x.startsWith("~");

/**
 * Bash の命令の、パスに見える語を、禁じる場所と照らす。
 * - 語全体に加えて、語の中の `/` のたびに、その位置から後ろも絶対パスとして確かめる（`-C/path`・`a=b=/p`・`x:/p` など）。
 *   語の途中から切り出した部分は、祖先の判定をしない（`src/` の末尾の `/` などで、作業を妨げないため）。
 * - `cd`・`pushd` を順に追い、相対の語は、元の作業ツリーと、それまでに移った先のすべてを基準に確かめる（パイプの中の cd は
 *   続かないが、厳しめに倒す）。行き先を確かめきれない `cd`（`cd -`・`popd`・グロブなど）は拒否する。
 */
async function checkBash(
  command: string,
  cwd: string,
  p: ProtectedPaths,
  resolve: ResolvePath,
): Promise<ProtectedKind | "unresolvable" | undefined> {
  const segs = commandWords(command);
  if (segs === undefined) return undefined; // 解析できない命令は、範囲の判定が拒否する
  const cwds: string[] = [cwd];
  for (const words of segs) {
    const name = words[0];
    if (name === "popd") return "unresolvable";
    for (const w of words) {
      if (pathLike(w)) {
        const k = await checkProtectedPath(w, cwds, p, resolve, true);
        if (k !== undefined) return k;
      }
      for (let i = w.indexOf("/", 1); i > 0; i = w.indexOf("/", i + 1)) {
        const tail = w.slice(i);
        if (tail === "/") continue;
        const k = await checkProtectedPath(tail, cwds, p, resolve, false);
        if (k !== undefined) return k;
      }
    }
    if (name === "cd" || name === "pushd") {
      const args = words.slice(1).filter((x) => !(x.startsWith("-") && x !== "-"));
      const target = args[0];
      if (args.length > 1 || target === "-" || (target !== undefined && GLOB.test(target)))
        return "unresolvable";
      let dest: string | undefined;
      if (target === undefined) dest = p.home;
      else if (target.startsWith("~")) {
        if (!(target === "~" || target.startsWith("~/")) || p.home === undefined)
          return "unresolvable";
        dest = p.home + target.slice(1);
      } else dest = target;
      if (dest === undefined) return "unresolvable";
      const next: string[] = [];
      for (const base of dest.startsWith("/") ? [cwd] : cwds) {
        try {
          next.push(await resolve(dest.startsWith("/") ? dest : `${base}/${dest}`));
        } catch {
          return "unresolvable";
        }
      }
      cwds.push(...next);
    }
  }
  return undefined;
}

/** 読み取りの道具 → 対象のパスを持つ入力のキーと、再帰的に読むか。 */
const READ_PATHS: Readonly<
  Record<string, { readonly keys: readonly string[]; readonly recursive: boolean }>
> = {
  Read: { keys: ["file_path"], recursive: false },
  NotebookRead: { keys: ["notebook_path"], recursive: false },
  LS: { keys: ["path"], recursive: false },
  Glob: { keys: ["path"], recursive: true },
  Grep: { keys: ["path"], recursive: true },
};

/** 禁じる場所の判定（読み取りの道具と Bash の引数。書き込みの道具は見ない）。禁じる場所がなければ、何もしない（undefined）。 */
async function checkProtected(
  p: ProtectedPaths | undefined,
  cwd: string,
  toolName: string,
  toolInput: unknown,
  resolve: ResolvePath,
): Promise<ToolDecision | undefined> {
  if (p === undefined || p.roots.length === 0) return undefined;
  const input = isRec(toolInput) ? toolInput : {};
  const verdict = (
    k: ProtectedKind | "unresolvable" | undefined,
    subject: string,
  ): ToolDecision | undefined =>
    k === undefined
      ? undefined
      : k === "unresolvable"
        ? deny("invalidPath", subject)
        : denyProtected(k);
  const spec = Object.hasOwn(READ_PATHS, toolName) ? READ_PATHS[toolName] : undefined;
  if (spec !== undefined) {
    const paths = spec.keys
      .map((k) => input[k])
      .filter((v): v is string => typeof v === "string" && v !== "");
    // Glob・Grep で path がなければ、作業ツリーを読む。Glob の pattern は、絶対でも相対でも、基準につないで確かめる。
    if (toolName === "Glob" && typeof input.pattern === "string") {
      const base = paths[0] ?? cwd;
      const pat = input.pattern;
      paths.push(pat.startsWith("/") || pat.startsWith("~") ? pat : `${base}/${pat}`);
    }
    for (const path of paths) {
      const d = verdict(
        await checkProtectedPath(path, [cwd], p, resolve, spec.recursive),
        `${toolName}（パスを確かめられない）`,
      );
      if (d !== undefined) return d;
    }
    return undefined;
  }
  // 書き込みは、今の範囲の決まり（書き込みを許可する場所）のまま判定する（ここでは見ない）。
  if (toolName === "Bash" && typeof input.command === "string") {
    return verdict(await checkBash(input.command, cwd, p, resolve), "Bash（パスを確かめられない）");
  }
  return undefined;
}

const READ_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "NotebookRead",
  "LS",
  "TodoWrite",
  "ToolSearch",
  "BashOutput",
  // skill を読む（T22-c）。中身は SKILL.md の文で、書き込み・コマンドの実行は、それぞれのツールの判定を通る。
  "Skill",
]);
/** 書き込み系のツール → 対象のパスを持つ入力のキー。 */
const WRITE_TOOLS: Readonly<Record<string, string>> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};
const OWN_MCP_PREFIX = "mcp__node__";

const isRec = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const deny = (reason: ScopeViolationReason, subject: string): ToolDecision => ({
  allow: false,
  violation: { reason, subject },
  reason: `作業範囲の外の操作です（${reason}: ${subject}）。範囲の拡張が必要なら、親へ拡張要求を出してください。`,
});

const denyUnknown = (tool: string): ToolDecision => ({
  allow: false,
  unknownTool: tool,
  reason: `ツール ${tool} は、このノードでは使えない。`,
});

/** scope の場所（writable・forbidden）を実パスにする。解決できない writable は落とし、forbidden は絶対パスのまま残す。 */
export async function resolveScope(
  scope: Scope,
  cwd: string,
  resolve: ResolvePath,
): Promise<Scope> {
  const abs = (d: string): string => (d.startsWith("/") ? d : `${cwd}/${d}`);
  const real = async (d: string): Promise<string | undefined> => {
    if (typeof d !== "string" || d.trim() === "" || d.includes("\0")) return undefined;
    try {
      return await resolve(abs(d));
    } catch {
      return undefined;
    }
  };
  const writable: string[] = [];
  for (const d of scope.writableLocations) {
    const r = await real(d);
    if (r !== undefined) writable.push(r);
  }
  const forbidden: string[] = [];
  for (const d of scope.forbiddenLocations) {
    if (typeof d !== "string") continue;
    forbidden.push((await real(d)) ?? abs(d));
  }
  return { ...scope, writableLocations: writable, forbiddenLocations: forbidden };
}

/** `scope` は `resolveScope` で実パスにしたもの、`cwd` は実パスの作業ツリー。 */
export async function decideToolUse(
  scope: Scope,
  cwd: string,
  toolName: string,
  toolInput: unknown,
  resolve: ResolvePath,
  protectedPaths?: ProtectedPaths,
): Promise<ToolDecision> {
  if (typeof toolName !== "string") return denyUnknown("(ツール名が不正)");
  // 禁じる場所（FR_014 の例外）は、読み取りの道具も含めて、ほかの判定より先に見る。
  const prot = await checkProtected(protectedPaths, cwd, toolName, toolInput, resolve);
  if (prot !== undefined) return prot;
  if (READ_TOOLS.has(toolName)) return ALLOW;

  if (Object.hasOwn(WRITE_TOOLS, toolName)) {
    const key = WRITE_TOOLS[toolName] as string;
    const path = isRec(toolInput) ? toolInput[key] : undefined;
    if (typeof path !== "string" || path.trim() === "")
      return deny("invalidPath", `${toolName}（${key} がない）`);
    let target: string;
    try {
      target = await resolve(path.startsWith("/") ? path : `${cwd}/${path}`);
    } catch {
      return deny("invalidPath", `${path}（実パスを解決できない）`);
    }
    const d = evaluateScope(scope, cwd, { kind: "write", path: target });
    if (d.allowed) return ALLOW;
    // 判定は今の範囲の決まりのまま。ただし、対象が禁じる場所の中なら、件名（記録と文面）には種類だけを書く（実パスを出さない）
    const hidden = protectedPaths?.roots.find((r) => under(target, r.path));
    return deny(d.reason, hidden === undefined ? d.subject : `protected:${hidden.kind}`);
  }

  if (toolName === "Bash") {
    const command = isRec(toolInput) ? toolInput.command : undefined;
    if (typeof command !== "string" || command.trim() === "")
      return deny("commandNotAllowed", "Bash（command がない）");
    const input = toolInput as Record<string, unknown>;
    if (input.run_in_background !== undefined && input.run_in_background !== false)
      return deny("backgroundExecution", command);
    if (input.dangerouslyDisableSandbox === true)
      return deny("commandNotAllowed", `${command}（dangerouslyDisableSandbox）`);
    const d = evaluateScope(scope, cwd, { kind: "command", command });
    return d.allowed ? ALLOW : deny(d.reason, d.subject);
  }

  if (toolName.startsWith(OWN_MCP_PREFIX) && toolName.length > OWN_MCP_PREFIX.length) return ALLOW;
  return denyUnknown(toolName === "" ? "(ツール名が空)" : toolName);
}
