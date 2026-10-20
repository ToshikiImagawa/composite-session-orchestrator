import { describe, expect, it } from "vitest";
import { err, type Failure, isErr, isOk, mapResult, ok, type Result } from "../src/index.js";

describe("Result（NFR_010）", () => {
  it("ok は値を持つ", () => {
    const r: Result<number> = ok(1);
    expect(isOk(r)).toBe(true);
    expect(r).toEqual({ ok: true, value: 1 });
  });

  it("err は原因と次の操作を必ず持つ", () => {
    const f: Failure = {
      code: "not_found",
      cause: "ノード n1 がない",
      nextActions: ["一覧を取得する"],
    };
    const r: Result<number> = err(f);
    expect(isErr(r)).toBe(true);
    expect(r).toEqual({ ok: false, error: f });
  });

  it("mapResult は成功のみ変換し、失敗はそのまま返す", () => {
    expect(mapResult(ok(1), (n) => n + 1)).toEqual(ok(2));
    const e = err({ code: "x", cause: "c", nextActions: ["a"] });
    expect(mapResult(e, (n: number) => n + 1)).toBe(e);
  });
});
