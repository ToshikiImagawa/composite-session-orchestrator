import { describe, expect, it } from "vitest";
import {
  applyEvent,
  type EventBody,
  foldEvents,
  INBOX_SUMMARY_MAX,
  initialState,
  LIMITS,
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
    const d = ev({
      type: "decision.requested",
      payload: { decisionId: "d1", nodeId: "a", question: "DB はどれにする？" },
    });
    const e = ev({
      type: "inbox.added",
      payload: { id: "i1", kind: "decision", nodeId: "a", summary: "DB はどれにする？", ref: "d1" },
    });
    const s = must(foldEvents([...base(), d, e]));
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

  it("報告の種類は progress・done・outOfScope・failure・review", () => {
    expect(REPORT_KINDS).toEqual(["progress", "done", "outOfScope", "failure", "review"]);
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

describe("子が入れる文字列・配列の上限（コードポイントで数える）", () => {
  const repeat = (n: number, ch = "あ") => ch.repeat(n);
  const addReport = (over: Record<string, unknown>) =>
    ev({
      type: "report.added",
      payload: { reportId: `r${counter}`, nodeId: "a", kind: "progress", text: "x", ...over },
    } as never);
  const request = (over: Record<string, unknown>) =>
    ev({
      type: "decision.requested",
      payload: { decisionId: `d${counter}`, nodeId: "a", ...over },
    } as never);
  const exited = (reason: string) => ev({ type: "node.exited", payload: { nodeId: "a", reason } });
  const denied = (tool: string) => ev({ type: "node.toolDenied", payload: { nodeId: "a", tool } });
  const ok = (e: OrchEvent) => code(foldEvents([...base(), e]));

  it("上限は core の定数にまとまっている", () => {
    expect(LIMITS).toEqual({
      reportText: 64 * 1024,
      question: 8 * 1024,
      optionCount: 20,
      optionLength: 500,
      evidenceCount: 50,
      evidenceLength: 4 * 1024,
      reason: 1024,
      tool: 1024,
      summary: INBOX_SUMMARY_MAX,
      objective: 8 * 1024,
      criteriaCount: 50,
      criterionLength: 1024,
      scopeEntryCount: 100,
      scopeEntryLength: 4096,
      dependsOnCount: 50,
      extensionTarget: 1024,
      extensionReason: 4 * 1024,
      openExtensionsPerNode: 10,
      openDecisionsPerNode: 10,
      lossSubjects: 5,
      lossSubjectLength: 100,
      expectTips: 256,
      digestTopItems: 3,
      purgeHoldReason: 200,
      purgeHoldMaxDays: 365,
      reportsPerNode: 200,
      pauseNodeCount: 100,
      purgeNodeCount: 10_000,
      commit: 128,
      feedback: 8 * 1024,
    });
  });

  it("ちょうど上限までは受け入れ、超えたら invalidPayload", () => {
    expect(ok(addReport({ text: repeat(LIMITS.reportText) }))).toBeNull();
    expect(ok(addReport({ text: repeat(LIMITS.reportText + 1) }))).toBe("invalidPayload");
    expect(ok(request({ question: repeat(LIMITS.question) }))).toBeNull();
    expect(ok(request({ question: repeat(LIMITS.question + 1) }))).toBe("invalidPayload");
    expect(ok(exited(repeat(LIMITS.reason)))).toBeNull();
    expect(ok(exited(repeat(LIMITS.reason + 1)))).toBe("invalidPayload");
    expect(ok(denied(repeat(LIMITS.tool)))).toBeNull();
    expect(ok(denied(repeat(LIMITS.tool + 1)))).toBe("invalidPayload");
  });

  it("選択肢は 20 件・各 500 文字まで", () => {
    const opts = (n: number) => Array.from({ length: n }, (_, i) => `案${i}`);
    expect(ok(request({ question: "q", options: opts(LIMITS.optionCount) }))).toBeNull();
    expect(ok(request({ question: "q", options: opts(LIMITS.optionCount + 1) }))).toBe(
      "invalidPayload",
    );
    expect(ok(request({ question: "q", options: [repeat(LIMITS.optionLength)] }))).toBeNull();
    expect(ok(request({ question: "q", options: [repeat(LIMITS.optionLength + 1)] }))).toBe(
      "invalidPayload",
    );
  });

  it("根拠は 50 件・各項目 4KB まで", () => {
    const ev1 = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ criterion: `c${i}`, evidence: "e" }));
    expect(ok(addReport({ kind: "done", evidence: ev1(LIMITS.evidenceCount) }))).toBeNull();
    expect(ok(addReport({ kind: "done", evidence: ev1(LIMITS.evidenceCount + 1) }))).toBe(
      "invalidPayload",
    );
    const long = repeat(LIMITS.evidenceLength + 1);
    expect(ok(addReport({ kind: "done", evidence: [{ criterion: "c", evidence: long }] }))).toBe(
      "invalidPayload",
    );
    expect(ok(addReport({ kind: "done", evidence: [{ criterion: long, evidence: "e" }] }))).toBe(
      "invalidPayload",
    );
  });

  it("長さはコードポイントで数える（サロゲートペアを 2 と数えない）。summary も同じ", () => {
    expect(ok(exited("😀".repeat(LIMITS.reason)))).toBeNull();
    expect(ok(exited("😀".repeat(LIMITS.reason + 1)))).toBe("invalidPayload");
    const sum = (summary: string) =>
      ev({
        type: "inbox.added",
        payload: { id: `i${counter}`, kind: "info", nodeId: "a", summary },
      });
    expect(ok(sum("😀".repeat(INBOX_SUMMARY_MAX)))).toBeNull();
    expect(ok(sum("😀".repeat(INBOX_SUMMARY_MAX + 1)))).toBe("invalidPayload");
  });

  it("タブ・改行以外の制御文字・DEL・書式制御（Cf。U+202E など）を拒否する", () => {
    const bad = ["a\u0000b", "a\u001bb", "a\rb", "a\u007fb", "a‮b", "a​b", "a\u0085b"];
    for (const s of bad) {
      const label = JSON.stringify(s);
      expect(ok(addReport({ text: s })), `text ${label}`).toBe("invalidPayload");
      expect(ok(request({ question: s })), `question ${label}`).toBe("invalidPayload");
      expect(ok(request({ question: "q", options: [s, "b"] })), `options ${label}`).toBe(
        "invalidPayload",
      );
      expect(ok(exited(s)), `reason ${label}`).toBe("invalidPayload");
      expect(ok(denied(s)), `tool ${label}`).toBe("invalidPayload");
      expect(
        ok(
          ev({
            type: "inbox.added",
            payload: { id: `i${counter}`, kind: "info", nodeId: "a", summary: s },
          }),
        ),
        `summary ${label}`,
      ).toBe("invalidPayload");
      expect(
        ok(addReport({ kind: "done", evidence: [{ criterion: s, evidence: "e" }] })),
        `evidence ${label}`,
      ).toBe("invalidPayload");
    }
    expect(ok(addReport({ text: "行1\n\t行2" }))).toBeNull();
  });
});

