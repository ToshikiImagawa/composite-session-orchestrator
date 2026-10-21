import { describe, expect, it } from "vitest";
import { type EventBody, foldEvents, type OrchEvent, visibleState } from "../src/index.js";

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
const full = () => {
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
    ev({ type: "inbox.added", payload: { id: "ia", kind: "progress", nodeId: "a", ref: "ra" } }),
    ev({ type: "inbox.added", payload: { id: "ib", kind: "progress", nodeId: "b", ref: "rb" } }),
    ev({
      type: "scope.violation",
      payload: { nodeId: "b", reason: "outsideWritable", subject: "/x" },
    }),
    ev({ type: "node.toolDenied", payload: { nodeId: "b", tool: "WebFetch" } }),
    ev({ type: "node.exited", payload: { nodeId: "b", reason: "x" } }),
    ev({
      type: "scope.extensionRequested",
      payload: { extensionId: "xa", nodeId: "a", target: "/t", reason: "r" },
    }),
    ev({
      type: "scope.extensionRequested",
      payload: { extensionId: "xb", nodeId: "b", target: "/t", reason: "r" },
    }),
  ]);
  if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  return r.value;
};

describe("visibleState（呼び出した統合ノードが読める状態＝自分の部分木）", () => {
  it("部分木のノードと、その記録（受信箱・判断・報告・違反・拒否・終了）だけを残す", () => {
    const v = visibleState(full(), "m1");
    expect(v.nodes.map((x) => x.id)).toEqual(["m1", "a"]);
    expect(v.inbox.map((x) => x.id)).toEqual(["ia"]);
    expect(v.decisions.map((x) => x.decisionId)).toEqual(["da"]);
    expect(v.reports.map((x) => x.reportId)).toEqual(["ra"]);
    expect(v.extensions.map((x) => x.extensionId)).toEqual(["xa"]);
    expect(v.violations).toEqual([]);
    expect(v.toolDenials).toEqual([]);
    expect(v.exits).toEqual([]);
  });

  it("根は全体を読める。別の部分木の記録は見えない", () => {
    const all = full();
    const root = visibleState(all, "root");
    expect(root.nodes).toHaveLength(all.nodes.length);
    expect(root.inbox).toHaveLength(all.inbox.length);
    const m2 = visibleState(all, "m2");
    expect(m2.violations).toHaveLength(1);
    expect(m2.reports.map((x) => x.reportId)).toEqual(["rb"]);
  });

  it("要求識別子の索引は空にし（他の部分木の要求を漏らさない）、元の状態を変更しない", () => {
    const all = full();
    const before = JSON.stringify(all);
    expect(visibleState(all, "m1").requests).toEqual({});
    expect(JSON.stringify(all)).toBe(before);
  });

  it("木にいない呼び出し元・壊れた入力は、空の状態（フェイルクローズ）", () => {
    const empty = visibleState(full(), "ghost");
    expect(empty.nodes).toEqual([]);
    expect(empty.inbox).toEqual([]);
    expect(visibleState(full(), 5 as never).nodes).toEqual([]);
    expect(visibleState(null as never, "m1").nodes).toEqual([]);
  });
});
