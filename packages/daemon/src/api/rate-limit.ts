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
  summary(windowSec: number, counts: Record<CounterKind, Record<string, number>>): void;
}

export function createApiCounters(options: {
  readonly sink: CounterSink;
  readonly nowMs?: () => number;
  readonly windowMs?: number;
}): ApiCounters {
  const now = options.nowMs ?? hrtimeMs;
  const windowMs = options.windowMs ?? 60_000;
  let start: number | undefined;
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
    if (total() > 0) options.sink.summary(Math.round(windowMs / 1000), counts);
    counts = empty();
  };
  return {
    count(kind, name) {
      const t = now();
      if (start === undefined || t - start >= windowMs) {
        emit();
        start = t;
      }
      const bucket = counts[kind];
      const isFirst = bucket[name] === undefined;
      bucket[name] = (bucket[name] ?? 0) + 1;
      if (isFirst) options.sink.first(kind, name);
    },
    flush() {
      emit();
      start = undefined;
    },
  };
}
