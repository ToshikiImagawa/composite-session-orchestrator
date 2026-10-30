/**
 * `cso child bind`・`cso child report`（Desktop の子が使う。課題 1 の ①。T21-cc）。
 *
 * 子の引き出し `<D>/<鍵>/`（daemon が先に 0700 で作る。`docs/desktop-runtime.md` の「子の引き出し」）に置いたファイルだけで、
 * daemon に紐付けて報告する。コード・トークンを、コマンドの引数にも、標準出力・標準エラーにも出さない（M2・M6）。
 *
 * - `bind --dir <引き出し> --url <窓口>`: 子が Write の道具で書いた `code` を確かめて読み、送る前に消す。`node`（daemon が書いた
 *   ノード ID）と一緒に `POST /v1/bind` へ送り、受け取ったトークンを `token` に、窓口の URL を `url` に置く（一時ファイルに
 *   O_EXCL・O_NOFOLLOW・0600 で書いて rename）。標準出力は結果の記号 1 行だけ。
 * - `report --dir <引き出し> --url <窓口> <操作>`: 子のロールの 5 つの操作だけ（M7）。本文は、子が Write で書いた引き出しの `report`（cso が読んで、送る前に消す）。`--url` が `url` のファイルと
 *   違えば送らない（別の daemon にトークンを送らない）。期限切れ（`tokenExpired`）なら `token` を消して、結び直しを案内する。
 *
 * ファイルは、lstat で持ち主・種類・権限・リンクの数を確かめてから O_NOFOLLOW で開き、fstat で同じものかを確かめて読む（M3）。
 * 同じユーザーの攻撃（確かめたあとの差し替え）には、完全には耐えない（引き出しの 0700 が守りの本体）。
 */
import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  type Stats,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import {
  createIdentityVerifier,
  createRelay,
  IDENTITY_FILE,
  type IdentityVerifier,
} from "@cso/mcp/relay";
import type { CommandResult } from "./commands.js";

/** 引き出しの中のファイルの名前。 */
export const CHILD_FILES = {
  /** 紐付けのコード（子が Write で書く。cso が読んだらすぐ消す）。 */
  code: "code",
  /** ノードのトークン（cso が書く。0600）。 */
  token: "token",
  /** 紐付けた窓口の URL（cso が書く。0600）。 */
  url: "url",
  /** ノード ID（daemon が引き出しを作るときに書く。0600）。 */
  node: "node",
  /** 報告の本文（子が Write で書く。cso が読んだらすぐ消す。T21-cb R1）。 */
  report: "report",
  /** フック専用のトークン（daemon が spawn・bindCode で書く。0600。`cso child hook` が読む。T21-ch）。 */
  hookToken: "hook-token",
} as const;
/** 一時ファイルの名前の頭（`token.tmp-<乱数>` など）。hook-policy が、Bash の語でこの名前を拒む。 */
export const TMP_SUFFIX = ".tmp-";

/** 報告の引数 → 操作（子のロールの操作だけ。M7）。 */
export const REPORT_OPERATIONS = {
  progress: "report.progress",
  "out-of-scope": "report.outOfScope",
  decision: "report.decision",
  done: "report.done",
  "scope-extend": "scope.extend",
} as const;
type ReportArg = keyof typeof REPORT_OPERATIONS;
/** 本文が文（`{ text }`）の操作。ほかは JSON の params。 */
const TEXT_BODY: ReadonlySet<ReportArg> = new Set(["progress", "out-of-scope"]);

const CODE_MAX = 64;
const TOKEN_MAX = 8192;
const URL_MAX = 2048;
const NODE_MAX = 256;
/** 報告の本文の大きさの上限（daemon の文の上限〔数千字〕と、done の証拠の JSON に見合う値）。 */
const REPORT_MAX = 64 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TOKEN_FORMAT = /^[\x21-\x7e]+$/;
const BIND_TIMEOUT_MS = 30_000;

