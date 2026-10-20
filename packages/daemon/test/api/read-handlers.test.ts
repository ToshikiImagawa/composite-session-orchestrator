import { type EventBody, foldEvents, type OrchEvent } from "@cso/core";
import { describe, expect, it } from "vitest";
import { createReadHandlers } from "../../src/api/read-handlers.js";

let n = 0;
const ev = (body: EventBody, actor: OrchEvent["actor"] = { system: true }): OrchEvent =>
  ({ seq: ++n, at: "2026-10-20T00:00:00Z", requestId: `r${n}`, actor, ...body }) as OrchEvent;
const state = () => {
  const r = foldEvents([
    ev({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    }),
    ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
    ev({
      type: "node.created",
      payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
    }),
    ev({
      type: "decision.requested",
      payload: { decisionId: "d1", nodeId: "a", question: "どちら？", options: ["A", "B"] },
    }),
    ev({ type: "decision.requested", payload: { decisionId: "d2", nodeId: "a" } }),
    ev({ type: "decision.answered", payload: { decisionId: "d1", answer: "A" } }, { human: true }),
    ev({
      type: "report.added",
      payload: {
        reportId: "r1",
        nodeId: "a",
        kind: "done",
        text: "完了",
        evidence: [{ criterion: "テスト", evidence: "通過" }],
      },
    }),
    ev({
      type: "report.added",
      payload: { reportId: "r2", nodeId: "a", kind: "progress", text: "半分" },
    }),
  ]);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};
const req = (operation: string, params: unknown) =>
  ({ requestId: "q", operation, role: "integrator", caller: { nodeId: "root" }, params }) as never;

describe("読み取りの操作（decision.get・report.get）", () => {
  const h = createReadHandlers(state);

  it("判断要求の内容（問い・選択肢・状態・回答）を返す", async () => {
    const r = await h["decision.get"](req("decision.get", { decisionId: "d1" }));
    expect(r).toEqual({
      ok: true,
      value: {
        decisionId: "d1",
        nodeId: "a",
        status: "answered",
        question: "どちら？",
        options: ["A", "B"],
        answer: "A",
      },
    });
  });

  it("内容が記録されていない判断要求は、問い・選択肢を省略して返す", async () => {
    const r = await h["decision.get"](req("decision.get", { decisionId: "d2" }));
    expect(r).toEqual({ ok: true, value: { decisionId: "d2", nodeId: "a", status: "open" } });
  });

  it("報告の本文（完了報告は根拠つき）を返す", async () => {
    const done = await h["report.get"](req("report.get", { reportId: "r1" }));
    expect(done).toEqual({
      ok: true,
      value: {
        reportId: "r1",
        nodeId: "a",
        kind: "done",
        text: "完了",
        evidence: [{ criterion: "テスト", evidence: "通過" }],
      },
    });
    const prog = await h["report.get"](req("report.get", { reportId: "r2" }));
    expect(prog).toEqual({
      ok: true,
      value: { reportId: "r2", nodeId: "a", kind: "progress", text: "半分" },
    });
  });

  it("未知の ID は notFound", async () => {
    const d = await h["decision.get"](req("decision.get", { decisionId: "zz" }));
    const r = await h["report.get"](req("report.get", { reportId: "zz" }));
    expect(d.ok ? null : d.error.code).toBe("notFound");
    expect(r.ok ? null : r.error.code).toBe("notFound");
  });
});
