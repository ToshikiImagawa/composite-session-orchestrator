import { describe, expect, it } from "vitest";
import {
  createCredentialStore,
  generateHumanToken,
  parseBearer,
} from "../../src/api/credentials.js";

const HUMAN = "h".repeat(40);
const store = () => createCredentialStore({ humanToken: HUMAN });

describe("parseBearer（Authorization ヘッダー）", () => {
  it("Bearer とトークンの形だけを受け付ける", () => {
    expect(parseBearer(`Bearer ${HUMAN}`)).toBe(HUMAN);
    for (const bad of [
      undefined,
      "",
      "Basic abc",
      "bearer abc123abc123abc123",
      "Bearer",
      "Bearer ",
      "Bearer a b",
      "Bearer short",
      `Bearer ${"x".repeat(513)}`,
      "Bearer abc\u0000abcabcabcabcabc",
      ["Bearer x"],
    ]) {
      expect(parseBearer(bad as never), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe("認証情報（人間と、ノード専用のトークンを分ける）", () => {
  it("人間のトークンは human、ノードのトークンはそのノードの役割と nodeId に結び付く", () => {
    const s = store();
    const t = s.issueNodeToken("m1", "integrator");
    const c = s.issueNodeToken("a", "child");
    expect(s.authenticate(HUMAN)).toEqual({ role: "human" });
    expect(s.authenticate(t)).toEqual({ role: "integrator", nodeId: "m1" });
    expect(s.authenticate(c)).toEqual({ role: "child", nodeId: "a" });
  });

  it("未知・空・文字列でないトークンは認証できない（フェイルクローズ）", () => {
    const s = store();
    for (const bad of ["", "x", "unknown-token-unknown-token-unknown", undefined, null, 5, {}]) {
      expect(s.authenticate(bad as never), JSON.stringify(bad)).toBeUndefined();
    }
  });

  it("発行するトークンは十分に長く、毎回異なり、同じノードに再発行すると古いトークンは無効になる", () => {
    const s = store();
    const t1 = s.issueNodeToken("a", "child");
    const t2 = s.issueNodeToken("a", "child");
    expect(t1.length).toBeGreaterThanOrEqual(43);
    expect(t1).not.toBe(t2);
    expect(s.authenticate(t1)).toBeUndefined();
    expect(s.authenticate(t2)).toEqual({ role: "child", nodeId: "a" });
  });

  it("revokeNode でトークンが無効になる。トークンそのものは保持しない", () => {
    const s = store();
    const t = s.issueNodeToken("a", "child");
    s.revokeNode("a");
    expect(s.authenticate(t)).toBeUndefined();
    s.revokeNode("zzz"); // 未知でも例外を出さない
    expect(JSON.stringify(s)).not.toContain(t);
    expect(JSON.stringify(s)).not.toContain(HUMAN);
  });

  it("人間のトークンが短すぎる設定、不正な nodeId・役割での発行は拒否する", () => {
    expect(() => createCredentialStore({ humanToken: "short" })).toThrow();
    const s = store();
    expect(() => s.issueNodeToken("", "child")).toThrow();
    expect(() => s.issueNodeToken("a", "human" as never)).toThrow();
  });

  it("ノードのトークンは人間として認証されない（逆も同様）", () => {
    const s = store();
    const t = s.issueNodeToken("m1", "integrator");
    expect(s.authenticate(t)?.role).not.toBe("human");
    expect(s.authenticate(HUMAN)).not.toHaveProperty("nodeId");
  });
});

describe("generateHumanToken（人間のトークンの生成。randomBytes(32).base64url に固定）", () => {
  it("43 文字の base64url で、毎回異なる。ストアの最小長を満たす", () => {
    const a = generateHumanToken();
    const b = generateHumanToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a).not.toBe(b);
    expect(createCredentialStore({ humanToken: a }).authenticate(a)).toEqual({ role: "human" });
  });

  it("nodeIds は、トークンを持つノードを返す（失効したら外れる）", () => {
    const c = createCredentialStore({ humanToken: "h".repeat(32) });
    c.issueNodeToken("a", "child");
    c.issueNodeToken("b", "integrator");
    expect(c.nodeIds().sort()).toEqual(["a", "b"]);
    c.revokeNode("a");
    expect(c.nodeIds()).toEqual(["b"]);
  });
});
