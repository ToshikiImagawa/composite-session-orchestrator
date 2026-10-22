import { describe, expect, expectTypeOf, it } from "vitest";
import {
  type DaemonRequest,
  INTEGRATOR_OPERATION_CLASS,
  LIMITS,
  type NodeLoss,
  ROLE_OPERATIONS,
} from "../src/index.js";

describe("回収の事前確認の loss（T21r）", () => {
  it("人間のロールも node.reclaimPreview を持つ（統合ノードと共通。読み取りだけ）。破棄の指示と最終削除は、人間だけのまま", () => {
    expect(ROLE_OPERATIONS.human).toContain("node.reclaimPreview");
    expect(ROLE_OPERATIONS.integrator).toContain("node.reclaimPreview");
    expect(ROLE_OPERATIONS.child).not.toContain("node.reclaimPreview");
    expect(ROLE_OPERATIONS.integrator).not.toContain("node.reclaimInstruct");
    expect(ROLE_OPERATIONS.integrator).not.toContain("node.purge");
    expect(INTEGRATOR_OPERATION_CLASS["node.reclaimPreview"]).toBe("subtree");
  });

  it("人間の node.reclaimPreview の要求は、ノードの識別子だけを持つ", () => {
    const req: DaemonRequest<"human"> = {
      requestId: "r1",
      role: "human",
      operation: "node.reclaimPreview",
      params: { nodeId: "n" },
    };
    expect(req.operation).toBe("node.reclaimPreview");
  });

  it("NodeLoss は、件名を untrustedSubjects（信頼できない入力）として持つ。aheadCommits は任意（不明なら省略）", () => {
    expectTypeOf<NodeLoss>().toEqualTypeOf<{
      readonly nodeId: string;
      readonly aheadCommits?: number;
      readonly untrustedSubjects: readonly string[];
      readonly uncommitted: boolean;
      readonly untracked: number;
    }>();
  });

  it("件名の件数・長さの上限がある", () => {
    expect(LIMITS.lossSubjects).toBe(5);
    expect(LIMITS.lossSubjectLength).toBe(100);
  });
});
