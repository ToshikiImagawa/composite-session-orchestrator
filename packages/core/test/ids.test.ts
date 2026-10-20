import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ID_MAX_LENGTH, ID_PATTERN, isSafeId } from "../src/index.js";

describe("isSafeId（ノード・判断・報告などの識別子の形式）", () => {
  it("英数字で始まり、英数字と . _ : - だけの 128 文字以下を受け付ける", () => {
    for (const ok of [
      "a",
      "root",
      "m1",
      "node-1",
      "node_1.2",
      "a:b",
      "A0",
      "x".repeat(ID_MAX_LENGTH),
    ]) {
      expect(isSafeId(ok), ok).toBe(true);
    }
  });

  it("空・長すぎる・区切りや空白・制御文字・パスの要素・非 ASCII・文字列でない値を拒否する", () => {
    for (const bad of [
      "",
      "x".repeat(ID_MAX_LENGTH + 1),
      ".",
      "..",
      ".hidden",
      "-flag",
      "_x",
      ":x",
      "a/b",
      "a\\b",
      "../x",
      "a b",
      "a\nb",
      "a\u0000b",
      "a‮b",
      "あ",
      "a;b",
      "a$b",
      "a`b",
      "a'b",
      'a"b',
      "a*b",
      "aé",
      5,
      null,
      undefined,
      {},
      [],
    ]) {
      expect(isSafeId(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it("ID_PATTERN と一致する（cli など core の外から同じ規則を使える）", () => {
    expect(ID_PATTERN.test("node-1")).toBe(true);
    expect(ID_PATTERN.test("a/b")).toBe(false);
  });

  it("性質: 受け付ける識別子は、空白・スラッシュ・制御文字・先頭の記号を含まない", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), (s) => {
        if (isSafeId(s)) {
          expect(
            [...s].some(
              (c) => c.charCodeAt(0) <= 0x20 || c === "/" || c === "\\" || c === "\u007f",
            ),
          ).toBe(false);
          expect(/^[A-Za-z0-9]/.test(s)).toBe(true);
          expect(s.length).toBeLessThanOrEqual(ID_MAX_LENGTH);
        }
      }),
    );
  });
});
