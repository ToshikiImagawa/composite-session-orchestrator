import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Priority } from "../src/index.js";

// 基盤の動作確認用。ドメインロジックの検証は、実装 PR で別途追加する。
const ORDER: readonly Priority[] = ["blocking", "failed", "completed", "progress", "info"];
const rank = (p: Priority): number => ORDER.indexOf(p);

describe("test infrastructure smoke", () => {
  it("Vitest が動く", () => {
    expect(rank("blocking")).toBeLessThan(rank("info"));
  });

  it("fast-check で並べ替えが要素を保つ（性質ベース）", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...ORDER)), (items) => {
        const sorted = [...items].sort((a, b) => rank(a) - rank(b));
        expect(sorted).toHaveLength(items.length);
        expect(sorted.map(rank)).toEqual([...sorted.map(rank)].sort((a, b) => a - b));
      }),
    );
  });
});
