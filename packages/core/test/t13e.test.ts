import { describe, expect, expectTypeOf, it } from "vitest";
import {
  applyEvent,
  type Blocker,
  type DaemonResponse,
  discardedNodeIds,
  type EventBody,
  foldEvents,
  INTEGRATOR_OPERATION_CLASS,
  initialState,
  type NodeEvent,
  type NodeLoss,
  type OrchEvent,
  type OrchState,
  REPORT_KINDS,
  type Result,
  ROLE_OPERATIONS,
  SUBTREE_RULES,
  type UnmetReason,
  unresolvedInbox,
} from "../src/index.js";

const SYS = { system: true } as const;
const HUMAN = { human: true } as const;
let counter = 5000;
const ev = (
  body: EventBody,
  over: Partial<Pick<OrchEvent, "seq" | "requestId" | "actor" | "at">> = {},
): OrchEvent => {
  counter += 1;
  return {
    seq: over.seq ?? counter,
    at: over.at ?? "2026-10-20T00:00:00Z",
    requestId: over.requestId ?? `req-${counter}`,
    actor: over.actor ?? SYS,
    ...body,
  } as OrchEvent;
};
const created = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
  ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
const changed = (nodeId: string, event: NodeEvent, over: Parameters<typeof ev>[1] = {}) =>
  ev({ type: "node.stateChanged", payload: { nodeId, event } }, over);
const code = (r: ReturnType<typeof foldEvents>) => (r.ok ? null : r.error.code);
const must = (r: ReturnType<typeof foldEvents>): OrchState => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
  return r.value;
};
/** root ─ a。a は running。 */
const base = (): OrchEvent[] => [
  created("root", "integrator", null),
  changed("root", { type: "start" }),
  created("a", "implement", "root"),
  changed("a", { type: "start" }),
];
/** a を停止済み（stopped）にする。 */
const stopped = (): OrchEvent[] => [
  ...base(),
  changed("a", { type: "stop", mode: "immediate" }),
  changed("a", { type: "confirmStopped" }),
];

describe("REPORT_KINDS に review（accept の feedback の記録）", () => {
  const report = (kind: string, evidence?: unknown) =>
    ev({
      type: "report.added",
      payload: {
        reportId: "r1",
        nodeId: "a",
        kind,
        text: "よい",
        ...(evidence ? { evidence } : {}),
      },
    } as never);

  it("REPORT_KINDS に review がある。review の報告を記録できる", () => {
    expect(REPORT_KINDS).toContain("review");
    expect(code(foldEvents([...base(), report("review")]))).toBeNull();
  });

  it("未知の種類は拒否する", () => {
    expect(code(foldEvents([...base(), report("unknown")]))).toBe("invalidPayload");
  });

  it("完了報告の根拠（evidence）が空白だけなら拒否する", () => {
    const ok = [{ criterion: "c", evidence: "テストが通る" }];
    expect(code(foldEvents([...base(), report("done", ok)]))).toBeNull();
    for (const bad of ["", " ", "\n\t "]) {
      const r = foldEvents([...base(), report("done", [{ criterion: "c", evidence: bad }])]);
      expect(code(r), JSON.stringify(bad)).toBe("invalidPayload");
    }
  });
});

describe("node.discardDecided（破棄の判断。停止したノードだけ）", () => {
  const discard = (nodeId: string, over: Parameters<typeof ev>[1] = {}) =>
    ev({ type: "node.discardDecided", payload: { nodeId } } as never, {
      actor: HUMAN,
      at: "2026-10-21T01:00:00Z",
      ...over,
    });

  it("停止したノードに、判断した者・時刻・seq を記録する", () => {
    const d = discard("a", { seq: 9000 });
    const s = must(foldEvents([...stopped(), d]));
    expect(s.nodes.find((n) => n.id === "a")?.discarded).toEqual({
      seq: 9000,
      at: "2026-10-21T01:00:00Z",
      by: HUMAN,
    });
    expect(s.nodes.find((n) => n.id === "a")?.state).toBe("stopped");
  });

  it("停止していないノード・存在しないノード・不正な識別子は拒否する", () => {
    expect(code(foldEvents([...base(), discard("a")]))).toBe("invalidTransition");
    expect(code(foldEvents([...stopped(), discard("zz")]))).toBe("unknownNode");
    expect(code(foldEvents([...stopped(), discard("a b")]))).toBe("invalidPayload");
  });

  it("二度目の判断は拒否する（先に確定した判断を残す）", () => {
    expect(code(foldEvents([...stopped(), discard("a"), discard("a")]))).toBe("alreadyDiscarded");
  });

  it("停止したノードを再開（restart）したら、破棄の判断は消える", () => {
    const s = must(
      foldEvents([
        ...stopped(),
        discard("a"),
        changed("a", { type: "restart", dependenciesDone: true }),
      ]),
    );
    expect(s.nodes.find((n) => n.id === "a")).not.toHaveProperty("discarded");
  });

  it("markReclaimable の discarded は payload を信用せず、破棄の判断の記録から判定する", () => {
    const mark = (discarded: boolean) => changed("a", { type: "markReclaimable", discarded });
    // 判断なしで discarded: true と申告しても、停止したノードは回収可能にならない
    expect(code(foldEvents([...stopped(), mark(true)]))).not.toBeNull();
    // 判断があれば、payload が false でも回収可能になる
    const s = must(foldEvents([...stopped(), discard("a"), mark(false)]));
    expect(s.nodes.find((n) => n.id === "a")?.state).toBe("reclaimable");
  });

  it("discardedNodeIds は、判断済みのノードの識別子を返す（回収の再判定の入力 facts.discarded の情報源）", () => {
    const s = must(foldEvents([...stopped(), discard("a")]));
    expect(discardedNodeIds(s)).toEqual(["a"]);
    expect(discardedNodeIds(initialState())).toEqual([]);
  });
});

