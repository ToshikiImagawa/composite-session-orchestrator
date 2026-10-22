/**
 * daemon の身元確認（T10m-i2。NFR_004・DC_003。契約は `docs/daemon-identity.md`）。別のプロセスが窓口のポートを奪っても、
 * トークンを偽の daemon へ送らないために、**トークンつきの要求を送る直前に毎回**、チャレンジ応答で相手を確かめる。
 *
 * - 秘密（`<stateDir>/daemon-identity`。0600）は、毎回開き直して読む（古い秘密を、メモリに長く持たない）。形が違うものは信用しない。
 *   読むときは、`O_NOFOLLOW`（symlink を辿らない）・`O_NONBLOCK`（FIFO で止まらない）で開き、`fstat` で、通常のファイル・所有者が自分・
 *   権限が 0600（グループ・他人に権限がない）・4 KiB 以下を確かめてから読む（daemon の `assertSecureFile` と対称）。
 * - 新しいランダムな `nonce` で `GET /v1/identity`（Bearer なし）を呼び、`proof`（HMAC-SHA256）を、自分が接続したポート
 *   （`127.0.0.1:<port>`）で計算した値と、定数時間で比べる。キャッシュはしない。
 * - 身元の失敗（不一致・形の不正・404・400/403/405・その他の 3xx/4xx/5xx）は、ファイルを読み直して 1 度だけやり直し、それでも
 *   失敗なら `daemon_identity_failed`。通常の失敗（接続できない・タイムアウト・429・503）は、そのまま通常の失敗として返す。
 *   どちらでも、トークンは送らない。`secret`・`proof`・トークンは、失敗の原因・記録に出さない。
 * - 検証から送信までの窓の検知: 検証に成功すると、`daemonId` を返す。relay は、トークンつきの要求の応答の `x-cso-daemon-id` を、これと
 *   照合する（不一致・なしなら、応答を捨てて `daemon_identity_failed`）。検知であって、防止ではない（`docs/daemon-identity.md` §5）。
 * - daemon の実装（`packages/daemon/src/api/identity.ts`）には依存しない。同じ式を実装し、試験ベクトルで一致を確かめる。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { type Failure, failure } from "@cso/core";

export const IDENTITY_FILE = "daemon-identity";
export const IDENTITY_CONTEXT = "cso-daemon-identity-v1";
/** `/v1/identity` の応答の大きさの上限（本文は 150 バイトほど。偽の daemon に大きな本文を読まされない）。 */
export const IDENTITY_MAX_BYTES = 4096;
/** `/v1/identity` 1 回の呼び出しのタイムアウト（loopback で HMAC だけ。操作のタイムアウトとは別）。 */
export const IDENTITY_TIMEOUT_MS = 5_000;
/** 秘密のファイルの大きさの上限（本文は 150 バイトほど）。 */
const FILE_MAX_BYTES = 4096;

export interface DaemonIdentity {
  readonly daemonId: string;
  readonly secret: string;
}

const DAEMON_ID_RE = /^[0-9a-f]{32}$/;
const SECRET_RE = /^[0-9a-f]{64}$/;
const PROOF_RE = /^[0-9a-f]{64}$/;

/** `proof` の計算（契約 §3）。 */
export function proofOf(identity: DaemonIdentity, hostPort: string, nonce: string): string {
  return createHmac("sha256", Buffer.from(identity.secret, "hex"))
    .update(`${IDENTITY_CONTEXT}\0${identity.daemonId}\0${hostPort}\0${nonce}`, "utf8")
    .digest("hex");
}

/** 定数時間の比較（長さが違えば不一致）。 */
export function proofMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 秘密のファイルの内容を読む。形が違えば `undefined`（信用しない）。 */
export function parseIdentityFile(text: string): DaemonIdentity | undefined {
  if (text.length > FILE_MAX_BYTES) return undefined;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined;
  const o = json as Record<string, unknown>;
  if (o.version !== 1) return undefined;
  if (typeof o.daemonId !== "string" || !DAEMON_ID_RE.test(o.daemonId)) return undefined;
  if (typeof o.secret !== "string" || !SECRET_RE.test(o.secret)) return undefined;
  return { daemonId: o.daemonId, secret: o.secret };
}

