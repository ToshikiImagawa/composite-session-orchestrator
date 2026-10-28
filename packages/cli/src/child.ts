/**
 * `cso child bind`・`cso child report`（Desktop の子が使う。課題 1 の ①。T21-cc）。
 *
 * 子の引き出し `<D>/<鍵>/`（daemon が先に 0700 で作る。`docs/desktop-runtime.md` の「子の引き出し」）に置いたファイルだけで、
 * daemon に紐付けて報告する。コード・トークンを、コマンドの引数にも、標準出力・標準エラーにも出さない（M2・M6）。
 *
 * - `bind --dir <引き出し> --url <窓口>`: 子が Write の道具で書いた `code` を確かめて読み、送る前に消す。`node`（daemon が書いた
 *   ノード ID）と一緒に `POST /v1/bind` へ送り、受け取ったトークンを `token` に、窓口の URL を `url` に置く（一時ファイルに
 *   O_EXCL・O_NOFOLLOW・0600 で書いて rename）。標準出力は結果の記号 1 行だけ。
 * - `report --dir <引き出し> --url <窓口> <操作>`: 子のロールの 5 つの操作だけ（M7）。本文は標準入力。`--url` が `url` のファイルと
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
import { isAbsolute, join } from "node:path";
import { createRelay } from "@cso/mcp/relay";
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
const STDIN_MAX = 256 * 1024;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TOKEN_FORMAT = /^[\x21-\x7e]+$/;
const BIND_TIMEOUT_MS = 30_000;

export interface ChildDeps {
  /** 標準入力の全部（report の本文）。 */
  readonly readStdin: () => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly newRequestId: () => string;
  /** 自分の uid（既定は `process.getuid()`）。 */
  readonly uid?: number;
  /** 試験用: lstat で確かめたあと、開く前に呼ぶ（差し替えの試験）。 */
  readonly afterCheck?: (path: string) => void;
}

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
    "        cso child report --dir <引き出しの絶対パス> --url <窓口の URL> <progress|out-of-scope|decision|done|scope-extend>（本文は標準入力）",
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
    if (f.ino !== st.ino || f.dev !== st.dev || !f.isFile() || f.size > opts.max) {
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
  return usage("cso child の次に、bind か report を指定する");
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
    try {
      code = readChecked(codePath, { max: CODE_MAX, strict: false, name: "code" }, deps, uid);
    } finally {
      // 読めても読めなくても、送る前に消す（コードを残さない。一度きりなので、失敗したら出し直してもらう）
      removeQuietly(codePath);
    }
    nodeId = readChecked(
      join(p.dir, CHILD_FILES.node),
      { max: NODE_MAX, strict: true, name: "node" },
      deps,
      uid,
    );
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
    try {
      writeAtomic(p.dir, CHILD_FILES.token, token);
      writeAtomic(p.dir, CHILD_FILES.url, origin);
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
  return daemonFailure(v.error, status === 429 ? "rateLimited" : "bindFailed");
}

/** daemon の失敗を、記号（標準出力）と、理由・次の操作（標準エラー）にする。トークンは含まれない（daemon の失敗の文面）。 */
function daemonFailure(error: unknown, fallback: string): CommandResult {
  const e = error as { code?: unknown; cause?: unknown; nextActions?: unknown } | undefined;
  const code =
    typeof e?.code === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(e.code) ? e.code : fallback;
  const lines: string[] = [];
  if (typeof e?.cause === "string") lines.push(e.cause.slice(0, 2000));
  if (Array.isArray(e?.nextActions)) {
    for (const a of e.nextActions.slice(0, 10))
      if (typeof a === "string") lines.push(`次の操作: ${a.slice(0, 500)}`);
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
  const raw = await deps.readStdin();
  if (raw.length > STDIN_MAX)
    return usage(`本文（標準入力）が大きすぎる（${STDIN_MAX} バイトまで）`);
  let params: unknown;
  if (TEXT_BODY.has(kind)) {
    const text = raw.replace(/\s+$/, "");
    if (text === "") return usage("本文（標準入力）に、報告の文を書く");
    params = { text };
  } else {
    try {
      params = JSON.parse(raw);
    } catch {
      return usage("本文（標準入力）は、操作の params の JSON にする");
    }
    if (typeof params !== "object" || params === null || Array.isArray(params)) {
      return usage("本文（標準入力）は、操作の params の JSON のオブジェクトにする");
    }
  }
  const relay = createRelay({
    daemonUrl: origin,
    token,
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
  const out = daemonFailure(r.error, "reportFailed");
  return redact({ ...out, stderr: `${out.stderr}${rerun}\n` }, token);
}

/** 出力の中のトークンの値を `***` に置き換える（出す直前。念のため）。 */
function redact(result: CommandResult, token: string): CommandResult {
  if (token === "") return result;
  const hide = (s: string): string => s.split(token).join("***");
  return { ...result, stdout: hide(result.stdout), stderr: hide(result.stderr) };
}
