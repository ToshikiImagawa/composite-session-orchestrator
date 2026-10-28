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
import {
  CONNECTION_BOUNDS,
  CONNECTION_DEFAULTS,
  IN_PROGRESS_BOUNDS,
  RATE_LIMIT_BOUNDS,
} from "./api/rate-limit.js";
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
  /** 保管する、破棄した成果（`refs/cso/discarded/*`）の数の上限（1〜10000）。上限に達したら、強制の回収は失敗する。省略すると 200。 */
  readonly discardedRefsMax?: number;
  /** 最終削除の保持期間（木全体のアーカイブからの日数。0 以上）。省略すると 90。 */
  readonly retentionDays?: number;
  /** `node.purge` の `tombstone` を省略したときに、墓標を残すか。省略すると `DEFAULT_PURGE_TOMBSTONE`（残す）。 */
  readonly purgeTombstone?: boolean;
  /**
   * Desktop の子で、フックが確認済みでない間は起動を拒否するか（T20 のゲート）。省略すると true。設定ファイルでのみ false にでき、
   * false のときは起動のたびに警告を記録する（作業範囲外の拒否 FR_014 による安全を保証できない）。
   */
  readonly desktopRequireVerifiedHooks?: boolean;
  /**
   * 窓口の回数の制限（T10l）の調整。**制限そのものは、常に有効**（無効にはできない）。省略した項目は既定: 主体ごと（人間は 1 つ、
   * ノードは nodeId ごと）に容量 60・毎秒 20（重い操作は 5 トークン）、認証の失敗は接続元ごとに容量 20・毎分 30、キーの数の上限 10,000。
   * 下限がある（極端に低くして、自分を締め出さないため）: `perPrincipal.burst` 10〜10000、`perSecond` 1〜10000、
   * `authFailures.burst` 5〜10000、`perMinute` 5〜100000、`maxKeys` 100〜1000000。
   */
  readonly rateLimit?: {
    readonly perPrincipal?: { readonly burst?: number; readonly perSecond?: number };
    readonly authFailures?: { readonly burst?: number; readonly perMinute?: number };
    readonly maxKeys?: number;
    /** 主体ごとの、同時に処理中の要求の数の上限（T10l-f。1〜64。既定 8）。超えたら、本文を読まずに 429。 */
    readonly maxInFlightPerPrincipal?: number;
    /**
     * 運用の見える化（T10l-f PR-B）。**既定で有効**: 窓（1 分）の、認証の失敗・制限の発動の件数が `threshold`（5〜100000。既定 30）以上のとき、
     * 根の受信箱に `info` の項目を 1 件出す（同じ種類は、最短 `minIntervalMinutes` 分〔1〜1440。既定 10〕あける）。`enabled: false` で出さない
     * （件数のまとめは、daemon の記録に、いつも出る）。
     */
    readonly alert?: {
      readonly enabled?: boolean;
      readonly threshold?: number;
      readonly minIntervalMinutes?: number;
    };
  };
  /**
   * 接続の上限とタイムアウト（T10l-f。遅い要求への対策）。省略した項目は既定: `requestTimeoutMs` 30,000（1,000〜600,000）・
   * `headersTimeoutMs` 10,000（1,000〜600,000。実効の `requestTimeoutMs` 以下）・`keepAliveTimeoutMs` 5,000（3,000〜120,000）・
   * `maxConnections` 256（64〜10,000。mcp の接続と SSE も数に含まれる）。
   */
  readonly connection?: {
    readonly requestTimeoutMs?: number;
    readonly headersTimeoutMs?: number;
    readonly keepAliveTimeoutMs?: number;
    readonly maxConnections?: number;
  };
  /**
   * 同じ要求（同じ主体・同じ requestId）の処理中の重複の扱い（T10l-f。`docs/request-dedup.md`）。省略した項目は既定: `waitMs` 20,000
   * （1,000〜60,000。最初の結果を待つ上限）・`maxWaiters` 16（1〜256。1 つの項目に同時に待てる重複の数）・
   * `staleMs` 300,000（150,000〜3,600,000。古いと見なして外す時間。最長の操作のタイムアウト 120 秒より長い）・`maxEntries` 1,024（64〜100,000。表の大きさ）。
   */
  readonly inProgress?: {
    readonly waitMs?: number;
    readonly maxWaiters?: number;
    readonly staleMs?: number;
    readonly maxEntries?: number;
  };
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
  /**
   * 配下の要約（T24-d。`docs/digest.md`）。**既定で有効**（既存の受信箱の項目に追加で 1 件出すだけで、隠さない）。`enabled: false` で無効にできる。
   * `intervalSec`: 周期（5〜3600 秒。既定 30）。`minIntervalSec`: 中間統合ノードごとの、要約の最短の間隔（10〜3600 秒。既定 60）。
   * `maxPerRun`: 1 周期に出す要約の数の上限（1〜100。既定 20）。
   */
  readonly digest?: {
    readonly enabled?: boolean;
    readonly intervalSec?: number;
    readonly minIntervalSec?: number;
    readonly maxPerRun?: number;
  };
  /**
   * 中間統合ノードを起こす（T24-w。`docs/digest.md`）。**既定で無効**: 有効にすると、配下に新しい項目が届くたびに、動作中の中間統合ノードへ
   * 固定の 1 行の指示を送るので、**追加のターンと予算（`maxBudgetUsd`）を使う**。`enabled: true` で有効にする。
   * `intervalSec`: 周期（5〜3600 秒。既定 15）。`minIntervalSec`: ノードごとの、最短の間隔（10〜3600 秒。既定 60）。
   * `maxPerRun`: 1 周期に起こす数の上限（1〜100。既定 10）。`maxPerHour`: 全ノード合計で、1 時間に起こす数の上限（1〜1000。既定 120）。
   */
  readonly wake?: {
    readonly enabled?: boolean;
    readonly intervalSec?: number;
    readonly minIntervalSec?: number;
    readonly maxPerRun?: number;
    /** 全ノード合計で、1 時間に起こす数の上限（1〜1000。既定 120）。 */
    readonly maxPerHour?: number;
  };
  /** 子に渡す環境変数の、既定（PATH・HOME・認証・プロキシなど）に加える名前（完全一致）。 */
  readonly childEnvAllow?: readonly string[];
  /**
   * Desktop の子が `cso` を起動する語（T21-cc。例: `["/usr/local/bin/node", "/opt/cso/packages/cli/dist/bin.js"]`・`["/usr/local/bin/cso"]`）。
   * 紐付けの文面（`node.bindCode`）に、そのまま書く。1〜4 語。語は英数字と `. _ / @ : + = -` だけ（空白・引用符なし）。
   * `/` を含む語は絶対パス（`..` なし）で、絶対パスの語が 1 つ以上要る。ないと、`node.bindCode` は `csoCommandMissing` で失敗する。
   */
  readonly csoCommand?: readonly string[];
  /** 子の `HOME`。`isolated`（既定）は、子ごとの空のディレクトリ。`inherit` は、daemon の `HOME` をそのまま渡す。 */
  readonly childHome?: "isolated" | "inherit";
  /**
   * 子に渡す skill（`cso-child`・`cso-integrator`）を持つ plugin のディレクトリ（絶対パス。T22-c）。daemon は、ここから skill だけを
   * stateDir の下に写して、子に渡す（hooks・commands・.mcp.json は渡さない）。省略すると、子に skill を渡さない。
   */
  readonly childPluginDir?: string;
  /**
   * 子の実行環境（T21）。`cli`（既定）は daemon が SDK で起動する。`desktop` は、統合セッションが Desktop のタスク生成で起動し、
   * 子が紐付けコードで結ぶ（仮置き。`docs/desktop-runtime.md`）。木全体で 1 つ（ノードごとの混在は扱わない）。
   */
  readonly childRuntime?: "cli" | "desktop";
  /** 子ごとの、エージェントのターン数の上限（API の往復）。省略すると 100。 */
  readonly maxTurns?: number;
  /** 子ごとの、費用の上限（USD）。省略すると 5。 */
  readonly maxBudgetUsd?: number;
  /** スケジューラが同時に起動する数の上限（親ごと・全体。1〜64）。省略した項目は既定の 4。 */
  readonly startLimits?: { readonly perParent?: number; readonly total?: number };
  /**
   * トークンの期限（分。T21-te・M5）。`sdkIdle`: daemon が起動する子の、使わなければ切れる期限（既定 360）。`bindAbsolute`:
   * 紐付け（Desktop の子）の、発行からの期限（既定 1440）。`bindIdle`: 紐付けの、使わなければ切れる期限（既定 60）。
   * `hookAbsolute`: フック用のトークンの、発行からの期限（既定 1440）。根のトークンには付けない。
   */
  readonly tokenExpiryMinutes?: {
    readonly sdkIdle?: number;
    readonly bindAbsolute?: number;
    readonly bindIdle?: number;
    readonly hookAbsolute?: number;
  };
  /**
   * 窓口の待ち受けポート（127.0.0.1）。0 以外ならそのポート。0（既定）なら、起動オプション `--port` がなければ、stateDir に保存した
   * 前回のポートを使い、それもなければ空いているポートを選んで保存する（`port-file.ts`）。
   */
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
  "discardedRefsMax",
  "startLimits",
  "tokenExpiryMinutes",
  "retentionDays",
  "purgeTombstone",
  "desktopRequireVerifiedHooks",
  "autoPurge",
  "digest",
  "wake",
  "rateLimit",
  "connection",
  "inProgress",
  "maxTurns",
  "maxBudgetUsd",
  "childEnvAllow",
  "csoCommand",
  "childHome",
  "childPluginDir",
  "childRuntime",
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
  if (
    raw.discardedRefsMax !== undefined &&
    (typeof raw.discardedRefsMax !== "number" ||
      !Number.isInteger(raw.discardedRefsMax) ||
      raw.discardedRefsMax < 1 ||
      raw.discardedRefsMax > 10000)
  ) {
    return bad("discardedRefsMax は 1〜10000 の整数");
  }
  if (raw.purgeTombstone !== undefined && typeof raw.purgeTombstone !== "boolean") {
    return bad("purgeTombstone は真偽値");
  }
  if (
    raw.desktopRequireVerifiedHooks !== undefined &&
    typeof raw.desktopRequireVerifiedHooks !== "boolean"
  ) {
    return bad("desktopRequireVerifiedHooks は真偽値");
  }
  let rateLimit: DaemonConfig["rateLimit"];
  if (raw.rateLimit !== undefined) {
    const v = raw.rateLimit;
    const inRange = (x: unknown, b: { min: number; max: number }): boolean =>
      x === undefined || (typeof x === "number" && Number.isInteger(x) && x >= b.min && x <= b.max);
    const onlyKeys = (o: unknown, keys: readonly string[]): o is Record<string, unknown> =>
      isRec(o) && Object.keys(o).every((k) => keys.includes(k));
    const pp = isRec(v) ? v.perPrincipal : undefined;
    const af = isRec(v) ? v.authFailures : undefined;
    if (
      !onlyKeys(v, [
        "perPrincipal",
        "authFailures",
        "maxKeys",
        "maxInFlightPerPrincipal",
        "alert",
      ]) ||
      (v.alert !== undefined &&
        (!onlyKeys(v.alert, ["enabled", "threshold", "minIntervalMinutes"]) ||
          (v.alert.enabled !== undefined && typeof v.alert.enabled !== "boolean") ||
          !inRange(v.alert.threshold, RATE_LIMIT_BOUNDS.alertThreshold) ||
          !inRange(v.alert.minIntervalMinutes, RATE_LIMIT_BOUNDS.alertIntervalMinutes))) ||
      !inRange(v.maxInFlightPerPrincipal, RATE_LIMIT_BOUNDS.maxInFlightPerPrincipal) ||
      (pp !== undefined && !onlyKeys(pp, ["burst", "perSecond"])) ||
      (af !== undefined && !onlyKeys(af, ["burst", "perMinute"])) ||
      !inRange(v.maxKeys, RATE_LIMIT_BOUNDS.maxKeys) ||
      (isRec(pp) &&
        (!inRange(pp.burst, RATE_LIMIT_BOUNDS.principalBurst) ||
          !inRange(pp.perSecond, RATE_LIMIT_BOUNDS.principalPerSecond))) ||
      (isRec(af) &&
        (!inRange(af.burst, RATE_LIMIT_BOUNDS.authFailureBurst) ||
          !inRange(af.perMinute, RATE_LIMIT_BOUNDS.authFailurePerMinute)))
    ) {
      return bad(
        `rateLimit は、perPrincipal（burst ${RATE_LIMIT_BOUNDS.principalBurst.min}〜${RATE_LIMIT_BOUNDS.principalBurst.max}・perSecond ${RATE_LIMIT_BOUNDS.principalPerSecond.min}〜${RATE_LIMIT_BOUNDS.principalPerSecond.max}）・authFailures（burst ${RATE_LIMIT_BOUNDS.authFailureBurst.min}〜${RATE_LIMIT_BOUNDS.authFailureBurst.max}・perMinute ${RATE_LIMIT_BOUNDS.authFailurePerMinute.min}〜${RATE_LIMIT_BOUNDS.authFailurePerMinute.max}）・maxKeys（${RATE_LIMIT_BOUNDS.maxKeys.min}〜${RATE_LIMIT_BOUNDS.maxKeys.max}）・maxInFlightPerPrincipal（${RATE_LIMIT_BOUNDS.maxInFlightPerPrincipal.min}〜${RATE_LIMIT_BOUNDS.maxInFlightPerPrincipal.max}）・alert（enabled・threshold ${RATE_LIMIT_BOUNDS.alertThreshold.min}〜${RATE_LIMIT_BOUNDS.alertThreshold.max}・minIntervalMinutes ${RATE_LIMIT_BOUNDS.alertIntervalMinutes.min}〜${RATE_LIMIT_BOUNDS.alertIntervalMinutes.max}）だけを持つオブジェクト（整数。制限は無効にできない）`,
      );
    }
    const num = (o: unknown, k: string): number | undefined =>
      isRec(o) && typeof o[k] === "number" ? (o[k] as number) : undefined;
    rateLimit = {
      ...(pp === undefined
        ? {}
        : {
            perPrincipal: {
              ...(num(pp, "burst") === undefined ? {} : { burst: num(pp, "burst") as number }),
              ...(num(pp, "perSecond") === undefined
                ? {}
                : { perSecond: num(pp, "perSecond") as number }),
            },
          }),
      ...(af === undefined
        ? {}
        : {
            authFailures: {
              ...(num(af, "burst") === undefined ? {} : { burst: num(af, "burst") as number }),
              ...(num(af, "perMinute") === undefined
                ? {}
                : { perMinute: num(af, "perMinute") as number }),
            },
          }),
      ...(v.maxKeys === undefined ? {} : { maxKeys: v.maxKeys as number }),
      ...(v.maxInFlightPerPrincipal === undefined
        ? {}
        : { maxInFlightPerPrincipal: v.maxInFlightPerPrincipal as number }),
      ...(v.alert === undefined
        ? {}
        : { alert: v.alert as NonNullable<NonNullable<DaemonConfig["rateLimit"]>["alert"]> }),
    };
  }
  // 接続・処理中の重複の設定（T10l-f）。範囲・型・未知のキーを検査し、実効の値（省略は既定）の組み合わせも検査する。
  const boundedGroup = <K extends string>(
    name: string,
    v: unknown,
    bounds: Readonly<Record<K, { min: number; max: number }>>,
  ): { ok: true; value: Partial<Record<K, number>> } | { ok: false; cause: string } => {
    const keys = Object.keys(bounds) as K[];
    if (!isRec(v) || Object.keys(v).some((k) => !(keys as string[]).includes(k))) {
      return {
        ok: false,
        cause: `${name} は、${keys.join("・")} だけを持つオブジェクト`,
      };
    }
    const out: Partial<Record<K, number>> = {};
    for (const k of keys) {
      const x = v[k];
      if (x === undefined) continue;
      const b = bounds[k];
      if (typeof x !== "number" || !Number.isInteger(x) || x < b.min || x > b.max) {
        return { ok: false, cause: `${name}.${k} は ${b.min}〜${b.max} の整数` };
      }
      out[k] = x;
    }
    return { ok: true, value: out };
  };
  let connection: DaemonConfig["connection"];
  if (raw.connection !== undefined) {
    const g = boundedGroup("connection", raw.connection, CONNECTION_BOUNDS);
    if (!g.ok) return bad(g.cause);
    const headers = g.value.headersTimeoutMs ?? CONNECTION_DEFAULTS.headersTimeoutMs;
    const request = g.value.requestTimeoutMs ?? CONNECTION_DEFAULTS.requestTimeoutMs;
    if (headers > request) {
      return bad(
        `connection.headersTimeoutMs（${headers}。省略すると ${CONNECTION_DEFAULTS.headersTimeoutMs}）は、requestTimeoutMs（${request}。省略すると ${CONNECTION_DEFAULTS.requestTimeoutMs}）以下にする`,
      );
    }
    connection = g.value;
  }
  let inProgress: DaemonConfig["inProgress"];
  if (raw.inProgress !== undefined) {
    const g = boundedGroup("inProgress", raw.inProgress, IN_PROGRESS_BOUNDS);
    if (!g.ok) return bad(g.cause);
    inProgress = g.value;
  }
  let autoPurge:
    | { enabled: boolean; intervalMinutes?: number; maxTreesPerRun?: number; noticeDays?: number }
    | undefined;
  let digest: DaemonConfig["digest"];
  if (raw.digest !== undefined) {
    const v = raw.digest;
    const okRange = (x: unknown, min: number, max: number): boolean =>
      x === undefined || (typeof x === "number" && Number.isInteger(x) && x >= min && x <= max);
    if (
      !isRec(v) ||
      Object.keys(v).some(
        (k) =>
          k !== "enabled" && k !== "intervalSec" && k !== "minIntervalSec" && k !== "maxPerRun",
      ) ||
      (v.enabled !== undefined && typeof v.enabled !== "boolean") ||
      !okRange(v.intervalSec, 5, 3600) ||
      !okRange(v.minIntervalSec, 10, 3600) ||
      !okRange(v.maxPerRun, 1, 100)
    ) {
      return bad(
        "digest は、enabled（真偽値。任意）・intervalSec（5〜3600 の整数。任意）・minIntervalSec（10〜3600 の整数。任意）・maxPerRun（1〜100 の整数。任意）だけを持つオブジェクト",
      );
    }
    digest = {
      ...(v.enabled === undefined ? {} : { enabled: v.enabled as boolean }),
      ...(v.intervalSec === undefined ? {} : { intervalSec: v.intervalSec as number }),
      ...(v.minIntervalSec === undefined ? {} : { minIntervalSec: v.minIntervalSec as number }),
      ...(v.maxPerRun === undefined ? {} : { maxPerRun: v.maxPerRun as number }),
    };
  }
  let wake: DaemonConfig["wake"];
  if (raw.wake !== undefined) {
    const v = raw.wake;
    const okRange = (x: unknown, min: number, max: number): boolean =>
      x === undefined || (typeof x === "number" && Number.isInteger(x) && x >= min && x <= max);
    if (
      !isRec(v) ||
      Object.keys(v).some(
        (k) =>
          k !== "enabled" &&
          k !== "intervalSec" &&
          k !== "minIntervalSec" &&
          k !== "maxPerRun" &&
          k !== "maxPerHour",
      ) ||
      (v.enabled !== undefined && typeof v.enabled !== "boolean") ||
      !okRange(v.intervalSec, 5, 3600) ||
      !okRange(v.minIntervalSec, 10, 3600) ||
      !okRange(v.maxPerRun, 1, 100) ||
      !okRange(v.maxPerHour, 1, 1000)
    ) {
      return bad(
        "wake は、enabled（真偽値。任意）・intervalSec（5〜3600 の整数。任意）・minIntervalSec（10〜3600 の整数。任意）・maxPerRun（1〜100 の整数。任意）・maxPerHour（1〜1000 の整数。任意）だけを持つオブジェクト",
      );
    }
    wake = {
      ...(v.enabled === undefined ? {} : { enabled: v.enabled as boolean }),
      ...(v.intervalSec === undefined ? {} : { intervalSec: v.intervalSec as number }),
      ...(v.minIntervalSec === undefined ? {} : { minIntervalSec: v.minIntervalSec as number }),
      ...(v.maxPerRun === undefined ? {} : { maxPerRun: v.maxPerRun as number }),
      ...(v.maxPerHour === undefined ? {} : { maxPerHour: v.maxPerHour as number }),
    };
  }
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
        `childEnvAllow に、子に渡せない名前（子の実行を乗っ取れる名前・CSO のトークンの名前）は指定できない: ${forbidden.join("、")}`,
      );
    }
    childEnvAllow = [...(v as string[])];
  }
  let csoCommand: string[] | undefined;
  if (raw.csoCommand !== undefined) {
    const v = raw.csoCommand;
    const word = /^[A-Za-z0-9._/@:+=-]{1,1024}$/;
    const absOk = (x: string): boolean =>
      !x.includes("/") || (x.startsWith("/") && !x.split("/").includes(".."));
    if (
      !Array.isArray(v) ||
      v.length < 1 ||
      v.length > 4 ||
      !v.every((x) => typeof x === "string" && word.test(x) && absOk(x)) ||
      !(v as string[]).some((x) => x.startsWith("/"))
    ) {
      return bad(
        "csoCommand は、cso を起動する語の配列（1〜4 語。英数字と . _ / @ : + = - だけ。/ を含む語は絶対パスで、絶対パスの語が 1 つ以上）",
      );
    }
    csoCommand = [...(v as string[])];
  }
  let childPluginDir: string | undefined;
  if (raw.childPluginDir !== undefined) {
    childPluginDir = absPath(raw.childPluginDir);
    if (childPluginDir === undefined) return bad("childPluginDir は絶対パス（.. を含まない）");
  }
  if (
    raw.childRuntime !== undefined &&
    raw.childRuntime !== "cli" &&
    raw.childRuntime !== "desktop"
  ) {
    return bad('childRuntime は "cli" か "desktop"');
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

  let tokenExpiryMinutes: Record<string, number> | undefined;
  if (raw.tokenExpiryMinutes !== undefined) {
    const v = raw.tokenExpiryMinutes as Record<string, unknown>;
    const names = ["sdkIdle", "bindAbsolute", "bindIdle", "hookAbsolute"];
    const okMin = (x: unknown): boolean =>
      x === undefined || (typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= 525_600);
    if (
      typeof v !== "object" ||
      v === null ||
      Array.isArray(v) ||
      Object.keys(v).some((k) => !names.includes(k)) ||
      !names.every((k) => okMin(v[k]))
    ) {
      return bad(
        "tokenExpiryMinutes は、sdkIdle・bindAbsolute・bindIdle・hookAbsolute（どれも 1〜525600 の整数〔分〕。任意）だけを持つオブジェクト",
      );
    }
    tokenExpiryMinutes = Object.fromEntries(
      names.filter((k) => v[k] !== undefined).map((k) => [k, v[k] as number]),
    );
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
      ...(tokenExpiryMinutes === undefined ? {} : { tokenExpiryMinutes }),
      ...(childEnvAllow === undefined ? {} : { childEnvAllow }),
      ...(csoCommand === undefined ? {} : { csoCommand }),
      ...(autoPurge === undefined ? {} : { autoPurge }),
      ...(digest === undefined ? {} : { digest }),
      ...(wake === undefined ? {} : { wake }),
      ...(rateLimit === undefined ? {} : { rateLimit }),
      ...(connection === undefined ? {} : { connection }),
      ...(inProgress === undefined ? {} : { inProgress }),
      ...(childPluginDir === undefined ? {} : { childPluginDir }),
      ...(raw.childRuntime === undefined
        ? {}
        : { childRuntime: raw.childRuntime as "cli" | "desktop" }),
      ...(raw.childHome === undefined
        ? {}
        : { childHome: raw.childHome as "isolated" | "inherit" }),
      ...(raw.maxTurns === undefined ? {} : { maxTurns: raw.maxTurns as number }),
      ...(raw.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: raw.maxBudgetUsd as number }),
      ...(raw.retentionDays === undefined ? {} : { retentionDays: raw.retentionDays as number }),
      ...(raw.discardedRefsMax === undefined
        ? {}
        : { discardedRefsMax: raw.discardedRefsMax as number }),
      ...(raw.purgeTombstone === undefined
        ? {}
        : { purgeTombstone: raw.purgeTombstone as boolean }),
      ...(raw.desktopRequireVerifiedHooks === undefined
        ? {}
        : { desktopRequireVerifiedHooks: raw.desktopRequireVerifiedHooks as boolean }),
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
