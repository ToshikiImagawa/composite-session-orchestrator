/**
 * cso-mcp の待ち受け（Streamable HTTP）。子・統合の MCP クライアントが `mcpUrl` で接続する。
 * 127.0.0.1 だけで待ち受け、`POST /mcp` の 1 本で受ける。ステートレス（接続のセッションを持たない）で、リクエストごとに
 * Bearer のトークンから daemon にロールを尋ね（`openSession`）、そのロールのツールだけを公開する。
 * トークンの真偽・ロールの判定は daemon の窓口に委ねる。ログにトークンも本文も出さない。
 *
 * 処理の順（どこで失敗しても拒否する）: Host・Origin（ポートも照合）→ パス・メソッド → Bearer（daemon と同じ形）→ ロールの解決（whoami）→ Content-Type → 本文（上限・読み取り全体の時間）→ MCP。
 * 停止（`close`）は、新しい接続を止め、処理中の要求が終わるのを猶予まで待ってから、残りを切る（結果が返らず、呼び直しで二重に実行されるのを防ぐ）。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type Failure, failure, ok, type Result } from "@cso/core";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { IdentityVerifier } from "./identity.js";
import { createRelay, MAX_RELAY_BYTES } from "./relay.js";
import { openSession } from "./server.js";

const HOST = "127.0.0.1";
const PATH = "/mcp";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type McpHttpLogEvent =
  | { readonly event: "sessionFailed"; readonly code: string; readonly at: string }
  /** 検証なしで動いている（起動のとき 1 度だけ）。 */
  | { readonly event: "identityUnverified"; readonly at: string };

/**
 * daemon の身元確認の方式。`verified`: トークンつきの要求の直前に、毎回、検証する。`unverified`: 検証しない
 * （`--config` なしの `CSO_MCP_ALLOW_UNVERIFIED=1`）。そのときは、起動のログと、すべての応答のヘッダー
 * （`x-cso-identity: unverified`）で分かるようにする。
 */
export type IdentityMode =
  | { readonly kind: "verified"; readonly verifier: IdentityVerifier }
  | { readonly kind: "unverified" };

/** 検証なしで動いているときの、応答のヘッダー。 */
export const UNVERIFIED_HEADER = "x-cso-identity";

/** 接続の上限・タイムアウト（遅い接続・多すぎる接続への対策）。 */
export const MAX_CONNECTIONS = 64;
export const REQUEST_TIMEOUT_MS = 30_000;
export const HEADERS_TIMEOUT_MS = 10_000;
export const KEEP_ALIVE_TIMEOUT_MS = 5_000;
/** 本文の読み取り全体の上限時間。 */
export const BODY_TIMEOUT_MS = 15_000;
/** 停止の猶予（bin の 10 秒の強制終了より短く）。 */
export const SHUTDOWN_GRACE_MS = 8_000;

export interface McpHttpOptions {
  /** daemon の窓口（ループバックの URL）。 */
  readonly daemonUrl: string;
  /** daemon の身元確認の方式（必須。省略して、検証なしで動くことがないように）。 */
  readonly identity: IdentityMode;
  readonly fetch?: typeof fetch;
  /** 本文の上限（バイト）。既定 1 MiB。 */
  readonly maxBodyBytes?: number;
  /** 本文の読み取り全体の上限時間（ミリ秒）。既定 15 秒。 */
  readonly bodyTimeoutMs?: number;
  /** 停止の猶予（ミリ秒）。既定 8 秒。 */
  readonly shutdownGraceMs?: number;
  /** daemon への中継のタイムアウト（ミリ秒。テスト用。既定は `createRelay` のもの）。 */
  readonly relayTimeoutMs?: number;
  /** 失敗の記録（トークン・本文は渡さない）。 */
  readonly logger?: (e: McpHttpLogEvent) => void;
}

export interface McpHttpServer {
  /** 127.0.0.1 で待ち受ける。`port` が 0 なら空いているポート。`url` は `http://127.0.0.1:<port>`。 */
  listen(port: number): Promise<{ readonly port: number; readonly url: string }>;
  /** 停止: 新しい接続を止め、アイドルの接続を閉じ、処理中の要求が終わるのを猶予まで待ち、残りを切る。 */
  close(): Promise<void>;
  /** 設定している接続の上限・タイムアウト。 */
  limits(): {
    readonly maxConnections: number;
    readonly requestTimeoutMs: number;
    readonly headersTimeoutMs: number;
    readonly keepAliveTimeoutMs: number;
  };
}

const STATUS: Readonly<Record<string, number>> = {
  unauthenticated: 401,
  forbidden: 403,
  role_not_exposed: 403,
  invalid_config: 401,
  daemon_timeout: 504,
  tooManyRequests: 429,
  rate_limited: 429,
  in_progress: 409,
};

