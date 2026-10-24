import { CONTRACT_ROLES, type DaemonOperation, ROLE_OPERATIONS } from "@cso/core";
import { describe, expect, it } from "vitest";
import { MCP_ROLES, type McpRole, operationForTool, toolName, toolsFor } from "../src/index.js";

const names = (role: McpRole) => toolsFor(role).map((t) => t.name);

// 公開一覧の固定（NFR_004）。ツールを増減したら、このテストを意図して更新する。
const EXPECTED: Record<McpRole, readonly string[]> = {
  integrator: [
    "node_spawn",
    "node_send",
    "node_stop",
    "node_confirmStopped",
    "node_hookUnbind",
    "node_bindCode",
    "inbox_fetch",
    "tree_list",
    "decision_present",
    "node_split",
    "scope_decide",
    "node_review",
    "node_reclaimPreview",
    "node_reclaim",
    "node_capabilities",
    "decision_get",
    "report_get",
  ],
  child: ["report_progress", "report_decision", "report_outOfScope", "report_done", "scope_extend"],
};

describe("ロール別のツール公開（NFR_004）", () => {
  it.each(MCP_ROLES)("%s の公開一覧が固定されている（CLI）", (role) => {
    expect(names(role)).toEqual(EXPECTED[role]);
  });

  it("node_bind はどのロールにも公開されない（紐付けは POST /v1/bind）", () => {
    for (const role of MCP_ROLES) {
      expect(names(role)).not.toContain("node_bind");
      expect(operationForTool(role, "node_bind").ok).toBe(false);
    }
  });

  it.each(["human", "constructor", "__proto__", "toString", "", "admin"])(
    "MCP のロールでない %j には何も公開しない",
    (role) => {
      expect(toolsFor(role as McpRole)).toEqual([]);
      const r = operationForTool(role as McpRole, "node_spawn");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("role_not_exposed");
    },
  );

  it("MCP で公開するのは統合と子だけで、人間用の操作は含まない", () => {
    expect([...MCP_ROLES]).toEqual(["integrator", "child"]);
    // 人間専用の操作（最終削除など）は、どのロールにも公開しない。人間と統合で共有する操作（scope.decide）は統合に公開してよい。
    const shared = new Set<DaemonOperation>(MCP_ROLES.flatMap((r) => ROLE_OPERATIONS[r]));
    const humanOnly = new Set<DaemonOperation>(ROLE_OPERATIONS.human.filter((o) => !shared.has(o)));
    expect(humanOnly.has("node.purge")).toBe(true);
    for (const role of MCP_ROLES) {
      for (const tool of toolsFor(role)) expect(humanOnly.has(tool.operation)).toBe(false);
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

  it("近い名前があれば、もしかして候補を次の操作に含める", () => {
    const r = operationForTool("integrator", "node_spwan");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.nextActions.join(" ")).toContain("node_spawn");
  });

  it("説明が、ブリーフと差し戻しの引数を示す", () => {
    const d = (n: string) => toolsFor("integrator").find((t) => t.name === n)?.description ?? "";
    for (const key of [
      "parentId",
      "role",
      "objective",
      "acceptanceCriteria",
      "scope",
      "dependsOn",
    ]) {
      expect(d("node_spawn"), key).toContain(key);
    }
    expect(d("node_spawn")).toContain("ブランチは指定しない");
    expect(d("node_split")).toContain("keep");
    expect(d("node_review")).toContain("feedback");
    expect(d("decision_present")).toContain("pauseNodeIds");
    expect(d("node_send")).toContain("queued");
    expect(d("node_send")).toContain("duplicate");
    expect(d("node_spawn")).toContain("waitingFor");
    expect(d("node_reclaimPreview")).toContain("blockers");
    expect(d("scope_decide")).toContain("子孫");
    expect(d("node_stop")).toContain("graceMs");
    expect(toolsFor("child").find((t) => t.name === "scope_extend")?.description).toContain("kind");
  });

  it("toolName は操作名の . を _ にする", () => {
    expect(toolName("node.review")).toBe("node_review");
  });

  it("ID を引数に取る操作の説明は、自分の ID が起動の指示の先頭にあることと、短縮しないことを書く（T10m-id）", () => {
    const d = (n: string) => toolsFor("integrator").find((t) => t.name === n)?.description ?? "";
    for (const name of ["node_spawn", "node_split", "decision_present"]) {
      expect(d(name), name).toContain("起動の指示");
      expect(d(name), name).toContain("tree_list");
      expect(d(name), name).toContain("短縮しない");
    }
    expect(d("tree_list")).toContain("self");
  });
});