describe("NodeRecord.archivedAt", () => {
  it("archive のイベントの at から設定され、それまではない", () => {
    const path = [
      ...base(),
      changed("a", { type: "reportDone" }),
      changed("a", { type: "accept" }),
      changed("a", { type: "markReclaimable", discarded: false }),
    ];
    const before = must(foldEvents(path));
    expect(before.nodes.find((n) => n.id === "a")).not.toHaveProperty("archivedAt");
    const after = must(
      foldEvents([...path, changed("a", { type: "archive" }, { at: "2026-10-22T03:00:00Z" })]),
    );
    expect(after.nodes.find((n) => n.id === "a")?.archivedAt).toBe("2026-10-22T03:00:00Z");
    expect(after.nodes.find((n) => n.id === "a")?.state).toBe("archived");
  });
});

describe("node.instructionDelivered（指示の配送の記録）", () => {
  const instructed = (text: string) =>
    ev({ type: "node.instructed", payload: { nodeId: "a", text } } as never);
  const delivered = (instructedSeq: unknown, over: Parameters<typeof ev>[1] = {}) =>
    ev({ type: "node.instructionDelivered", payload: { instructedSeq } } as never, over);

  it("指示ごとに、配送済みかどうかを導ける（deliveredSeq がある指示が配送済み）", () => {
    const b = base();
    const i1 = instructed("1");
    const i2 = instructed("2");
    const s = must(foldEvents([...b, i1, i2, delivered(i1.seq)]));
    expect(s.instructions.map((x) => [x.text, x.deliveredSeq !== undefined])).toEqual([
      ["1", true],
      ["2", false],
    ]);
  });

  it("存在しない指示は unknownInstruction、不正な値は invalidPayload", () => {
    expect(code(foldEvents([...base(), delivered(123456)]))).toBe("unknownInstruction");
    for (const bad of ["x", -1, 1.5, null, undefined]) {
      expect(code(foldEvents([...base(), delivered(bad)])), String(bad)).toBe("invalidPayload");
    }
  });

  it("同じ指示の配送を二度記録しても、最初の記録を残す（状態は変わらない）", () => {
    const b = base();
    const i1 = instructed("1");
    const d1 = delivered(i1.seq);
    const d2 = delivered(i1.seq);
    const s = must(foldEvents([...b, i1, d1, d2]));
    expect(s.instructions[0]?.deliveredSeq).toBe(d1.seq);
  });

  it("古いスナップショット（instructions がない）からも復元できる", () => {
    const old = { ...initialState() } as Record<string, unknown>;
    old.instructions = undefined;
    expect(applyEvent(old as never, created("root", "integrator", null)).ok).toBe(true);
  });
});

describe("受信箱の ref から拡張要求（extensionId）を指せる", () => {
  const request = () =>
    ev({
      type: "scope.extensionRequested",
      payload: {
        extensionId: "x1",
        nodeId: "a",
        target: { kind: "write", value: "docs" },
        reason: "r",
      },
    } as never);
  const item = (kind: string, ref: string, nodeId = "a", id = "i1") =>
    ev({ type: "inbox.added", payload: { id, kind, nodeId, ref } } as never);

  it("violation の ref に、同じノードの拡張要求を指せる", () => {
    expect(code(foldEvents([...base(), request(), item("violation", "x1")]))).toBeNull();
  });

  it("存在しない拡張要求・別のノードの拡張要求・他の種類からの参照は unknownRef", () => {
    expect(code(foldEvents([...base(), request(), item("violation", "nope")]))).toBe("unknownRef");
    expect(code(foldEvents([...base(), request(), item("violation", "x1", "root")]))).toBe(
      "unknownRef",
    );
    expect(code(foldEvents([...base(), request(), item("info", "x1")]))).toBe("unknownRef");
    expect(code(foldEvents([...base(), request(), item("stopIncomplete", "x1")]))).toBe(
      "unknownRef",
    );
  });
});

