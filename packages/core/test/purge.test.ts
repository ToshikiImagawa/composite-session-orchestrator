import { describe, expect, it } from "vitest";
import {
  type EventBody,
  foldEvents,
  type OrchEvent,
  type OrchState,
  planPurge,
  purgeEventSeqs,
} from "../src/index.js";

let n = 0;
const ev = (body: EventBody, at = "2026-01-01T00:00:00Z"): OrchEvent =>
  ({ seq: ++n, at, requestId: `r${n}`, actor: { system: true }, ...body }) as OrchEvent;
const created = (
  nodeId: string,
  role: "integrator" | "implement",
  parentId: string | null,
  dependsOn: string[] = [],
) => ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn } });
const st = (nodeId: string, event: EventBody extends never ? never : object, at?: string) =>
  ev({ type: "node.stateChanged", payload: { nodeId, event } } as EventBody, at);
/** 動作中 → 完了 → 受理 → 回収可能 → アーカイブ。 */
const archive = (nodeId: string, at: string): OrchEvent[] => [
  st(nodeId, { type: "reportDone" }),
  st(nodeId, { type: "accept" }),
  st(nodeId, { type: "markReclaimable", discarded: false }),
  st(nodeId, { type: "archive" }, at),
];

const fold = (events: OrchEvent[]): OrchState => {
  const r = foldEvents(events);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
  return r.value;
};

/** root ─ t ─ c1・c2（すべてアーカイブ済み。t は 2026-01-10 に最後）、root ─ o（動作中）。 */
const base = (): OrchEvent[] => [
  created("root", "integrator", null),
  st("root", { type: "start" }),
  created("t", "integrator", "root"),
  st("t", { type: "start" }),
  created("c1", "implement", "t"),
  st("c1", { type: "start" }),
  created("c2", "implement", "t"),
  st("c2", { type: "start" }),
  ...archive("c1", "2026-01-05T00:00:00Z"),
  ...archive("c2", "2026-01-07T00:00:00Z"),
  ...archive("t", "2026-01-10T00:00:00Z"),
  created("o", "implement", "root"),
  st("o", { type: "start" }),
];

const NOW = Date.parse("2026-04-10T00:00:00Z"); // 2026-01-10 の 90 日後

describe("planPurge（最終削除の対象の木と事前確認）", () => {
  it("アーカイブ済みの木を、配下から先の順で返す。木全体のアーカイブ日は最後の日、経過日数はそこから", () => {
    const r = planPurge(fold(base()), "t", NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.nodeIds).toEqual(["c1", "c2", "t"]);
    expect(r.value.archivedAt).toBe("2026-01-10T00:00:00Z");
    expect(r.value.elapsedDays).toBe(90);
  });

  it("存在しないノードは notFound", () => {
    const r = planPurge(fold(base()), "zz", NOW);
    expect(r.ok === false && r.error.code).toBe("notFound");
  });

  it("木にアーカイブでないノードがあれば、notArchived（そのノードを名指す）", () => {
    const r = planPurge(fold(base()), "root", NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("notArchived");
      expect(r.error.cause).toContain("ノード o");
    }
  });

  it("親がアーカイブ済みなら、最上位の木ではない（親を指定する）", () => {
    const r = planPurge(fold(base()), "c1", NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("notTopOfTree");
      expect(r.error.cause).toContain("t");
    }
  });

  it("木の外のノードが、木のノードに依存していれば、dependedOn（依存する側を名指す）", () => {
    const events = [...base(), created("d", "implement", "root", ["c1"])];
    const r = planPurge(fold(events), "t", NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("dependedOn");
      expect(r.error.cause).toContain("d");
    }
  });

  it("木の中どうしの依存は妨げない", () => {
    const only = [
      created("root", "integrator", null),
      st("root", { type: "start" }),
      created("t2", "integrator", "root"),
      st("t2", { type: "start" }),
      created("a", "implement", "t2"),
      st("a", { type: "start" }),
      ...archive("a", "2026-01-01T00:00:00Z"),
      created("b", "implement", "t2", ["a"]),
      st("b", { type: "start" }),
      ...archive("b", "2026-01-02T00:00:00Z"),
      ...archive("t2", "2026-01-03T00:00:00Z"),
    ];
    const r = planPurge(fold(only), "t2", NOW);
    expect(r.ok && r.value.nodeIds).toEqual(["a", "b", "t2"]);
  });

  it("経過日数は、アーカイブ日より前の now でも 0 以上", () => {
    const r = planPurge(fold(base()), "t", Date.parse("2025-01-01T00:00:00Z"));
    expect(r.ok && r.value.elapsedDays).toBe(0);
  });
});