describe("選択肢の検査", () => {
  const request = (over: Record<string, unknown>) =>
    ev({
      type: "decision.requested",
      payload: { decisionId: `d${counter}`, nodeId: "a", ...over },
    } as never);
  it("options を指定するなら question が必須。options は空・重複を拒否する", () => {
    const r = (over: Record<string, unknown>) => code(foldEvents([...base(), request(over)]));
    expect(r({ options: ["A", "B"] })).toBe("invalidPayload");
    expect(r({ question: "q", options: [] })).toBe("invalidPayload");
    expect(r({ question: "q", options: ["A", "A"] })).toBe("invalidPayload");
    expect(r({ question: "q", options: ["A", "B"] })).toBeNull();
    expect(r({ question: "q" })).toBeNull();
  });
});

describe("inbox.added の ref の検査（unknownRef）", () => {
  const added = (over: Record<string, unknown>) =>
    ev({ type: "inbox.added", payload: { id: `i${counter}`, nodeId: "a", ...over } } as never);
  const dec = (nodeId = "a") =>
    ev({ type: "decision.requested", payload: { decisionId: "d1", nodeId, question: "q" } });
  const rep = (kind = "progress", nodeId = "a") =>
    ev({ type: "report.added", payload: { reportId: "r1", nodeId, kind, text: "t" } } as never);

  it("decision・answer は記録済みの decisionId、それ以外の報告系は記録済みの reportId を指す", () => {
    const d = dec();
    const r = rep();
    const b = base();
    const run = (...e: OrchEvent[]) => code(foldEvents([...b, d, r, ...e]));
    expect(run(added({ kind: "decision", ref: "d1" }))).toBeNull();
    expect(run(added({ kind: "answer", ref: "d1" }))).toBeNull();
    for (const kind of ["done", "progress", "failure", "info"]) {
      expect(run(added({ kind, ref: "r1" })), kind).toBeNull();
    }
  });

  it("未記録・種類の食い違い・別ノードのものは unknownRef", () => {
    const b = base();
    const d = dec();
    const r = rep();
    const other = created(5, "b", "implement", "root");
    const run = (...e: OrchEvent[]) => code(foldEvents([...b, other, d, r, ...e]));
    expect(run(added({ kind: "decision", ref: "nope" }))).toBe("unknownRef");
    expect(run(added({ kind: "progress", ref: "nope" }))).toBe("unknownRef");
    expect(run(added({ kind: "decision", ref: "r1" }))).toBe("unknownRef"); // 種類の食い違い
    expect(run(added({ kind: "progress", ref: "d1" }))).toBe("unknownRef");
    expect(run(added({ kind: "progress", ref: "r1", nodeId: "b" }))).toBe("unknownRef"); // 別ノード
    expect(run(added({ kind: "decision", ref: "d1", nodeId: "b" }))).toBe("unknownRef");
    // 参照先のない種類（violation・stopIncomplete）は ref を持てない
    expect(run(added({ kind: "violation", ref: "r1" }))).toBe("unknownRef");
    expect(run(added({ kind: "stopIncomplete", ref: "r1" }))).toBe("unknownRef");
  });

  it("ref なしは従来どおり", () => {
    expect(code(foldEvents([...base(), added({ kind: "violation" })]))).toBeNull();
  });
});

