/**
 * cso-mcp の待ち受け（Streamable HTTP）。子・統合の MCP クライアントが `mcpUrl` で接続する。
 * 127.0.0.1 だけで待ち受け、`POST /mcp` の 1 本で受ける。ステートレス（接続のセッションを持たない）で、リクエストごとに
 * Bearer のトークンから daemon にロールを尋ね（`openSession`）、そのロールのツールだけを公開する。
 * トークンの真偽・ロールの判定は daemon の窓口に委ねる。ログにトークンも本文も出さない。
 *
 * 処理の順（どこで失敗しても拒否する）: Host・Origin → パス・メソッド → Bearer → Content-Type → 本文（上限）→ ロールの解決 → MCP。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type Failure, failure, ok, type Result } from "@cso/core";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createRelay, MAX_RELAY_BYTES } from "./relay.js";
import { openSession } from "./server.js";

const HOST = "127.0.0.1";
const PATH = "/mcp";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export type McpHttpLogEvent = {
  readonly event: "sessionFailed";
  readonly code: string;
  readonly at: string;
};

export interface McpHttpOptions {
  /** daemon の窓口（ループバックの URL）。 */
  readonly daemonUrl: string;
  readonly fetch?: typeof fetch;
  /** 本文の上限（バイト）。既定 1 MiB。 */
  readonly maxBodyBytes?: number;
  /** 失敗の記録（トークン・本文は渡さない）。 */
  readonly logger?: (e: McpHttpLogEvent) => void;
}

export interface McpHttpServer {
  /** 127.0.0.1 で待ち受ける。`port` が 0 なら空いているポート。`url` は `http://127.0.0.1:<port>`。 */
  listen(port: number): Promise<{ readonly port: number; readonly url: string }>;
  close(): Promise<void>;
}

const STATUS: Readonly<Record<string, number>> = {
  unauthenticated: 401,
  forbidden: 403,
  role_not_exposed: 403,
  invalid_config: 401,
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

const hostnameOf = (hostHeader: string): string | undefined => {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return undefined;
  }
};
const isLoopbackHost = (h: string | undefined): boolean =>
  h !== undefined && LOOPBACK_HOSTS.has(h.startsWith("[") || !h.includes(":") ? h : `[${h}]`);

function loopbackOrigin(origin: string): boolean {
  try {
    return isLoopbackHost(new URL(origin).hostname);
  } catch {
    return false;
  }
}

function bearer(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const m = /^Bearer ([^ ]+)$/.exec(header);
  return m?.[1];
}

/** 本文を上限つきで読む。超えたら `undefined`。 */
function readBody(req: IncomingMessage, max: number): Promise<Buffer | undefined> {
  return new Promise((resolve) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > max) return resolve(undefined);
    const chunks: Buffer[] = [];
    let size = 0;
    const finish = (v: Buffer | undefined): void => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      resolve(v);
    };
    const onData = (c: Buffer): void => {
      size += c.length;
      if (size > max) {
        finish(undefined);
        return;
      }
      chunks.push(c);
    };
    const onEnd = (): void => finish(Buffer.concat(chunks));
    const onError = (): void => finish(undefined);
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

export function createMcpHttpServer(opts: McpHttpOptions): Result<McpHttpServer> {
  // 設定の検査（daemonUrl がループバックか）。トークンは接続ごとに来るので、ここでは仮の値で形だけ確かめる。
  const probe = createRelay({ daemonUrl: opts.daemonUrl, token: "probe" });
  if (!probe.ok) return probe;
  const maxBody = opts.maxBodyBytes ?? MAX_RELAY_BYTES;
  const log = (code: string): void => {
    try {
      opts.logger?.({ event: "sessionFailed", code, at: new Date().toISOString() });
    } catch {
      // 記録の失敗は応答を変えない
    }
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const hostHeader = req.headers.host;
    if (typeof hostHeader !== "string" || !isLoopbackHost(hostnameOf(hostHeader))) {
      return send(
        res,
        403,
        failure("forbidden", "Host がループバックでない", "127.0.0.1 で接続する"),
      );
    }
    const origin = req.headers.origin;
    if (origin !== undefined && !(typeof origin === "string" && loopbackOrigin(origin))) {
      return send(
        res,
        403,
        failure("forbidden", "Origin がループバックでない", "ブラウザからは接続できない"),
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
        {
          allow: "POST",
        },
      );
    }
    const token = bearer(req.headers.authorization);
    const relay =
      token === undefined
        ? undefined
        : createRelay({
            daemonUrl: opts.daemonUrl,
            token,
            ...(opts.fetch ? { fetch: opts.fetch } : {}),
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
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
      req.resume();
      return send(
        res,
        415,
        failure("unsupportedMediaType", "Content-Type が application/json でない", "JSON で送る"),
      );
    }
    const raw = await readBody(req, maxBody);
    if (raw === undefined) {
      return send(
        res,
        413,
        failure("payloadTooLarge", `本文が上限（${maxBody} バイト）を超えた`, "本文を小さくする"),
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(raw.toString("utf8"));
    } catch {
      return send(res, 400, failure("invalidRequest", "本文が JSON でない", "JSON で送る"));
    }
    const session = await openSession(relay.value);
    if (!session.ok) {
      log(session.error.code);
      const status = STATUS[session.error.code] ?? 502;
      return send(
        res,
        status,
        session.error,
        status === 401 ? { "www-authenticate": "Bearer" } : {},
      );
    }
    const server = session.value;
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
    async listen(port) {
      const server = createServer((req, res) => {
        handle(req, res).catch(() => {
          log("internal_error");
          if (!res.headersSent) {
            send(res, 500, failure("internalError", "内部エラー", "管理者（人間）に知らせる"));
          } else {
            res.end();
          }
        });
      });
      http = server;
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, HOST, () => {
          server.off("error", reject);
          resolve();
        });
      });
      const actual = (server.address() as AddressInfo).port;
      return { port: actual, url: `http://${HOST}:${actual}` };
    },
    async close() {
      const server = http;
      if (server === undefined) return;
      http = undefined;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  });
}
