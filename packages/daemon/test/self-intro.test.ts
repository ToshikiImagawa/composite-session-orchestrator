import { isSafeId } from "@cso/core";
import { describe, expect, it } from "vitest";
import { selfIntroLines } from "../src/self-intro.js";

describe("selfIntroLines（起動の指示の先頭。自分のノード ID・role・親）", () => {
  it("自分の ID・role・親を、省略せずに書く。作業ツリーの名前は ID ではないことを添える", () => {
    const id = "node-a4cf56b90c29ee7587b58ad14a6f9d85";
    const text = selfIntroLines(id, "integrator", "root").join("\n");
    expect(text).toContain(`あなたのノード ID: ${id}`);
    expect(text).toContain("role: integrator");
    expect(text).toContain("親: root");
    expect(text).toContain("省略・短縮せず");
    expect(text).toContain("作業ツリーのディレクトリ名は、ID ではない");
    // 切り詰めた ID（作業ツリーの名前の形）は、含めない
    expect(text).not.toContain("node-a4cf56b90c29ee7587b58ad14a6 ");
  });

  it("根の直接の子の親は、根の ID をそのまま書く。親がない（根）ときは「なし」", () => {
    expect(selfIntroLines("m1", "integrator", "root").join("\n")).toContain("親: root");
    expect(selfIntroLines("root", "integrator", null).join("\n")).toContain("親: なし");
  });

  it("本文は固定の文面で、ID は安全な識別子だけ（子が影響できる文字列を入れない）", () => {
    for (const bad of ["a b", "a\nb", "../x", "x;y", ""]) {
      expect(isSafeId(bad)).toBe(false);
      expect(() => selfIntroLines(bad, "implement", "root")).toThrow();
      expect(() => selfIntroLines("m1", "implement", bad)).toThrow();
    }
  });
});