describe("node.exited・node.toolDenied を記録できるノードの状態", () => {
  const exited = (nodeId: string) => ev({ type: "node.exited", payload: { nodeId, reason: "x" } });
  const denied = (nodeId: string) =>
    ev({ type: "node.toolDenied", payload: { nodeId, tool: "T" } });

  it("running・waiting・stopping・stopIncomplete のノードに限る（pending・停止済み・完了後は invalidTransition）", () => {
    const pending = [...base().slice(0, 3)]; // a は pending
    expect(code(foldEvents([...pending, exited("a")]))).toBe("invalidTransition");
    expect(code(foldEvents([...pending, denied("a")]))).toBe("invalidTransition");
    expect(code(foldEvents([...base(), exited("a")]))).toBeNull();
    expect(code(foldEvents([...base(), denied("a")]))).toBeNull();
    const waiting = [...base(), changed(10, "a", { type: "requestDecision" })];
    expect(code(foldEvents([...waiting, exited("a")]))).toBeNull();
    const stopping = [...base(), changed(10, "a", { type: "stop", mode: "immediate" })];
    expect(code(foldEvents([...stopping, denied("a")]))).toBeNull();
    const stopped = [...stopping, changed(11, "a", { type: "confirmStopped" })];
    expect(code(foldEvents([...stopped, exited("a")]))).toBe("invalidTransition");
    const done = [...base(), changed(10, "a", { type: "reportDone" })];
    expect(code(foldEvents([...done, denied("a")]))).toBe("invalidTransition");
  });
});

describe("追加指示の記録（node.instructed。記録のみ）", () => {
  const instructed = (nodeId: string, text: unknown) =>
    ev({ type: "node.instructed", payload: { nodeId, text } } as never);

  it("ノード・本文・seq・at・発行者を記録し、ノードの状態を変えない", () => {
    const s = must(foldEvents([...base(), instructed("a", "続けて")]));
    expect(s.instructions).toEqual([
      expect.objectContaining({ nodeId: "a", text: "続けて", actor: SYS }),
    ]);
    expect(s.instructions[0]).toMatchObject({
      seq: expect.any(Number),
      at: "2026-10-20T00:00:00Z",
    });
    expect(s.nodes.find((n) => n.id === "a")?.state).toBe("running");
  });

  it("複数の指示は時系列で残る", () => {
    const s = must(foldEvents([...base(), instructed("a", "1"), instructed("a", "2")]));
    expect(s.instructions.map((x) => x.text)).toEqual(["1", "2"]);
  });

  it.each([
    ["空", ""],
    ["空白だけ", "  \n"],
    ["文字列でない", 5],
    ["制御文字", "a\u0000b"],
    ["上限超え", "あ".repeat(LIMITS.reportText + 1)],
  ])("本文が%sなら invalidPayload", (_name, text) => {
    expect(code(foldEvents([...base(), instructed("a", text)]))).toBe("invalidPayload");
  });

  it("ちょうど上限までは受け入れる", () => {
    const text = "あ".repeat(LIMITS.reportText);
    expect(code(foldEvents([...base(), instructed("a", text)]))).toBeNull();
  });

  it("存在しないノードは unknownNode、識別子の形式が不正なら invalidPayload", () => {
    expect(code(foldEvents([...base(), instructed("zz", "x")]))).toBe("unknownNode");
    expect(code(foldEvents([...base(), instructed("a b", "x")]))).toBe("invalidPayload");
  });

  it("指示を届けられるのは running・waiting・stopping・stopIncomplete のノードだけ", () => {
    const pending = foldEvents([
      ...base(),
      created(5, "p", "implement", "root"),
      instructed("p", "x"),
    ]);
    expect(code(pending)).toBe("invalidTransition");
    const done = foldEvents([
      ...base(),
      changed(5, "a", { type: "reportDone" }),
      instructed("a", "x"),
    ]);
    expect(code(done)).toBe("invalidTransition");
  });

  it("古いスナップショット（instructions がない）からも復元できる", () => {
    const old = { ...initialState() } as Record<string, unknown>;
    old.instructions = undefined;
    const r = applyEvent(old as never, created(1, "root", "integrator", null));
    expect(r.ok).toBe(true);
  });
});
