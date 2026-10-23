/**
 * 窓口の回数の制限（T10l。NFR_004・NFR_011）。依存を増やさず、自前の token bucket で行う。
 *
 * - token bucket: 容量（`burst`。突発の許容）と補充（`perSecond`）。要求は重み（コスト）の分のトークンを使う。足りなければ拒否し、
 *   足りるまでの秒数（`retryAfterSec`）を返す。使われなかったキーでも、容量を超えては貯まらない。
 * - 時計は単調時計（ミリ秒。`process.hrtime` 由来）を注入する。壁時計は使わない（時計が飛んでも、制限が外れたり、固まったりしない）。
 * - キーごとに別の bucket。表の大きさに上限（`maxKeys`）があり、超えたら最も古く使われたキーを捨てる（メモリを増やされない）。
 *   捨てられたキーは、満タンから始まる（制限が一時的に緩むだけで、正規の呼び出しを止めることはない）。
 * - **429 は「実行していない」ことを保証する応答**: 制限の判定は、ハンドラを呼ぶ前にだけ行う（`server.ts`）。
 */

export interface BucketSpec {
  /** 容量（突発の許容）。 */
  readonly burst: number;
  /** 毎秒の補充。 */
  readonly perSecond: number;
}

export type Consume =
  | { readonly ok: true }
  | { readonly ok: false; readonly retryAfterSec: number };

export interface RateLimiter {
  /** `cost` 個のトークンを使う（全部使えるときだけ。足りなければ何も使わない）。 */
  tryConsume(key: string, cost: number): Consume;
  /** `cost` 個を使えるか（何も使わない・キーを作らない・並べ替えない）。bind の入口が、失敗が続いている接続元を先に断るのに使う。 */
  canConsume(key: string, cost: number): Consume;
  /** 表にあるキーの数（試験用）。 */
  size(): number;
}

export const DEFAULT_MAX_KEYS = 10_000;

export const hrtimeMs = (): number => Number(process.hrtime.bigint() / 1_000_000n);

interface Bucket {
  tokens: number;
  last: number;
}

export function createRateLimiter(options: {
  readonly spec: BucketSpec;
  readonly nowMs?: () => number;
  readonly maxKeys?: number;
}): RateLimiter {
  const { burst, perSecond } = options.spec;
  const now = options.nowMs ?? hrtimeMs;
  const maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  /** `Map` は挿入順。使うたびに入れ直して、先頭が最も古く使われたキーになるようにする。 */
  const buckets = new Map<string, Bucket>();

  return {
    tryConsume(key, cost) {
      const t = now();
      const need = Math.min(Math.max(cost, 0), burst);
      const existing = buckets.get(key);
      const bucket: Bucket =
        existing === undefined
          ? { tokens: burst, last: t }
          : {
              // 経過が負（単調時計なので通常は起きない）でも、増やさない。
              tokens: Math.min(
                burst,
                existing.tokens + (Math.max(t - existing.last, 0) / 1000) * perSecond,
              ),
              last: t,
            };
      buckets.delete(key);
      buckets.set(key, bucket);
      if (buckets.size > maxKeys) {
        const oldest = buckets.keys().next().value;
        if (oldest !== undefined) buckets.delete(oldest);
      }
      if (bucket.tokens >= need) {
        bucket.tokens -= need;
        return { ok: true };
      }
      const missing = need - bucket.tokens;
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil(missing / perSecond)) };
    },
    canConsume(key, cost) {
      const need = Math.min(Math.max(cost, 0), burst);
      const existing = buckets.get(key);
      const tokens =
        existing === undefined
          ? burst
          : Math.min(
              burst,
              existing.tokens + (Math.max(now() - existing.last, 0) / 1000) * perSecond,
            );
      if (tokens >= need) return { ok: true };
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((need - tokens) / perSecond)) };
    },
    size: () => buckets.size,
  };
}