/**
 * 接続先の `127.0.0.1:<port>`（`localhost`・`[::1]` も同じ文字列にする）。ポートがなければ `undefined`。
 * http の既定のポート（80）は仮定しない（URL に明示されたポートだけを使う。daemon の窓口は、必ず明示のポートで待ち受けるため）。
 */
export function hostPortOf(daemonUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(daemonUrl);
  } catch {
    return undefined;
  }
  return /^[0-9]{1,5}$/.test(url.port) && Number(url.port) >= 1 && Number(url.port) <= 65535
    ? `127.0.0.1:${Number(url.port)}`
    : undefined;
}

export interface SecureReadOps {
  /** 自分の uid（テストで差し替える）。 */
  readonly getuid?: () => number | undefined;
}

/**
 * 秘密のファイルを、安全に読む。`O_NOFOLLOW`（symlink は開けない）・`O_NONBLOCK`（FIFO で止まらない）で開き、`fstat` で、通常のファイル・
 * 所有者が自分・`mode & 0o077 === 0`・4 KiB 以下を確かめてから読む。満たさなければ例外（呼び出し側は、身元の失敗にする）。
 * 内容は、例外に含めない。
 */
export function readIdentityFileSecure(path: string, ops: SecureReadOps = {}): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new Error("not a regular file");
    const uid = (ops.getuid ?? (() => process.getuid?.()))();
    if (uid !== undefined && st.uid !== uid) throw new Error("owner mismatch");
    if ((st.mode & 0o077) !== 0) throw new Error("permissions too open");
    if (st.size > FILE_MAX_BYTES) throw new Error("too large");
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** 検証の結果。成功のとき、`daemonId`（検証した daemon の公開 ID）を返す。失敗のとき、`failure` は呼び出し元へそのまま返してよい（トークンは送らない）。 */
export type VerifyResult =
  | { readonly ok: true; readonly daemonId: string }
  | { readonly ok: false; readonly kind: "identity" | "transient"; readonly failure: Failure };

export interface IdentityVerifier {
  /** トークンつきの要求を送る直前に呼ぶ。毎回、検証する（キャッシュしない）。 */
  verify(): Promise<VerifyResult>;
}

export interface IdentityVerifierOptions {
  /** 接続する daemon の窓口（ループバック。ポートが必要）。 */
  readonly daemonUrl: string;
  /** 秘密のファイル（`<stateDir>/daemon-identity`）。 */
  readonly identityPath: string;
  readonly fetch?: typeof fetch;
  readonly readFile?: (path: string) => string;
  /** nonce の素（テストで差し替える）。 */
  readonly random?: (n: number) => Buffer;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
  /** 429 のあとの待ち（テストで差し替える）。 */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly jitter?: () => number;
}

export const identityFailed = (): Failure =>
  failure(
    "daemon_identity_failed",
    "daemon の身元を確認できない（窓口の相手が、本物の daemon か分からない。トークンは送っていない）",
    "daemon を起動し直して、同じ設定（--config）で cso-mcp を起動し直す",
    "別のプロセスが窓口のポートを使っていないか確認する",
  );

const MAX_RETRY_AFTER_SEC = 10;

type Attempt =
  | { readonly kind: "ok"; readonly daemonId: string }
  | { readonly kind: "identity" }
  | { readonly kind: "transient"; readonly failure: Failure; readonly retrySec?: number };

