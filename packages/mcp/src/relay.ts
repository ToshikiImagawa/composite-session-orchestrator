/**
 * daemon の窓口への中継。`POST /v1/request` と `GET /v1/whoami` を、呼び出し元のノードのトークンで呼ぶ。
 * トークンの真偽・ロールの判定・部分木の判定は daemon が行い（ここでは検証しない）、失敗はそのまま返す。
 * 外へ出すのはループバックの daemon だけ。トークンと本文は、失敗の原因にもログにも入れない。
 */
import { type Failure, failure, ok, type Result, sanitizeText } from "@cso/core";

/** 中継する本文・応答の上限（daemon の窓口と同じ 1 MiB）。 */
export const MAX_RELAY_BYTES = 1024 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 子の起動・切り出し・回収は、時間がかかる（git の作業ツリーを扱う）ので、長めにする。 */
export const LONG_OPERATION_TIMEOUT_MS = 120_000;
const LONG_OPERATIONS: ReadonlySet<string> = new Set(["node.spawn", "node.split", "node.reclaim"]);
/** 操作ごとのタイムアウト。 */
export const timeoutFor = (operation: string): number =>
  LONG_OPERATIONS.has(operation) ? LONG_OPERATION_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
/** トークンの長さの上限。 */
const TOKEN_MAX = 8192;
/** daemon の失敗の文面の長さの上限（応答を受け手のコンテキストに入れすぎない）。 */
const FAILURE_TEXT_MAX = 2000;
const FAILURE_ACTIONS_MAX = 10;

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
  /** 指定すると、全操作のタイムアウトをこの値にする（既定は操作ごと。`timeoutFor`）。 */
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** 429 のあとの待ち（テストで差し替える）。既定は実時間。 */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** 429 のあとに待つ秒数の上限。 */
export const MAX_RETRY_AFTER_SEC = 10;
const DEFAULT_RETRY_AFTER_SEC = 1;

/** `rate_limited`（daemon の 429。daemon は実行していない）。`retryAfterSec`: 待つ秒数の目安（Retry-After を丸めたもの）。 */
export type RateLimited = Failure & { readonly retryAfterSec: number };

/** `Retry-After`（整数の秒）を読む。なし・不正（日付・小数・負）は 1 秒。上限 10 秒。 */
export function parseRetryAfter(header: string | null | undefined): number {
  if (typeof header !== "string" || !/^[0-9]{1,6}$/.test(header.trim()))
    return DEFAULT_RETRY_AFTER_SEC;
  return Math.min(Number(header.trim()), MAX_RETRY_AFTER_SEC);
}