export interface ChildDeps {
  /** 標準入力の全部（`cso child hook` のフック入力）。 */
  readonly readStdin?: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly newRequestId: () => string;
  /** 自分の uid（既定は `process.getuid()`）。 */
  readonly uid?: number;
  /** 試験用: lstat で確かめたあと、開く前に呼ぶ（差し替えの試験）。 */
  readonly afterCheck?: (path: string) => void;
  /**
   * daemon の身元の検証を作る（既定は `createIdentityVerifier`。cso・cso-mcp と同じ仕組み）。秘密のファイルは、引き出しから
   * 決まる `<stateDir>/daemon-identity`（引き出しは `<stateDir>/children.noindex/<鍵>`）。試験で差し替える。
   */
  readonly verifierFor?: (daemonUrl: string, identityPath: string) => IdentityVerifier;
}

/** 引き出しの置き場の名前（daemon の `children-dir.ts` の `CHILDREN_DIR` と同じ）。 */
export const CHILDREN_DIR_NAME = "children.noindex";

/** 引き出し `<stateDir>/children.noindex/<鍵>` から、daemon の身元の秘密のファイル。形が違えば undefined。 */
export function identityPathOf(dir: string): string | undefined {
  const parent = dirname(dir);
  if (basename(parent) !== CHILDREN_DIR_NAME) return undefined;
  return join(dirname(parent), IDENTITY_FILE);
}

/** 文面のコード・トークンを伏せ、制御文字を除き、長さを切る（daemon の失敗の文面を出す前）。 */
function clean(text: string, secrets: readonly string[], max: number): string {
  let t = text;
  for (const s of secrets) if (s !== "") t = t.split(s).join("***");
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を取り除く
  return t.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max);
}

