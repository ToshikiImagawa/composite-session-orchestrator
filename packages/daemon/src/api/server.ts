/**
 * daemon の窓口（HTTP API）。127.0.0.1 だけで待ち受け、`POST /v1/request` の 1 本で全操作を受ける。
 * PRD: NFR_003, NFR_004, DC_003 / design 4.2, 9.1
 *
 * 処理の順（どこで失敗しても拒否する。フェイルクローズ）:
 * Host・Origin → ルート・メソッド → 認証（401。本文を読む前）→ 主体の検査（トークンのロール・ノードの状態。401）→
 * Content-Type → 本文（上限。超えたら 413 で接続を破棄）→ 封筒 → ロールの判定（403）→ 引数の検証（400）→
 * 部分木の判定（403・404）→ ハンドラ。ロールの判定を先にして、ロールのない操作に引数の形を教えない。応答は常に `Result`（成功 `{ok:true,value}`、失敗 `{ok:false,error}`）で、HTTP の状態は
 * 失敗の種類を表す（401 未認証、403 権限なし、404 見つからない・未知の操作、400 不正な要求、413 本文が大きい、
 * 415 JSON でない、422 操作の失敗、500 内部エラー、501 未実装）。内部の例外の詳細は返さず、`logger` に記録する。
 * 成功の結果は、`OperationMap` の `result` のキーだけに写して返す（`pickResult`）。
 *
 * `GET /v1/whoami`: Bearer で認証し、ロール（`integrator`・`child`・`human`）と、ノードのトークンには自分の `nodeId` を返す（人間には、nodeId がない。T10m-wh）。MCP の入口が、
 * 受け取った資格情報のロールを知るのに使う。Host・Origin の検査と、主体の検査（失効・止まったノードは 401）は、操作の入口と同じ。
 *
 * `GET /v1/identity?nonce=…`（`identity` を渡したときだけ）: 認証なし。daemon の身元確認（T10m-i。`docs/daemon-identity.md`）。`daemonId` と、
 *   秘密と、待ち受けているポートを使った `proof` だけを返す（秘密は返さない）。接続元ごとの、専用の回数の制限がある。
 *
 * もう 1 つの入口 `POST /v1/bind`（`bind` を渡したときだけ）は、トークンを持たない子のための専用の経路で、`nodeId` と bind コードだけで
 * 子ロールのノードトークンを返す（そのノードの既存のトークンは無効になる）（失敗が続いたら 429）。
 *
 * 操作の実体は `handlers` に差し込む（このファイルは入口と権限の判定だけを持つ）。ハンドラには、認証から決めた
 * ロールと caller と、検証済みの引数を渡す。caller の部分木に限った結果（受信箱・一覧）にするのはハンドラの責務。
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  type ContractRole,
  type DaemonOperation,
  type Failure,
  failure,
  isBoundedText,
  isSafeId,
  type OperationMap,
  type OrchState,
  type PendingConfirmation,
  type Result,
  uiViewOf,
} from "@cso/core";
import { authorizeRole, authorizeScope, checkPrincipal } from "./authorize.js";
import { type BindCodes, createThrottle, type Throttle } from "./bind.js";
import { type CredentialStore, type Principal, parseBearer } from "./credentials.js";
import { fingerprintOf } from "./dedupe.js";
import {
  createSessionBinder,
  type HookDecider,
  type HookTokens,
  parseHookRequest,
  type SessionBinder,
} from "./hook.js";
import { type Identity, isValidNonce, NONCE_MAX_HEX, NONCE_MIN_HEX, proofOf } from "./identity.js";
import {
  type ApiCounters,
  type BucketSpec,
  createApiCounters,
  createRateLimiter,
  DEFAULT_AUTH_FAILURE_BURST,
  DEFAULT_AUTH_FAILURE_PER_MINUTE,
  DEFAULT_IDENTITY_SPEC,
  DEFAULT_PRINCIPAL_SPEC,
  hrtimeMs,
  operationWeight,
  type SummaryScheduler,
} from "./rate-limit.js";
import { pickResult } from "./results.js";
import { createSseHub, responseSink } from "./sse-hub.js";
import { UI_CSS, UI_HEADERS, UI_HTML, UI_HTML_HEADERS, UI_JS } from "./ui-assets.js";
import { parseEnvelope, validateParams } from "./validate.js";

export interface HandlerRequest<Op extends DaemonOperation = DaemonOperation> {
  readonly requestId: string;
  readonly operation: Op;
  /** 認証から決めたロール。 */
  readonly role: ContractRole;
  /** 認証から決めた呼び出したノード（人間は持たない）。 */
  readonly caller?: { readonly nodeId: string };
  readonly params: OperationMap[Op]["params"];
}

export type Handlers = {
  [Op in DaemonOperation]?: (
    request: HandlerRequest<Op>,
  ) =>
    | Result<OperationMap[Op]["result"], Failure>
    | Promise<Result<OperationMap[Op]["result"], Failure>>;
};

/**
 * 記録するイベント（`at` は ISO 8601 UTC）。`internalError`: 500 の原因（応答には出さない）。bind の入口の結果:
 * `bindSucceeded`（成功。`nodeId` を持つのはこれだけ）、`bindFailed`（`reason`: invalid＝コードが無効・
 * rejected＝ノードの状態が許さない・malformed＝本文の形が不正。ロックはしない）、
 * `bindThrottled`（全体のスロットル。`reason: "global"`）。コードの値・ハッシュ・先頭の文字・トークンは書かない
 * （失敗では、申告された nodeId も書かない）。logger が例外を投げても、応答は変えない。
 */
export type ApiLogEvent =
  | {
      readonly event: "internalError";
      readonly requestId: string;
      /** `bind` は紐付けの入口（`POST /v1/bind`。契約の操作ではない）。 */
      readonly operation: DaemonOperation | "bind";
      readonly error: unknown;
      readonly at: string;
    }
  | { readonly event: "bindSucceeded"; readonly nodeId: string; readonly at: string }
  /** `POST /v1/hook`（T22-h）: 結んだものと別の `session_id` を拒否した。ID は書かない。 */
  | { readonly event: "hookSessionMismatch"; readonly at: string }
  | {
      readonly event: "bindFailed";
      readonly reason: "invalid" | "rejected" | "malformed";
      readonly at: string;
    }
  | {
      readonly event: "bindThrottled";
      /** `global`: 全体のスロットル。`origin`: 接続元ごとの、bind 専用の失敗の bucket が尽きている（T10l-f）。 */
      readonly reason: "global" | "origin";
      readonly at: string;
    }
  /** 認証の失敗（窓の最初の 1 件。理由の種類だけ）。`reason`: missing・invalid・principalRejected。 */
  | { readonly event: "apiAuthFailed"; readonly reason: string; readonly at: string }
  /** 回数の制限の発動（窓の最初の 1 件）。`key`: principal（主体）・origin（認証の失敗の接続元）。 */
  | { readonly event: "apiRateLimited"; readonly key: string; readonly at: string }
  /** 窓（既定 1 分）の、種類別の件数のまとめ。 */
  | {
      readonly event: "apiSummary";
      readonly windowSec: number;
      /** 窓の開始・終了（ISO 8601 UTC。T10l-f PR-B）。 */
      readonly windowStart?: string;
      readonly windowEnd?: string;
      readonly authFailed: Readonly<Record<string, number>>;
      readonly rateLimited: Readonly<Record<string, number>>;
      /** 同じ要求の重複（`coalesced`: 最初の結果を待って返した、`inProgress`: 待ちきれず 409、`conflict`: 本文が違う）。 */
      readonly deduped: Readonly<Record<string, number>>;
      /**
       * フックの受け口（`POST /v1/hook`。T24-hc）の要求数。`received`: 届いた（メソッドの検査の後、認証・回数の制限の前）、
       * `allowed`・`denied`: 200 で返した判定。件数だけ（nodeId・session_id・ツール名・内容は出さない）。要求がなかった窓では出さない。
       */
      readonly hook?: Readonly<Record<string, number>>;
      readonly at: string;
    }
  /** 同じ要求の重複の処理（窓の最初の 1 件）。`kind`: coalesced・inProgress・conflict。 */
  | { readonly event: "apiDeduped"; readonly kind: string; readonly at: string }
  /**
   * 処理中の表の項目が古くなって（`staleMs` を超えて）外された。**外したあとに届いた同じ組の要求は、ハンドラが実行されうる**ので、
   * 件数にまとめず、毎回すぐに記録する。`requestId`・主体・内容は出さない。
   */
  | {
      readonly event: "apiInProgressStale";
      readonly operation: string;
      readonly ageSec: number;
      readonly at: string;
    };

