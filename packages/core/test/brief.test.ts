import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type Brief, briefProblem, LIMITS } from "../src/index.js";

const scope = {
  writableLocations: ["/w"],
  forbiddenLocations: [],
  allowedCommands: ["git status"],
};
const ok = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  objective: "ログイン画面を作る",
  acceptanceCriteria: ["表示できる"],
  scope,
  ...over,
});

describe("briefProblem（spec 5.2 のブリーフの検査）", () => {
  it("正しいブリーフ（dependsOn は省略可）は問題なし", () => {
    expect(briefProblem(ok())).toBeUndefined();
    expect(briefProblem(ok({ dependsOn: [] }))).toBeUndefined();
    expect(briefProblem(ok({ dependsOn: ["n1", "n2.a"] }))).toBeUndefined();
  });

  it.each([
    ["objective が空", ok({ objective: "" })],
    ["objective が空白だけ", ok({ objective: "  \n" })],
    ["objective が文字列でない", ok({ objective: 1 })],
    ["objective が長すぎる", ok({ objective: "あ".repeat(LIMITS.objective + 1) })],
    ["objective に制御文字", ok({ objective: "a\u0000b" })],
    ["acceptanceCriteria が空", ok({ acceptanceCriteria: [] })],
    ["acceptanceCriteria が配列でない", ok({ acceptanceCriteria: "x" })],
    ["acceptanceCriteria の要素が空", ok({ acceptanceCriteria: ["a", ""] })],
    [
      "acceptanceCriteria の要素が長すぎる",
      ok({ acceptanceCriteria: ["a".repeat(LIMITS.criterionLength + 1)] }),
    ],
    [
      "acceptanceCriteria が多すぎる",
      ok({
        acceptanceCriteria: Array.from({ length: LIMITS.criteriaCount + 1 }, (_, i) => `c${i}`),
      }),
    ],
    ["scope がない", ok({ scope: undefined })],
    ["scope が配列", ok({ scope: [] })],
    ["scope に未知のキー", ok({ scope: { ...scope, extra: [] } })],
    ["scope の一覧が欠けている", ok({ scope: { writableLocations: [], forbiddenLocations: [] } })],
    ["scope の要素が空文字", ok({ scope: { ...scope, writableLocations: [""] } })],
    ["scope の要素に NUL", ok({ scope: { ...scope, allowedCommands: ["a\u0000"] } })],
    [
      "scope の一覧が多すぎる",
      ok({
        scope: {
          ...scope,
          forbiddenLocations: Array.from(
            { length: LIMITS.scopeEntryCount + 1 },
            (_, i) => `/p${i}`,
          ),
        },
      }),
    ],
    ["acceptanceCriteria に重複", ok({ acceptanceCriteria: ["a", "b", "a"] })],
    ["writableLocations に .. を含む", ok({ scope: { ...scope, writableLocations: ["/w/../x"] } })],
    ["writableLocations が .. だけ", ok({ scope: { ...scope, writableLocations: [".."] } })],
    [
      "forbiddenLocations に .. を含む",
      ok({ scope: { ...scope, forbiddenLocations: ["a/../b"] } }),
    ],
    ["writableLocations が / だけ", ok({ scope: { ...scope, writableLocations: ["/"] } })],
    ["forbiddenLocations が / だけ", ok({ scope: { ...scope, forbiddenLocations: ["/"] } })],
    ["writableLocations に重複", ok({ scope: { ...scope, writableLocations: ["/w", "/w"] } })],
    ["forbiddenLocations に重複", ok({ scope: { ...scope, forbiddenLocations: ["/a", "/a"] } })],
    ["allowedCommands に重複", ok({ scope: { ...scope, allowedCommands: ["ls", "ls"] } })],
    ["dependsOn に不正な ID", ok({ dependsOn: ["a b"] })],
    ["dependsOn に重複", ok({ dependsOn: ["a", "a"] })],
    ["dependsOn が配列でない", ok({ dependsOn: "a" })],
    [
      "dependsOn が多すぎる",
      ok({ dependsOn: Array.from({ length: LIMITS.dependsOnCount + 1 }, (_, i) => `n${i}`) }),
    ],
  ])("%s は拒否する", (_name, brief) => {
    const problem = briefProblem(brief as never);
    expect(typeof problem).toBe("string");
    expect((problem as string).length).toBeGreaterThan(0);
  });

  it("..・/ を含まない通常の場所と、.. を名前に含むだけのものは受け入れる", () => {
    expect(
      briefProblem(
        ok({ scope: { ...scope, writableLocations: ["/w/a..b", "src/..hidden", "/w/..."] } }),
      ),
    ).toBeUndefined();
  });

  it("上限ちょうどは受け入れる", () => {
    expect(
      briefProblem(
        ok({
          objective: "あ".repeat(LIMITS.objective),
          acceptanceCriteria: Array.from({ length: LIMITS.criteriaCount }, (_, i) =>
            `${i}`.padEnd(LIMITS.criterionLength, "c"),
          ),
        }),
      ),
    ).toBeUndefined();
  });

  it("性質: 任意の入力でも例外を出さず、文字列か undefined を返す", () => {
    fc.assert(
      fc.property(fc.anything(), (x) => {
        const r = briefProblem(x as never);
        expect(r === undefined || typeof r === "string").toBe(true);
      }),
    );
  });

  it("Brief 型は spec 5.2 の形に合う", () => {
    const b: Brief = { objective: "o", acceptanceCriteria: ["a"], scope, dependsOn: ["n"] };
    expect(briefProblem(b)).toBeUndefined();
  });
});