export function createIdentityVerifier(opts: IdentityVerifierOptions): IdentityVerifier {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const readFile = opts.readFile ?? ((p: string) => readIdentityFileSecure(p));
  const random = opts.random ?? randomBytes;
  const timeoutMs = opts.timeoutMs ?? IDENTITY_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? IDENTITY_MAX_BYTES;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const jitter = opts.jitter ?? (() => Math.floor(Math.random() * 500));
  const hostPort = hostPortOf(opts.daemonUrl);
  const origin = (() => {
    try {
      return new URL(opts.daemonUrl).origin;
    } catch {
      return undefined;
    }
  })();

  async function attempt(): Promise<Attempt> {
    if (hostPort === undefined || origin === undefined) return { kind: "identity" };
    let text: string;
    try {
      text = readFile(opts.identityPath);
    } catch {
      return { kind: "identity" };
    }
    const identity = parseIdentityFile(text);
    if (identity === undefined) return { kind: "identity" };
    const nonce = random(16).toString("hex");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await doFetch(`${origin}/v1/identity?nonce=${nonce}`, {
        method: "GET",
        // 3xx は辿らない（`manual`）。status で、身元の失敗に分類する（`error` だと、例外になり、接続の失敗と区別できない）。
        redirect: "manual",
        signal: controller.signal,
      });
      if (res.status === 429) {
        await res.body?.cancel().catch(() => undefined);
        const h = res.headers.get("retry-after")?.trim() ?? "";
        const sec = /^[0-9]{1,6}$/.test(h) ? Math.min(Number(h), MAX_RETRY_AFTER_SEC) : 1;
        return {
          kind: "transient",
          retrySec: sec,
          failure: failure(
            "rate_limited",
            "daemon の身元確認が、回数の制限にかかった（トークンは送っていない）",
            `${sec} 秒ほど待ってから、同じ操作を呼び直す`,
          ),
        };
      }
      if (res.status === 503) {
        await res.body?.cancel().catch(() => undefined);
        return {
          kind: "transient",
          failure: failure(
            "daemon_unreachable",
            "daemon がまだ起動の途中（トークンは送っていない）",
            "少し待ってから、呼び直す",
          ),
        };
      }
      if (res.status !== 200) {
        await res.body?.cancel().catch(() => undefined);
        return { kind: "identity" };
      }
      const raw = await readLimited(res, maxBytes);
      if (raw === undefined) return { kind: "identity" };
      let body: unknown;
      try {
        body = JSON.parse(raw);
      } catch {
        return { kind: "identity" };
      }
      const value =
        typeof body === "object" && body !== null && (body as { ok?: unknown }).ok === true
          ? (body as { value?: unknown }).value
          : undefined;
      if (typeof value !== "object" || value === null) return { kind: "identity" };
      const { daemonId, proof } = value as { daemonId?: unknown; proof?: unknown };
      if (typeof daemonId !== "string" || typeof proof !== "string") return { kind: "identity" };
      if (!DAEMON_ID_RE.test(daemonId) || !PROOF_RE.test(proof)) return { kind: "identity" };
      if (daemonId !== identity.daemonId) return { kind: "identity" };
      return proofMatches(proofOf(identity, hostPort, nonce), proof)
        ? { kind: "ok", daemonId: identity.daemonId }
        : { kind: "identity" };
    } catch {
      const timedOut = controller.signal.aborted;
      return {
        kind: "transient",
        failure: timedOut
          ? failure(
              "daemon_timeout",
              `daemon の身元確認の応答が ${timeoutMs}ms 以内に返らなかった（トークンは送っていない）`,
              "daemon の状態を確認する",
            )
          : failure(
              "daemon_unreachable",
              "daemon に接続できない（トークンは送っていない）",
              "daemon が起動しているか確認する",
              "daemonUrl を確認する",
            ),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async verify(): Promise<VerifyResult> {
      let identityFailures = 0;
      let busyRetries = 0;
      for (;;) {
        const a = await attempt();
        if (a.kind === "ok") return { ok: true, daemonId: a.daemonId };
        if (a.kind === "identity") {
          // daemon の再起動で秘密が変わる。ファイルを読み直して、1 度だけやり直す。
          if (identityFailures++ < 1) continue;
          return { ok: false, kind: "identity", failure: identityFailed() };
        }
        if (a.retrySec !== undefined && busyRetries++ < 1) {
          await sleep(a.retrySec * 1000 + jitter());
          continue;
        }
        return { ok: false, kind: "transient", failure: a.failure };
      }
    },
  };
}

/** 応答の本文を、上限を超えない範囲で読む。超えたら `undefined`。 */
async function readLimited(res: Response, max: number): Promise<string | undefined> {
  const reader = res.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
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
  } catch (e) {
    // 読み取りの途中の失敗でも、本文を開けたままにしない。
    await reader.cancel().catch(() => undefined);
    throw e;
  }
  return Buffer.concat(chunks).toString("utf8");
}