export type ApiLogger = (event: ApiLogEvent) => void;

export interface ApiDeps {
  readonly credentials: CredentialStore;
  /** 認可（部分木の判定）に使う現在の状態。 */
  readonly getState: () => OrchState;
  /**
   * 画面の表示モデル（`/v1/ui/state`）に出す、ノードの能力表の `stopDelegated`（T22d）。省略すると、どのノードにも出さない。
   * ハンドラと同じく、能力表だけで決める（アダプタが子を管理しているかは見ない）。表示のキャッシュは `lastSeq` を鍵にするので、
   * 能力表がアダプタごとに固定であること（同じノードの値が、記録なしに変わらない）が前提。
   */
  readonly stopDelegated?: (nodeId: string) => boolean;
  /**
   * 画面の表示モデルに出す、取り消せない操作の確認待ち（T24-cf。`confirmation-gate.ts`）。コードは含まない。`confirmationsVersion` は、
   * 確認待ちが変わるたびに増える数で、表示モデルのキャッシュの鍵と、SSE の変化の通知に足す（記録の seq は変わらないため）。
   */
  readonly confirmations?: () => readonly PendingConfirmation[];
  readonly confirmationsVersion?: () => number;
  readonly handlers: Handlers;
  /** 本文の上限（バイト）。既定 1 MiB。 */
  readonly maxBodyBytes?: number;
  /** 500 の原因と、bind の結果を記録する。省略すると記録しない。 */
  readonly logger?: ApiLogger;
  /** 身元確認の入口（`GET /v1/identity`）。起動のたびに変わりうるので、関数で渡す。`undefined` を返す間は、503（まだ使えない）。省略すると、この入口はない（404）。 */
  readonly identity?: () => Identity | undefined;
  /** bind 専用の入口（`POST /v1/bind`）の bind コード。省略すると、この入口はない（404）。 */
  readonly bind?: BindCodes;
  /** ファイルで設定するフックの受け口（`POST /v1/hook`。T22-h）の判定。省略すると、この入口はない（404）。 */
  readonly hook?: HookDecider;
  /** フックの受け口の session_id の結び付け（T22-hu で外から外せるように渡す）。省略すると、このサーバーの中だけのもの。 */
  readonly hookSessions?: SessionBinder;
  /** 手動の CLI セッション用の、フック専用のトークン（T22-ht）。`POST /v1/hook` だけで認証に使う。 */
  readonly hookTokens?: HookTokens;
  /**
   * Desktop の子のフックが効いているか（T21-ch）。そのノードの PreToolUse のフックを、直前（設定 `hookFreshSeconds`）に
   * 受けていれば true。渡すと、子のロールの要求（report.*・scope.extend）と `POST /v1/bind` は、false なら `hooksNotActive` で断る。
   */
  readonly hookFresh?: (nodeId: string) => boolean;
  /** PreToolUse のフックを判定して、許可したときに呼ぶ（拒否された呼び出しでは、窓を満たさない。R2）。 */
  readonly onHookSeen?: (nodeId: string) => void;
  /** フックの受け口で、フック専用のトークンだけを受け付ける（ノードのトークンは拒否。Desktop の木。R2）。 */
  readonly hookTokensOnly?: boolean;
  /** bind の入口の、全体のスロットル（1 秒あたりの失敗）。省略すると 1 秒に 10 回。 */
  readonly bindThrottle?: Throttle;
  /** 記録の時刻（ISO 8601 UTC）。既定は現在時刻。 */
  readonly clock?: () => string;
  /** 回数の制限（T10l）。常に有効（無効にはできない）。値は調整できる。 */
  readonly rateLimit?: {
    /** 主体（人間は 1 つ、ノードは nodeId ごと）の bucket。 */
    readonly perPrincipal?: BucketSpec;
    /** 身元確認（`GET /v1/identity`。接続元ごと）の bucket。認証済みの要求とは別。既定は容量 600・毎秒 200。 */
    readonly identity?: BucketSpec;
    /** 認証の失敗（接続元ごと）の bucket。 */
    readonly authFailures?: BucketSpec;
    readonly maxKeys?: number;
    /** 単調時計（ミリ秒）。既定は `process.hrtime`。試験で差し替える。 */
    readonly monotonicMs?: () => number;
    /** 件数のまとめの窓（ミリ秒）。既定 1 分。 */
    readonly summaryWindowMs?: number;
    /** 主体ごとに同時に処理中の要求の数の上限（超えたら、本文を読まずに 429）。既定 8。 */
    readonly maxInFlightPerPrincipal?: number;
    /** 件数のまとめを、窓の終わりに出す予約（T10l-f PR-B）。既定は、`unref` したタイマー。試験で差し替える（`null` なら予約しない）。 */
    readonly summaryScheduler?: SummaryScheduler | null;
  };
  /** 同じ要求（同じ主体・同じ requestId）の処理中の重複の扱い（T10l-d。試験で小さくする）。 */
  readonly inProgress?: {
    /** 最初の結果を待つ上限（ミリ秒）。既定 20 秒。超えたら 409 `inProgress`。 */
    readonly waitMs?: number;
    /** 1 つの処理中の項目に、同時に待てる重複の数。既定 16。 */
    readonly maxWaiters?: number;
    /** この時間（ミリ秒）を超えた項目は、古いと見なして外す。既定 5 分。 */
    readonly staleMs?: number;
    /** 表の項目の数の上限。既定 1,024。 */
    readonly maxEntries?: number;
  };
  /** SSE（`GET /v1/events`）の上限と周期。既定は、同時 4 本・250ms にまとめる・15 秒ごとに heartbeat・`drain` を 10 秒待って来なければ切る・寿命 1 時間。試験で小さくする。 */
  readonly sse?: {
    readonly maxConnections?: number;
    readonly coalesceMs?: number;
    readonly heartbeatMs?: number;
    /** `write()` が `false` を返してから、`drain` を待つ上限（超えたら切る）。既定 10 秒。 */
    readonly drainTimeoutMs?: number;
    /** 1 つの接続の最大の寿命（超えたら閉じる。画面は再接続する）。既定 1 時間。 */
    readonly maxLifetimeMs?: number;
  };
  /** 接続の上限と、遅い要求への対策（slowloris）。既定は、要求 30 秒・ヘッダ 10 秒・keep-alive 5 秒・接続 256。試験で小さくする。 */
  readonly connection?: {
    readonly requestTimeoutMs?: number;
    readonly headersTimeoutMs?: number;
    readonly keepAliveTimeoutMs?: number;
    readonly maxConnections?: number;
    /** タイムアウトを検査する間隔（ミリ秒）。既定 1 秒（Node の既定は 30 秒）。 */
    readonly checkIntervalMs?: number;
  };
}

