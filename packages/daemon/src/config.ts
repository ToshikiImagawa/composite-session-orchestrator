/**
 * daemon の設定ファイル（JSON 1 ファイル）の読み込みと検査。設定がない・不正なときは、起動を失敗させる（フェイルクローズ）。
 *
 * - 未知のキーは拒否する。パスはすべて絶対パス（`..` を含まない・NUL を含まない・`/` だけでない）。
 * - 置き場（状態・作業ツリー・リポジトリ）は、互いに重ならないこと（状態の置き場に作業ツリーを作らない、など）。
 * - 根の範囲（`rootScope`）は、ブリーフを持たない根の子の、権限の上限になる。場所は、根の作業ツリー（`rootCwd`）からの
 *   相対パスで書き、`validateScope(rootScope, rootCwd)` を満たすこと。
 * - `mcpUrl` は、子に渡す MCP の接続先。トークンを外へ送らないよう、ループバック（127.0.0.1・localhost・::1）に限り、
 *   ユーザー名・パスワードを含めない。
 * - `rootScope` の場所の `.` は、作業ツリー全体を許す（書き込み可能な場所に `.` を書くと、根の作業ツリー全体が書き込み可能になる）。
 */

import { lstatSync, readFileSync } from "node:fs";
import {
  briefProblem,
  type Failure,
  failure,
  isPathUnder,
  isSafeId,
  normalizePath,
  type Result,
  type Scope,
  validateScope,
} from "@cso/core";

export interface DaemonConfig {
  /** 状態（SQLite・トークン）の置き場。0700 のディレクトリにする。 */
  readonly stateDir: string;
  /** 子の作業ツリーを作る git リポジトリ。 */
  readonly repoRoot: string;
  /** 子の作業ツリーの置き場。 */
  readonly worktreeRoot: string;
  /** 根の作業ツリー（`repoRoot` 自身またはその配下）。 */
  readonly rootCwd: string;
  /** 根のノードの ID。既定 `root`。 */
  readonly rootNodeId: string;
  /** 根の範囲（子の権限の上限）。場所は `rootCwd` からの相対パス。 */
  readonly rootScope: Scope;
  /** 子に渡す MCP の接続先（ループバックだけ）。 */
  readonly mcpUrl: string;
  /**
   * 再生成できるので、残っていても未保存の変更とみなさない gitignore の対象（パスの先頭のディレクトリ名）。省略すると
   * `node_modules`・`dist`・`.turbo`。これ以外の gitignore の対象（`.env` など）が作業ツリーにあれば、回収は拒否される。
   */
  readonly regenerableIgnored?: readonly string[];
  /** 窓口の待ち受けポート（127.0.0.1）。0 なら空いているポート。既定 0。 */
  readonly port: number;
}

const KEYS = [
  "stateDir",
  "repoRoot",
  "worktreeRoot",
  "rootCwd",
  "rootNodeId",
  "rootScope",
  "mcpUrl",
  "port",
  "regenerableIgnored",
] as const;

const bad = (cause: string): { ok: false; error: Failure } => ({
  ok: false,
  error: failure(
    "invalidConfig",
    `設定が不正: ${cause}`,
    "設定ファイルを直して、もう一度起動する",
    "設定の書き方は design 9.1（daemon の組み立て）を見る",
  ),
});

const isRec = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

/** 絶対パスで、`..`・NUL を含まず、`/` だけでないこと。正規化した値を返す。 */
function absPath(v: unknown): string | undefined {
  if (typeof v !== "string" || !v.startsWith("/") || v.includes("\0")) return undefined;
  if (v.split("/").some((s) => s === "..")) return undefined;
  const n = normalizePath("/", v);
  return n === "/" ? undefined : n;
}

