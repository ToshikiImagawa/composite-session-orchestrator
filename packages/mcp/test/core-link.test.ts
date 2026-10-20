import { foldEvents, NODE_STATES } from "@cso/core";
import { describe, expect, it } from "vitest";

describe("@cso/core への依存", () => {
  it("workspace の core を参照できる（A-001: 依存方向は core へ）", () => {
    expect(NODE_STATES).toContain("pending");
    expect(foldEvents([]).ok).toBe(true);
  });
});
