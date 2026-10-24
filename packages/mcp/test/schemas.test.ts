import {
  briefProblem,
  isSafeId,
  LIMITS,
  MAX_GRACE_MS,
  pauseNodeIdsProblem,
  ROLE_OPERATIONS,
} from "@cso/core";
import { describe, expect, it } from "vitest";
import { validateParams } from "../../daemon/src/api/validate.js";
import { MCP_ROLES, parseToolInput, toolName } from "../src/index.js";

const brief = {
  objective: "目的",
  acceptanceCriteria: ["基準"],
  scope: { writableLocations: ["src"], forbiddenLocations: [], allowedCommands: ["pnpm test"] },
};

const VALID: Record<string, unknown> = {
  node_spawn: { parentId: "root", role: "integrator", ...brief },
  node_send: { nodeId: "n1", text: "追加指示" },
  node_stop: { nodeId: "n1", mode: "graceful", graceMs: 1000 },
  node_confirmStopped: { nodeId: "n1", note: "Desktop でアーカイブした" },
  node_hookUnbind: { nodeId: "n1" },
  node_bindCode: { nodeId: "n1" },
  inbox_fetch: { sinceSeq: 3, detail: "full", limit: 10, offset: 0, asOfSeq: 9 },
  tree_list: {},
  decision_present: { question: "どちら?", options: ["a", "b"], pauseNodeIds: ["n1"] },
  node_split: { nodeId: "n1", keep: "mainline", ...brief },
  scope_decide: { extensionId: "e1", decision: "approve" },
  node_review: { nodeId: "n1", verdict: "accept" },
  node_reclaimPreview: { nodeId: "n1" },
  node_reclaim: { nodeId: "n1" },
  node_capabilities: { nodeId: "n1" },
  decision_get: { decisionId: "d1" },
  report_get: { reportId: "r1" },
  report_progress: { text: "進捗" },
  report_decision: { question: "q", options: ["a"] },
  report_outOfScope: { text: "範囲外" },
  report_done: { evidence: [{ criterion: "基準", evidence: "根拠" }] },
  scope_extend: { target: { kind: "write", value: "docs" }, reason: "必要" },
};

const run = (role: "integrator" | "child", name: string, input: unknown) =>
  parseToolInput(role, name, input);