const overlaps = (a: string, b: string): boolean => isPathUnder(a, b) || isPathUnder(b, a);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function parseConfig(text: string): Result<DaemonConfig, Failure> {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return bad(`JSON として読めない（${String(e instanceof Error ? e.message : e)}）`);
  }
  if (!isRec(raw)) return bad("設定はオブジェクトでなければならない");
  const unknown = Object.keys(raw).filter((k) => !(KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) return bad(`未知のキー: ${unknown.join("、")}`);

  const paths: Record<"stateDir" | "repoRoot" | "worktreeRoot" | "rootCwd", string> = {
    stateDir: "",
    repoRoot: "",
    worktreeRoot: "",
    rootCwd: "",
  };
  for (const k of ["stateDir", "repoRoot", "worktreeRoot", "rootCwd"] as const) {
    const p = absPath(raw[k]);
    if (p === undefined) return bad(`${k} は、絶対パス（.. を含まない。/ だけでない）で指定する`);
    paths[k] = p;
  }
  const { stateDir, repoRoot, worktreeRoot, rootCwd } = paths;
  if (
    overlaps(stateDir, worktreeRoot) ||
    overlaps(stateDir, repoRoot) ||
    overlaps(worktreeRoot, repoRoot)
  ) {
    return bad("stateDir・repoRoot・worktreeRoot は、互いに重なってはならない");
  }
  if (!isPathUnder(rootCwd, repoRoot))
    return bad("rootCwd は、repoRoot 自身かその配下でなければならない");

  const rootNodeId = raw.rootNodeId === undefined ? "root" : raw.rootNodeId;
  if (!isSafeId(rootNodeId)) return bad("rootNodeId が識別子として不正");
  const port = raw.port === undefined ? 0 : raw.port;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65535) {
    return bad("port は 0〜65535 の整数");
  }

  let regenerableIgnored: string[] | undefined;
  if (raw.regenerableIgnored !== undefined) {
    const v = raw.regenerableIgnored;
    if (
      !Array.isArray(v) ||
      v.length > 50 ||
      !v.every(
        (x) =>
          typeof x === "string" &&
          x !== "" &&
          x !== "." &&
          x !== ".." &&
          !x.includes("/") &&
          !x.includes("\0") &&
          x === x.trim(),
      ) ||
      new Set(v).size !== v.length
    ) {
      return bad(
        "regenerableIgnored は、ディレクトリ名（/ を含まない・空でない・重複なし、50 件以下）の配列",
      );
    }
    regenerableIgnored = [...(v as string[])];
  }

  const rs = raw.rootScope;
  if (!isRec(rs))
    return bad(
      "rootScope は、writableLocations・forbiddenLocations・allowedCommands のオブジェクト",
    );
  // 形・件数・長さ・重複・場所の `..` と `/` は、ブリーフと同じ規則で検査する。
  const problem = briefProblem({ objective: "x", acceptanceCriteria: ["x"], scope: rs });
  if (problem !== undefined) return bad(`rootScope: ${problem}`);
  const scope = rs as unknown as Scope;
  const issues = validateScope(scope, rootCwd);
  if (issues.length > 0) {
    return bad(
      `rootScope が rootCwd の規則を満たさない: ${issues.map((i) => `${i.field}（${i.problem}）`).join("、")}`,
    );
  }

  const mcpUrl = raw.mcpUrl;
  let url: URL | undefined;
  try {
    url = typeof mcpUrl === "string" ? new URL(mcpUrl) : undefined;
  } catch {
    url = undefined;
  }
  if (
    typeof mcpUrl !== "string" ||
    url === undefined ||
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    !LOOPBACK.has(url.hostname) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    return bad(
      "mcpUrl は、ループバック（127.0.0.1・localhost・[::1]）の http(s) の URL（ユーザー名・パスワードは含めない）",
    );
  }

  return {
    ok: true,
    value: {
      stateDir,
      repoRoot,
      worktreeRoot,
      rootCwd,
      rootNodeId,
      rootScope: {
        writableLocations: [...scope.writableLocations],
        forbiddenLocations: [...scope.forbiddenLocations],
        allowedCommands: [...scope.allowedCommands],
      },
      mcpUrl,
      port,
      ...(regenerableIgnored === undefined ? {} : { regenerableIgnored }),
    },
  };
}

/** 設定ファイルを読んで検査する。読めない・不正なら失敗（起動しない）。 */
export function loadConfigFile(path: string): Result<DaemonConfig, Failure> {
  if (typeof path !== "string" || !path.startsWith("/")) {
    return bad("設定ファイルは、絶対パスで指定する");
  }
  // 設定ファイルは、他のユーザーが書き換えられないこと（通常のファイルで、グループ・他者の書き込み権限がない）。
  try {
    const st = lstatSync(path);
    if (!st.isFile()) return bad(`設定ファイル ${path} が通常のファイルでない（リンクは使えない）`);
    const uid = process.getuid?.();
    if (uid !== undefined && st.uid !== uid) {
      return bad(`設定ファイル ${path} の所有者が、このプロセスのユーザーと違う`);
    }
    if ((st.mode & 0o022) !== 0) {
      return bad(`設定ファイル ${path} を、他のユーザーが書き換えられる（chmod go-w で直す）`);
    }
  } catch (e) {
    return bad(
      `設定ファイル ${path} を調べられない（${String(e instanceof Error ? e.message : e)}）`,
    );
  }
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return bad(`設定ファイル ${path} を読めない（${String(e instanceof Error ? e.message : e)}）`);
  }
  return parseConfig(text);
}
