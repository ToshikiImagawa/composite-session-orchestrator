import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  createApiCounters,
  createRateLimiter,
  HEAVY_WEIGHT,
  operationWeight,
  RATE_LIMIT_BOUNDS,
} from "../../src/api/rate-limit.js";

const clockOf = () => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

describe("token bucket（createRateLimiter）", () => {
  it("容量の分は、突発で通る。使い切ったら、拒否して、足りるまでの秒数（1 以上）を返す", () => {
    const c = clockOf();
    const rl = createRateLimiter({ spec: { burst: 3, perSecond: 1 }, nowMs: c.now });
    expect(rl.tryConsume("k", 1)).toEqual({ ok: true });
    expect(rl.tryConsume("k", 1)).toEqual({ ok: true });
    expect(rl.tryConsume("k", 1)).toEqual({ ok: true });
    expect(rl.tryConsume("k", 1)).toEqual({ ok: false, retryAfterSec: 1 });
  });

  it("canConsume（T10l-f）: 使えるかだけを返す。何も使わない・キーを作らない。尽きていれば、足りるまでの秒数を返す。補充は tryConsume と同じ", () => {
    const c = clockOf();
    const rl = createRateLimiter({ spec: { burst: 2, perSecond: 1 }, nowMs: c.now });
    expect(rl.canConsume("k", 1)).toEqual({ ok: true });
    expect(rl.size()).toBe(0); // キーを作らない
    for (let i = 0; i < 5; i++) expect(rl.canConsume("k", 1)).toEqual({ ok: true }); // 何も使わない
    rl.tryConsume("k", 2);
    expect(rl.canConsume("k", 1)).toEqual({ ok: false, retryAfterSec: 1 });
    expect(rl.canConsume("k", 1)).toEqual({ ok: false, retryAfterSec: 1 }); // 数えても、変わらない
    c.advance(1000);
    expect(rl.canConsume("k", 1)).toEqual({ ok: true });
    expect(rl.tryConsume("k", 1).ok).toBe(true);
    expect(rl.canConsume("k", 1).ok).toBe(false);
    // 容量を超える要求は、容量に切られる（tryConsume と同じ）
    expect(rl.canConsume("other", 100)).toEqual({ ok: true });
  });

  it("補充は毎秒。小数の経過も数える。拒否は、何も使わない（トークンが減らない）", () => {
    const c = clockOf();
    const rl = createRateLimiter({ spec: { burst: 2, perSecond: 2 }, nowMs: c.now });
    rl.tryConsume("k", 2);
    expect(rl.tryConsume("k", 1).ok).toBe(false);
    c.advance(250); // 0.5 トークン
    expect(rl.tryConsume("k", 1).ok).toBe(false);
    c.advance(250); // 1 トークン
    expect(rl.tryConsume("k", 1).ok).toBe(true);
    expect(rl.tryConsume("k", 1).ok).toBe(false);
  });

  it("長く使われなくても、容量を超えては貯まらない", () => {
    const c = clockOf();
    const rl = createRateLimiter({ spec: { burst: 3, perSecond: 10 }, nowMs: c.now });
    rl.tryConsume("k", 3);
    c.advance(10 * 60_000);
    for (let i = 0; i < 3; i++) expect(rl.tryConsume("k", 1).ok).toBe(true);
    expect(rl.tryConsume("k", 1).ok).toBe(false);
  });

  it("重み（コスト）の分を使う。足りなければ、全部使わずに拒否する。Retry-After は不足分から決まる", () => {
    const c = clockOf();
    const rl = createRateLimiter({ spec: { burst: 10, perSecond: 2 }, nowMs: c.now });
    expect(rl.tryConsume("k", 6).ok).toBe(true);
    const r = rl.tryConsume("k", 5); // 残り 4、不足 1 → 0.5 秒 → 1 秒に切り上げ
    expect(r).toEqual({ ok: false, retryAfterSec: 1 });
    expect(rl.tryConsume("k", 4).ok).toBe(true); // 拒否で減っていない
    const big = rl.tryConsume("k", 10); // 空から 10 → 5 秒
    expect(big).toEqual({ ok: false, retryAfterSec: 5 });
  });

  it("キーごとに独立している", () => {
    const c = clockOf();
    const rl = createRateLimiter({ spec: { burst: 1, perSecond: 1 }, nowMs: c.now });
    expect(rl.tryConsume("a", 1).ok).toBe(true);
    expect(rl.tryConsume("a", 1).ok).toBe(false);
    expect(rl.tryConsume("b", 1).ok).toBe(true);
  });

  it("表の大きさに上限がある。超えたら、最も古く使われたキーを捨てる（捨てられたキーは満タンから）", () => {
    const c = clockOf();
    const rl = createRateLimiter({
      spec: { burst: 1, perSecond: 0.001 },
      nowMs: c.now,
      maxKeys: 3,
    });
    for (const k of ["a", "b", "c"]) rl.tryConsume(k, 1);
    rl.tryConsume("a", 1); // a を最近使った（拒否でも、使った扱い）
    rl.tryConsume("d", 1); // 4 つ目: 最も古い b を捨てる
    expect(rl.size()).toBe(3);
    expect(rl.tryConsume("b", 1).ok).toBe(true); // 捨てられていたので、満タンから
    expect(rl.tryConsume("a", 1).ok).toBe(false); // a は残っていて、空のまま
  });

  it("時計が戻っても（異常な入力）、トークンは増えず、負にもならない", () => {
    const c = clockOf();
    c.advance(10_000);
    const rl = createRateLimiter({ spec: { burst: 2, perSecond: 1 }, nowMs: c.now });
    rl.tryConsume("k", 2);
    c.advance(-5000);
    expect(rl.tryConsume("k", 1).ok).toBe(false);
  });

  it("性質: 通った重みの合計は、「容量 + 補充 × 経過」を超えない。拒否の後も、次の判定が壊れない", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 1, max: 20 }),
        fc.array(
          fc.record({
            dt: fc.integer({ min: 0, max: 3000 }),
            cost: fc.integer({ min: 1, max: 5 }),
          }),
          { minLength: 1, maxLength: 60 },
        ),
        (burst, perSecond, steps) => {
          const c = clockOf();
          const rl = createRateLimiter({ spec: { burst, perSecond }, nowMs: c.now });
          let granted = 0;
          for (const s of steps) {
            c.advance(s.dt);
            const r = rl.tryConsume("k", s.cost);
            if (r.ok) granted += Math.min(s.cost, burst);
            else expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
          }
          expect(granted).toBeLessThanOrEqual(burst + (c.now() / 1000) * perSecond + 1e-6);
        },
      ),
    );
  });
});