function send(
  res: ServerResponse,
  status: number,
  error: Failure,
  extra: Record<string, string> = {},
): void {
  const json = JSON.stringify({ ok: false, error });
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(json),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extra,
  });
  res.end(json);
}

const isLoopbackHost = (h: string | undefined): boolean =>
  h !== undefined && LOOPBACK_HOSTS.has(h.startsWith("[") || !h.includes(":") ? h : `[${h}]`);

/** daemon の `parseBearer` と同じ規則（スキームは `Bearer` で大文字小文字を区別。トークンは 16〜512 文字の許可された文字）。 */
const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{16,512}$/;
function bearer(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const m = /^Bearer ([^ ]+)$/.exec(header);
  const token = m?.[1];
  return token !== undefined && TOKEN_SHAPE.test(token) ? token : undefined;
}

/** 本文を、上限（バイト）と読み取り全体の時間つきで読む。`size`: 上限超過、`time`: 時間切れ・読み取りの失敗。 */
function readBody(
  req: IncomingMessage,
  max: number,
  timeoutMs: number,
): Promise<{ body: Buffer } | { error: "size" | "time" }> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) return resolve({ error: "size" });
    const chunks: Buffer[] = [];
    let size = 0;
    const timer = setTimeout(() => finish({ error: "time" }), timeoutMs);
    const finish = (v: { body: Buffer } | { error: "size" | "time" }): void => {
      clearTimeout(timer);
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      resolve(v);
    };
    const onData = (c: Buffer): void => {
      size += c.length;
      if (size > max) {
        finish({ error: "size" });
        return;
      }
      chunks.push(c);
    };
    const onEnd = (): void => finish({ body: Buffer.concat(chunks) });
    const onError = (): void => finish({ error: "time" });
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