const rateLimited = (sec: number): RateLimited =>
  Object.assign(
    failure(
      "rate_limited",
      "要求が多すぎる（回数の制限。daemon は実行していない）",
      `${sec} 秒ほど待ってから、同じ操作を呼び直す（実行されていないので、二重にならない）`,
      "続くときは、呼び出しの頻度を下げる",
    ),
    { retryAfterSec: sec },
  );

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
  if (
    typeof opts.token !== "string" ||
    opts.token.length > TOKEN_MAX ||
    !TOKEN_FORMAT.test(opts.token)
  ) {
    return fail("invalid_config", "トークンの形が不正", "接続のトークンを確認する");
  }
  const doFetch = opts.fetch ?? globalThis.fetch;
  const maxBytes = opts.maxBytes ?? MAX_RELAY_BYTES;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const origin = base.origin;
  const authorization = `Bearer ${opts.token}`;
  let counter = 0;
  const newRequestId = (): string =>
    `mcp-${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

  /** 1 回の呼び出し。`transport`: 応答を受け取れなかった（接続の失敗・タイムアウト）。操作が実行されたかは分からない。 */
  async function call(
    path: string,
    init: RequestInit,
    timeout: number,
  ): Promise<{ result: Result<unknown>; transport: boolean; rateLimitedSec?: number }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const done = (result: Result<unknown>) => ({ result, transport: false });
    try {
      // リダイレクトは辿らない（トークンと本文を別のオリジンへ送らない）。
      const res = await doFetch(`${origin}${path}`, {
        ...init,
        redirect: "error",
        signal: controller.signal,
      });
      if (res.status === 429) {
        // 回数の制限。daemon は実行していない。本文は読まない。
        await res.body?.cancel().catch(() => undefined);
        const sec = parseRetryAfter(res.headers.get("retry-after"));
        return {
          result: { ok: false, error: rateLimited(sec) },
          transport: false,
          rateLimitedSec: sec,
        };
      }
      const raw = await readLimited(res, maxBytes);
      if (raw === undefined) {
        return done(
          fail(
            "daemon_response_too_large",
            `daemon の応答が上限（${maxBytes} バイト）を超えた（操作は実行された可能性がある）`,
            "tree_list などで状態を確かめる",
            "対象を絞って参照する",
          ),
        );
      }
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return done(
          fail("daemon_bad_response", "daemon の応答が JSON でない", "daemon の状態を確認する"),
        );
      }
      if (isRec(body) && body.ok === true && "value" in body) return done(ok(body.value));
      if (isRec(body) && body.ok === false && isFailure(body.error)) {
        return done({ ok: false, error: bounded(body.error) });
      }
      return done(
        fail("daemon_bad_response", "daemon の応答の形が不正", "daemon の状態を確認する"),
      );
    } catch {
      const timedOut = controller.signal.aborted;
      return {
        transport: true,
        result: timedOut
          ? fail(
              "daemon_timeout",
              `daemon の応答が ${timeout}ms 以内に返らなかった`,
              "daemon の状態を確認する",
            )
          : fail(
              "daemon_unreachable",
              "daemon に接続できない",
              "daemon が起動しているか確認する",
              "daemonUrl を確認する",
            ),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return ok({
    async whoami() {
      // 読み取りだけなので、失敗してもそのまま返す（再送しない）。
      const { result: r } = await call(
        "/v1/whoami",
        { method: "GET", headers: { authorization } },
        opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      );
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
      const init = {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body,
      };
      const timeout = opts.timeoutMs ?? timeoutFor(operation);
      // 同じ requestId で再送する（daemon が requestId で冪等に扱うので、二重に実行されない）。
      // - 応答を受け取れなかった（接続の失敗・タイムアウト）: 1 度だけ。それでも失敗なら、結果は不明。
      // - 429（回数の制限。daemon は実行していない）: Retry-After（上限 10 秒）だけ待って、1 度だけ。
      // 送信は合計 3 回まで。401 の Retry-After では再送しない（待っても直らない）。
      let transportRetries = 0;
      let rateRetries = 0;
      for (let sends = 0; sends < 3; sends++) {
        const r = await call("/v1/request", init, timeout);
        if (r.transport) {
          if (transportRetries++ < 1) continue;
          break;
        }
        if (r.rateLimitedSec !== undefined && rateRetries++ < 1) {
          await sleep(r.rateLimitedSec * 1000);
          continue;
        }
        return r.result;
      }
      return fail(
        "daemon_result_unknown",
        "daemon から応答を受け取れず、結果は不明（操作は実行されたかもしれない）",
        "tree_list などで状態を確かめてから、必要なら操作をやり直す",
        "daemon の状態を確認する",
      );
    },
  });
}

/** daemon の失敗の文面の長さを抑える（制御文字を除き、約 2000 文字まで）。 */
function bounded(f: Failure): Failure {
  const [first, ...rest] = f.nextActions.slice(0, FAILURE_ACTIONS_MAX);
  return failure(
    sanitizeText(f.code, 128),
    sanitizeText(f.cause, FAILURE_TEXT_MAX),
    sanitizeText(first, FAILURE_TEXT_MAX),
    ...rest.map((a) => sanitizeText(a, FAILURE_TEXT_MAX)),
  );
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
