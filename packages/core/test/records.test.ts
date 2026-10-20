import { describe, expect, it } from "vitest";
import {
  applyEvent,
  type EventBody,
  foldEvents,
  INBOX_SUMMARY_MAX,
  initialState,
  type NodeEvent,
  type OrchEvent,
  type OrchState,
  REPORT_KINDS,
} from "../src/index.js";

const SYS = { system: true } as const;
let counter = 1000;
const ev = (
  body: EventBody,
  over: Partial<Pick<OrchEvent, "seq" | "requestId" | "actor">> = {},
): OrchEvent => {
  counter += 1;
  return {
    seq: over.seq ?? counter,
    at: "2026-10-20T00:00:00Z",
    requestId: over.requestId ?? `req-${counter}`,
    actor: over.actor ?? SYS,
    ...body,
  } as OrchEvent;
};
const created = (
  n: number,
  nodeId: string,
  role: "integrator" | "implement",
  parentId: string | null,
) =>
  ev(
    { type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } },
    { seq: n, requestId: `base-${n}` },
  );
const changed = (n: number, nodeId: string, event: NodeEvent) =>
  ev({ type: "node.stateChanged", payload: { nodeId, event } }, { seq: n, requestId: `base-${n}` });
const must = (r: ReturnType<typeof foldEvents>): OrchState => {
  if (!r.ok) throw new Error(`fold failed: ${r.error.code} ${r.error.cause}`);
  return r.value;
};
const base = (): OrchEvent[] => [
  created(1, "root", "integrator", null),
  changed(2, "root", { type: "start" }),
  created(3, "a", "implement", "root"),
  changed(4, "a", { type: "start" }),
];
const code = (r: ReturnType<typeof foldEvents>) => (r.ok ? null : r.error.code);

describe("記録専用イベント node.toolDenied・node.exited（T10c。状態は変えない）", () => {
  it("初期状態は空", () => {
    expect(initialState().toolDenials).toEqual([]);
    expect(initialState().exits).toEqual([]);
    expect(initialState().reports).toEqual([]);
  });

  it("node.toolDenied は、ノード・ツール名・seq・at・発行者を記録し、ノードの状態を変えない", () => {
    const b = base();
    const before = must(foldEvents(b));
    const e = ev({ type: "node.toolDenied", payload: { nodeId: "a", tool: "WebFetch" } });
    const s = must(foldEvents([...b, e]));
    expect(s.toolDenials).toEqual([
      { seq: e.seq, at: e.at, nodeId: "a", tool: "WebFetch", actor: SYS },
    ]);
    expect(s.nodes.map((n) => n.state)).toEqual(before.nodes.map((n) => n.state));
    expect(s.inbox).toEqual([]); // 受信箱には載せない
    expect(s.violations).toEqual([]); // 範囲違反ではない
  });

  it("node.exited は、ノード・理由を記録し、状態は変えない（状態の扱いは daemon が別イベントで決める）", () => {
    const b = base();
    const e = ev({ type: "node.exited", payload: { nodeId: "a", reason: "子が異常終了した" } });
    const s = must(foldEvents([...b, e]));
    expect(s.exits).toEqual([
      { seq: e.seq, at: e.at, nodeId: "a", reason: "子が異常終了した", actor: SYS },
    ]);
    expect(s.nodes.find((n) => n.id === "a")?.state).toBe("running");
  });

  it("不正な payload・未知のノードは拒否する", () => {
    for (const payload of [
      {},
      { nodeId: "a" },
      { nodeId: "a", tool: "" },
      { nodeId: "a", tool: 5 },
    ]) {
      const r = foldEvents([...base(), ev({ type: "node.toolDenied", payload } as never)]);
      expect(code(r), JSON.stringify(payload)).toBe("invalidPayload");
    }
    for (const payload of [
      {},
      { nodeId: "a" },
      { nodeId: "a", reason: 5 },
      { nodeId: "", reason: "x" },
    ]) {
      const r = foldEvents([...base(), ev({ type: "node.exited", payload } as never)]);
      expect(code(r), JSON.stringify(payload)).toBe("invalidPayload");
    }
    expect(
      code(
        foldEvents([
          ...base(),
          ev({ type: "node.toolDenied", payload: { nodeId: "zz", tool: "X" } }),
        ]),
      ),
    ).toBe("unknownNode");
    expect(
      code(
        foldEvents([
          ...base(),
          ev({ type: "node.exited", payload: { nodeId: "zz", reason: "x" } }),
        ]),
      ),
    ).toBe("unknownNode");
  });

  it("同じ requestId・同一内容は冪等で無視される", () => {
    const b = base();
    const e = ev({ type: "node.toolDenied", payload: { nodeId: "a", tool: "Task" } });
    const s = must(foldEvents([...b, e]));
    const again = applyEvent(s, { ...e, seq: e.seq + 1 });
    expect(again.ok && again.value.applied).toBe(false);
  });

  it("古いスナップショット（新しい配列が無い）からも畳み込める", () => {
    const { toolDenials: _a, exits: _b, reports: _c, ...old } = must(foldEvents(base()));
    const r = foldEvents(
      [ev({ type: "node.toolDenied", payload: { nodeId: "a", tool: "Task" } })],
      old as unknown as OrchState,
    );
    expect(r.ok && r.value.toolDenials).toHaveLength(1);
  });

  it("壊れた配列は invalidState", () => {
    const good = must(foldEvents(base()));
    for (const key of ["toolDenials", "exits", "reports"]) {
      for (const junk of [5, {}, [null], [5]]) {
        const r = foldEvents(
          [
            ev({
              type: "node.stateChanged",
              payload: { nodeId: "a", event: { type: "stopTimeout" } },
            }),
          ],
          {
            ...good,
            [key]: junk,
          } as unknown as OrchState,
        );
        expect(code(r), `${key}=${JSON.stringify(junk)}`).toBe("invalidState");
      }
    }
  });
});