export function createMcpHttpServer(opts: McpHttpOptions): Result<McpHttpServer> {
  // 設定の検査（daemonUrl がループバックか）。トークンは接続ごとに来るので、ここでは仮の値で形だけ確かめる。
  const probe = createRelay({ daemonUrl: opts.daemonUrl, token: "probe-token-0123456789" });
  if (!probe.ok) return probe;
  const maxBody = opts.maxBodyBytes ?? MAX_RELAY_BYTES;
  const bodyTimeoutMs = opts.bodyTimeoutMs ?? BODY_TIMEOUT_MS;
  const graceMs = opts.shutdownGraceMs ?? SHUTDOWN_GRACE_MS;
  const log = (code: string): void => {
    try {
      opts.logger?.({ event: "sessionFailed", code, at: new Date().toISOString() });
    } catch {
      // 記録の失敗は応答を変えない
    }
  };

  let warnedUnverified = false;
  const warnUnverified = (): void => {
    if (opts.identity.kind !== "unverified" || warnedUnverified) return;
    warnedUnverified = true; // 警告は 1 回だけ
    try {
      opts.logger?.({ event: "identityUnverified", at: new Date().toISOString() });
    } catch {
      // 記録の失敗は応答を変えない
    }
  };

  /** listen で決まったポート。Host・Origin の照合に使う（それ以外のポートは拒否）。 */
  let listenPort = 0;
  const allowedAuthority = (hostname: string, port: string): boolean =>
    isLoopbackHost(hostname) && port === String(listenPort);
  const hostAllowed = (hostHeader: string): boolean => {
    try {
      const u = new URL(`http://${hostHeader}`);
      return allowedAuthority(u.hostname, u.port);
    } catch {
      return false;
    }
  };
  const originAllowed = (origin: string): boolean => {
    try {
      const u = new URL(origin);
      return u.protocol === "http:" && allowedAuthority(u.hostname, u.port);
    } catch {
      return false;
    }
  };

  // 処理中の要求の数（停止のときに、終わるのを待つ）。
  let inFlight = 0;
  let idle: (() => void) | undefined;
  const track = async (work: () => Promise<void>): Promise<void> => {
    inFlight += 1;
    try {
      await work();
    } finally {
      inFlight -= 1;
      if (inFlight === 0) idle?.();
    }
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (opts.identity.kind === "unverified") res.setHeader(UNVERIFIED_HEADER, "unverified");
    const hostHeader = req.headers.host;
    if (typeof hostHeader !== "string" || !hostAllowed(hostHeader)) {
      return send(
        res,
        403,
        failure(
          "forbidden",
          "Host が待ち受けのアドレス（ループバックとポート）でない",
          "127.0.0.1 で接続する",
        ),
      );
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !(typeof origin === "string" && originAllowed(origin))) {
      return send(
        res,
        403,
        failure("forbidden", "Origin が待ち受けのアドレスでない", "ブラウザからは接続できない"),
      );
    }
    const path = (req.url ?? "").split("?")[0];
    if (path !== PATH) {
      return send(res, 404, failure("notFound", "このパスはない", `POST ${PATH} を使う`));
    }
    if (req.method !== "POST") {
      req.resume();
      return send(
        res,
        405,
        failure("methodNotAllowed", "POST だけを受け付ける", "POST で接続する"),
        { allow: "POST" },
      );
    }
    // トークンの確認（形 → daemon のロール）を、本文を読む前に行う。
    const token = bearer(req.headers.authorization);
    const relay =
      token === undefined
        ? undefined
        : createRelay({
            daemonUrl: opts.daemonUrl,
            token,
            ...(opts.identity.kind === "verified" ? { verifier: opts.identity.verifier } : {}),
            ...(opts.fetch ? { fetch: opts.fetch } : {}),
            ...(opts.relayTimeoutMs !== undefined ? { timeoutMs: opts.relayTimeoutMs } : {}),
          });
    if (relay === undefined || !relay.ok) {
      req.resume();
      return send(
        res,
        401,
        failure(
          "unauthenticated",
          "資格情報がないか、形が正しくない",
          "ノードのトークンを Authorization: Bearer で渡す",
        ),
        { "www-authenticate": "Bearer" },
      );
    }
    const session = await openSession(relay.value);
    if (!session.ok) {
      req.resume();
      log(session.error.code);
      const status = STATUS[session.error.code] ?? 502;
      const retryAfter = (session.error as { retryAfterSec?: unknown }).retryAfterSec;
      // 本文は code・cause・nextActions だけ（待つ秒数は、Retry-After ヘッダで伝える）。
      const { code, cause, nextActions } = session.error;
      return send(
        res,
        status,
        { code, cause, nextActions },
        {
          ...(status === 401 ? { "www-authenticate": "Bearer" } : {}),
          ...(status === 429
            ? { "retry-after": String(typeof retryAfter === "number" ? retryAfter : 1) }
            : {}),
        },
      );
    }
    const server = session.value;
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
      req.resume();
      return send(
        res,
        415,
        failure("unsupportedMediaType", "Content-Type が application/json でない", "JSON で送る"),
      );
    }
    const read = await readBody(req, maxBody, bodyTimeoutMs);
    if ("error" in read) {
      if (read.error === "size") {
        return send(
          res,
          413,
          failure("payloadTooLarge", `本文が上限（${maxBody} バイト）を超えた`, "本文を小さくする"),
          { connection: "close" },
        );
      }
      return send(
        res,
        408,
        failure("requestTimeout", "本文の読み取りが時間内に終わらなかった", "本文を送り直す"),
        { connection: "close" },
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(read.body.toString("utf8"));
    } catch {
      return send(res, 400, failure("invalidRequest", "本文が JSON でない", "JSON で送る"));
    }
    // SDK の型は exactOptionalPropertyTypes に合わないので、ここで寄せる（ステートレス: セッション ID を作らない）。
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0]);
    res.on("close", () => {
      void transport.close().catch(() => undefined);
      void server.close().catch(() => undefined);
    });
    await server.connect(transport as unknown as Transport);
    await transport.handleRequest(req, res, body);
  }

  let http: Server | undefined;
  return ok({
    limits: () => ({
      maxConnections: MAX_CONNECTIONS,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      headersTimeoutMs: HEADERS_TIMEOUT_MS,
      keepAliveTimeoutMs: KEEP_ALIVE_TIMEOUT_MS,
    }),
    async listen(port) {
      const server = createServer((req, res) => {
        track(() => handle(req, res)).catch(() => {
          log("internal_error");
          if (!res.headersSent) {
            send(res, 500, failure("internalError", "内部エラー", "管理者（人間）に知らせる"));
          } else {
            res.end();
          }
        });
      });
      // 遅い接続・多すぎる接続への対策（明示する）。
      server.requestTimeout = REQUEST_TIMEOUT_MS;
      server.headersTimeout = HEADERS_TIMEOUT_MS;
      server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
      server.maxConnections = MAX_CONNECTIONS;
      http = server;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, HOST, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const actual = (server.address() as AddressInfo).port;
      listenPort = actual;
      warnUnverified();
      return { port: actual, url: `http://${HOST}:${actual}` };
    },
    async close() {
      const server = http;
      if (server === undefined) return;
      http = undefined;
      // (a) 新しい接続を受けない (b) アイドルの接続を閉じる (c) 処理中の要求が終わるのを猶予まで待つ (d) 超えたら残りを切る
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeIdleConnections();
      if (inFlight > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, graceMs);
          idle = () => {
            clearTimeout(timer);
            resolve();
          };
        });
        idle = undefined;
      }
      // 応答を書き終えた接続は、アイドルになってから閉じる（書き終える前に切らない）。残ったものは、少し待って切る。
      server.closeIdleConnections();
      await Promise.race([closed, new Promise<void>((r) => setTimeout(r, 500))]);
      server.closeAllConnections();
      await closed;
    },
  });
}