/** 重い操作（子の生成・分割、回収、最終削除）の重み。そのほかは 1。 */
const HEAVY_OPERATIONS: ReadonlySet<string> = new Set([
  "node.spawn",
  "node.split",
  "node.reclaim",
  "node.purge",
]);
export const HEAVY_WEIGHT = 5;
export const operationWeight = (operation: string): number =>
  HEAVY_OPERATIONS.has(operation) ? HEAVY_WEIGHT : 1;

/** 既定: 主体ごとに、容量 60・毎秒 20。認証の失敗は、接続元ごとに、容量 20・毎分 30。 */
export const DEFAULT_PRINCIPAL_SPEC: BucketSpec = { burst: 60, perSecond: 20 };
/** 身元確認（`GET /v1/identity`）: 接続元ごとに、容量 600・毎秒 200。mcp は、トークンつきの要求の直前ごとに 1 回呼ぶので、その頻度に耐える。 */
export const DEFAULT_IDENTITY_SPEC: BucketSpec = { burst: 600, perSecond: 200 };
export const DEFAULT_AUTH_FAILURE_PER_MINUTE = 30;
export const DEFAULT_AUTH_FAILURE_BURST = 20;

/** 設定の下限・上限（極端に低くして、自分を締め出さないため）。重い操作の重みの 2 倍を、容量の下限にする。 */
export const RATE_LIMIT_BOUNDS = {
  principalBurst: { min: HEAVY_WEIGHT * 2, max: 10_000 },
  principalPerSecond: { min: 1, max: 10_000 },
  authFailureBurst: { min: 5, max: 10_000 },
  authFailurePerMinute: { min: 5, max: 100_000 },
  maxKeys: { min: 100, max: 1_000_000 },
  /** 主体ごとの同時に処理中の要求の数（T10l-f）。 */
  maxInFlightPerPrincipal: { min: 1, max: 64 },
  /** 運用の見える化（T10l-f PR-B）: 閾値（1 つの窓の、種類ごとの件数）と、同じ種類の項目を出す最短の間隔（分）。 */
  alertThreshold: { min: 5, max: 100_000 },
  alertIntervalMinutes: { min: 1, max: 1_440 },
} as const;

/** 接続の上限とタイムアウトの設定の範囲（T10l-f。ミリ秒）。`headersTimeoutMs` は、実効の `requestTimeoutMs` 以下（Node の制約）。 */
export const CONNECTION_BOUNDS = {
  requestTimeoutMs: { min: 1_000, max: 600_000 },
  headersTimeoutMs: { min: 1_000, max: 600_000 },
  keepAliveTimeoutMs: { min: 3_000, max: 120_000 },
  maxConnections: { min: 64, max: 10_000 },
} as const;
export const CONNECTION_DEFAULTS = {
  requestTimeoutMs: 30_000,
  headersTimeoutMs: 10_000,
  keepAliveTimeoutMs: 5_000,
  maxConnections: 256,
} as const;

/**
 * 同じ要求の処理中の重複の扱いの設定の範囲（T10l-f）。`staleMs` の下限（150 秒）は、最長の操作のタイムアウト（120 秒）より長い
 * （正常に処理中の項目を、古いと見なして外さない）。`waitMs` の上限（60 秒）は、`staleMs` の下限より小さいので、組み合わせの検査はいらない。
 */
export const IN_PROGRESS_BOUNDS = {
  waitMs: { min: 1_000, max: 60_000 },
  maxWaiters: { min: 1, max: 256 },
  staleMs: { min: 150_000, max: 3_600_000 },
  maxEntries: { min: 64, max: 100_000 },
} as const;
export const IN_PROGRESS_DEFAULTS = {
  waitMs: 20_000,
  maxWaiters: 16,
  staleMs: 300_000,
  maxEntries: 1_024,
} as const;

