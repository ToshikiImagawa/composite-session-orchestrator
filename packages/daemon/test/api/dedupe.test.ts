import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fingerprintOf, stableStringify } from "../../src/api/dedupe.js";

describe("本文の指紋（fingerprintOf）", () => {
  it("キーの並び・空白に影響されない。入れ子・配列も同じ", () => {
    expect(fingerprintOf("op", { a: 1, b: { c: [1, { y: 2, x: 1 }] } })).toBe(
      fingerprintOf("op", { b: { c: [1, { x: 1, y: 2 }] }, a: 1 }),
    );
  });

  it("操作の名前・値が違えば、違う", () => {
    expect(fingerprintOf("a", { x: 1 })).not.toBe(fingerprintOf("b", { x: 1 }));
    expect(fingerprintOf("a", { x: 1 })).not.toBe(fingerprintOf("a", { x: 2 }));
    expect(fingerprintOf("a", { x: [1, 2] })).not.toBe(fingerprintOf("a", { x: [2, 1] }));
  });

  it("有限でない数（JSON の 1e999 は Infinity になる）は、null とも、互いにも、文字列とも区別する", () => {
    const inf = JSON.parse("1e999") as number;
    expect(inf).toBe(Number.POSITIVE_INFINITY);
    const f = (v: unknown) => fingerprintOf("op", { v });
    expect(f(inf)).not.toBe(f(null));
    expect(f(inf)).not.toBe(f(-inf));
    expect(f(inf)).not.toBe(f("Infinity"));
    expect(f(Number.NaN)).not.toBe(f(null));
    expect(f(inf)).not.toBe(f(Number.NaN));
  });

  it("性質: 同じ値は同じ指紋。キーの順を入れ替えても同じ", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string({ maxLength: 6 }), fc.jsonValue()), (o) => {
        const reversed = Object.fromEntries(Object.entries(o).reverse());
        expect(fingerprintOf("op", reversed)).toBe(fingerprintOf("op", o));
        expect(stableStringify(o)).toBe(stableStringify(structuredClone(o)));
      }),
    );
  });
});
