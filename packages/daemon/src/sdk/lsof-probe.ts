/**
 * 作業ツリー配下で動作中のプロセスの一覧（lsof）。T05（回収可能判定の条件 6）の入力を作る。
 * PRD: FR_026, FR_027 / design 6.2
 *
 * - `lsof -nP -d cwd -F pcn`（全プロセスの cwd）と、`lsof -nP -F pcfn +D <作業ツリー>`（配下のファイルを開いているプロセス）
 *   を使う。macOS と Linux の両方で使える。cwd が作業ツリー配下、または配下のファイルを開いているプロセスだけを返す。
 * - cwd を読めなかったプロセス（`(readlink: Permission denied)`。他のユーザーのプロセス）は対象にしない。
 *   この限界は、daemon が子を起動するユーザーと同じユーザーで動くことを前提とする。
 * - cwd の一覧が取れなければ `null`（確認できない。安全側で回収不可）。`+D` が失敗したときは、開いているファイルを
 *   `"unknown"`（動作中として扱われる）にする。
 * - 外部のプロセスは `Exec` に抽象化し、テストはフェイクで行う。引数は配列で渡し、シェルを介さない。
 * - 作業ツリーのパスは、呼び出し側が realpath にして渡す（lsof は実パスを返す）。
 */

import { execFile } from "node:child_process";
import { isPathUnder, normalizePath, type ProcessInfo } from "@cso/core";

export interface ExecResult {
  /** 終了コード。起動できなかった・時間切れなどは `null`。 */
  readonly code: number | null;
  readonly stdout: string;
  readonly error?: string;
}

export type Exec = (
  file: string,
  args: readonly string[],
  options: { readonly timeoutMs: number },
) => Promise<ExecResult>;

/** 作業ツリー配下で動作中のプロセスの一覧。取得できなければ `null`。 */
export type ProcessProbe = (worktreePath: string) => Promise<readonly ProcessInfo[] | null>;

export interface LsofFile {
  readonly fd: string;
  readonly name: string;
}

export interface LsofProcess {
  readonly pid: number;
  readonly command: string;
  readonly files: readonly LsofFile[];
}

/** `lsof -F` の出力を解析する。壊れた行は読み飛ばし、例外を出さない。 */
export function parseLsofFields(output: string): LsofProcess[] {
  const out: { pid: number; command: string; files: LsofFile[] }[] = [];
  let cur: { pid: number; command: string; files: LsofFile[] } | undefined;
  let pendingFd: string | undefined;
  for (const line of output.split("\n")) {
    if (line === "") continue;
    const tag = line[0];
    const value = line.slice(1);
    if (tag === "p") {
      pendingFd = undefined;
      if (/^\d+$/.test(value)) {
        cur = { pid: Number(value), command: "", files: [] };
        out.push(cur);
      } else {
        cur = undefined;
      }
    } else if (cur === undefined) {
      continue;
    } else if (tag === "c") {
      cur.command = value;
    } else if (tag === "f") {
      pendingFd = value;
    } else if (tag === "n") {
      cur.files.push({ fd: pendingFd ?? "", name: value });
      pendingFd = undefined;
    }
  }
  return out;
}

const UNREADABLE = / \((?:readlink|stat)[^)]*\)$/;
const DELETED = / \(deleted\)$/;

/** プロセスの cwd の名前。読めなかったもの（他ユーザーのプロセス）は `undefined`。 */
function cwdOf(p: LsofProcess): string | undefined {
  const f = p.files.find((x) => x.fd === "cwd" || x.fd === "");
  if (f === undefined || UNREADABLE.test(f.name)) return undefined;
  const name = f.name.replace(DELETED, "");
  return name.startsWith("/") ? name : undefined;
}

const okExit = (r: ExecResult): boolean => r.error === undefined && (r.code === 0 || r.code === 1);

const under = (path: string, dir: string): boolean =>
  isPathUnder(normalizePath("/", path), normalizePath("/", dir));

export function createLsofProbe(
  exec: Exec,
  options: { readonly timeoutMs?: number } = {},
): ProcessProbe {
  const timeoutMs = options.timeoutMs ?? 10_000;
  return async (worktreePath) => {
    if (
      typeof worktreePath !== "string" ||
      !worktreePath.startsWith("/") ||
      worktreePath.includes("\0")
    )
      return null;
    const [cwdRes, openRes] = await Promise.all([
      exec("lsof", ["-nP", "-d", "cwd", "-F", "pcn"], { timeoutMs }),
      exec("lsof", ["-nP", "-F", "pcfn", "+D", worktreePath], { timeoutMs }),
    ]);
    if (!okExit(cwdRes)) return null;

    const cwds = new Map<number, string>();
    for (const p of parseLsofFields(cwdRes.stdout)) {
      const cwd = cwdOf(p);
      if (cwd !== undefined) cwds.set(p.pid, cwd);
    }

    const openKnown = okExit(openRes);
    const openPids = new Set<number>();
    if (openKnown) {
      for (const p of parseLsofFields(openRes.stdout)) {
        // cwd の行は cwd の一覧で扱うので、開いているファイルには数えない。
        if (p.files.some((f) => f.fd !== "cwd" && under(f.name, worktreePath))) openPids.add(p.pid);
      }
    }

    const pids = new Set<number>(openPids);
    for (const [pid, cwd] of cwds) if (under(cwd, worktreePath)) pids.add(pid);
    return [...pids]
      .sort((a, b) => a - b)
      .map(
        (pid): ProcessInfo => ({
          pid,
          cwd: cwds.get(pid) ?? "",
          hasOpenFiles: openKnown ? openPids.has(pid) : "unknown",
        }),
      );
  };
}

/** `child_process.execFile` による実行。例外を出さず、結果（終了コード・出力・失敗の理由）を返す。 */
export const nodeExec: Exec = (file, args, { timeoutMs }) =>
  new Promise((resolve) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024, windowsHide: true, encoding: "utf8" },
      (err, stdout) => {
        if (err === null) return resolve({ code: 0, stdout });
        const code = (err as NodeJS.ErrnoException & { code?: unknown }).code;
        // 終了コードのある失敗（lsof は一致なしで 1）は、出力を保って返す。起動できない・時間切れは code: null。
        resolve(
          typeof code === "number"
            ? { code, stdout: typeof stdout === "string" ? stdout : "" }
            : { code: null, stdout: "", error: String(err.message) },
        );
      },
    );
  });
