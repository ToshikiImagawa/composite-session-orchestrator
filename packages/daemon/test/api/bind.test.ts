import { describe, expect, it } from "vitest";
import { createBindCodes } from "../../src/api/bind.js";

const rig = (over: Parameters<typeof createBindCodes>[0] = {}) => {
  let now = 1_000_000;
  const codes = createBindCodes({ clock: () => now, ...over });
  return { codes, advance: (ms: number) => (now += ms) };
};

describe("bind コード（一度きり・短い有効期限・ノードに結ぶ）", () => {
  it("発行したコードは、一度だけ使えて、結び付いたノードを返す", () => {
    const { codes } = rig();
    const c = codes.issue("a");
    expect(c).toMatch(/^[A-Za-z0-9_-]{22,}$/);
    expect(codes.redeem(c)).toEqual({ ok: true, nodeId: "a" });
    expect(codes.redeem(c)).toEqual({ ok: false, reason: "invalid" }); // 二度目は無効
  });

  it("有効期限（既定 10 分）を過ぎたら無効。期限内は有効", () => {
    const r = rig();
    const c1 = r.codes.issue("a");
    r.advance(10 * 60_000 - 1);
    expect(r.codes.redeem(c1)).toEqual({ ok: true, nodeId: "a" });
    const c2 = r.codes.issue("a");
    r.advance(10 * 60_000);
    expect(r.codes.redeem(c2)).toEqual({ ok: false, reason: "invalid" });
    const r2 = rig({ ttlMs: 1000 });
    const c3 = r2.codes.issue("b");
    r2.advance(1001);
    expect(r2.codes.redeem(c3)).toEqual({ ok: false, reason: "invalid" });
  });

  it("同じノードに再発行すると、古いコードは無効になる。コードは毎回異なる", () => {
    const { codes } = rig();
    const c1 = codes.issue("a");
    const c2 = codes.issue("a");
    expect(c1).not.toBe(c2);
    expect(codes.redeem(c1)).toEqual({ ok: false, reason: "invalid" });
    expect(codes.redeem(c2)).toEqual({ ok: true, nodeId: "a" });
  });

  it("revoke でノードのコードが無効になる。コードそのものは保持しない", () => {
    const { codes } = rig();
    const c = codes.issue("a");
    codes.revoke("a");
    codes.revoke("zzz");
    expect(codes.redeem(c)).toEqual({ ok: false, reason: "invalid" });
    const c2 = codes.issue("b");
    expect(JSON.stringify(codes)).not.toContain(c2);
  });

  it("不正なノード ID・未発行・不正な形のコードは使えない", () => {
    const { codes } = rig({ maxFailures: 100 });
    expect(() => codes.issue("")).toThrow();
    expect(() => codes.issue("../x")).toThrow();
    for (const bad of ["", "x", "unknown-code-unknown-code", null, undefined, 5, {}]) {
      expect(codes.redeem(bad as never), JSON.stringify(bad)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
  });

  it("未使用のコードの数に上限がある（超えたら、最も古いものから捨てる）", () => {
    const { codes } = rig({ maxOutstanding: 3 });
    const cs = ["a", "b", "c", "d"].map((n) => codes.issue(n));
    expect(codes.redeem(cs[0] as string)).toEqual({ ok: false, reason: "invalid" });
    expect(codes.redeem(cs[3] as string)).toEqual({ ok: true, nodeId: "d" });
  });
});

describe("失敗の回数制限（総当たりへの対策）", () => {
  it("窓の中で失敗が上限（既定 5 回）に達すると、ロックする。ロック中は正しいコードも拒否（locked）し、解除後に使える", () => {
    const r = rig();
    const good = r.codes.issue("a");
    for (let i = 0; i < 5; i++) {
      expect(r.codes.redeem(`wrong-code-wrong-code-${i}xx`)).toEqual({
        ok: false,
        reason: "invalid",
      });
    }
    expect(r.codes.redeem(good)).toMatchObject({ ok: false, reason: "locked" });
    expect(r.codes.redeem("another-wrong-code-xxxxxx")).toMatchObject({
      ok: false,
      reason: "locked",
    });
    r.advance(60_000);
    expect(r.codes.redeem(good)).toEqual({ ok: true, nodeId: "a" });
  });

  it("古い失敗は窓（既定 1 分）を過ぎたら数えない。成功は失敗の数を増やさない", () => {
    const r = rig();
    const good = r.codes.issue("a");
    for (let i = 0; i < 4; i++) r.codes.redeem(`wrong-code-wrong-code-${i}xx`);
    r.advance(60_001);
    for (let i = 0; i < 4; i++) r.codes.redeem(`wrong-code-wrong-code-${i}yy`);
    expect(r.codes.redeem(good)).toEqual({ ok: true, nodeId: "a" });
  });

  it("上限と時間は設定できる", () => {
    const r = rig({ maxFailures: 2, failureWindowMs: 1000, lockoutMs: 5000 });
    r.codes.redeem("wrong-code-wrong-code-1xx");
    r.codes.redeem("wrong-code-wrong-code-2xx");
    expect(r.codes.redeem("wrong-code-wrong-code-3xx")).toMatchObject({
      ok: false,
      reason: "locked",
    });
    r.advance(4999);
    expect(r.codes.redeem("wrong-code-wrong-code-4xx")).toMatchObject({
      ok: false,
      reason: "locked",
    });
    r.advance(1);
    expect(r.codes.redeem("wrong-code-wrong-code-5xx")).toEqual({ ok: false, reason: "invalid" });
  });
});
