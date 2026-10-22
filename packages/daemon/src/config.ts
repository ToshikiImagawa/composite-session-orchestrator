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
import { isForbiddenChildEnvName } from "./sdk/child-env.js";

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
  /** 最終削除の保持期間（木全体のアーカイブからの日数。0 以上）。省略すると 90。 */
  readonly retentionDays?: number;
  /** `node.purge` の `tombstone` を省略したときに、墓標を残すか。省略すると `DEFAULT_PURGE_TOMBSTONE`（残す）。 */
  readonly purgeTombstone?: boolean;
  /**
   * 自動の最終削除。省略すると、オフ。**有効にすると、保持期間（`retentionDays`）を過ぎた、アーカイブ済みの最上位の木が、
   * 取り返しのつかない形で（ログの行を物理削除して）自動的に消える。** 人間のコマンド（`cso purge`）と同じ検査を通る。
   * 最初の実行は 1 周期後。`intervalMinutes` は 1〜1440（既定 60）、`maxTreesPerRun` は 1 回の実行で消す木の数の上限で 1〜100（既定 2）。
   * 有効にするときは、`retentionDays` を 7 以上にする（省略した既定の 90 は可）。根のノードは対象にならない（人間の `node.purge` だけ）。
   * 時計が大きく動いたと疑われるとき（ログの最後の記録より前、または保持期間の半分以上先）は、その回の実行を止める。
   */
  readonly autoPurge?: {
    readonly enabled: boolean;
    readonly intervalMinutes?: number;
    readonly maxTreesPerRun?: number;
    /** 予告（受信箱の項目）を出してから、削除するまでの日数（1〜30。既定 7）。予告の後にだけ削除する。 */
    readonly noticeDays?: number;
  };
  /** 子に渡す環境変数の、既定（PATH・HOME・認証・プロキシなど）に加える名前（完全一致）。 */
  readonly childEnvAllow?: readonly string[];
  /** 子の `HOME`。`isolated`（既定）は、子ごとの空のディレクトリ。`inherit` は、daemon の `HOME` をそのまま渡す。 */
  readonly childHome?: "isolated" | "inherit";
  /** 子ごとの、エージェントのターン数の上限（API の往復）。省略すると 100。 */
  readonly maxTurns?: number;
  /** 子ごとの、費用の上限（USD）。省略すると 5。 */
  readonly maxBudgetUsd?: number;
  /** スケジューラが同時に起動する数の上限（親ごと・全体。1〜64）。省略した項目は既定の 4。 */
  readonly startLimits?: { readonly perParent?: number; readonly total?: number };
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
  "startLimits",
  "retentionDays",
  "purgeTombstone",
  "autoPurge",
  "maxTurns",
  "maxBudgetUsd",
  "childEnvAllow",
  "childHome",
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

  if (
    raw.retentionDays !== undefined &&
    (typeof raw.retentionDays !== "number" ||
      !Number.isInteger(raw.retentionDays) ||
      raw.retentionDays < 0 ||
      raw.retentionDays > 36500)
  ) {
    return bad("retentionDays は 0〜36500 の整数");
  }
  if (
    isRec(raw.autoPurge) &&
    raw.autoPurge.enabled === true &&
    typeof raw.retentionDays === "number" &&
    raw.retentionDays < 7
  ) {
    return bad(
      "autoPurge を有効にするときは、retentionDays を 7 以上にする（短い保持期間で、自動の削除が早く進みすぎるのを防ぐ。省略した既定の 90 は可）",
    );
  }
  if (raw.purgeTombstone !== undefined && typeof raw.purgeTombstone !== "boolean") {
    return bad("purgeTombstone は真偽値");
  }
  let autoPurge:
    | { enabled: boolean; intervalMinutes?: number; maxTreesPerRun?: number; noticeDays?: number }
    | undefined;
  if (raw.autoPurge !== undefined) {
    const v = raw.autoPurge;
    const okInt = (x: unknown, max: number): boolean =>
      x === undefined || (typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= max);
    if (
      !isRec(v) ||
      Object.keys(v).some(
        (k) =>
          k !== "enabled" &&
          k !== "intervalMinutes" &&
          k !== "maxTreesPerRun" &&
          k !== "noticeDays",
      ) ||
      typeof v.enabled !== "boolean" ||
      !okInt(v.intervalMinutes, 1440) ||
      !okInt(v.maxTreesPerRun, 100) ||
      !okInt(v.noticeDays, 30)
    ) {
      return bad(
        "autoPurge は、enabled（真偽値）・intervalMinutes（1〜1440 の整数。任意）・maxTreesPerRun（1〜100 の整数。任意）・noticeDays（1〜30 の整数。任意）だけを持つオブジェクト",
      );
    }
    autoPurge = {
      enabled: v.enabled,
      ...(v.intervalMinutes === undefined ? {} : { intervalMinutes: v.intervalMinutes as number }),
      ...(v.maxTreesPerRun === undefined ? {} : { maxTreesPerRun: v.maxTreesPerRun as number }),
      ...(v.noticeDays === undefined ? {} : { noticeDays: v.noticeDays as number }),
    };
  }
  if (
    raw.maxTurns !== undefined &&
    (typeof raw.maxTurns !== "number" ||
      !Number.isInteger(raw.maxTurns) ||
      raw.maxTurns < 1 ||
      raw.maxTurns > 100_000)
  ) {
    return bad("maxTurns は 1〜100000 の整数");
  }
  if (
    raw.maxBudgetUsd !== undefined &&
    (typeof raw.maxBudgetUsd !== "number" ||
      !Number.isFinite(raw.maxBudgetUsd) ||
      raw.maxBudgetUsd <= 0 ||
      raw.maxBudgetUsd > 10_000)
  ) {
    return bad("maxBudgetUsd は 0 より大きく 10000 以下の数");
  }
  let childEnvAllow: string[] | undefined;
  if (raw.childEnvAllow !== undefined) {
    const v = raw.childEnvAllow;
    if (
      !Array.isArray(v) ||
      v.length > 100 ||
      new Set(v).size !== v.length ||
      !v.every((x) => typeof x === "string" && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(x))
    ) {
      return bad("childEnvAllow は、環境変数の名前（英数字と _。重複なし、100 件以下）の配列");
    }
    const forbidden = (v as string[]).filter(isForbiddenChildEnvName);
    if (forbidden.length > 0) {
      return bad(
        `childEnvAllow に、子の実行を乗っ取れる名前は指定できない: ${forbidden.join("、")}`,
      );
    }
    childEnvAllow = [...(v as string[])];
  }
  if (raw.childHome !== undefined && raw.childHome !== "isolated" && raw.childHome !== "inherit") {
    return bad('childHome は "isolated" か "inherit"');
  }
  let startLimits: { perParent?: number; total?: number } | undefined;
  if (raw.startLimits !== undefined) {
    const v = raw.startLimits as Record<string, unknown>;
    const okLimit = (x: unknown): boolean =>
      x === undefined || (typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= 64);
    if (
      typeof v !== "object" ||
      v === null ||
      Array.isArray(v) ||
      Object.keys(v).some((k) => k !== "perParent" && k !== "total") ||
      !okLimit(v.perParent) ||
      !okLimit(v.total)
    ) {
      return bad(
        "startLimits は、perParent・total（どちらも 1〜64 の整数。任意）だけを持つオブジェクト",
      );
    }
    startLimits = {
      ...(v.perParent === undefined ? {} : { perParent: v.perParent as number }),
      ...(v.total === undefined ? {} : { total: v.total as number }),
    };
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
      ...(startLimits === undefined ? {} : { startLimits }),
      ...(childEnvAllow === undefined ? {} : { childEnvAllow }),
      ...(autoPurge === undefined ? {} : { autoPurge }),
      ...(raw.childHome === undefined
        ? {}
        : { childHome: raw.childHome as "isolated" | "inherit" }),
      ...(raw.maxTurns === undefined ? {} : { maxTurns: raw.maxTurns as number }),
      ...(raw.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: raw.maxBudgetUsd as number }),
      ...(raw.retentionDays === undefined ? {} : { retentionDays: raw.retentionDays as number }),
      ...(raw.purgeTombstone === undefined
        ? {}
        : { purgeTombstone: raw.purgeTombstone as boolean }),
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
