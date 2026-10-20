import { CONTRACT_ROLES, type DaemonOperation, ROLE_OPERATIONS } from "@cso/core";
import { describe, expect, it } from "vitest";
import { MCP_ROLES, type McpRole, operationForTool, toolsFor } from "../src/index.js";

const names = (role: McpRole) => toolsFor(role).map((t) => t.name);

// 公開一覧の固定（NFR_004）。ツールを増減したら、このテストを意図して更新する。
const EXPECTED: Record<McpRole, readonly string[]> = {
  integrator: [
    "node_spawn",
    "node_send",
    "node_stop",
    "inbox_fetch",
    "tree_list",
    "decision_present",
    "node_split",
    "scope_decide",
    "node_review",
    "node_reclaimPreview",
    "node_reclaim",
    "node_capabilities",
  ],
  child: [
    "report_progress",
    "report_decision",
    "report_outOfScope",
    "report_done",
    "scope_extend",
    "node_bind",
  ],
};

describe("ロール別のツール公開（NFR_004）", () => {
  it.each(MCP_ROLES)("%s の公開一覧が固定されている", (role) => {
    expect(names(role)).toEqual(EXPECTED[role]);
  });

  it("MCP で公開するのは統合と子だけで、人間用の操作は含まない", () => {
    expect([...MCP_ROLES]).toEqual(["integrator", "child"]);
    const human = new Set<DaemonOperation>(ROLE_OPERATIONS.human);
    for (const role of MCP_ROLES) {
      for (const tool of toolsFor(role)) expect(human.has(tool.operation)).toBe(false);
    }
  });

  it("child には子の生成・停止・人間宛ての連絡・最終削除が公開されない", () => {
    const forbidden = [
      "node_spawn",
      "node_stop",
      "node_send",
      "node_split",
      "decision_present",
      "node_reclaim",
      "node_purge",
    ];
    for (const n of forbidden) expect(names("child")).not.toContain(n);
  });

  it("最終削除（node.purge）はどのロールにも公開されない（DC_003）", () => {
    for (const role of MCP_ROLES) {
      expect(toolsFor(role).some((t) => t.operation === "node.purge")).toBe(false);
    }
  });

  it("情報源は core の ROLE_OPERATIONS（操作の並びが一致する）", () => {
    for (const role of MCP_ROLES) {
      expect(toolsFor(role).map((t) => t.operation)).toEqual([...ROLE_OPERATIONS[role]]);
    }
    expect(CONTRACT_ROLES).toContain("human");
  });

  it("ツール名は重複せず、説明がある", () => {
    const all = MCP_ROLES.flatMap((r) => toolsFor(r));
    expect(new Set(all.map((t) => t.name)).size).toBe(all.length);
    for (const t of all) expect(t.description.length).toBeGreaterThan(0);
  });
});

describe("operationForTool", () => {
  it("公開されたツール名を操作へ解決する", () => {
    expect(operationForTool("integrator", "node_spawn")).toEqual({
      ok: true,
      value: "node.spawn",
    });
  });

  it("そのロールに公開されていないツールは、原因と次の操作つきの失敗にする（NFR_010）", () => {
    const r = operationForTool("child", "node_spawn");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("tool_not_exposed");
      expect(r.error.cause).toContain("node_spawn");
      expect(r.error.nextActions.length).toBeGreaterThan(0);
    }
  });

  it("存在しないツール名も失敗にする", () => {
    const r = operationForTool("integrator", "node_purge");
    expect(r.ok).toBe(false);
  });
});
