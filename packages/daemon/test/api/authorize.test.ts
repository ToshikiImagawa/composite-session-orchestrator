import {
  type EventBody,
  foldEvents,
  type OrchEvent,
  type OrchState,
  ROLE_OPERATIONS,
  SUBTREE_SCOPED_OPERATIONS,
} from "@cso/core";
import { describe, expect, it } from "vitest";
import { authorize } from "../../src/api/authorize.js";
import type { Principal } from "../../src/api/credentials.js";

let n = 0;
const ev = (body: EventBody): OrchEvent =>
  ({
    seq: ++n,
    at: "2026-10-20T00:00:00Z",
    requestId: `r${n}`,
    actor: { system: true },
    ...body,
  }) as OrchEvent;
const created = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
  ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
const start = (nodeId: string) =>
  ev({ type: "node.stateChanged", payload: { nodeId, event: { type: "start" } } });

/** root ─ m1 ─ a / root ─ m2 ─ b */
const state = (): OrchState => {
  const r = foldEvents([
    created("root", "integrator", null),
    start("root"),
    created("m1", "integrator", "root"),
    start("m1"),
    created("a", "implement", "m1"),
    created("m2", "integrator", "root"),
    start("m2"),
    created("b", "implement", "m2"),
    ev({ type: "decision.requested", payload: { decisionId: "da", nodeId: "a", question: "q" } }),
    ev({ type: "decision.requested", payload: { decisionId: "db", nodeId: "b", question: "q" } }),
    ev({
      type: "report.added",
      payload: { reportId: "ra", nodeId: "a", kind: "progress", text: "t" },
    }),
    ev({
      type: "report.added",
      payload: { reportId: "rb", nodeId: "b", kind: "progress", text: "t" },
    }),
  ]);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};
const S = state();

const m1: Principal = { role: "integrator", nodeId: "m1" };
const root: Principal = { role: "integrator", nodeId: "root" };
const childA: Principal = { role: "child", nodeId: "a" };
const human: Principal = { role: "human" };
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? null : r.error?.code);
const run = (p: Principal, op: string, params: unknown, claimed = {}) =>
  authorize(p, op as never, params as never, S, claimed);

describe("ロールごとの操作（ROLE_OPERATIONS）", () => {
  it("ロールが持たない操作は forbidden（child は spawn・stop・purge ができない。人間以外は purge ができない）", () => {
    expect(code(run(childA, "node.spawn", { brief: "x", parentId: "a" }))).toBe("forbidden");
    expect(code(run(childA, "node.stop", { nodeId: "a", mode: "immediate" }))).toBe("forbidden");
    expect(code(run(m1, "node.purge", { nodeId: "root" }))).toBe("forbidden");
    expect(code(run(m1, "decision.answer", { decisionId: "da", choice: "A" }))).toBe("forbidden");
    expect(code(run(human, "node.send", { nodeId: "a", text: "x" }))).toBe("forbidden");
    expect(code(run(human, "report.progress", { text: "x" }))).toBe("forbidden");
  });

  it("ロールが持つ操作は許可する（引数に対象ノードがないもの）", () => {
    expect(run(childA, "report.progress", { text: "x" }).ok).toBe(true);
    expect(run(m1, "inbox.fetch", {}).ok).toBe(true);
    expect(run(m1, "tree.list", {}).ok).toBe(true);
    expect(run(human, "node.purge", { nodeId: "root" }).ok).toBe(true);
    expect(run(human, "node.purgePreview", { nodeId: "root" }).ok).toBe(true);
    expect(run(human, "decision.answer", { decisionId: "da", choice: "A" }).ok).toBe(true);
  });
});

describe("読める範囲（自分の部分木のみ）", () => {
  it("統合ノードは、自分の部分木のノードを指す操作だけ許可する", () => {
    for (const op of SUBTREE_SCOPED_OPERATIONS) {
      if (op === "decision.get" || op === "report.get") continue;
      const p = (nodeId: string) =>
        op === "node.stop"
          ? { nodeId, mode: "graceful" }
          : op === "node.send"
            ? { nodeId, text: "x" }
            : op === "node.split"
              ? { nodeId, brief: "b", keep: "stop" }
              : op === "node.review"
                ? { nodeId, verdict: "accept" }
                : { nodeId };
      expect(run(m1, op, p("a")).ok, `${op} 子孫`).toBe(true);
      expect(run(m1, op, p("m1")).ok, `${op} 自分`).toBe(true);
      expect(code(run(m1, op, p("b"))), `${op} 兄弟の部分木`).toBe("forbidden");
      expect(code(run(m1, op, p("root"))), `${op} 祖先`).toBe("forbidden");
      expect(code(run(m1, op, p("zzz"))), `${op} 未知`).toBe("forbidden");
      expect(run(root, op, p("b")).ok, `${op} 根は全体`).toBe(true);
    }
  });

  it("decision.get・report.get は、記録のノードで判定する。範囲外と未知は区別しない（notFound）", () => {
    expect(run(m1, "decision.get", { decisionId: "da" }).ok).toBe(true);
    expect(run(m1, "report.get", { reportId: "ra" }).ok).toBe(true);
    expect(code(run(m1, "decision.get", { decisionId: "db" }))).toBe("notFound");
    expect(code(run(m1, "report.get", { reportId: "rb" }))).toBe("notFound");
    expect(code(run(m1, "decision.get", { decisionId: "nope" }))).toBe("notFound");
    expect(code(run(m1, "report.get", { reportId: "nope" }))).toBe("notFound");
    expect(run(root, "decision.get", { decisionId: "db" }).ok).toBe(true);
  });

  it("木にいないノードのトークンは、どの操作も forbidden（フェイルクローズ）", () => {
    const ghost: Principal = { role: "integrator", nodeId: "ghost" };
    expect(code(run(ghost, "inbox.fetch", {}))).toBe("forbidden");
    expect(code(run(ghost, "node.send", { nodeId: "a", text: "x" }))).toBe("forbidden");
    expect(code(run({ role: "child", nodeId: "ghost" }, "report.progress", { text: "x" }))).toBe(
      "forbidden",
    );
  });
});

describe("申告の検査（ロール・caller は認証で決める）", () => {
  it("申告が認証したロール・ノードと食い違えば forbidden。一致する・省略は許可", () => {
    expect(code(run(childA, "report.progress", { text: "x" }, { claimedRole: "integrator" }))).toBe(
      "forbidden",
    );
    expect(code(run(m1, "tree.list", {}, { claimedRole: "human" }))).toBe("forbidden");
    expect(code(run(m1, "tree.list", {}, { claimedCaller: "root" }))).toBe("forbidden");
    expect(
      code(run(human, "node.purgePreview", { nodeId: "root" }, { claimedCaller: "root" })),
    ).toBe("forbidden");
    expect(run(m1, "tree.list", {}, { claimedRole: "integrator", claimedCaller: "m1" }).ok).toBe(
      true,
    );
    expect(run(human, "node.purgePreview", { nodeId: "root" }, { claimedRole: "human" }).ok).toBe(
      true,
    );
  });
});

describe("操作表との整合", () => {
  it("統合ノードの操作は、部分木の対象を持つものを除き、引数なしの判定だけで通る", () => {
    const scoped = new Set<string>(SUBTREE_SCOPED_OPERATIONS);
    for (const op of ROLE_OPERATIONS.integrator) {
      if (scoped.has(op)) continue;
      expect(authorize(m1, op, {} as never, S, {}).ok, op).toBe(true);
    }
  });
});