describe("purgeEventSeqs（木のノードを主語とするイベントの seq）", () => {
  it("直接の主語と、間接の主語（拡張の判定・受信箱の解決・配送の記録・判断への回答）を含め、外のイベントは残す", () => {
    n = 0;
    const events: OrchEvent[] = [
      created("root", "integrator", null),
      st("root", { type: "start" }),
      created("a", "implement", "root"),
      st("a", { type: "start" }),
      created("b", "implement", "root"),
      st("b", { type: "start" }),
    ];
    const add = (body: EventBody): number => {
      const e = ev(body);
      events.push(e);
      return e.seq;
    };
    const mine: number[] = [];
    mine.push(
      add({
        type: "scope.violation",
        payload: { nodeId: "a", reason: "outsideWritable", subject: "/x" },
      }),
    );
    mine.push(add({ type: "node.toolDenied", payload: { nodeId: "a", tool: "T" } }));
    mine.push(add({ type: "node.exited", payload: { nodeId: "a", reason: "x" } }));
    mine.push(
      add({
        type: "report.added",
        payload: { reportId: "ra", nodeId: "a", kind: "progress", text: "t" },
      }),
    );
    mine.push(
      add({ type: "inbox.added", payload: { id: "ia", kind: "progress", nodeId: "a", ref: "ra" } }),
    );
    mine.push(add({ type: "inbox.resolved", payload: { itemId: "ia" } }));
    mine.push(
      add({
        type: "decision.requested",
        payload: { decisionId: "da", nodeId: "a", question: "q" },
      }),
    );
    mine.push(add({ type: "decision.answered", payload: { decisionId: "da", answer: "x" } }));
    mine.push(
      add({
        type: "scope.extensionRequested",
        payload: {
          extensionId: "xa",
          nodeId: "a",
          target: { kind: "write", value: "src" },
          reason: "r",
        },
      }),
    );
    mine.push(
      add({ type: "scope.extensionDecided", payload: { extensionId: "xa", decision: "reject" } }),
    );
    const instructed = add({ type: "node.instructed", payload: { nodeId: "a", text: "go" } });
    mine.push(instructed);
    mine.push(add({ type: "node.instructionDelivered", payload: { instructedSeq: instructed } }));
    mine.push(add({ type: "node.discardDecided", payload: { nodeId: "a" } }));
    const theirs: number[] = [];
    theirs.push(
      add({
        type: "report.added",
        payload: { reportId: "rb", nodeId: "b", kind: "progress", text: "t" },
      }),
    );
    theirs.push(
      add({ type: "inbox.added", payload: { id: "ib", kind: "progress", nodeId: "b", ref: "rb" } }),
    );
    theirs.push(add({ type: "inbox.resolved", payload: { itemId: "ib" } }));
    const nodeSeqs = events
      .filter(
        (e) =>
          "payload" in e &&
          (e.payload as { nodeId?: string }).nodeId === "a" &&
          (e.type === "node.created" || e.type === "node.stateChanged"),
      )
      .map((e) => e.seq);
    const got = purgeEventSeqs(events, new Set(["a"]));
    expect([...got].sort((x, y) => x - y)).toEqual([...nodeSeqs, ...mine].sort((x, y) => x - y));
    for (const s of theirs) expect(got).not.toContain(s);
  });
});