describe("ツール入力の検証（zod）", () => {
  it("公開されているすべてのツールに、受理される入力の例がある", () => {
    for (const role of MCP_ROLES) {
      for (const op of ROLE_OPERATIONS[role]) {
        const r = run(role, toolName(op), VALID[toolName(op)]);
        expect(r.ok, `${role}:${op}`).toBe(true);
        if (r.ok) expect(r.value.operation).toBe(op);
      }
    }
  });

  it("未知のキーは、どのツールでも拒否する（strict）", () => {
    for (const role of MCP_ROLES) {
      for (const op of ROLE_OPERATIONS[role]) {
        const input = { ...(VALID[toolName(op)] as object), extra: 1 };
        const r = run(role, toolName(op), input);
        expect(r.ok, `${role}:${op}`).toBe(false);
      }
    }
  });

  it.each([undefined, null, 1, "x", []])("オブジェクトでない入力 %j は拒否する", (input) => {
    expect(run("child", "report_progress", input).ok).toBe(false);
  });

  it("失敗は invalid_argument で、次の操作が 1 つ以上ある", () => {
    const r = run("child", "report_progress", { text: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("invalid_argument");
      expect(r.error.nextActions.length).toBeGreaterThan(0);
    }
  });

  it("公開されていないツール・ロールは、解決の失敗を返す", () => {
    const a = run("child", "node_spawn", VALID.node_spawn);
    expect(!a.ok && a.error.code).toBe("tool_not_exposed");
    const b = parseToolInput("human" as never, "decision_answer", {});
    expect(!b.ok && b.error.code).toBe("role_not_exposed");
  });

  describe("core の規則と揃える", () => {
    it("id は isSafeId と同じ判定", () => {
      for (const v of [
        "a",
        "a.b:c-d_e",
        "",
        "-a",
        "a b",
        "a/b",
        "x".repeat(128),
        "x".repeat(129),
      ]) {
        const r = run("integrator", "node_reclaim", { nodeId: v });
        expect(r.ok, v).toBe(isSafeId(v));
      }
    });

    it("text は LIMITS.reportText まで。制御文字は拒否", () => {
      const ok = run("child", "report_progress", { text: "x".repeat(LIMITS.reportText) });
      const long = run("child", "report_progress", { text: "x".repeat(LIMITS.reportText + 1) });
      const ctl = run("child", "report_progress", { text: "a\u0000b" });
      expect(ok.ok).toBe(true);
      expect(long.ok).toBe(false);
      expect(ctl.ok).toBe(false);
    });

    it("ブリーフは briefProblem と同じ判定（絶対パスも briefProblem に従う）", () => {
      const cases = [
        { ...brief, objective: "" },
        { ...brief, acceptanceCriteria: [] },
        { ...brief, scope: { ...brief.scope, writableLocations: ["../x"] } },
        { ...brief, scope: { ...brief.scope, writableLocations: ["a", "a"] } },
        { ...brief, dependsOn: ["bad id"] },
      ];
      for (const b of cases) {
        const r = run("integrator", "node_spawn", { parentId: "root", role: "child", ...b });
        expect(r.ok).toBe(briefProblem(b) === undefined);
      }
    });

    it("pauseNodeIds は pauseNodeIdsProblem と同じ判定", () => {
      for (const p of [[], ["a", "a"], ["bad id"], ["a"], Array(100).fill("x")]) {
        const r = run("integrator", "decision_present", {
          question: "q",
          options: ["a"],
          pauseNodeIds: p,
        });
        expect(r.ok).toBe(pauseNodeIdsProblem(p) === undefined);
      }
    });

    it("options は 1〜optionCount 件・重複なし・空文字なし", () => {
      const opts = (o: unknown) =>
        run("child", "report_decision", { question: "q", options: o }).ok;
      expect(opts([])).toBe(false);
      expect(opts(["a", "a"])).toBe(false);
      expect(opts([""])).toBe(false);
      expect(opts(Array.from({ length: LIMITS.optionCount + 1 }, (_, i) => `o${i}`))).toBe(false);
      expect(opts(["x".repeat(LIMITS.optionLength + 1)])).toBe(false);
    });
  });

  describe("node_stop", () => {
    const stop = (x: object) => run("integrator", "node_stop", { nodeId: "n1", ...x }).ok;
    it("graceMs は graceful のときだけ、1〜MAX_GRACE_MS の整数", () => {
      expect(stop({ mode: "graceful" })).toBe(true);
      expect(stop({ mode: "immediate" })).toBe(true);
      expect(stop({ mode: "immediate", graceMs: 1000 })).toBe(false);
      expect(stop({ mode: "graceful", graceMs: 0 })).toBe(false);
      expect(stop({ mode: "graceful", graceMs: 1.5 })).toBe(false);
      expect(stop({ mode: "graceful", graceMs: MAX_GRACE_MS })).toBe(true);
      expect(stop({ mode: "graceful", graceMs: MAX_GRACE_MS + 1 })).toBe(false);
      expect(stop({ mode: "other" })).toBe(false);
    });
  });

  describe("node_review", () => {
    const rev = (x: object) => run("integrator", "node_review", { nodeId: "n1", ...x }).ok;
    it("reject には空白でない feedback が必要。accept では任意", () => {
      expect(rev({ verdict: "reject" })).toBe(false);
      expect(rev({ verdict: "reject", feedback: "  " })).toBe(false);
      expect(rev({ verdict: "reject", feedback: "直す" })).toBe(true);
      expect(rev({ verdict: "accept", feedback: "良い" })).toBe(true);
      expect(rev({ verdict: "reject", feedback: "x".repeat(LIMITS.feedback + 1) })).toBe(false);
    });
  });

  describe("report_done / scope_extend", () => {
    it("evidence は空白だけを拒否し、件数に上限がある", () => {
      const done = (evidence: unknown) => run("child", "report_done", { evidence }).ok;
      expect(done([{ criterion: " ", evidence: "x" }])).toBe(false);
      expect(done([{ criterion: "c", evidence: "" }])).toBe(false);
      expect(done([{ criterion: "c", evidence: "e", extra: 1 }])).toBe(false);
      const many = Array.from({ length: LIMITS.evidenceCount + 1 }, () => ({
        criterion: "c",
        evidence: "e",
      }));
      expect(done(many)).toBe(false);
    });

    it("target と reason は空白だけを拒否し、kind は write か command", () => {
      const ext = (x: object) => run("child", "scope_extend", x).ok;
      const t = { kind: "write", value: "docs" };
      expect(ext({ target: { ...t, value: " " }, reason: "r" })).toBe(false);
      expect(ext({ target: t, reason: " " })).toBe(false);
      expect(ext({ target: { ...t, kind: "read" }, reason: "r" })).toBe(false);
      expect(
        ext({ target: { ...t, value: "x".repeat(LIMITS.extensionTarget + 1) }, reason: "r" }),
      ).toBe(false);
    });
  });

  describe("inbox_fetch", () => {
    const f = (x: unknown) => run("integrator", "inbox_fetch", x).ok;
    it("省略可。limit 1〜100、offset・sinceSeq・asOfSeq は 0 以上の整数、detail は brief か full", () => {
      expect(f({})).toBe(true);
      expect(f({ limit: 0 })).toBe(false);
      expect(f({ limit: 101 })).toBe(false);
      expect(f({ limit: 1.5 })).toBe(false);
      expect(f({ offset: -1 })).toBe(false);
      expect(f({ sinceSeq: -1 })).toBe(false);
      expect(f({ asOfSeq: 1.2 })).toBe(false);
      expect(f({ detail: "x" })).toBe(false);
    });
  });

  it("疎な配列など、検査中に例外になりうる入力でも例外を出さず invalid_argument を返す", () => {
    const sparse = new Array(3);
    const evil = new Proxy(
      {},
      {
        get() {
          throw new Error("boom");
        },
        ownKeys() {
          throw new Error("boom");
        },
      },
    );
    for (const input of [{ evidence: sparse }, { options: sparse, question: "q" }, evil]) {
      for (const [role, name] of [
        ["child", "report_done"],
        ["child", "report_decision"],
        ["child", "report_progress"],
      ] as const) {
        const r = run(role, name, input);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.code).toBe("invalid_argument");
      }
    }
  });

  it("cause は 300 文字程度に切り詰める", () => {
    const evidence = Array.from({ length: 5 }, () => ({ criterion: "", evidence: "" }));
    const r = run("child", "report_done", { evidence });
    expect(!r.ok && r.error.cause.length).toBeLessThanOrEqual(301);
  });

  it("inbox_fetch は daemon へ送る分（forward）と表示用（view）に分かれる", () => {
    const r = run("integrator", "inbox_fetch", VALID.inbox_fetch);
    expect(r.ok && r.value.forward).toEqual({ sinceSeq: 3 });
    expect(r.ok && r.value.view).toEqual({ detail: "full", limit: 10, offset: 0, asOfSeq: 9 });
    const e = run("integrator", "inbox_fetch", {});
    expect(e.ok && e.value.forward).toEqual({});
  });

  it("forward は daemon の validateParams を通る（全ツール）", () => {
    for (const role of MCP_ROLES) {
      for (const op of ROLE_OPERATIONS[role]) {
        const r = run(role, toolName(op), VALID[toolName(op)]);
        if (!r.ok) throw new Error("unreachable");
        expect(validateParams(op, r.value.forward).ok, op).toBe(true);
      }
    }
  });

  it("成功時の値は新しいオブジェクト（top レベルは入力と別物）", () => {
    const input = { text: "x" };
    const r = run("child", "report_progress", input);
    expect(r.ok && r.value.forward).toEqual(input);
    expect(r.ok && r.value.forward).not.toBe(input);
  });
});
