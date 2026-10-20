import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { isBoundedText, LIMITS, sanitizeText } from "../src/index.js";

describe("sanitizeText（子や外部由来の文字列を、記録できる形にする）", () => {
  it("禁止された文字を U+FFFD に置き換え、タブ・改行は残す", () => {
    expect(sanitizeText("a‮b\u001b\r\nc\td", 100)).toBe("a�b��\nc\td");
  });

  it("上限（コードポイント）を超えたら、末尾を「…」にして上限に収める", () => {
    expect(sanitizeText("あ".repeat(10), 10)).toBe("あ".repeat(10));
    expect(sanitizeText("あ".repeat(11), 10)).toBe(`${"あ".repeat(9)}…`);
    expect([..."😀".repeat(5000)].length).toBe(5000);
    expect([...sanitizeText("😀".repeat(5000), LIMITS.reason)].length).toBe(LIMITS.reason);
  });

  it("性質: 結果は常に isBoundedText を満たす（例外なし）", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary" }), fc.integer({ min: 1, max: 50 }), (s, max) => {
        expect(isBoundedText(sanitizeText(s, max), max)).toBe(true);
      }),
    );
  });

  it("文字列でない入力は String にして扱う", () => {
    expect(sanitizeText(new Error("boom"), 100)).toBe("Error: boom");
    expect(sanitizeText(undefined, 100)).toBe("undefined");
  });
});
