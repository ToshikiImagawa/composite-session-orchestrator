/**
 * daemon の窓口への中継。`POST /v1/request` と `GET /v1/whoami` を、呼び出し元のノードのトークンで呼ぶ。
 * トークンの真偽・ロールの判定・部分木の判定は daemon が行い（ここでは検証しない）、失敗はそのまま返す。
 * 外へ出すのはループバックの daemon だけ。トークンと本文は、失敗の原因にもログにも入れない。
 */
import { type Failure, failure, ok, type Result } from "@cso/core";

/** 中継する本文・応答の上限（daemon の窓口と同じ 1 MiB）。 */
export const MAX_RELAY_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface Relay {
  /** トークンのロール（接続ごとに 1 回引く）。 */
  whoami(): Promise<Result<{ role: string }>>;
  /** 操作を daemon へ中継する。成功の値・daemon の失敗は、そのまま返す。 */
  request(operation: string, params: unknown): Promise<Result<unknown>>;
}

export interface RelayOptions {
  /** daemon の窓口。ループバック（127.0.0.1・localhost・[::1]）の http(s) の URL に限る。 */
  readonly daemonUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const TOKEN_FORMAT = /^[\x21-\x7e]+$/;

const fail = (code: string, cause: string, ...next: [string, ...string[]]): Result<never> => ({
  ok: false,
  error: failure(code, cause, ...next),
});

const isRec = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const isFailure = (x: unknown): x is Failure =>
  isRec(x) &&
  typeof x.code === "string" &&
  typeof x.cause === "string" &&
  Array.isArray(x.nextActions) &&
  x.nextActions.length > 0 &&
  x.nextActions.every((n) => typeof n === "string");

export function createRelay(opts: RelayOptions): Result<Relay> {
  let base: URL;
  try {
    base = new URL(opts.daemonUrl);
  } catch {
    return fail("invalid_config", "daemonUrl が URL でない", "daemonUrl を確認する");
  }
  if (
    (base.protocol !== "http:" && base.protocol !== "https:") ||
    !LOOPBACK.has(base.hostname) ||
    base.username !== "" ||
    base.password !== ""
  ) {
    return fail(
      "invalid_config",
      "daemonUrl は、ループバック（127.0.0.1・localhost・[::1]）の http(s) の URL に限る（ユーザー名・パスワードは含めない）",
      "daemonUrl を確認する",
    );
  }
  if (typeof opts.token !== "string" || !TOKEN_FORMAT.test(opts.token)) {
    return fail("invalid_config", "トークンの形が不正", "接続のトークンを確認する");
  }
  const doFetch = opts.fetch ?? globalThis.fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? MAX_RELAY_BYTES;
  const origin = base.origin;
  const authorization = `Bearer ${opts.token}`;
  let counter = 0;
  const newRequestId = (): string =>
    `mcp-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  async function call(path: string, init: RequestInit): Promise<Result<unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${origin}${path}`, { ...init, signal: controller.signal });
      const raw = await readLimited(res, maxBytes);
      if (raw === undefined) {
        return fail(
          "daemon_response_too_large",
          `daemon の応答が上限（${maxBytes} バイト）を超えた`,
          "対象を絞って呼び直す",
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return fail(
          "daemon_bad_response",
          "daemon の応答が JSON でない",
          "daemon の状態を確認する",
        );
      }
      if (isRec(body) && body.ok === true && "value" in body) return ok(body.value);
      if (isRec(body) && body.ok === false && isFailure(body.error)) {
        return { ok: false, error: body.error };
      }
      return fail("daemon_bad_response", "daemon の応答の形が不正", "daemon の状態を確認する");
    } catch {
      return controller.signal.aborted
        ? fail(
            "daemon_timeout",
            `daemon の応答が ${timeoutMs}ms 以内に返らなかった`,
            "少し待って呼び直す",
            "daemon の状態を確認する",
          )
        : fail(
            "daemon_unreachable",
            "daemon に接続できない",
            "daemon が起動しているか確認する",
            "daemonUrl を確認する",
          );
    } finally {
      clearTimeout(timer);
    }
  }

  return ok({
    async whoami() {
      const r = await call("/v1/whoami", { method: "GET", headers: { authorization } });
      if (!r.ok) return r;
      if (!isRec(r.value) || typeof r.value.role !== "string") {
        return fail(
          "daemon_bad_response",
          "whoami の応答に role がない",
          "daemon の状態を確認する",
        );
      }
      return ok({ role: r.value.role });
    },
    async request(operation, params) {
      const body = JSON.stringify({ requestId: newRequestId(), operation, params });
      if (Buffer.byteLength(body) > maxBytes) {
        return fail(
          "request_too_large",
          `送る本文が上限（${maxBytes} バイト）を超えた`,
          "内容を小さくして呼び直す",
        );
      }
      return call("/v1/request", {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body,
      });
    },
  });
}

/** 応答の本文を、上限を超えない範囲で読む。超えたら `undefined`。 */
async function readLimited(res: Response, max: number): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}
