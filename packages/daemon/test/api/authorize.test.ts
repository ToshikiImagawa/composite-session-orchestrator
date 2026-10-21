import {
  type EventBody,
  foldEvents,
  INTEGRATOR_OPERATION_CLASS,
  type NodeEvent,
  type OrchEvent,
  type OrchState,
  ROLE_OPERATIONS,
  SUBTREE_RULES,
  SUBTREE_SCOPED_OPERATIONS,
} from "@cso/core";
import { describe, expect, it } from "vitest";
import {
  authorize,
  authorizeRole,
  authorizeScope,
  checkPrincipal,
} from "../../src/api/authorize.js";
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
    start("a"),
    created("m2", "integrator", "root"),
    start("m2"),
    created("b", "implement", "m2"),
    start("b"),
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
    ...(["xa:a", "xb:b", "xm1:m1"] as const).map((x) => {
      const [extensionId, nodeId] = x.split(":") as [string, string];
      return ev({
        type: "scope.extensionRequested",
        payload: { extensionId, nodeId, target: { kind: "write", value: "docs" }, reason: "r" },
      });
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

describe("読める範囲（部分木の規則）", () => {
  const nodeParams = (op: string, nodeId: string) =>
    op === "node.stop"
      ? { nodeId, mode: "graceful" }
      : op === "node.send"
        ? { nodeId, text: "x" }
        : op === "node.split"
          ? { nodeId, brief: "b", keep: "stop" }
          : op === "node.review"
            ? { nodeId, verdict: "accept" }
            : { nodeId };

  it("strictDescendant: 自分の子孫だけ。自分自身・祖先・兄弟の部分木・未知は forbidden（自分の停止は親か人間だけ）", () => {
    for (const op of [
      "node.send",
      "node.stop",
      "node.split",
      "node.reclaimPreview",
      "node.reclaim",
      "node.capabilities",
    ]) {
      expect(run(m1, op, nodeParams(op, "a")).ok, `${op} 子孫`).toBe(true);
      expect(code(run(m1, op, nodeParams(op, "m1"))), `${op} 自分`).toBe("forbidden");
      expect(code(run(m1, op, nodeParams(op, "b"))), `${op} 兄弟の部分木`).toBe("forbidden");
      expect(code(run(m1, op, nodeParams(op, "root"))), `${op} 祖先`).toBe("forbidden");
      expect(code(run(m1, op, nodeParams(op, "zzz"))), `${op} 未知`).toBe("forbidden");
      expect(run(root, op, nodeParams(op, "b")).ok, `${op} 根は全体の子孫`).toBe(true);
      expect(code(run(root, op, nodeParams(op, "root"))), `${op} 根の自分`).toBe("forbidden");
    }
  });

  it("directChild: node.review（完了の判定）は直接の親だけ", () => {
    expect(run(m1, "node.review", nodeParams("node.review", "a")).ok).toBe(true);
    expect(code(run(root, "node.review", nodeParams("node.review", "a")))).toBe("forbidden"); // 孫
    expect(run(root, "node.review", nodeParams("node.review", "m1")).ok).toBe(true);
    expect(code(run(m1, "node.review", nodeParams("node.review", "m1")))).toBe("forbidden");
    expect(code(run(m1, "node.review", nodeParams("node.review", "b")))).toBe("forbidden");
  });

  it("node.spawn の parentId は、自分か自分の子孫（selfOrDescendant）", () => {
    const spawn = (parentId: string) => ({ brief: "b", parentId });
    expect(run(m1, "node.spawn", spawn("m1")).ok).toBe(true);
    expect(run(m1, "node.spawn", spawn("a")).ok).toBe(true);
    expect(code(run(m1, "node.spawn", spawn("m2")))).toBe("forbidden");
    expect(code(run(m1, "node.spawn", spawn("root")))).toBe("forbidden");
    expect(code(run(m1, "node.spawn", spawn("zzz")))).toBe("forbidden");
  });

  it("decision.present の pauseNodeIds は、すべて厳密な子孫（1 つでも外れれば forbidden）", () => {
    const present = (pauseNodeIds?: string[]) => ({
      question: "q",
      options: ["A"],
      ...(pauseNodeIds === undefined ? {} : { pauseNodeIds }),
    });
    expect(run(m1, "decision.present", present()).ok).toBe(true);
    expect(run(m1, "decision.present", present([])).ok).toBe(true);
    expect(run(m1, "decision.present", present(["a"])).ok).toBe(true);
    expect(code(run(m1, "decision.present", present(["a", "b"])))).toBe("forbidden");
    expect(code(run(m1, "decision.present", present(["m1"])))).toBe("forbidden");
    expect(code(run(m1, "decision.present", present(["zzz"])))).toBe("forbidden");
  });

  it("scope.decide は、拡張の発生元のノードが自分の子孫（自分を含まない）のときだけ。範囲外と未知は区別しない（notFound）", () => {
    const decide = (extensionId: string) => ({ extensionId, decision: "approve" });
    expect(run(m1, "scope.decide", decide("xa")).ok).toBe(true); // a は m1 の子
    expect(run(root, "scope.decide", decide("xa")).ok).toBe(true);
    expect(run(root, "scope.decide", decide("xm1")).ok).toBe(true);
    expect(code(run(m1, "scope.decide", decide("xb")))).toBe("notFound"); // b は別の部分木
    expect(code(run(m1, "scope.decide", decide("xm1")))).toBe("notFound"); // 自分の拡張は判定できない
    expect(code(run(m1, "scope.decide", decide("nope")))).toBe("notFound");
  });

  it("scope.decide は、人間なら全ノードを対象にでき、子ロールは操作を持たない", () => {
    for (const x of ["xa", "xb", "xm1"]) {
      expect(run(human, "scope.decide", { extensionId: x, decision: "reject" }).ok).toBe(true);
    }
    expect(code(run(childA, "scope.decide", { extensionId: "xa", decision: "approve" }))).toBe(
      "forbidden",
    );
  });

  it("decision.get・report.get は、記録のノード（自分か子孫）で判定する。範囲外と未知は区別しない（notFound）", () => {
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

describe("主体の検査（checkPrincipal: トークンのロールとノードの状態）", () => {
  const withState = (extra: EventBody[] = []): OrchState => {
    const r = foldEvents([
      created("root", "integrator", null),
      start("root"),
      created("m1", "integrator", "root"),
      start("m1"),
      created("a", "implement", "m1"),
      start("a"),
      ...extra.map(ev),
    ]);
    if (!r.ok) throw new Error(r.error.code);
    return r.value;
  };
  const stateOf = (nodeId: string, ...events: NodeEvent[]) =>
    withState(events.map((event) => ({ type: "node.stateChanged", payload: { nodeId, event } })));

  it("人間は常に有効。ノードのトークンは、ノードが木にあり、ロールが NodeRecord.role と合うときだけ有効", () => {
    expect(checkPrincipal(human, withState()).ok).toBe(true);
    expect(checkPrincipal(m1, withState()).ok).toBe(true);
    expect(checkPrincipal(childA, withState()).ok).toBe(true);
    expect(code(checkPrincipal({ role: "integrator", nodeId: "ghost" }, withState()))).toBe(
      "unauthenticated",
    );
    // 子のトークンで統合ノードを名乗る・逆
    expect(code(checkPrincipal({ role: "child", nodeId: "m1" }, withState()))).toBe(
      "unauthenticated",
    );
    expect(code(checkPrincipal({ role: "integrator", nodeId: "a" }, withState()))).toBe(
      "unauthenticated",
    );
  });

  it("停止後（stopIncomplete・stopped）・回収可能・アーカイブのノードのトークンは無効。停止要求中（stopping）は有効", () => {
    const stopping = stateOf("a", { type: "stop", mode: "graceful" });
    expect(checkPrincipal(childA, stopping).ok).toBe(true);
    const incomplete = stateOf("a", { type: "stop", mode: "immediate" }, { type: "stopTimeout" });
    expect(code(checkPrincipal(childA, incomplete))).toBe("unauthenticated");
    const stopped = stateOf("a", { type: "stop", mode: "immediate" }, { type: "confirmStopped" });
    expect(code(checkPrincipal(childA, stopped))).toBe("unauthenticated");
    // 破棄の判断（node.discardDecided）を経て、回収可能になる。
    const change = (event: NodeEvent): EventBody => ({
      type: "node.stateChanged",
      payload: { nodeId: "a", event },
    });
    const reclaimable = withState([
      change({ type: "stop", mode: "immediate" }),
      change({ type: "confirmStopped" }),
      { type: "node.discardDecided", payload: { nodeId: "a" } },
      change({ type: "markReclaimable", discarded: true }),
    ]);
    expect(code(checkPrincipal(childA, reclaimable))).toBe("unauthenticated");
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

describe("判定の順序（ロール → 引数の検証 → 部分木）", () => {
  it("authorizeRole は引数を見ない。ロールのない操作は、引数が不正でも forbidden", () => {
    expect(code(authorizeRole(childA, "node.stop", {}))).toBe("forbidden");
    expect(authorizeRole(m1, "node.stop", {}).ok).toBe(true);
  });
  it("authorizeScope は検証済みの引数で、部分木だけを判定する", () => {
    expect(code(authorizeScope(m1, "node.stop", { nodeId: "b", mode: "graceful" }, S))).toBe(
      "forbidden",
    );
    expect(authorizeScope(m1, "node.stop", { nodeId: "a", mode: "graceful" }, S).ok).toBe(true);
  });
});

describe("操作表との整合", () => {
  it("統合ノードの操作は、分類（INTEGRATOR_OPERATION_CLASS）のとおりに判定される", () => {
    for (const op of ROLE_OPERATIONS.integrator) {
      const cls = INTEGRATOR_OPERATION_CLASS[op];
      const r = authorize(m1, op, {} as never, S, {});
      // decision.present は pauseNodeIds が任意（省略なら対象なし）
      if (cls === "callerFiltered" || op === "decision.present") expect(r.ok, op).toBe(true);
      else expect(r.ok, op).toBe(false);
    }
  });
  it("SUBTREE_SCOPED_OPERATIONS は SUBTREE_RULES のキー", () => {
    expect([...SUBTREE_SCOPED_OPERATIONS].sort()).toEqual(Object.keys(SUBTREE_RULES).sort());
  });
});