export interface ApiServer {
  /** 127.0.0.1 で待ち受ける。`port` が 0 なら空いているポート。 */
  listen(port: number): Promise<{ readonly port: number; readonly url: string }>;
  close(): Promise<void>;
}

const HOST = "127.0.0.1";
interface UiAsset {
  readonly type: string;
  readonly body: string;
  /** HTML だけに付けるヘッダー（COOP・Permissions-Policy）を付ける。 */
  readonly html?: boolean;
}
/** 画面の資産（パス → 内容）。 */
const UI_ASSETS: Readonly<Record<string, UiAsset>> = {
  "/ui": { type: "text/html; charset=utf-8", body: UI_HTML, html: true },
  "/ui/app.js": { type: "text/javascript; charset=utf-8", body: UI_JS },
  "/ui/app.css": { type: "text/css; charset=utf-8", body: UI_CSS },
};
/** 本文を読まずに返す応答には、接続を閉じさせる（読んでいない本文が、次の要求と混ざらない。遅い本文で接続を占有されない）。 */
const CLOSE = { connection: "close" } as const;
const DEFAULT_MAX_BODY = 1024 * 1024;
/** `POST /v1/hook` の、主体ごとの bucket の重み（T22-h。ほかの要求は 1）。 */
const HOOK_WEIGHT = 0.5;
/** bind の本文は { nodeId, bindCode } だけなので小さく。 */
const BIND_MAX_BODY = 1024;

const STATUS: Readonly<Record<string, number>> = {
  unauthenticated: 401,
  tokenExpired: 401,
  hooksNotActive: 403,
  forbidden: 403,
  invalidHost: 403,
  notFound: 404,
  unknownOperation: 404,
  invalidRequest: 400,
  payloadTooLarge: 413,
  unsupportedMediaType: 415,
  methodNotAllowed: 405,
  notImplemented: 501,
  internalError: 500,
  tooManyRequests: 429,
  inProgress: 409,
};

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  res.end(json);
}

/** 完成した応答（最初の要求の結果を、重複した要求にも同じに返すため、送る前の形で持つ）。 */
interface Reply {
  readonly status: number;
  readonly body: unknown;
  readonly extra?: Record<string, string>;
}
const sendReply = (res: ServerResponse, r: Reply): void => send(res, r.status, r.body, r.extra);

/** 処理中の項目（同じ主体・同じ requestId の要求が、実行中）。 */
interface InProgressEntry {
  readonly fingerprint: string;
  readonly startedAt: number;
  readonly operation: string;
  waiters: number;
  readonly reply: Promise<Reply>;
}

const reject = (res: ServerResponse, error: Failure, extra: Record<string, string> = {}): void =>
  send(res, STATUS[error.code] ?? 422, { ok: false, error }, extra);

/** 本文を上限つきで読む。超えたら（宣言の長さでも、チャンク転送の途中でも）読むのをやめて `undefined`。 */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) return resolve(undefined);
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (v: Buffer | undefined): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
      resolve(v);
    };
    const onData = (c: Buffer): void => {
      size += c.length;
      if (size > max) {
        done(undefined);
        return;
      }
      chunks.push(c);
    };
    const onEnd = (): void => {
      done(Buffer.concat(chunks));
    };
    const onError = (): void => {
      done(undefined);
    };
    // 本文を読み終える前に、接続が切れた（`end` も `error` も出ない場合がある）: 待ち続けない（同時数の枠を、返すため）。
    const onClose = (): void => {
      done(undefined);
    };
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });
}

