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
  type OperationMap,
  type OrchState,
  type Result,
} from "@cso/core";
import { authorizeRole, authorizeScope, checkPrincipal } from "./authorize.js";
import { type CredentialStore, parseBearer } from "./credentials.js";
import { pickResult } from "./results.js";
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

/** 500 の原因の記録（応答には出さない）。logger が例外を投げても、応答は変えない。 */
export type ApiLogger = (event: {
  readonly requestId: string;
  readonly operation: DaemonOperation;
  readonly error: unknown;
}) => void;

export interface ApiDeps {
  readonly credentials: CredentialStore;
  /** 認可（部分木の判定）に使う現在の状態。 */
  readonly getState: () => OrchState;
  readonly handlers: Handlers;
  /** 本文の上限（バイト）。既定 1 MiB。 */
  readonly maxBodyBytes?: number;
  /** 500 の原因を記録する。省略すると記録しない。 */
  readonly logger?: ApiLogger;
}

export interface ApiServer {
  /** 127.0.0.1 で待ち受ける。`port` が 0 なら空いているポート。 */
  listen(port: number): Promise<{ readonly port: number; readonly url: string }>;
  close(): Promise<void>;
}

const HOST = "127.0.0.1";
const DEFAULT_MAX_BODY = 1024 * 1024;

const STATUS: Readonly<Record<string, number>> = {
  unauthenticated: 401,
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
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

export function createApiServer(deps: ApiDeps): ApiServer {
  const maxBody = deps.maxBodyBytes ?? DEFAULT_MAX_BODY;
  let port = 0;

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
    const valid = checkPrincipal(principal, deps.getState());
    if (!valid.ok) return reject(res, valid.error, { "www-authenticate": "Bearer" });
    if (!/^application\/json(\s*;|$)/i.test(String(req.headers["content-type"] ?? ""))) {
      req.resume();
      return reject(
        res,
        failure("unsupportedMediaType", "Content-Type が application/json でない", "JSON で送る"),
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
    // ロールの判定を、引数の検証より先に行う（ロールのない操作に、引数の形を教えない）。
    const role = authorizeRole(principal, operation, {
      ...(env.value.claimedRole === undefined ? {} : { claimedRole: env.value.claimedRole }),
      ...(env.value.claimedCaller === undefined ? {} : { claimedCaller: env.value.claimedCaller }),
    });
    if (!role.ok) return reject(res, role.error);
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
    let result: Result<unknown, Failure>;
    try {
      result = (await handler(request)) as Result<unknown, Failure>;
    } catch (error) {
      return internalError(res, requestId, operation, error);
    }
    if (!result.ok) {
      // 操作の失敗（権限・入力の検査を通った後の、状態に依る失敗）は 422。コードごとの状態に写さない:
      // ハンドラの失敗コードは操作ごとに増えるため、ここでは「要求は正しいが、今は実行できない」で統一する。
      return send(res, 422, { ok: false, error: result.error });
    }
    const value = pickResult(operation, result.value);
    if (value === undefined) {
      return internalError(
        res,
        requestId,
        operation,
        new Error("ハンドラの結果がオブジェクトでない"),
      );
    }
    send(res, 200, { ok: true, value });
  }

  function internalError(
    res: ServerResponse,
    requestId: string,
    operation: DaemonOperation,
    error: unknown,
  ): void {
    try {
      deps.logger?.({ requestId, operation, error });
    } catch {
      // 記録の失敗で、応答を変えない。
    }
    reject(
      res,
      failure("internalError", "内部エラー", "もう一度試す", "改善しなければ管理者に知らせる"),
    );
  }

  const server: Server = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) {
        reject(res, failure("internalError", "内部エラー", "もう一度試す"));
      } else {
        res.destroy();
      }
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;

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
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