describe("契約（node.send・node.spawn・node.reclaimPreview・scope.decide）", () => {
  it("node.send の結果は { status: 'queued', duplicate }", () => {
    expectTypeOf<DaemonResponse<"node.send">>().toEqualTypeOf<
      Result<{ status: "queued"; duplicate: boolean }>
    >();
  });

  it("node.spawn の結果は { nodeId, status: running | pending, waitingFor? }", () => {
    expectTypeOf<DaemonResponse<"node.spawn">>().toEqualTypeOf<
      Result<{ nodeId: string; status: "running" | "pending"; waitingFor?: string[] }>
    >();
  });

  it("node.reclaimPreview の結果は assessReclaim の結果の構造（reclaimable・unmet・blockers）と、任意の loss（T21r）", () => {
    expectTypeOf<DaemonResponse<"node.reclaimPreview">>().toEqualTypeOf<
      Result<{
        reclaimable: boolean;
        unmet: readonly UnmetReason[];
        blockers: readonly Blocker[];
        loss?: readonly NodeLoss[];
      }>
    >();
  });

  it("scope.decide は人間にも開放され、統合ロールは発生元ノードが自分の部分木のときだけ", () => {
    expect(ROLE_OPERATIONS.human).toContain("scope.decide");
    expect(ROLE_OPERATIONS.integrator).toContain("scope.decide");
    expect(INTEGRATOR_OPERATION_CLASS["scope.decide"]).toBe("subtree");
    expect(SUBTREE_RULES["scope.decide"]).toBe("strictDescendant");
  });
});

describe("report.added（done）の criterion も、空白だけを拒否する", () => {
  const done = (criterion: string, evidence = "根拠") =>
    ev({
      type: "report.added",
      payload: {
        reportId: "rc1",
        nodeId: "a",
        kind: "done",
        text: "t",
        evidence: [{ criterion, evidence }],
      },
    } as never);

  it("criterion が空・空白だけなら invalidPayload。通常の値は受け入れる", () => {
    for (const bad of ["", " ", "\n\t "]) {
      expect(code(foldEvents([...base(), done(bad)])), JSON.stringify(bad)).toBe("invalidPayload");
    }
    expect(code(foldEvents([...base(), done("基準 1")]))).toBeNull();
  });
});

describe("inbox.resolved（受信箱の項目を解決済みにする。記録のみ）", () => {
  const added = (id: string, over: Record<string, unknown> = {}) =>
    ev({ type: "inbox.added", payload: { id, kind: "info", nodeId: "a", ...over } } as never);
  const resolved = (itemId: unknown, over: Parameters<typeof ev>[1] = {}) =>
    ev({ type: "inbox.resolved", payload: { itemId } } as never, {
      actor: HUMAN,
      at: "2026-10-22T04:00:00Z",
      ...over,
    });

  it("項目に、解決した者・時刻・seq を記録する（項目そのものは消えない）", () => {
    const b = base();
    const i = added("i1");
    const r = resolved("i1", { seq: 9100 });
    const s = must(foldEvents([...b, i, r]));
    expect(s.inbox).toHaveLength(1);
    expect(s.inbox[0]).toMatchObject({
      id: "i1",
      resolved: { seq: 9100, at: "2026-10-22T04:00:00Z", by: HUMAN },
    });
  });

  it("存在しない項目は unknownInboxItem、識別子の形式が不正なら invalidPayload", () => {
    expect(code(foldEvents([...base(), resolved("zz")]))).toBe("unknownInboxItem");
    for (const bad of ["a b", "", 5, null, undefined]) {
      expect(code(foldEvents([...base(), resolved(bad)])), String(bad)).toBe("invalidPayload");
    }
  });

  it("二度目の解決は、最初の記録を残す（状態は変わらない）", () => {
    const b = base();
    const i = added("i1");
    const first = resolved("i1", { seq: 9200, at: "2026-10-22T04:00:00Z" });
    const second = resolved("i1", { seq: 9300, at: "2026-10-23T05:00:00Z", actor: SYS });
    const s = must(foldEvents([...b, i, first, second]));
    expect(s.inbox[0]?.resolved).toMatchObject({ seq: 9200, by: HUMAN });
  });

  it("解決していない項目には resolved がなく、unresolvedInbox は解決済みを除く", () => {
    const b = base();
    const i1 = added("i1");
    const i2 = added("i2");
    const s = must(foldEvents([...b, i1, i2, resolved("i1")]));
    expect(s.inbox.find((x) => x.id === "i2")).not.toHaveProperty("resolved");
    expect(unresolvedInbox(s.inbox).map((x) => x.id)).toEqual(["i2"]);
  });

  it("古いスナップショットの受信箱（resolved がない）からも復元できる", () => {
    const b = base();
    const s = must(foldEvents([...b, added("i1")]));
    const r = applyEvent(s, resolved("i1"));
    expect(r.ok).toBe(true);
  });
});
