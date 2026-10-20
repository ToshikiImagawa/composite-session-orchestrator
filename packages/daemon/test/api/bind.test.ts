import { ID_PATTERN, isSafeId } from "@cso/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  BIND_CODE_ALPHABET,
  BIND_CODE_SHAPE,
  createBindCodes,
  createThrottle,
  formatBindCodeForDisplay,
  normalizeBindCode,
} from "../../src/api/bind.js";

const rig = (over: Parameters<typeof createBindCodes>[0] = {}) => {
  let now = 1_000_000;
  const codes = createBindCodes({ clock: () => now, ...over });
  return { codes, advance: (ms: number) => (now += ms) };
};
const wrong = (i: number) => `${String(i).padStart(4, "0")}ABCDEFGHJKMNPQRSTVWXYZ`.slice(0, 26);

describe("bind コードの形式（英数字だけ・128 ビット以上・isSafeId の部分集合）", () => {
  it("Crockford base32（0-9 と A-Z から I L O U を除く 32 種）の 26 文字（130 ビット）。発行したコードはすべて isSafeId を満たす", () => {
    expect(BIND_CODE_ALPHABET).toBe("0123456789ABCDEFGHJKMNPQRSTVWXYZ");
    const { codes } = rig({ maxOutstanding: 5000 });
    for (let i = 0; i < 300; i++) {
      const c = codes.issue(`n${i}`);
      expect(c, c).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
      expect(BIND_CODE_SHAPE.test(c)).toBe(true);
      expect(isSafeId(c), c).toBe(true);
    }
  });

  it("性質: BIND_CODE_SHAPE に合う文字列は、必ず ID_PATTERN にも合う（部分集合）", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[0-9A-Za-z\-_. :]{0,40}$/), (s) => {
        if (BIND_CODE_SHAPE.test(s)) expect(ID_PATTERN.test(s)).toBe(true);
      }),
    );
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...BIND_CODE_ALPHABET), { minLength: 26, maxLength: 26 }),
        (cs) => {
          const s = cs.join("");
          expect(BIND_CODE_SHAPE.test(s)).toBe(true);
          expect(isSafeId(s)).toBe(true);
        },
      ),
    );
  });

  it("入力の正規化: 大文字小文字・区切り・空白を問わず、紛らわしい文字は Crockford の規則（I L → 1、O → 0）", () => {
    expect(normalizeBindCode("abcde-fghjk mnpqr\tstvwx-yz0123")).toBe("ABCDEFGHJKMNPQRSTVWXYZ0123");
    expect(normalizeBindCode("OIl0")).toBe("0110");
    const { codes } = rig();
    const c = codes.issue("a");
    const typed = formatBindCodeForDisplay(c).toLowerCase().replaceAll("-", " ");
    expect(codes.redeem("a", typed)).toEqual({ ok: true, nodeId: "a" });
  });

  it("表示用の整形: 5 文字ずつ「-」で区切る（5-5-5-5-6）。正規化すると元に戻る", () => {
    const { codes } = rig();
    const c = codes.issue("a");
    const shown = formatBindCodeForDisplay(c);
    expect(shown).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}-[0-9A-Z]{6}$/);
    expect(normalizeBindCode(shown)).toBe(c);
  });

  it("コードは一様に選ぶ（32 種がすべて現れ、偏りがない）", () => {
    const { codes } = rig({ maxOutstanding: 5000 });
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      for (const ch of codes.issue(`n${i}`)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(counts.size).toBe(32);
    const total = 400 * 26;
    for (const n of counts.values()) expect(n / total).toBeGreaterThan(0.02); // 期待は 1/32 ≒ 0.031
  });
});