describe("受信箱の中身（summary・ref）", () => {
  it("inbox.added は任意の summary（短い要約）・ref（参照 ID）を持ち、InboxItem に載る", () => {
    const e = ev({
      type: "inbox.added",
      payload: { id: "i1", kind: "decision", nodeId: "a", summary: "DB はどれにする？", ref: "d1" },
    });
    const s = must(foldEvents([...base(), e]));
    expect(s.inbox[0]).toMatchObject({ id: "i1", summary: "DB はどれにする？", ref: "d1" });
  });

  it("summary・ref を省略した項目は、これまでと同じ形（後方互換）", () => {
    const e = ev({ type: "inbox.added", payload: { id: "i1", kind: "info", nodeId: "a" } });
    const s = must(foldEvents([...base(), e]));
    expect(s.inbox[0]).toEqual({
      seq: e.seq,
      id: "i1",
      kind: "info",
      nodeId: "a",
      dependsOn: [],
      at: e.at,
    });
    expect("summary" in (s.inbox[0] ?? {})).toBe(false);
  });

  it("summary は上限（INBOX_SUMMARY_MAX）以下の文字列、ref は空でない文字列", () => {
    const body = (extra: Record<string, unknown>) =>
      ev({
        type: "inbox.added",
        payload: { id: `i${counter}`, kind: "info", nodeId: "a", ...extra },
      } as never);
    expect(
      code(foldEvents([...base(), body({ summary: "x".repeat(INBOX_SUMMARY_MAX) })])),
    ).toBeNull();
    for (const bad of [
      { summary: "x".repeat(INBOX_SUMMARY_MAX + 1) },
      { summary: 5 },
      { ref: "" },
      { ref: 5 },
    ]) {
      expect(code(foldEvents([...base(), body(bad)])), JSON.stringify(bad)).toBe("invalidPayload");
    }
  });
});

describe("判断要求の内容（question・options）", () => {
  it("decision.requested は任意の question・options を持ち、DecisionRecord に載る", () => {
    const s = must(
      foldEvents([
        ...base(),
        ev({
          type: "decision.requested",
          payload: { decisionId: "d1", nodeId: "a", question: "どちら？", options: ["A", "B"] },
        }),
      ]),
    );
    expect(s.decisions[0]).toMatchObject({ question: "どちら？", options: ["A", "B"] });
  });

  it("省略は後方互換。不正な question・options は拒否する", () => {
    const s = must(
      foldEvents([
        ...base(),
        ev({ type: "decision.requested", payload: { decisionId: "d1", nodeId: "a" } }),
      ]),
    );
    expect("question" in (s.decisions[0] ?? {})).toBe(false);
    for (const bad of [{ question: 5 }, { options: "A" }, { options: [1] }]) {
      const r = foldEvents([
        ...base(),
        ev({
          type: "decision.requested",
          payload: { decisionId: "d2", nodeId: "a", ...bad },
        } as never),
      ]);
      expect(code(r), JSON.stringify(bad)).toBe("invalidPayload");
    }
  });
});

describe("報告の保存（report.added）", () => {
  const added = (over: Record<string, unknown> = {}) =>
    ev({
      type: "report.added",
      payload: { reportId: "r1", nodeId: "a", kind: "progress", text: "半分終わった", ...over },
    } as never);

  it("報告の種類は progress・done・outOfScope", () => {
    expect(REPORT_KINDS).toEqual(["progress", "done", "outOfScope"]);
  });

  it("報告を保存し、状態は変えない。done は受け入れ基準ごとの根拠を持てる", () => {
    const first = added();
    const e = added({
      reportId: "r2",
      kind: "done",
      text: "完了",
      evidence: [{ criterion: "テスト", evidence: "pnpm test 通過" }],
    });
    const s = must(foldEvents([...base(), first, e]));
    expect(s.reports.map((r) => r.reportId)).toEqual(["r1", "r2"]);
    expect(s.reports[1]).toMatchObject({
      seq: e.seq,
      nodeId: "a",
      kind: "done",
      evidence: [{ criterion: "テスト", evidence: "pnpm test 通過" }],
    });
    expect(s.nodes.find((n) => n.id === "a")?.state).toBe("running");
  });

  it("同じ reportId・未知のノード・不正な payload は拒否する", () => {
    expect(code(foldEvents([...base(), added(), added()]))).toBe("duplicateReport");
    expect(code(foldEvents([...base(), added({ nodeId: "zz" })]))).toBe("unknownNode");
    for (const bad of [
      { reportId: "" },
      { kind: "bogus" },
      { text: 5 },
      { evidence: "x" },
      { evidence: [{ criterion: "a" }] },
      { kind: "progress", evidence: [] },
    ]) {
      expect(code(foldEvents([...base(), added(bad)])), JSON.stringify(bad)).toBe("invalidPayload");
    }
  });
});
