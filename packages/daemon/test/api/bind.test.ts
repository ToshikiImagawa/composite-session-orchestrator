import { isSafeId } from "@cso/core";
import { describe, expect, it } from "vitest";
import { BIND_CODE_ALPHABET, createBindCodes, normalizeBindCode } from "../../src/api/bind.js";

const rig = (over: Parameters<typeof createBindCodes>[0] = {}) => {
  let now = 1_000_000;
  const codes = createBindCodes({ clock: () => now, ...over });
  return { codes, advance: (ms: number) => (now += ms) };
};
const wrong = (i: number) =>
  `WRNG-${String(i)
    .padStart(4, "A")
    .replace(/[^A-Z]/g, "B")}-AAAA-BBBB`;

describe("bind コードの形式（Desktop で人が見て入力しやすい）", () => {
  it("紛らわしい文字（0 O 1 I L）を除いた英数字 16 文字を、4 文字ずつ「-」で区切る。isSafeId を満たす", () => {
    const { codes } = rig();
    expect(BIND_CODE_ALPHABET).toHaveLength(31);
    for (const bad of ["0", "O", "1", "I", "L"]) expect(BIND_CODE_ALPHABET).not.toContain(bad);
    for (let i = 0; i < 50; i++) {
      const c = codes.issue(`n${i}`);
      expect(c).toMatch(/^[A-HJ-KM-NP-Z2-9]{4}(-[A-HJ-KM-NP-Z2-9]{4}){3}$/);
      expect(isSafeId(c), c).toBe(true);
    }
  });

  it("小文字・区切りなしで入力しても同じコードとして使える（正規化）", () => {
    expect(normalizeBindCode("abcd-efgh-jkmn-pqrs")).toBe("ABCDEFGHJKMNPQRS");
    expect(normalizeBindCode("ABCD EFGH JKMN PQRS")).toBe("ABCDEFGHJKMNPQRS");
    expect(normalizeBindCode("ABCDEFGHJKMNPQRS")).toBe("ABCDEFGHJKMNPQRS");
    const { codes } = rig();
    const c = codes.issue("a");
    expect(codes.redeem("a", c.toLowerCase().replaceAll("-", ""))).toEqual({
      ok: true,
      nodeId: "a",
    });
  });

  it("コードは一様に選ぶ（偏りのない文字の出現）", () => {
    const { codes } = rig({ maxOutstanding: 5000 });
    const counts = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      for (const ch of codes.issue(`n${i}`).replaceAll("-", ""))
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
    expect(counts.size).toBe(31);
    const total = 400 * 16;
    for (const n of counts.values()) expect(n / total).toBeGreaterThan(0.015); // 期待は約 0.032
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
    expect(JSON.stringify(codes)).not.toContain(normalizeBindCode(c2));
  });

  it("不正なノード ID・未発行・不正な形のコードは使えない", () => {
    const { codes } = rig({ maxFailures: 1000, maxGlobalFailures: 1000 });
    expect(() => codes.issue("")).toThrow();
    expect(() => codes.issue("../x")).toThrow();
    for (const bad of ["", "x", "unknown-code-unknown-code", null, undefined, 5, {}]) {
      expect(codes.redeem("a", bad as never), JSON.stringify(bad)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
    expect(codes.redeem("../x" as never, "ABCD-EFGH-JKMN-PQRS")).toEqual({
      ok: false,
      reason: "invalid",
    });
    expect(codes.redeem(5 as never, "ABCD-EFGH-JKMN-PQRS")).toEqual({
      ok: false,
      reason: "invalid",
    });
  });

  it("未使用のコードの数に上限がある（超えたら、最も古いものから捨てる）", () => {
    const { codes } = rig({ maxOutstanding: 3 });
    const cs = ["a", "b", "c", "d"].map((n) => codes.issue(n));
    expect(codes.redeem("a", cs[0] as string)).toEqual({ ok: false, reason: "invalid" });
    expect(codes.redeem("d", cs[3] as string)).toEqual({ ok: true, nodeId: "d" });
  });
});

describe("失敗の回数制限（ノード単位と全体の両方で数える）", () => {
  it("ノード単位: 窓の中で、そのノードの失敗が上限（既定 5 回）に達すると、そのノードをロックする。他のノードは使える", () => {
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

  it("全体: ノードを変えて試しても、全体の失敗が上限（既定 20 回）に達すると、全員をロックする", () => {
    const r = rig();
    const good = r.codes.issue("zz");
    for (let i = 0; i < 20; i++) r.codes.redeem(`n${i}`, wrong(i));
    expect(r.codes.redeem("zz", good)).toMatchObject({ ok: false, reason: "locked" });
    r.advance(60_000);
    expect(r.codes.redeem("zz", good)).toEqual({ ok: true, nodeId: "zz" });
  });

  it("古い失敗は窓（既定 1 分）を過ぎたら数えない。ロック中の試行は失敗に数えず、ロックを延ばさない", () => {
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
    const r = rig({ maxTrackedNodes: 10, maxGlobalFailures: 100000 });
    for (let i = 0; i < 1000; i++) r.codes.redeem(`n${i}`, wrong(i));
    expect(r.codes.trackedNodes()).toBeLessThanOrEqual(10);
  });
});