describe("bind コード（一度きり・短い有効期限・ノードに結ぶ）", () => {
  it("発行したコードは、結び付いたノードだけが、一度だけ使える", () => {
    const { codes } = rig();
    const c = codes.issue("a");
    expect(codes.redeem("a", c)).toEqual({ ok: true, nodeId: "a" });
    expect(codes.redeem("a", c)).toEqual({ ok: false, reason: "invalid" });
  });

  it("別のノードの名前では使えない（失敗として数え、コードは残る）", () => {
    const { codes } = rig();
    const c = codes.issue("a");
    expect(codes.redeem("b", c)).toEqual({ ok: false, reason: "invalid" });
    expect(codes.redeem("a", c)).toEqual({ ok: true, nodeId: "a" });
  });

  it("ノードの状態が許さないときは、コードを消費しない（accept が偽なら rejected。許すようになれば使える）", () => {
    const { codes } = rig();
    const c = codes.issue("a");
    let allowed = false;
    const accept = () => allowed;
    expect(codes.redeem("a", c, accept)).toEqual({ ok: false, reason: "rejected" });
    expect(codes.redeem("a", c, accept)).toEqual({ ok: false, reason: "rejected" });
    allowed = true;
    expect(codes.redeem("a", c, accept)).toEqual({ ok: true, nodeId: "a" });
    expect(codes.redeem("a", c, accept)).toEqual({ ok: false, reason: "invalid" });
  });

  it("accept が例外を投げたら rejected（フェイルクローズ。消費しない）。間違ったコードでは accept を呼ばない", () => {
    const { codes } = rig();
    const c = codes.issue("a");
    expect(
      codes.redeem("a", c, () => {
        throw new Error("x");
      }),
    ).toEqual({ ok: false, reason: "rejected" });
    let called = 0;
    codes.redeem("a", wrong(1), () => {
      called += 1;
      return true;
    });
    expect(called).toBe(0);
    expect(codes.redeem("a", c)).toEqual({ ok: true, nodeId: "a" });
  });

  it("有効期限（既定 10 分）を過ぎたら無効。期限内は有効", () => {
    const r = rig();
    const c1 = r.codes.issue("a");
    r.advance(10 * 60_000 - 1);
    expect(r.codes.redeem("a", c1)).toEqual({ ok: true, nodeId: "a" });
    const c2 = r.codes.issue("a");
    r.advance(10 * 60_000);
    expect(r.codes.redeem("a", c2)).toEqual({ ok: false, reason: "invalid" });
    const r2 = rig({ ttlMs: 1000 });
    const c3 = r2.codes.issue("b");
    r2.advance(1001);
    expect(r2.codes.redeem("b", c3)).toEqual({ ok: false, reason: "invalid" });
  });

  it("同じノードに再発行すると、古いコードは無効になる。コードは毎回異なる", () => {
    const { codes } = rig();
    const c1 = codes.issue("a");
    const c2 = codes.issue("a");
    expect(c1).not.toBe(c2);
    expect(codes.redeem("a", c1)).toEqual({ ok: false, reason: "invalid" });
    expect(codes.redeem("a", c2)).toEqual({ ok: true, nodeId: "a" });
  });

  it("revoke でノードのコードが無効になる。コードそのものは保持しない（ハッシュだけ）", () => {
    const { codes } = rig();
    const c = codes.issue("a");
    codes.revoke("a");
    codes.revoke("zzz");
    expect(codes.redeem("a", c)).toEqual({ ok: false, reason: "invalid" });
    const c2 = codes.issue("b");
    expect(JSON.stringify(codes)).not.toContain(c2);
  });

  it("不正なノード ID・未発行・不正な形のコードは使えない", () => {
    const { codes } = rig({ maxFailures: 1000 });
    expect(() => codes.issue("")).toThrow();
    expect(() => codes.issue("../x")).toThrow();
    for (const bad of ["", "x", "unknown-code-unknown-code", null, undefined, 5, {}]) {
      expect(codes.redeem("a", bad as never), JSON.stringify(bad)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
    expect(codes.redeem("../x" as never, wrong(1))).toEqual({ ok: false, reason: "invalid" });
    expect(codes.redeem(5 as never, wrong(1))).toEqual({ ok: false, reason: "invalid" });
  });

  it("未使用のコードの数に上限がある（超えたら、最も古いものから捨てる）", () => {
    const { codes } = rig({ maxOutstanding: 3 });
    const cs = ["a", "b", "c", "d"].map((n) => codes.issue(n));
    expect(codes.redeem("a", cs[0] as string)).toEqual({ ok: false, reason: "invalid" });
    expect(codes.redeem("d", cs[3] as string)).toEqual({ ok: true, nodeId: "d" });
  });
});

describe("ノードごとの失敗の回数制限", () => {
  it("窓の中で、そのノードの失敗が上限（既定 5 回）に達すると、そのノードをロックする。他のノードは使える", () => {
    const r = rig();
    const good = r.codes.issue("a");
    const other = r.codes.issue("b");
    for (let i = 0; i < 5; i++)
      expect(r.codes.redeem("a", wrong(i))).toEqual({ ok: false, reason: "invalid" });
    const locked = r.codes.redeem("a", good);
    expect(locked).toMatchObject({ ok: false, reason: "locked" });
    expect(locked.ok ? 0 : (locked as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect(r.codes.redeem("b", other)).toEqual({ ok: true, nodeId: "b" });
    r.advance(60_000);
    expect(r.codes.redeem("a", good)).toEqual({ ok: true, nodeId: "a" });
  });

  it("全体のロックはない（ノードを変えて試しても、全員は止まらない）", () => {
    const r = rig();
    const good = r.codes.issue("zz");
    for (let i = 0; i < 100; i++) r.codes.redeem(`n${i}`, wrong(i));
    expect(r.codes.redeem("zz", good)).toEqual({ ok: true, nodeId: "zz" });
  });

  it("古い失敗は窓（既定 1 分）を過ぎたら数えない。ロック中の試行は数えず、ロックを延ばさない", () => {
    const r = rig();
    const good = r.codes.issue("a");
    for (let i = 0; i < 4; i++) r.codes.redeem("a", wrong(i));
    r.advance(60_001);
    for (let i = 0; i < 4; i++) r.codes.redeem("a", wrong(i + 10));
    expect(r.codes.redeem("a", good)).toEqual({ ok: true, nodeId: "a" });
    const r2 = rig({ maxFailures: 2, failureWindowMs: 1000, lockoutMs: 5000 });
    r2.codes.redeem("a", wrong(1));
    r2.codes.redeem("a", wrong(2));
    for (let i = 0; i < 10; i++)
      expect(r2.codes.redeem("a", wrong(i))).toMatchObject({ reason: "locked" });
    r2.advance(5000);
    expect(r2.codes.redeem("a", wrong(99))).toEqual({ ok: false, reason: "invalid" });
  });

  it("失敗を覚えるノードの数に上限がある（メモリを使い切らせない）", () => {
    const r = rig({ maxTrackedNodes: 10 });
    for (let i = 0; i < 1000; i++) r.codes.redeem(`n${i}`, wrong(i));
    expect(r.codes.trackedNodes()).toBeLessThanOrEqual(10);
  });
});

describe("短いスロットル（全体で 1 秒あたり N 回の失敗）", () => {
  const rigT = (perSecond = 3) => {
    let now = 5_000;
    const t = createThrottle({ clock: () => now, perSecond });
    return { t, advance: (ms: number) => (now += ms) };
  };

  it("1 秒の中で失敗が N 回に達したら、その秒の残りは止める（retryAfterMs つき）。次の秒には解ける", () => {
    const { t, advance } = rigT(3);
    expect(t.blocked()).toBeUndefined();
    t.fail();
    t.fail();
    expect(t.blocked()).toBeUndefined();
    t.fail();
    const b = t.blocked();
    expect(b).toBeGreaterThan(0);
    expect(b).toBeLessThanOrEqual(1000);
    advance(1000);
    expect(t.blocked()).toBeUndefined();
  });

  it("止めている間の試行は数えない（延び続けない）。失敗の記録は上限を超えてもメモリを増やさない", () => {
    const { t, advance } = rigT(2);
    t.fail();
    t.fail();
    for (let i = 0; i < 10000; i++) t.fail();
    advance(1000);
    expect(t.blocked()).toBeUndefined();
  });
});