/** 身元を確かめる。失敗なら、送らずに返す結果。 */
async function verifyDaemon(
  dir: string,
  origin: string,
  deps: Pick<ChildDeps, "verifierFor" | "fetch">,
): Promise<{ readonly verifier: IdentityVerifier } | CommandResult> {
  const identityPath = identityPathOf(dir);
  if (identityPath === undefined) {
    return failed(
      "dirInvalid",
      1,
      "引き出しの場所が、daemon の置き場（children.noindex）の中でない",
    );
  }
  const verifier =
    deps.verifierFor?.(origin, identityPath) ??
    createIdentityVerifier({
      daemonUrl: origin,
      identityPath,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
  const v = await verifier.verify();
  if (!v.ok) {
    return failed(
      "daemonIdentityFailed",
      1,
      "窓口の相手が、引き出しを作った daemon か確かめられない（コード・トークンは送っていない）",
      "紐付けの文面の URL を、そのまま書く。daemon が動いているか、人に確かめてもらう",
    );
  }
  return { verifier };
}

const ASK_HUMAN =
  "報告できないので、会話で人（親）に、node.bindCode で紐付けの文面を出し直してもらうよう頼む";

/** 失敗（標準出力は記号 1 行。理由と次の操作は標準エラー）。 */
const failed = (
  code: string,
  exitCode: CommandResult["exitCode"],
  ...lines: string[]
): CommandResult => ({
  exitCode,
  stdout: `${code}\n`,
  stderr: lines.length === 0 ? "" : `${lines.join("\n")}\n`,
});
const usage = (cause: string): CommandResult =>
  failed(
    "usage",
    2,
    cause,
    "使い方: cso child bind --dir <引き出しの絶対パス> --url <窓口の URL>",
    "        cso child report --dir <引き出しの絶対パス> --url <窓口の URL> <progress|out-of-scope|decision|done|scope-extend>（本文は、引き出しの report のファイル）",
  );

class FileCheckError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 引き出し: 絶対パスの、実のディレクトリ（リンクでない）・持ち主が自分・0700。 */
function checkDir(dir: string, uid: number): void {
  let st: Stats;
  try {
    st = lstatSync(dir);
  } catch (e) {
    throw new FileCheckError("dirInvalid", `引き出しを確かめられない（${codeOf(e)}）`);
  }
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new FileCheckError("dirInvalid", "引き出しが実のディレクトリでない");
  }
  if (st.uid !== uid) throw new FileCheckError("dirInvalid", "引き出しの持ち主が自分でない");
  if ((st.mode & 0o777) !== 0o700) throw new FileCheckError("dirInvalid", "引き出しが 0700 でない");
}

const codeOf = (e: unknown): string =>
  typeof (e as { code?: unknown })?.code === "string" ? (e as { code: string }).code : "unknown";

/**
 * 引き出しの中のファイルを確かめて読む。通常のファイル・リンクでない・持ち主が自分・リンクの数が 1・大きさの上限。
 * `strict` なら、グループ・他者の権限がないこと（cso・daemon が書いた 0600 のファイル）。子が Write で書いた `code` は 0644 に
 * なるので（V3）、書き込みの権限がないことだけを見る。
 */
function readChecked(
  path: string,
  opts: { readonly max: number; readonly strict: boolean; readonly name: string },
  deps: Pick<ChildDeps, "afterCheck">,
  uid: number,
): string {
  let st: Stats;
  try {
    st = lstatSync(path);
  } catch (e) {
    const c = codeOf(e);
    throw new FileCheckError(
      c === "ENOENT" ? `${opts.name}Missing` : `${opts.name}Invalid`,
      `${opts.name} のファイルを確かめられない（${c}）`,
    );
  }
  const bad = (why: string) => new FileCheckError(`${opts.name}Invalid`, `${opts.name} の${why}`);
  if (!st.isFile() || st.isSymbolicLink()) throw bad("ファイルが通常のファイルでない");
  if (st.uid !== uid) throw bad("ファイルの持ち主が自分でない");
  if (st.nlink !== 1) throw bad("ファイルのリンクの数が 1 でない");
  if ((st.mode & (opts.strict ? 0o077 : 0o022)) !== 0) throw bad("ファイルの権限が緩い");
  if (st.size > opts.max) throw bad("ファイルが大きすぎる");
  deps.afterCheck?.(path);
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    throw new FileCheckError(
      `${opts.name}Invalid`,
      `${opts.name} のファイルを開けない（${codeOf(e)}）`,
    );
  }
  try {
    const f = fstatSync(fd);
    if (
      f.ino !== st.ino ||
      f.dev !== st.dev ||
      !f.isFile() ||
      f.uid !== uid ||
      f.nlink !== 1 ||
      (f.mode & (opts.strict ? 0o077 : 0o022)) !== 0 ||
      f.size > opts.max
    ) {
      throw bad("ファイルが、確かめたあとに差し替えられた");
    }
    const buf = Buffer.alloc(opts.max + 1);
    let n = 0;
    for (;;) {
      const r = readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > opts.max) throw bad("ファイルが大きすぎる");
    }
    return buf.subarray(0, n).toString("utf8").trim();
  } finally {
    closeSync(fd);
  }
}