/**
 * 認証の失敗と、制限の発動の記録（T10a。総当たりの検知と運用の監視）。1 件ずつは出さない: 窓（既定 1 分）の最初の 1 件だけを、
 * すぐに `first` として出し、窓が終わるときに、種類別の件数を 1 行にまとめる（次の記録が来たとき、または `flush`）。
 * 理由・キーの種類・操作の名前だけを出す。トークン・nodeId・内容は出さない。
 */
export type CounterKind = "authFailed" | "rateLimited" | "deduped";
export interface ApiCounters {
  count(kind: CounterKind, name: string): void;
  /** 溜まっている件数を、今すぐ 1 行にまとめて出す（停止のとき）。 */
  flush(): void;
}

export interface CounterSink {
  first(kind: CounterKind, name: string): void;
  /** `window`: 窓の開始と終了（壁時計のミリ秒。`wallMs` を渡したときだけ。終了は、開始 + 窓の長さ）。 */
  summary(
    windowSec: number,
    counts: Record<CounterKind, Record<string, number>>,
    window?: { readonly startMs: number; readonly endMs: number },
  ): void;
}

/** 窓の終わりに、まとめを出すための予約（T10l-f PR-B）。`cancel` で取り消す。既定は、`unref` したタイマー（止まるのを妨げない）。 */
export type SummaryScheduler = (fn: () => void, ms: number) => { readonly cancel: () => void };
const defaultScheduler: SummaryScheduler = (fn, ms) => {
  const t = setTimeout(fn, ms);
  t.unref();
  return { cancel: () => clearTimeout(t) };
};

export function createApiCounters(options: {
  readonly sink: CounterSink;
  readonly nowMs?: () => number;
  readonly windowMs?: number;
  /** 壁時計（ミリ秒）。窓の開始・終了の時刻を、まとめに付ける。 */
  readonly wallMs?: () => number;
  /**
   * 窓の終わりに、まとめを出す予約。**静かになっても、まとめを出し損ねない**（次の記録・停止を待たない）。省略すると、`unref` したタイマー。
   * `null` なら、予約しない（次の記録・`flush` のときだけ）。
   */
  readonly schedule?: SummaryScheduler | null;
}): ApiCounters {
  const now = options.nowMs ?? hrtimeMs;
  const windowMs = options.windowMs ?? 60_000;
  const schedule = options.schedule === null ? undefined : (options.schedule ?? defaultScheduler);
  let start: number | undefined;
  let startWall: number | undefined;
  let pending: { cancel: () => void } | undefined;
  const empty = (): Record<CounterKind, Record<string, number>> => ({
    authFailed: {},
    rateLimited: {},
    deduped: {},
  });
  let counts = empty();
  const total = (): number =>
    Object.values(counts).reduce(
      (sum, byName) => sum + Object.values(byName).reduce((a, b) => a + b, 0),
      0,
    );
  const emit = (): void => {
    pending?.cancel();
    pending = undefined;
    if (total() > 0) {
      options.sink.summary(
        Math.round(windowMs / 1000),
        counts,
        startWall === undefined ? undefined : { startMs: startWall, endMs: startWall + windowMs },
      );
    }
    counts = empty();
  };
  return {
    count(kind, name) {
      const t = now();
      if (start === undefined || t - start >= windowMs) {
        emit();
        start = t;
        startWall = options.wallMs?.();
        // 窓の終わりに、まとめを出す（次の記録を待たない）。窓が変わっていれば（その前に、次の記録でまとめた）、何もしない。
        const mine = start;
        const handle: { cancel: () => void } | undefined = schedule?.(() => {
          if (pending === handle) pending = undefined; // 取り消し損ねた古い予約が、新しい予約の手がかりを消さない
          if (start !== mine) return;
          emit();
          start = undefined;
          startWall = undefined;
        }, windowMs);
        pending = handle;
      }
      const bucket = counts[kind];
      const isFirst = bucket[name] === undefined;
      bucket[name] = (bucket[name] ?? 0) + 1;
      if (isFirst) options.sink.first(kind, name);
    },
    flush() {
      emit();
      start = undefined;
      startWall = undefined;
    },
  };
}
