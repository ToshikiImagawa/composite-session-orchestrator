import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PRIORITIES_DESC, type Priority } from "../src/index.js";

describe("PRIORITIES_DESC", () => {
  it("blocking が最上位、info が最下位である", () => {
    expect(PRIORITIES_DESC[0]).toBe("blocking");
    expect(PRIORITIES_DESC.at(-1)).toBe("info");
  });

  it("重複がなく、並べ替えても要素が保たれる（性質ベース）", () => {
    fc.assert(
      fc.property(fc.shuffledSubarray([...PRIORITIES_DESC]), (subset: Priority[]) => {
        const ranked = [...subset].sort(
          (a, b) => PRIORITIES_DESC.indexOf(a) - PRIORITIES_DESC.indexOf(b),
        );
        expect(ranked).toHaveLength(subset.length);
        expect(new Set(ranked)).toEqual(new Set(subset));
      }),
    );
  });
});