export function createApiServer(deps: ApiDeps): ApiServer {
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY;
  let port = 0;

  const rl = deps.rateLimit ?? {};
  const mono = rl.monotonicMs;
  const principalLimiter = createRateLimiter({
    spec: rl.perPrincipal ?? DEFAULT_PRINCIPAL_SPEC,
    ...(mono === undefined ? {} : { nowMs: mono }),
    ...(rl.maxKeys === undefined ? {} : { maxKeys: rl.maxKeys }),
  });
  const identityLimiter = createRateLimiter({
    spec: rl.identity ?? DEFAULT_IDENTITY_SPEC,
    ...(mono === undefined ? {} : { nowMs: mono }),
    ...(rl.maxKeys === undefined ? {} : { maxKeys: rl.maxKeys }),
  });
  const failureLimiter = createRateLimiter({
    spec: rl.authFailures ?? {
      burst: DEFAULT_AUTH_FAILURE_BURST,
      perSecond: DEFAULT_AUTH_FAILURE_PER_MINUTE / 60,
    },
    ...(mono === undefined ? {} : { nowMs: mono }),
    ...(rl.maxKeys === undefined ? {} : { maxKeys: rl.maxKeys }),
  });
  const counters: ApiCounters = createApiCounters({
    ...(mono === undefined ? {} : { nowMs: mono }),
    ...(rl.summaryWindowMs === undefined ? {} : { windowMs: rl.summaryWindowMs }),
    wallMs: () => {
      const t = Date.parse(now());
      return Number.isFinite(t) ? t : Date.now();
    },
    ...(rl.summaryScheduler === undefined ? {} : { schedule: rl.summaryScheduler }),
    sink: {
      first: (kind, name) =>
        log(
          kind === "authFailed"
            ? { event: "apiAuthFailed", reason: name, at: now() }
            : kind === "rateLimited"
              ? { event: "apiRateLimited", key: name, at: now() }
              : { event: "apiDeduped", kind: name, at: now() },
        ),
      summary: (windowSec, c, window) =>
        log({
          event: "apiSummary",
          windowSec,
          ...(window === undefined
            ? {}
            : {
                windowStart: new Date(window.startMs).toISOString(),
                windowEnd: new Date(window.endMs).toISOString(),
              }),
          authFailed: c.authFailed,
          rateLimited: c.rateLimited,
          deduped: c.deduped,
          ...(Object.keys(c.hook).length === 0 ? {} : { hook: c.hook }),
          at: now(),
        }),
    },
  });
  /** 処理中の要求の表（T10l-d）。キーは「主体のキー + requestId」。項目は、ハンドラが実行中の要求だけで、終わったら（例外でも）必ず消す。 */
  const ip = deps.inProgress ?? {};
  const waitMs = ip.waitMs ?? 20_000;
  const maxWaiters = ip.maxWaiters ?? 16;
  const staleMs = ip.staleMs ?? 5 * 60_000;
  const maxEntries = ip.maxEntries ?? 1_024;
  const monoNow = mono ?? hrtimeMs;
  const inProgress = new Map<string, InProgressEntry>();
  /** 主体ごとの、同時に処理中の要求の数。 */
  const inFlight = new Map<string, number>();
  const maxInFlight = rl.maxInFlightPerPrincipal ?? 8;
  /**
   * 同時数の枠を取る。取れたら、返す関数（冪等）を返す。取れなければ `undefined`。**枠は、接続が終わった時点ではなく、処理が終わった時点で返す**
   * （ハンドラが終わったとき。接続が切れても、ハンドラが動いている間は、枠を使い続ける）。
   */
  const acquire = (key: string): (() => void) | undefined => {
    const cur = inFlight.get(key) ?? 0;
    if (cur >= maxInFlight) return undefined;
    inFlight.set(key, cur + 1);
    let done = false;
    const release = (): void => {
      if (done) return;
      done = true;
      const c = (inFlight.get(key) ?? 1) - 1;
      if (c <= 0) inFlight.delete(key);
      else inFlight.set(key, c);
    };
    return release;
  };
  const principalKey = (p: { role: string; nodeId?: string }): string =>
    p.role === "human" ? "human" : `node:${p.nodeId ?? ""}`;
  /**
   * 429（要求が多すぎる）。**この要求は実行していない**ことを保証する応答: 制限の判定は、ハンドラを呼ぶ前にだけ行う
   * （再試行しても二重に実行されない）。cause・nextActions には、トークン・nodeId・残りの量を出さない（`Retry-After` だけ）。
   */
  const tooMany = (res: ServerResponse, retryAfterSec: number, early = false): void =>
    reject(
      res,
      failure(
        "tooManyRequests",
        "要求が多すぎる（この要求は実行していない）",
        "Retry-After の秒数を待ってから、同じ要求をもう一度送る",
      ),
      { "retry-after": String(retryAfterSec), ...(early ? CLOSE : {}) },
    );
  /** Desktop の子のフックが効いていない（T21-ch）。 */
  const hooksNotActive = (): Failure =>
    failure(
      "hooksNotActive",
      "このノードの見張り（フック）が、直前に動いていない（daemon の作業ツリーを、Desktop で「ローカル」で開いて始めた子だけが報告できる）",
      "人に、daemon の作業ツリーを Desktop で開き、「ローカル」で新しいセッションを始めてもらう（チップで作った子は使えない）",
      "フックの設定（作業ツリーの .claude/settings.json）を変えていないか、人に確かめてもらう",
    );
  /** 認証の失敗の理由。直近に期限で失効させたトークンなら expired（T21-te）。 */
  type FailReason = "missing" | "invalid" | "expired" | "hookExpired";
  /** フック専用のトークンの期限切れ（`hookExpired`）は、フックの受け口でだけ見る。 */
  const failReason = (token: string | undefined, hook = false): FailReason =>
    token === undefined
      ? "missing"
      : deps.credentials.wasExpired?.(token) === true
        ? "expired"
        : hook && deps.hookTokens?.wasExpired?.(token) === true
          ? "hookExpired"
          : "invalid";
  /** 認証の失敗を数え、接続元ごとの制限に達していれば 429、そうでなければ 401。 */
  const authFailed = (req: IncomingMessage, res: ServerResponse, reason: FailReason): void => {
    counters.count("authFailed", reason);
    const origin = req.socket.remoteAddress ?? "unknown";
    const c = failureLimiter.tryConsume(origin, 1);
    // 失敗の制限が尽きている間も、無効なトークンには 401 を返す（429 にすると、待っても直らない再試行に誘導してしまう）。
    // 待つ秒数は `Retry-After` で伝える。
    if (!c.ok) counters.count("rateLimited", "origin");
    reject(
      res,
      reason === "hookExpired"
        ? failure(
            "tokenExpired",
            "フック専用のトークンの期限が切れた（発行から時間がたった）",
            '人が eval "$(cso hook-env <nodeId>)" で出し直し、セッションを起動し直す',
          )
        : reason === "expired"
          ? failure(
              "tokenExpired",
              "ノードのトークンの期限が切れた（使わなかった時間が長い・発行から時間がたった・子の役目が終わった）",
              "親か人が node.bindCode で紐付けのコードを出し直し、子が結び直す（Desktop の子）",
              "daemon が起動した子なら、親か人が子を再開するか、作り直す",
            )
          : failure(
              "unauthenticated",
              "資格情報がないか、正しくない",
              "正しい資格情報で呼び出す",
              "資格情報を再発行する",
            ),
      {
        "www-authenticate": "Bearer",
        ...CLOSE,
        ...(c.ok ? {} : { "retry-after": String(c.retryAfterSec) }),
      },
    );
  };

  const hostOk = (host: unknown): boolean =>
    typeof host === "string" && (host === `${HOST}:${port}` || host === `localhost:${port}`);
  const originOk = (origin: unknown): boolean =>
    origin === undefined ||
    origin === `http://${HOST}:${port}` ||
    origin === `http://localhost:${port}`;

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!hostOk(req.headers.host) || !originOk(req.headers.origin)) {
      return reject(
        res,
        failure(
          "invalidHost",
          "Host または Origin が許可されていない",
          "127.0.0.1 から直接呼び出す",
        ),
      );
    }
    const path = (req.url ?? "").split("?")[0];
    if (path === "/v1/bind" && deps.bind !== undefined) return handleBind(req, res, deps.bind);
    if (path === "/v1/hook" && deps.hook !== undefined) return handleHook(req, res, deps.hook);
    if (path === "/v1/whoami") return handleWhoami(req, res);
    if (path === "/v1/ui/state") return handleUiState(req, res);
    if (path === "/v1/events") return handleEvents(req, res);
    const asset =
      path !== undefined && Object.hasOwn(UI_ASSETS, path) ? UI_ASSETS[path] : undefined;
    if (asset !== undefined) return handleUiAsset(req, res, asset);
    if (path === "/v1/identity" && deps.identity !== undefined) return handleIdentity(req, res);
    if (path !== "/v1/request") {
      return reject(res, failure("notFound", "このパスはない", "POST /v1/request を使う"));
    }
    if (req.method !== "POST") {
      return reject(res, failure("methodNotAllowed", "POST だけを受け付ける", "POST で呼び出す"), {
        allow: "POST",
      });
    }
    const token = parseBearer(req.headers.authorization);
    const principal = deps.credentials.authenticate(token);
    if (principal === undefined) {
      return authFailed(req, res, failReason(token));
    }
    const valid = checkPrincipal(principal, deps.getState());
    if (!valid.ok) {
      counters.count("authFailed", "principalRejected");
      req.resume();
      return reject(res, valid.error, { "www-authenticate": "Bearer", ...CLOSE });
    }
    // Desktop の子は、直前にフックが効いていなければ、報告を受けない（T21-ch。見張りの外で動く子を通さない）
    if (
      principal.role === "child" &&
      deps.hookFresh !== undefined &&
      !deps.hookFresh(principal.nodeId)
    ) {
      req.resume();
      return reject(res, hooksNotActive(), CLOSE);
    }
    // 回数の制限（主体ごと）。ハンドラを呼ぶ前にだけ判定するので、429 の要求は実行されていない。本文は読まない。
    // 同時に処理中の要求の数にも上限がある（ゆっくり本文を送る要求で、接続を塞がれないように）。
    const key = principalKey(principal);
    const releaseSlot = acquire(key);
    if (releaseSlot === undefined) {
      counters.count("rateLimited", "inflight");
      req.resume();
      return tooMany(res, 1, true);
    }
    const used = principalLimiter.tryConsume(key, 1);
    if (!used.ok) {
      releaseSlot();
      counters.count("rateLimited", "principal");
      req.resume();
      return tooMany(res, used.retryAfterSec, true);
    }
    try {
      await processBody(req, res, principal, key, releaseSlot);
    } finally {
      releaseSlot(); // ハンドラが終わった（または、ハンドラまで進まなかった）時点で、枠を返す
    }
  }

  /** 本文を読んでから、ハンドラまで。同時数の枠は、呼び出し側が、これが終わったときに返す（重複と分かったときは、すぐに返す）。 */
  async function processBody(
    req: IncomingMessage,
    res: ServerResponse,
    principal: Principal,
    key: string,
    releaseSlot: () => void,
  ): Promise<void> {
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
      req.resume();
      return reject(
        res,
        failure("unsupportedMediaType", "Content-Type が application/json でない", "JSON で送る"),
        CLOSE,
      );
    }
    const raw = await readBody(req, maxBody);
    if (raw === undefined) {
      return reject(
        res,
        failure("payloadTooLarge", `本文が上限（${maxBody} バイト）を超えた`, "本文を小さくする"),
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return reject(res, failure("invalidRequest", "本文が JSON でない", "JSON で送る"));
    }
    const env = parseEnvelope(body);
    if (!env.ok) return reject(res, env.error);
    const { requestId, operation } = env.value;
    // ロール・申告の判定は、重複の判定より前に行う（申告が食い違う要求が、処理中の要求の結果に相乗りして、拒否を逃れないように）。
    // 引数の検証より先に行う（ロールのない操作に、引数の形を教えない）。
    const role = authorizeRole(principal, operation, {
      ...(env.value.claimedRole === undefined ? {} : { claimedRole: env.value.claimedRole }),
      ...(env.value.claimedCaller === undefined ? {} : { claimedCaller: env.value.claimedCaller }),
    });
    if (!role.ok) return reject(res, role.error);
    // 同じ主体・同じ requestId の要求が処理中なら、実行せず、最初の結果を待って、同じ結果を返す（T10l-d。relay の再送で、操作が重なって
    // 実行されないように）。重い操作の追加の重みより前に判定する（重複が、重みを重ねて使わない）。枠も、判明した時点で返す。
    const dupKey = `${key}\u0000${requestId}`;
    const fingerprint = fingerprintOf(operation, env.value.params);
    let existing = inProgress.get(dupKey);
    if (existing !== undefined && monoNow() - existing.startedAt >= staleMs) {
      // 古い項目（ハンドラが戻らない不具合）は外す。外したあとの同じ組の要求は、ハンドラが実行されうるので、毎回すぐに記録する。
      log({
        event: "apiInProgressStale",
        operation: existing.operation,
        ageSec: Math.round((monoNow() - existing.startedAt) / 1000),
        at: now(),
      });
      inProgress.delete(dupKey);
      existing = undefined;
    }
    if (existing !== undefined) {
      releaseSlot();
      if (existing.fingerprint !== fingerprint) {
        // 同じ requestId が、別の内容の要求に使われている（実行しない）。ハンドラ層の requestIdConflict と同じ 422。
        counters.count("deduped", "conflict");
        return reject(
          res,
          failure(
            "requestIdConflict",
            "同じ requestId が、別の内容の要求に使われている",
            "新しい requestId で要求する",
          ),
        );
      }
      const busy = (): void => {
        counters.count("deduped", "inProgress");
        reject(
          res,
          failure(
            "inProgress",
            "同じ要求を処理中（この要求は実行していない）",
            "Retry-After の秒数を待ってから、同じ要求をもう一度送る",
          ),
          { "retry-after": "2" },
        );
      };
      if (existing.waiters >= maxWaiters) return busy();
      existing.waiters += 1;
      counters.count("deduped", "coalesced");
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), waitMs);
      });
      const outcome = await Promise.race([existing.reply, timedOut]);
      clearTimeout(timer);
      existing.waiters -= 1;
      if (outcome === "timeout") return busy();
      return sendReply(res, outcome);
    }
    // 重い操作は、追加のトークンを使う（操作の名前は本文から分かる。ハンドラの前）。
    const extra = operationWeight(operation) - 1;
    if (extra > 0) {
      const heavy = principalLimiter.tryConsume(key, extra);
      if (!heavy.ok) {
        counters.count("rateLimited", "principal");
        return tooMany(res, heavy.retryAfterSec);
      }
    }
    const params = validateParams(operation, env.value.params);
    if (!params.ok) return reject(res, params.error);
    const scope = authorizeScope(principal, operation, params.value, deps.getState());
    if (!scope.ok) return reject(res, scope.error);

    const handler = Object.hasOwn(deps.handlers, operation)
      ? (deps.handlers[operation] as ((r: HandlerRequest) => unknown) | undefined)
      : undefined;
    if (handler === undefined) {
      return reject(
        res,
        failure("notImplemented", `操作 ${operation} は未実装`, "実装の完了を待つ"),
      );
    }
    const request: HandlerRequest = {
      requestId,
      operation,
      role: principal.role,
      ...(principal.role === "human" ? {} : { caller: { nodeId: principal.nodeId } }),
      params: params.value,
    };
    if (inProgress.size >= maxEntries) {
      counters.count("rateLimited", "inProgressTable");
      return tooMany(res, 1);
    }
    let resolveReply: (r: Reply) => void = () => undefined;
    const entry: InProgressEntry = {
      fingerprint,
      startedAt: monoNow(),
      operation,
      waiters: 0,
      reply: new Promise<Reply>((resolve) => {
        resolveReply = resolve;
      }),
    };
    inProgress.set(dupKey, entry);
    let reply: Reply;
    try {
      reply = await execute(handler, request, operation, requestId);
    } finally {
      // 例外でも、必ず表から消す（古い項目を外したあとに入った、別の項目は消さない）。
      if (inProgress.get(dupKey) === entry) inProgress.delete(dupKey);
    }
    resolveReply(reply);
    sendReply(res, reply);
  }

  /** ハンドラを呼んで、応答を作る（送らない）。例外は 500。 */
  async function execute(
    handler: (r: HandlerRequest) => unknown,
    request: HandlerRequest,
    operation: DaemonOperation,
    requestId: string,
  ): Promise<Reply> {
    let result: Result<unknown, Failure>;
    try {
      result = (await handler(request)) as Result<unknown, Failure>;
    } catch (error) {
      return internalReply(requestId, operation, error);
    }
    if (!result.ok) {
      // 操作の失敗（権限・入力の検査を通った後の、状態に依る失敗）は 422。コードごとの状態に写さない:
      // ハンドラの失敗コードは操作ごとに増えるため、ここでは「要求は正しいが、今は実行できない」で統一する。
      return { status: 422, body: { ok: false, error: result.error } };
    }
    const value = pickResult(operation, result.value);
    if (value === undefined) {
      return internalReply(requestId, operation, new Error("ハンドラの結果がオブジェクトでない"));
    }
    return { status: 200, body: { ok: true, value } };
  }

  /** 認証したロールだけを返す。トークンはクエリでは受け取らない（Authorization ヘッダだけ）。 */
  /** 身元確認。認証なし。Host・Origin の検査は、入口で済んでいる。接続元ごとの回数の制限がある（超えたら 429）。 */
  function handleIdentity(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") {
      reject(res, failure("methodNotAllowed", "GET だけを受け付ける", "GET で呼び出す"), {
        allow: "GET",
      });
      return;
    }
    // 認証済みの要求とは別の bucket（mcp は、トークンつきの要求の直前ごとに 1 回呼ぶ）。
    const used = identityLimiter.tryConsume(req.socket.remoteAddress ?? "unknown", 1);
    if (!used.ok) {
      counters.count("rateLimited", "identity");
      tooMany(res, used.retryAfterSec);
      return;
    }
    const query = new URL(req.url ?? "", "http://127.0.0.1").searchParams;
    const nonces = query.getAll("nonce");
    const nonce = nonces[0];
    if (
      [...query.keys()].some((k) => k !== "nonce") ||
      nonces.length !== 1 ||
      !isValidNonce(nonce)
    ) {
      reject(
        res,
        failure(
          "invalidRequest",
          `nonce が不正（小文字の 16 進で ${NONCE_MIN_HEX}〜${NONCE_MAX_HEX} 桁の偶数。1 つだけ）`,
          "ランダムな nonce を 1 つ指定する",
        ),
      );
      return;
    }
    const identity = deps.identity?.();
    if (identity === undefined) {
      send(res, 503, {
        ok: false,
        error: failure("unavailable", "身元をまだ用意できていない", "少し待って、もう一度呼び出す"),
      });
      return;
    }
    send(res, 200, {
      ok: true,
      // 接続先（このサーバーが待ち受けているポート）を、proof に含める。別のポートの偽の daemon が、本物へ中継しても、一致しない。
      value: { daemonId: identity.daemonId, proof: proofOf(identity, `${HOST}:${port}`, nonce) },
    });
  }

  function handleWhoami(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") {
      reject(res, failure("methodNotAllowed", "GET だけを受け付ける", "GET で呼び出す"), {
        allow: "GET",
      });
      return;
    }
    const unauthenticated = (): void =>
      reject(
        res,
        failure(
          "unauthenticated",
          "資格情報がないか、正しくない",
          "正しい資格情報で呼び出す",
          "資格情報を再発行する",
        ),
        { "www-authenticate": "Bearer" },
      );
    const wsToken = parseBearer(req.headers.authorization);
    const principal = deps.credentials.authenticate(wsToken);
    if (principal === undefined) {
      authFailed(req, res, failReason(wsToken));
      return;
    }
    // 失効・止まったノード・ロールの食い違いは、理由を教えずに 401 にする。
    if (!checkPrincipal(principal, deps.getState()).ok) {
      counters.count("authFailed", "principalRejected");
      unauthenticated();
      return;
    }
    const used = principalLimiter.tryConsume(principalKey(principal), 1);
    if (!used.ok) {
      counters.count("rateLimited", "principal");
      tooMany(res, used.retryAfterSec);
      return;
    }
    // ノードのトークン（統合・子）には、自分の nodeId も返す（mcp の `whoami` ツール。T10m-wh）。人間には、nodeId がない。
    send(res, 200, {
      ok: true,
      value:
        principal.role === "human"
          ? { role: principal.role }
          : { role: principal.role, nodeId: principal.nodeId },
    });
  }

  const sessions = deps.hookSessions ?? createSessionBinder();
  /**
   * ファイルで設定するフックの受け口（T22-h。`docs/plugin.md` の「フック」）。子のノードのトークンだけ（ほかは 403）。
   * 認証・主体の検査・同時数・回数の制限は、`/v1/request` と同じ（重みは 0.5）。重複の扱い（requestId）はない（判定は冪等）。
   * 応答は `{ decision: "allow" | "deny", reason? }`。判定するのは PreToolUse だけで、PostToolUse・Stop は受けて allow を返す。
   */
  /** 受け口の主体: ノードのトークンか、フック専用のトークン（T22-ht。子のノードとして扱う。ほかの入口では使えない）。 */
  const hookPrincipal = (token: string | undefined): Principal | undefined => {
    const p = deps.hookTokensOnly === true ? undefined : deps.credentials.authenticate(token);
    if (p !== undefined) return p;
    const nodeId = deps.hookTokens?.authenticate(token);
    return nodeId === undefined ? undefined : { role: "child", nodeId };
  };

  async function handleHook(
    req: IncomingMessage,
    res: ServerResponse,
    decide: HookDecider,
  ): Promise<void> {
    if (req.method !== "POST") {
      return reject(res, failure("methodNotAllowed", "POST だけを受け付ける", "POST で呼び出す"), {
        allow: "POST",
      });
    }
    // 届いた要求の数（T24-hc。認証・回数の制限の前なので、断った要求も含む）。
    counters.count("hook", "received");
    const token = parseBearer(req.headers.authorization);
    const principal = hookPrincipal(token);
    if (principal === undefined) {
      return authFailed(req, res, failReason(token, true));
    }
    const valid = checkPrincipal(principal, deps.getState());
    if (!valid.ok) {
      counters.count("authFailed", "principalRejected");
      req.resume();
      return reject(res, valid.error, { "www-authenticate": "Bearer", ...CLOSE });
    }
    if (principal.role !== "child") {
      req.resume();
      return reject(
        res,
        failure(
          "forbidden",
          "フックの受け口は、子のノードのトークンだけが使える",
          "子のノードのトークンで呼び出す",
        ),
        CLOSE,
      );
    }
    const key = principalKey(principal);
    const releaseSlot = acquire(key);
    if (releaseSlot === undefined) {
      counters.count("rateLimited", "inflight");
      req.resume();
      return tooMany(res, 1, true);
    }
    try {
      // フックはツール呼び出しのたびに来るので、軽い重み（0.5）。同じ bucket の、子のほかの要求を締め出しにくくする。
      const used = principalLimiter.tryConsume(key, HOOK_WEIGHT);
      if (!used.ok) {
        counters.count("rateLimited", "principal");
        req.resume();
        return tooMany(res, used.retryAfterSec, true);
      }
      if (!/^application\/json(\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
        req.resume();
        return reject(
          res,
          failure("unsupportedMediaType", "Content-Type が application/json でない", "JSON で送る"),
          CLOSE,
        );
      }
      const raw = await readBody(req, maxBody);
      if (raw === undefined) {
        return reject(
          res,
          failure(
            "payloadTooLarge",
            `本文が大きすぎる（上限 ${maxBody} バイト）。フックは拒否として扱う`,
            "書き込む内容を分けて、小さくする",
          ),
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return reject(res, failure("invalidRequest", "本文が JSON でない", "JSON で送る"));
      }
      const parsed = parseHookRequest(body);
      if (!parsed.ok) return reject(res, parsed.error);
      const h = parsed.value;
      // 本文を読んでいるあいだに、トークンが発行し直された・失効したなら、この要求では結ばない（T22-hu）。認証からここまでは
      // 非同期（本文の読み込み）なので、もう一度確かめる。ここから結ぶまでは同期の処理なので、間に発行し直されることはない。
      const again = hookPrincipal(token);
      if (again === undefined || again.role !== "child" || again.nodeId !== principal.nodeId) {
        counters.count("authFailed", "principalRejected");
        return reject(
          res,
          failure(
            "unauthenticated",
            "資格情報がないか、正しくない",
            "正しい資格情報で呼び出す",
            "資格情報を再発行する",
          ),
          { "www-authenticate": "Bearer" },
        );
      }
      const mismatch = () => {
        log({ event: "hookSessionMismatch", at: now() });
        return reject(
          res,
          failure(
            "forbidden",
            "このトークンは、別のセッションに結ばれている。node.bindCode を出し直し、新しいセッションで始める",
            "node.bindCode を出し直し、新しいセッションで始める",
          ),
        );
      };
      // 結ぶのは、許可した最初の呼び出しのときだけ（拒否した呼び出しでは結ばない）
      if (!sessions.accepts(principal.nodeId, h.sessionId)) return mismatch();
      if (h.event !== "PreToolUse" || h.toolName === undefined) {
        if (!sessions.check(principal.nodeId, h.sessionId)) return mismatch();
        counters.count("hook", "allowed");
        return send(res, 200, { ok: true, value: { decision: "allow" } });
      }
      let d: Awaited<ReturnType<HookDecider>>;
      try {
        d = await decide(principal.nodeId, h.toolName, h.toolInput, h.cwd);
        // Desktop の子の「直前のフックの呼び出し」（T21-ch。bind・report の前に確かめる）。許可したときだけ数える（R2）
        if (d.allow) deps.onHookSeen?.(principal.nodeId);
      } catch {
        d = { allow: false, reason: "フックの判定に失敗したため拒否した。" };
      }
      // 判定の間に、別のセッションが先に結ばれていたら 403
      if (d.allow && !sessions.check(principal.nodeId, h.sessionId)) return mismatch();
      counters.count("hook", d.allow ? "allowed" : "denied");
      return send(res, 200, {
        ok: true,
        value: d.allow ? { decision: "allow" } : { decision: "deny", reason: d.reason },
      });
    } finally {
      releaseSlot();
    }
  }

  /** 画面の資産（HTML・JS・CSS）。状態を含まないので、認証はない（Host・Origin の検査は、入口で済んでいる）。 */
  function handleUiAsset(req: IncomingMessage, res: ServerResponse, asset: UiAsset): void {
    if (req.method !== "GET") {
      reject(res, failure("methodNotAllowed", "GET だけを受け付ける", "GET で呼び出す"), {
        allow: "GET",
      });
      return;
    }
    // 静的な資産（状態を含まない）には、回数の制限をかけない（`docs/ui.md`）。
    res.writeHead(200, {
      ...UI_HEADERS,
      ...(asset.html === true ? UI_HTML_HEADERS : {}),
      "content-type": asset.type,
      "content-length": Buffer.byteLength(asset.body),
    });
    res.end(asset.body);
  }

  /**
   * 画面の入口（`/v1/ui/state`・`/v1/events`）の認証。人間のトークンだけ（それ以外は 403）。認証・失効・回数の制限は、`whoami` と同じ。
   * 通らなければ、応答を返して `undefined`。
   */
  function authenticateHuman(req: IncomingMessage, res: ServerResponse): string | undefined {
    if (req.method !== "GET") {
      reject(res, failure("methodNotAllowed", "GET だけを受け付ける", "GET で呼び出す"), {
        allow: "GET",
      });
      return undefined;
    }
    const token = parseBearer(req.headers.authorization);
    const principal = deps.credentials.authenticate(token);
    if (principal === undefined || token === undefined) {
      authFailed(req, res, failReason(token));
      return undefined;
    }
    if (!checkPrincipal(principal, deps.getState()).ok) {
      counters.count("authFailed", "principalRejected");
      reject(
        res,
        failure(
          "unauthenticated",
          "資格情報がないか、正しくない",
          "正しい資格情報で呼び出す",
          "資格情報を再発行する",
        ),
        { "www-authenticate": "Bearer" },
      );
      return undefined;
    }
    const used = principalLimiter.tryConsume(principalKey(principal), 1);
    if (!used.ok) {
      counters.count("rateLimited", "principal");
      tooMany(res, used.retryAfterSec);
      return undefined;
    }
    if (principal.role !== "human") {
      reject(
        res,
        failure("forbidden", "画面の状態は人間のトークンだけが読める", "人間のトークンで呼び出す"),
      );
      return undefined;
    }
    return token;
  }

  /** 画面の表示モデル。 */
  function handleUiState(req: IncomingMessage, res: ServerResponse): void {
    if (authenticateHuman(req, res) === undefined) return;
    // 表示モデルは、`lastSeq` が同じなら同じ（直近の 1 件だけ持つ）。`If-None-Match` が一致すれば 304（本文なし）。
    const current = deps.getState();
    const cv = deps.confirmationsVersion?.() ?? 0;
    if (uiCache === undefined || uiCache.seq !== current.lastSeq || uiCache.cv !== cv) {
      const etag =
        deps.confirmations === undefined ? `"${current.lastSeq}"` : `"${current.lastSeq}.${cv}"`;
      uiCache = {
        seq: current.lastSeq,
        cv,
        etag,
        // 能力表（stopDelegated）は、アダプタごとに固定なので、lastSeq の鍵のままでよい。将来、能力表が記録なしに変わりうる
        // （実機確認の結果を実行中に差し替えるなど）なら、キャッシュの鍵に能力表を含めるよう見直す。
        json: JSON.stringify({
          ok: true,
          value: {
            ...uiViewOf(
              current,
              deps.stopDelegated === undefined ? {} : { stopDelegated: deps.stopDelegated },
            ),
            ...(deps.confirmations === undefined ? {} : { confirmations: deps.confirmations() }),
          },
        }),
      };
    }
    const headers = {
      etag: uiCache.etag,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
    };
    if (req.headers["if-none-match"] === uiCache.etag) {
      res.writeHead(304, headers);
      res.end();
      return;
    }
    res.writeHead(200, {
      ...headers,
      "content-type": "application/json; charset=utf-8",
      "content-length": Buffer.byteLength(uiCache.json),
    });
    res.end(uiCache.json);
  }

  // --- SSE（`GET /v1/events`。T23 PR2。接続の管理は `sse-hub.ts`）---
  const sseHub = createSseHub({
    spec: {
      maxConnections: deps.sse?.maxConnections ?? 4,
      coalesceMs: deps.sse?.coalesceMs ?? 250,
      heartbeatMs: deps.sse?.heartbeatMs ?? 15_000,
      drainTimeoutMs: deps.sse?.drainTimeoutMs ?? 10_000,
      maxLifetimeMs: deps.sse?.maxLifetimeMs ?? 3_600_000,
    },
    // 確認待ちの変化（記録の seq は変わらない）も、画面に知らせる（どちらも増えるだけなので、和も増えるだけ）。
    getSeq: () => deps.getState().lastSeq + (deps.confirmationsVersion?.() ?? 0),
    isTokenValid: (token) => deps.credentials.authenticate(token) !== undefined,
    nowMs: hrtimeMs,
  });

  function handleEvents(req: IncomingMessage, res: ServerResponse): void {
    const token = authenticateHuman(req, res);
    if (token === undefined) return;
    if (sseHub.size >= (deps.sse?.maxConnections ?? 4)) {
      counters.count("rateLimited", "sse");
      tooMany(res, 5);
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "cross-origin-resource-policy": "same-origin",
      connection: "keep-alive",
    });
    sseHub.add(responseSink(res), token);
  }

  /** `GET /v1/ui/state` の直近の 1 件（`lastSeq` が鍵）。 */
  let uiCache:
    | { readonly seq: number; readonly cv: number; readonly etag: string; readonly json: string }
    | undefined;

  const now = (): string => (deps.clock ?? (() => new Date().toISOString()))();
  const throttle: Throttle = deps.bindThrottle ?? createThrottle({});

  function log(event: ApiLogEvent): void {
    try {
      deps.logger?.(event);
    } catch {
      // 記録の失敗で、応答を変えない。
    }
  }

  /**
   * bind 専用の入口。トークンを持たない子が、`nodeId` と bind コード（一度きり・短い有効期限・ノードに結ぶ）だけで、
   * 子ロールのノードトークンを受け取る（そのノードの既存のトークンは無効になる）。失敗は、未知・使用済み・期限切れ・ノードの状態の違いを区別せず 401 とし、
   * 失敗が続いたら 429。トークンはこの応答でだけ返す（記録しない）。
   */
  async function handleBind(
    req: IncomingMessage,
    res: ServerResponse,
    bind: BindCodes,
  ): Promise<void> {
    const bindKey = `bind:${req.socket.remoteAddress ?? "unknown"}`;
    // 失敗は、どれも全体のスロットルで数える（不正な本文・型違いも）。
    const denied = (
      error: Failure,
      reason: "invalid" | "rejected" | "malformed",
      extra: Record<string, string> = {},
    ): void => {
      throttle.fail();
      log({ event: "bindFailed", reason, at: now() });
      counters.count("authFailed", "bindFailed");
      // 接続元ごとの bucket でも数える（T10l-f）。トークンの認証の失敗とは別のキー（`bind:<接続元>`）: 失効したトークンの連打で、
      // 新しい子の bind が止まらず、bind の失敗でトークンの認証が止まらない。
      if (!failureLimiter.tryConsume(bindKey, 1).ok) counters.count("rateLimited", "origin");
      reject(res, error, extra);
    };
    const wait = throttle.blocked();
    if (wait !== undefined) {
      log({ event: "bindThrottled", reason: "global", at: now() });
      req.resume();
      return reject(
        res,
        failure(
          "tooManyRequests",
          "失敗が続いたため、しばらく受け付けない",
          "しばらく待って、もう一度試す",
        ),
        { "retry-after": String(Math.max(1, Math.ceil(wait / 1000))) },
      );
    }
    // bind の失敗が続いている接続元は、本文を読まずに 429（bind 専用の bucket が尽きている間）。成功は数えない。
    const source = failureLimiter.canConsume(bindKey, 1);
    if (!source.ok) {
      log({ event: "bindThrottled", reason: "origin", at: now() });
      counters.count("rateLimited", "origin");
      req.resume();
      return reject(
        res,
        failure(
          "tooManyRequests",
          "この接続元からの失敗が続いたため、しばらく受け付けない",
          "Retry-After の秒数を待ってから、もう一度試す",
        ),
        { "retry-after": String(source.retryAfterSec), ...CLOSE },
      );
    }
    if (req.method !== "POST") {
      return reject(res, failure("methodNotAllowed", "POST だけを受け付ける", "POST で呼び出す"), {
        allow: "POST",
      });
    }
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
      req.resume();
      return denied(
        failure("unsupportedMediaType", "Content-Type が application/json でない", "JSON で送る"),
        "malformed",
      );
    }
    const raw = await readBody(req, BIND_MAX_BODY);
    if (raw === undefined) {
      res.once("finish", () => req.destroy());
      return denied(
        failure(
          "payloadTooLarge",
          `本文が上限（${BIND_MAX_BODY} バイト）を超えた`,
          "本文を小さくする",
        ),
        "malformed",
        { connection: "close" },
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return denied(failure("invalidRequest", "本文が JSON でない", "JSON で送る"), "malformed");
    }
    const b = body as { nodeId?: unknown; bindCode?: unknown } | null;
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      Object.keys(body).some((k) => k !== "nodeId" && k !== "bindCode") ||
      !isSafeId(b?.nodeId) ||
      !isBoundedText(b?.bindCode, 64)
    ) {
      return denied(
        failure(
          "invalidRequest",
          "本文は { nodeId, bindCode } の形で送る",
          "nodeId と bindCode を確認する",
        ),
        "malformed",
      );
    }
    const nodeId = b?.nodeId as string;
    // Desktop の子は、直前にフックが効いていなければ、紐付けない（コードは使わずに残す。T21-ch）
    if (deps.hookFresh !== undefined && !deps.hookFresh(nodeId)) {
      return reject(res, hooksNotActive(), CLOSE);
    }
    // 結び付いたノードが、子ロールで、トークンを持てる状態か（統合ノード・木にない・停止後などは不可）を先に確かめ、
    // 許されたときだけコードを消費する。
    const redeemed = bind.redeem(
      nodeId,
      b?.bindCode,
      (id) => checkPrincipal({ role: "child", nodeId: id }, deps.getState()).ok,
    );
    const unauthorized = (reason: "invalid" | "rejected"): void =>
      denied(failure("unauthenticated", "bind コードが無効", "bind コードを再発行する"), reason, {
        "www-authenticate": "Bearer",
      });
    if (!redeemed.ok) return unauthorized(redeemed.reason);
    let token: string;
    try {
      token = deps.credentials.issueNodeToken(redeemed.nodeId, "child", "bind");
    } catch (error) {
      return internalError(res, "bind", "bind", error);
    }
    log({ event: "bindSucceeded", nodeId: redeemed.nodeId, at: now() });
    send(res, 200, { ok: true, value: { nodeId: redeemed.nodeId, token } });
  }

  function internalReply(
    requestId: string,
    operation: DaemonOperation | "bind",
    error: unknown,
  ): Reply {
    log({ event: "internalError", requestId, operation, error, at: now() });
    return {
      status: 500,
      body: {
        ok: false,
        error: failure(
          "internalError",
          "内部エラー",
          "もう一度試す",
          "改善しなければ管理者に知らせる",
        ),
      },
    };
  }
  function internalError(
    res: ServerResponse,
    requestId: string,
    operation: DaemonOperation | "bind",
    error: unknown,
  ): void {
    sendReply(res, internalReply(requestId, operation, error));
  }

  const conn = deps.connection ?? {};
  const server: Server = createServer(
    // タイムアウトは、この間隔でしか検査されない（既定 30 秒）。ヘッダ 10 秒・要求 30 秒を、ほぼ正確に効かせるため、1 秒にする。
    { connectionsCheckingInterval: conn.checkIntervalMs ?? 1000 },
    (req, res) => {
      // すべての応答に、この daemon の公開 ID を付ける（相手の検知用。mcp は、検証で得た daemonId と、トークンつきの要求の応答で照合する。
      // 検証から送信までの窓で、別のプロセスに入れ替わったことを知るため。防止ではなく、検知）。身元がまだない間は付けない。
      const daemonId = deps.identity?.()?.daemonId;
      if (daemonId !== undefined) res.setHeader("x-cso-daemon-id", daemonId);
      handle(req, res).catch(() => {
        if (!res.headersSent) {
          reject(res, failure("internalError", "内部エラー", "もう一度試す"));
        } else {
          res.destroy();
        }
      });
    },
  );
  // 遅い要求で接続を塞がれないように、明示する（有効なトークンでも、本文をゆっくり送って、接続を占有できてしまう）。
  server.requestTimeout = conn.requestTimeoutMs ?? 30_000;
  server.headersTimeout = conn.headersTimeoutMs ?? 10_000;
  server.keepAliveTimeout = conn.keepAliveTimeoutMs ?? 5_000;
  server.maxConnections = conn.maxConnections ?? 256;

  return {
    listen: (p) =>
      new Promise((resolve, reject2) => {
        server.once("error", reject2);
        server.listen(p, HOST, () => {
          server.off("error", reject2);
          port = (server.address() as AddressInfo).port;
          resolve({ port, url: `http://${HOST}:${port}` });
        });
      }),
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          counters.flush(); // 溜まっている件数を、最後に 1 行にまとめる
          resolve();
        });
        server.closeAllConnections();
      }),
  };
}