/** 一時ファイル（O_EXCL・O_NOFOLLOW・0600）に書いて fsync し、rename で置く。失敗したら一時ファイルを消す。 */
function writeAtomic(dir: string, name: string, content: string): void {
  const tmp = join(dir, `${name}${TMP_SUFFIX}${randomBytes(8).toString("hex")}`);
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      writeSync(fd, `${content}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, join(dir, name));
    // rename を確かに残す（ディレクトリの fsync）
    const dfd = openSync(dir, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      // 消せなくても、元の失敗を返す
    }
    throw e;
  }
}

const removeQuietly = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    // ないときは何もしない
  }
};

/** 窓口の URL: ループバックの http(s)。ユーザー名・パスワード・パス・クエリなし。正規の形（origin）を返す。 */
function loopbackOrigin(url: string): string | undefined {
  if (url.length > URL_MAX) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
  if (!LOOPBACK.has(u.hostname) || u.username !== "" || u.password !== "") return undefined;
  if ((u.pathname !== "/" && u.pathname !== "") || u.search !== "" || u.hash !== "")
    return undefined;
  return u.origin;
}

interface Parsed {
  readonly dir: string;
  readonly url: string;
  readonly requestId?: string;
  readonly positional: readonly string[];
}

function parse(args: readonly string[], allowRequestId: boolean): Parsed | string {
  let dir: string | undefined;
  let url: string | undefined;
  let requestId: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    const next = (): string | undefined => {
      i += 1;
      return args[i];
    };
    if (a === "--dir") dir = next();
    else if (a === "--url") url = next();
    else if (a === "--request-id" && allowRequestId) requestId = next();
    else if (a.startsWith("-")) return `不明な指定: ${a}`;
    else positional.push(a);
  }
  if (dir === undefined || dir === "" || !isAbsolute(dir))
    return "--dir に、引き出しの絶対パスを指定する";
  if (url === undefined || url === "") return "--url に、窓口の URL を指定する";
  if (requestId !== undefined && !/^[A-Za-z0-9._:-]{1,128}$/.test(requestId)) {
    return "--request-id の形が不正";
  }
  return { dir, url, ...(requestId === undefined ? {} : { requestId }), positional };
}

const uidOf = (deps: Pick<ChildDeps, "uid">): number =>
  deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : -1);

/** `cso child <bind|report> ...`。 */
export async function runChild(argv: readonly string[], deps: ChildDeps): Promise<CommandResult> {
  const [sub, ...rest] = argv;
  if (sub === "bind") return bind(rest, deps);
  if (sub === "report") return report(rest, deps);
  if (sub === "hook") return hook(rest, deps);
  return usage("cso child の次に、bind・report・hook のどれかを指定する");
}

const HOOK_TIMEOUT_MS = 8000;
const HOOK_INPUT_MAX = 1024 * 1024;

/**
 * `cso child hook --dir <引き出し> --url <窓口>`（Claude Code のフックのコマンド。T21-ch）。標準入力のフック入力を、引き出しの
 * `hook-token` で `POST /v1/hook` へ送り、判定を Claude Code の形で返す: 許可は終了コード 0、拒否は 2（標準エラーの文が、拒否の
 * 理由としてモデルに伝わる）。PreToolUse（と、名前の分からないイベント）は、フェイルクローズ（届かない・形が違う・身元を確かめられない
 * のどれでも拒否）。PostToolUse・Stop は判定しないので、失敗しても 0（作業を止めない）。トークンは出さない。
 */
async function hook(args: readonly string[], deps: ChildDeps): Promise<CommandResult> {
  const input = (await deps.readStdin?.()) ?? "";
  let event: unknown;
  try {
    event = (JSON.parse(input) as { hook_event_name?: unknown })?.hook_event_name;
  } catch {
    event = undefined;
  }
  const guarding = !(event === "PostToolUse" || event === "Stop");
  const PREFIX = "[cso child hook]";
  const fail = (why: string): CommandResult =>
    guarding
      ? { exitCode: 2, stdout: "", stderr: `${PREFIX} 拒否: ${why}\n` }
      : { exitCode: 0, stdout: "", stderr: `${PREFIX} 記録できなかった: ${why}\n` };
  const p = parse(args, false);
  if (typeof p === "string") return fail(`フックのコマンドの指定が正しくない（${p}）`);
  const origin = loopbackOrigin(p.url);
  if (origin === undefined) return fail("フックのコマンドの --url が、ループバックの窓口でない");
  if (input.length > HOOK_INPUT_MAX) return fail("フック入力が大きすぎる");
  if (event === undefined) return fail("フック入力が JSON でない");
  const uid = uidOf(deps);
  let token: string;
  try {
    checkDir(p.dir, uid);
    token = readChecked(
      join(p.dir, CHILD_FILES.hookToken),
      { max: TOKEN_MAX, strict: true, name: "hookToken" },
      deps,
      uid,
    );
  } catch (e) {
    if (e instanceof FileCheckError) return fail(`${e.message}（人に知らせる）`);
    throw e;
  }
  const verified = await verifyDaemon(p.dir, origin, deps);
  if (!("verifier" in verified))
    return fail("窓口の相手が、引き出しを作った daemon か確かめられない");
  const doFetch = deps.fetch ?? globalThis.fetch;
  let status: number;
  let json:
    | {
        ok?: unknown;
        value?: { decision?: unknown; reason?: unknown };
        error?: { cause?: unknown };
      }
    | undefined;
  try {
    const res = await doFetch(`${origin}/v1/hook`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: input,
      redirect: "error",
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    json = text.length > HOOK_INPUT_MAX ? undefined : JSON.parse(text);
  } catch {
    return fail("daemon の受け口に届かない（daemon が動いているか、人に確かめてもらう）");
  }
  const hide = (s: string): string => clean(s, [token], 1000);
  if (status !== 200 || json?.ok !== true) {
    const cause = typeof json?.error?.cause === "string" ? `: ${hide(json.error.cause)}` : "";
    return fail(`daemon が受け付けなかった（HTTP ${status}${cause}）`);
  }
  const decision = json.value?.decision;
  if (decision === "allow") return { exitCode: 0, stdout: "", stderr: "" };
  if (decision === "deny" && guarding) {
    const reason =
      typeof json.value?.reason === "string" ? hide(json.value.reason) : "範囲外の操作";
    return { exitCode: 2, stdout: "", stderr: `${reason}\n` };
  }
  return fail("daemon の応答の形が正しくない");
}

async function bind(args: readonly string[], deps: ChildDeps): Promise<CommandResult> {
  const p = parse(args, false);
  if (typeof p === "string") return usage(p);
  if (p.positional.length > 0) return usage("bind は、--dir と --url のほかに引数を取らない");
  const origin = loopbackOrigin(p.url);
  if (origin === undefined) {
    return usage(
      "--url は、ループバック（127.0.0.1・localhost・[::1]）の http(s) の窓口だけ（パスなし）",
    );
  }
  const uid = uidOf(deps);
  const codePath = join(p.dir, CHILD_FILES.code);
  let code: string;
  let nodeId: string;
  try {
    checkDir(p.dir, uid);
    // 先に node（daemon が書いたもの）を確かめる。引き出しが daemon のものでなければ、code に触れない
    nodeId = readChecked(
      join(p.dir, CHILD_FILES.node),
      { max: NODE_MAX, strict: true, name: "node" },
      deps,
      uid,
    );
    try {
      code = readChecked(codePath, { max: CODE_MAX, strict: false, name: "code" }, deps, uid);
    } finally {
      // 読めても読めなくても、送る前に消す（コードを残さない。一度きりなので、失敗したら出し直してもらう）
      removeQuietly(codePath);
    }
  } catch (e) {
    if (e instanceof FileCheckError) {
      return failed(
        e.code,
        1,
        e.message,
        "親か人に、node.bindCode で紐付けの文面を出し直してもらう",
      );
    }
    throw e;
  }
  if (code === "")
    return failed(
      "codeInvalid",
      1,
      "code のファイルが空",
      "親か人に、node.bindCode で紐付けの文面を出し直してもらう",
    );
  const verified = await verifyDaemon(p.dir, origin, deps);
  if (!("verifier" in verified)) return verified;
  const doFetch = deps.fetch ?? globalThis.fetch;
  let status: number;
  let body: unknown;
  try {
    const res = await doFetch(`${origin}/v1/bind`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nodeId, bindCode: code }),
      redirect: "error",
      signal: AbortSignal.timeout(BIND_TIMEOUT_MS),
    });
    status = res.status;
    const text = await res.text();
    body = text.length > 1024 * 1024 ? undefined : JSON.parse(text);
  } catch {
    return failed(
      "bindUnknown",
      1,
      "窓口から応答を受け取れなかった（紐付けできたかは分からない。コードは消した）",
      "窓口の URL を確かめ、親か人に、node.bindCode で紐付けの文面を出し直してもらう",
    );
  }
  const v = (body as { ok?: unknown; value?: { token?: unknown }; error?: unknown }) ?? {};
  if (status === 200 && v.ok === true && typeof v.value?.token === "string") {
    const token = v.value.token;
    if (token.length > TOKEN_MAX || !TOKEN_FORMAT.test(token)) {
      return failed("bindUnknown", 1, "窓口の応答のトークンの形が不正", "親か人に知らせる");
    }
    // 先に url、そのあと token を置く（token があれば url もある）。token を置けなければ url も消す
    try {
      writeAtomic(p.dir, CHILD_FILES.url, origin);
      try {
        writeAtomic(p.dir, CHILD_FILES.token, token);
      } catch (e) {
        removeQuietly(join(p.dir, CHILD_FILES.url));
        throw e;
      }
    } catch (e) {
      return failed(
        "tokenSaveFailed",
        1,
        `トークンを引き出しに置けなかった（${codeOf(e)}）`,
        "親か人に、node.bindCode で紐付けの文面を出し直してもらう",
      );
    }
    return { exitCode: 0, stdout: "bound\n", stderr: "" };
  }
  const out = daemonFailure(v.error, status === 429 ? "rateLimited" : "bindFailed", [code]);
  return out.stdout === "unauthenticated\n"
    ? { ...out, stderr: `${out.stderr}${ASK_HUMAN}\n` }
    : out;
}

/** daemon の失敗を、記号（標準出力）と、理由・次の操作（標準エラー）にする。トークンは含まれない（daemon の失敗の文面）。 */
function daemonFailure(
  error: unknown,
  fallback: string,
  secrets: readonly string[] = [],
): CommandResult {
  const e = error as { code?: unknown; cause?: unknown; nextActions?: unknown } | undefined;
  const code =
    typeof e?.code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.code) ? e.code : fallback;
  const lines: string[] = [];
  if (typeof e?.cause === "string") lines.push(clean(e.cause, secrets, 500));
  if (Array.isArray(e?.nextActions)) {
    for (const a of e.nextActions.slice(0, 5))
      if (typeof a === "string") lines.push(`次の操作: ${clean(a, secrets, 300)}`);
  }
  return failed(code, 1, ...lines);
}

async function report(args: readonly string[], deps: ChildDeps): Promise<CommandResult> {
  const p = parse(args, true);
  if (typeof p === "string") return usage(p);
  const [arg, ...extra] = p.positional;
  if (arg === undefined || extra.length > 0 || !Object.hasOwn(REPORT_OPERATIONS, arg)) {
    return usage(
      "報告の種類を 1 つ指定する（progress・out-of-scope・decision・done・scope-extend）",
    );
  }
  const kind = arg as ReportArg;
  const origin = loopbackOrigin(p.url);
  if (origin === undefined) {
    return usage(
      "--url は、ループバック（127.0.0.1・localhost・[::1]）の http(s) の窓口だけ（パスなし）",
    );
  }
  const uid = uidOf(deps);
  let token: string;
  try {
    checkDir(p.dir, uid);
    const bound = readChecked(
      join(p.dir, CHILD_FILES.url),
      { max: URL_MAX, strict: true, name: "url" },
      deps,
      uid,
    );
    if (loopbackOrigin(bound) !== origin) {
      return failed(
        "urlMismatch",
        1,
        "--url が、紐付けた窓口と違う（トークンを送らなかった）",
        "紐付けの文面の URL を、そのまま書く",
      );
    }
    token = readChecked(
      join(p.dir, CHILD_FILES.token),
      { max: TOKEN_MAX, strict: true, name: "token" },
      deps,
      uid,
    );
  } catch (e) {
    if (e instanceof FileCheckError) {
      return failed(
        e.code,
        1,
        e.message,
        "まだ紐付けていなければ、紐付けの文面の手順（cso child bind）から行う",
      );
    }
    throw e;
  }
  // 本文は、子が Write で書いた引き出しの report（code と同じ確かめ方。読めても読めなくても、送る前に消す）
  const reportPath = join(p.dir, CHILD_FILES.report);
  let raw: string;
  try {
    try {
      raw = readChecked(reportPath, { max: REPORT_MAX, strict: false, name: "report" }, deps, uid);
    } finally {
      removeQuietly(reportPath);
    }
  } catch (e) {
    if (e instanceof FileCheckError) {
      return failed(
        e.code,
        1,
        e.message,
        `報告の本文を、Write の道具で ${reportPath} に書いてから、もう一度実行する（${REPORT_MAX} バイトまで）`,
      );
    }
    throw e;
  }
  let params: unknown;
  if (TEXT_BODY.has(kind)) {
    if (raw === "") return failed("reportInvalid", 1, "報告の本文（report のファイル）が空");
    params = { text: raw };
  } else {
    try {
      params = JSON.parse(raw);
    } catch {
      return failed(
        "reportInvalid",
        1,
        "報告の本文（report のファイル）は、操作の params の JSON にする",
      );
    }
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return failed(
        "reportInvalid",
        1,
        "報告の本文（report のファイル）は、操作の params の JSON のオブジェクトにする",
      );
    }
  }
  // 身元の検証は、relay が、トークンつきの要求を送る直前に毎回行う（失敗したら送らない）
  const identityPath = identityPathOf(p.dir);
  if (identityPath === undefined) {
    return failed(
      "dirInvalid",
      1,
      "引き出しの場所が、daemon の置き場（children.noindex）の中でない",
    );
  }
  const verifier =
    deps.verifierFor?.(origin, identityPath) ??
    createIdentityVerifier({
      daemonUrl: origin,
      identityPath,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
  const relay = createRelay({
    daemonUrl: origin,
    token,
    verifier,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  });
  if (!relay.ok) return redact(daemonFailure(relay.error, "invalidConfig"), token);
  const requestId = p.requestId ?? deps.newRequestId();
  const rerun = `同じ報告をやり直すときは、同じ本文で --request-id ${requestId} を付ける`;
  const r = await relay.value.request(REPORT_OPERATIONS[kind], params, { requestId });
  if (r.ok) {
    return redact(
      {
        exitCode: 0,
        stdout: `${JSON.stringify({ ok: true, requestId, value: r.value })}\n`,
        stderr: "",
      },
      token,
    );
  }
  if (r.error.code === "tokenExpired") {
    removeQuietly(join(p.dir, CHILD_FILES.token));
    return redact(
      failed(
        "tokenExpired",
        3,
        "このノードのトークンの期限が切れた（報告は、もう通らない）",
        "報告をやめて、会話で人（親）に、node.bindCode で紐付けの文面を出し直してもらうよう頼む",
        "新しい文面が届いたら、その手順（code を書く → cso child bind）をやり直す",
      ),
      token,
    );
  }
  if (r.error.code === "daemon_identity_failed") {
    return failed(
      "daemonIdentityFailed",
      1,
      "窓口の相手が、引き出しを作った daemon か確かめられない（トークンは送っていない）",
      "紐付けの文面の URL を、そのまま書く。daemon が動いているか、人に確かめてもらう",
    );
  }
  const out = daemonFailure(r.error, "reportFailed", [token]);
  const tail = r.error.code === "unauthenticated" ? `${ASK_HUMAN}\n` : `${rerun}\n`;
  return redact({ ...out, stderr: `${out.stderr}${tail}` }, token);
}

/** 出力の中のトークンの値を `***` に置き換える（出す直前。念のため）。 */
function redact(result: CommandResult, token: string): CommandResult {
  if (token === "") return result;
  const hide = (s: string): string => s.split(token).join("***");
  return { ...result, stdout: hide(result.stdout), stderr: hide(result.stderr) };
}