describe("操作の重みと、設定の下限", () => {
  it("重い操作（生成・分割・回収・最終削除）だけ重い。ほかは 1", () => {
    for (const op of ["node.spawn", "node.split", "node.reclaim", "node.purge"]) {
      expect(operationWeight(op)).toBe(HEAVY_WEIGHT);
    }
    for (const op of ["tree.list", "inbox.fetch", "node.purgePreview", "report.progress"]) {
      expect(operationWeight(op)).toBe(1);
    }
  });

  it("容量の下限は、重い操作の重みの 2 倍以上（重い操作が通らなくなって、自分を締め出さない）", () => {
    expect(RATE_LIMIT_BOUNDS.principalBurst.min).toBeGreaterThanOrEqual(HEAVY_WEIGHT * 2);
  });
});

describe("認証の失敗・制限の発動の集計（T10a）", () => {
  const rig = () => {
    const c = clockOf();
    const firsts: string[] = [];
    const summaries: { windowSec: number; counts: unknown }[] = [];
    const counters = createApiCounters({
      nowMs: c.now,
      windowMs: 60_000,
      sink: {
        first: (kind, name) => firsts.push(`${kind}:${name}`),
        summary: (windowSec, counts) => summaries.push({ windowSec, counts }),
      },
    });
    return { c, counters, firsts, summaries };
  };

  it("窓の中で、種類ごとの最初の 1 件だけをすぐに出し、窓が終わった次の記録で、件数を 1 行にまとめる", () => {
    const r = rig();
    for (let i = 0; i < 5; i++) r.counters.count("authFailed", "invalid");
    r.counters.count("authFailed", "missing");
    r.counters.count("rateLimited", "principal");
    expect(r.firsts).toEqual(["authFailed:invalid", "authFailed:missing", "rateLimited:principal"]);
    expect(r.summaries).toEqual([]);
    r.c.advance(60_000);
    r.counters.count("authFailed", "invalid"); // 窓が終わった: 前の窓をまとめ、新しい窓の最初の 1 件を出す
    expect(r.summaries).toEqual([
      {
        windowSec: 60,
        counts: {
          authFailed: { invalid: 5, missing: 1 },
          rateLimited: { principal: 1 },
          deduped: {},
        },
      },
    ]);
    expect(r.firsts.at(-1)).toBe("authFailed:invalid");
  });

  it("flush で、溜まっている件数を今すぐ 1 行にまとめる。何もなければ出さない", () => {
    const r = rig();
    r.counters.flush();
    expect(r.summaries).toEqual([]);
    r.counters.count("authFailed", "invalid");
    r.counters.flush();
    expect(r.summaries).toHaveLength(1);
    r.counters.flush();
    expect(r.summaries).toHaveLength(1);
  });
});
