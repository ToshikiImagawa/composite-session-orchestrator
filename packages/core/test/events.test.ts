import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  type EventBody,
  foldEvents,
  INBOX_KINDS,
  initialState,
  type NodeEvent,
  type OrchEvent,
  type OrchState,
  stateOf,
} from "../src/index.js";

const SYS = { system: true } as const;
let counter = 0;
/** テスト用の事象。seq と requestId を明示しなければ連番で付ける。 */
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
  nodeId: string,
  role: "integrator" | "implement" | "review",
  parentId: string | null,
  dependsOn: string[] = [],
): EventBody => ({
  type: "node.created",
  payload: { nodeId, role, parentId, dependsOn },
});
const changed = (nodeId: string, event: NodeEvent): EventBody => ({
  type: "node.stateChanged",
  payload: { nodeId, event },
});

const must = (r: ReturnType<typeof foldEvents>): OrchState => {
  if (!r.ok) throw new Error(`fold failed: ${r.error.code} ${r.error.cause}`);
  return r.value;
};

/** root(integrator) ─ a(implement) / b(implement, a に依存) */
const base = (): OrchEvent[] => [
  ev(created("root", "integrator", null)),
  ev(created("a", "implement", "root")),
  ev(created("b", "implement", "root", ["a"])),
];

describe("畳み込み（状態はイベント列からのみ導出）", () => {
  it("空のログは空の状態", () => {
    expect(must(foldEvents([]))).toEqual(initialState());
  });

  it("node.created で pending のノードができ、木の不変条件を守る", () => {
    const s = must(foldEvents(base()));
    expect(s.nodes.map((n) => [n.id, n.state])).toEqual([
      ["root", "pending"],
      ["a", "pending"],
      ["b", "pending"],
    ]);
  });

  it("木の不変条件に反する node.created は seq つきで拒否される", () => {
    const bad = foldEvents([
      ev(created("root", "integrator", null)),
      ev(created("w", "implement", "root")),
      ev(created("x", "review", "w")),
    ]);
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.error.code).toBe("invalidTree");
      expect(bad.error.seq).toBeGreaterThan(0);
      expect(bad.error.nextActions.length).toBeGreaterThan(0);
    }
  });

  it("未知の依存先・自己依存は拒否される", () => {
    const r1 = foldEvents([
      ev(created("root", "integrator", null)),
      ev(created("a", "implement", "root", ["ghost"])),
    ]);
    expect(r1.ok ? null : r1.error.code).toBe("unknownDependency");
    const r2 = foldEvents([
      ev(created("root", "integrator", null)),
      ev(created("a", "implement", "root", ["a"])),
    ]);
    expect(r2.ok ? null : r2.error.code).toBe("unknownDependency");
  });

  it("T03 の遷移表に従って状態が進む。矛盾する遷移は拒否される", () => {
    const ok = must(
      foldEvents([
        ...base(),
        ev(changed("a", { type: "start" })),
        ev(changed("a", { type: "reportDone" })),
      ]),
    );
    expect(stateOf(ok, "a")).toBe("done");
    const bad = foldEvents([...base(), ev(changed("a", { type: "reportDone" }))]); // pending からは完了できない
    expect(bad.ok ? null : bad.error.code).toBe("invalidTransition");
    const unknown = foldEvents([...base(), ev(changed("zzz", { type: "start" }))]);
    expect(unknown.ok ? null : unknown.error.code).toBe("unknownNode");
  });

  it("start は dependsOn の全ノードが verified のときだけ許可（done では不可）", () => {
    const upToDone: OrchEvent[] = [
      ...base(),
      ev(changed("a", { type: "start" })),
      ev(changed("a", { type: "reportDone" })),
    ];
    const early = foldEvents([...upToDone, ev(changed("b", { type: "start" }))]);
    expect(early.ok ? null : early.error.code).toBe("dependenciesNotVerified");
    const s = must(
      foldEvents([
        ...upToDone,
        ev(changed("a", { type: "accept" })),
        ev(changed("b", { type: "start" })),
      ]),
    );
    expect(stateOf(s, "b")).toBe("running");
  });

  it("restart の dependenciesDone は payload を信用せず、状態から判定する", () => {
    const stopped: OrchEvent[] = [
      ...base(),
      ev(changed("b", { type: "stop", mode: "immediate" })), // pending → stopped
    ];
    // a は未検証。payload が true と主張しても pending に戻る
    const s1 = must(
      foldEvents([...stopped, ev(changed("b", { type: "restart", dependenciesDone: true }))]),
    );
    expect(stateOf(s1, "b")).toBe("pending");
    // a が verified なら、payload が false と主張しても running へ進む
    const verifiedA: OrchEvent[] = [
      ...stopped,
      ev(changed("a", { type: "start" })),
      ev(changed("a", { type: "reportDone" })),
      ev(changed("a", { type: "accept" })),
    ];
    const s2 = must(
      foldEvents([...verifiedA, ev(changed("b", { type: "restart", dependenciesDone: false }))]),
    );
    expect(stateOf(s2, "b")).toBe("running");
  });

  it("親の回収可能は、配下がすべて回収可能以降のときだけ（親子の不変条件）", () => {
    const toVerified = (id: string): OrchEvent[] => [
      ev(changed(id, { type: "start" })),
      ev(changed(id, { type: "reportDone" })),
      ev(changed(id, { type: "accept" })),
    ];
    const tree: OrchEvent[] = [
      ev(created("root", "integrator", null)),
      ev(created("a", "implement", "root")),
    ];
    const bad = foldEvents([
      ...tree,
      ...toVerified("root"),
      ...toVerified("a"),
      ev(changed("root", { type: "markReclaimable", discarded: false })),
    ]);
    expect(bad.ok ? null : bad.error.code).toBe("reclaimInvariant");
    const good = must(
      foldEvents([
        ...tree,
        ...toVerified("root"),
        ...toVerified("a"),
        ev(changed("a", { type: "markReclaimable", discarded: false })),
        ev(changed("root", { type: "markReclaimable", discarded: false })),
      ]),
    );
    expect(stateOf(good, "root")).toBe("reclaimable");
  });
});

describe("scope.violation / inbox / 判断", () => {
  it("scope.violation は記録され、状態は変えない", () => {
    const before = must(foldEvents(base()));
    const s = must(
      foldEvents([
        ...base(),
        ev({
          type: "scope.violation",
          payload: { nodeId: "a", reason: "outsideWritable", subject: "/etc/x" },
        }),
      ]),
    );
    expect(s.violations).toHaveLength(1);
    expect(s.nodes).toEqual(before.nodes);
  });

  it("inbox.added は seq・at を envelope から取り、同じ id は拒否される", () => {
    const b = base();
    const e = ev({
      type: "inbox.added",
      payload: { id: "i1", kind: "progress", nodeId: "a", dependsOn: [] },
    });
    const s = must(foldEvents([...b, e]));
    expect(s.inbox).toEqual([
      { seq: e.seq, id: "i1", kind: "progress", nodeId: "a", dependsOn: [], at: e.at },
    ]);
    const dup = foldEvents([
      ...b,
      e,
      ev({ type: "inbox.added", payload: { id: "i1", kind: "info", nodeId: "a", dependsOn: [] } }),
    ]);
    expect(dup.ok ? null : dup.error.code).toBe("duplicateInboxId");
  });

  it("未知のノード・種類の inbox.added は拒否される", () => {
    const r = foldEvents([
      ...base(),
      ev({
        type: "inbox.added",
        payload: { id: "i", kind: "bogus" as never, nodeId: "a", dependsOn: [] },
      }),
    ]);
    expect(r.ok ? null : r.error.code).toBe("invalidPayload");
    const r2 = foldEvents([
      ...base(),
      ev({ type: "inbox.added", payload: { id: "i", kind: "info", nodeId: "zzz", dependsOn: [] } }),
    ]);
    expect(r2.ok ? null : r2.error.code).toBe("unknownNode");
  });

  it("回答の一本化: 先に確定した回答を採用し、後続は却下として記録する", () => {
    const s = must(
      foldEvents([
        ...base(),
        ev({ type: "decision.requested", payload: { decisionId: "d1", nodeId: "a" } }),
        ev(
          { type: "decision.answered", payload: { decisionId: "d1", answer: "A" } },
          { actor: { human: true } },
        ),
        ev(
          { type: "decision.answered", payload: { decisionId: "d1", answer: "B" } },
          { actor: { human: true } },
        ),
      ]),
    );
    const d = s.decisions[0];
    expect(d?.status).toBe("answered");
    expect(d?.answer).toBe("A");
    expect(d?.rejected.map((r) => r.answer)).toEqual(["B"]);
  });

  it("未知の判断への回答・重複した判断要求は拒否される", () => {
    const r = foldEvents([
      ...base(),
      ev({ type: "decision.answered", payload: { decisionId: "nope", answer: "x" } }),
    ]);
    expect(r.ok ? null : r.error.code).toBe("unknownDecision");
    const b = base();
    const req = ev({ type: "decision.requested", payload: { decisionId: "d", nodeId: "a" } });
    const r2 = foldEvents([
      ...b,
      req,
      ev({ type: "decision.requested", payload: { decisionId: "d", nodeId: "a" } }),
    ]);
    expect(r2.ok ? null : r2.error.code).toBe("duplicateDecision");
  });
});

describe("envelope の検査", () => {
  it("未知の type は拒否（無視しない）", () => {
    const r = foldEvents([ev({ type: "node.exploded", payload: {} } as unknown as EventBody)]);
    expect(r.ok ? null : r.error.code).toBe("unknownEventType");
  });

  it("seq の重複・空の requestId は拒否", () => {
    const a = ev(created("root", "integrator", null), { seq: 5 });
    const b = ev(created("x", "implement", "root"), { seq: 5 });
    const r = foldEvents([a, b]);
    expect(r.ok ? null : r.error.code).toBe("duplicateSeq");
    const r2 = foldEvents([ev(created("root", "integrator", null), { requestId: "" })]);
    expect(r2.ok ? null : r2.error.code).toBe("invalidRequestId");
  });

  it("applyEvent は seq が増えないイベントを拒否する", () => {
    const s = must(foldEvents(base()));
    const r = applyEvent(s, ev(created("c", "implement", "root"), { seq: 1 }));
    expect(r.ok ? null : r.error.code).toBe("seqNotIncreasing");
  });
});

describe("requestId の冪等性（NFR_003）", () => {
  it("同じ requestId・同一内容のイベントは無視され、結果は変わらない", () => {
    const log = base();
    const first = log[1] as OrchEvent;
    const dup = { ...first, seq: 1_000_000 } as OrchEvent;
    expect(must(foldEvents([...log, dup]))).toEqual(must(foldEvents(log)));
  });

  it("内容の違う同じ requestId は requestIdConflict", () => {
    const log = base();
    const first = log[1] as OrchEvent;
    const clash = ev(created("other", "implement", "root"), { requestId: first.requestId });
    const r = foldEvents([...log, clash]);
    expect(r.ok ? null : r.error.code).toBe("requestIdConflict");
  });

  it("payload のキー順が違うだけの同一内容は重複として扱う", () => {
    const b = base();
    const e1 = ev({
      type: "inbox.added",
      payload: { id: "i", kind: "info", nodeId: "a", dependsOn: [] },
    });
    const e2 = {
      ...e1,
      seq: e1.seq + 100,
      payload: { dependsOn: [], nodeId: "a", kind: "info", id: "i" },
    } as OrchEvent;
    expect(must(foldEvents([...b, e1, e2]))).toEqual(must(foldEvents([...b, e1])));
  });
});

describe("入力を変更しない", () => {
  it("fold は入力の配列・イベントを変更しない", () => {
    const log = base();
    const frozen = JSON.stringify(log);
    foldEvents(log);
    expect(JSON.stringify(log)).toBe(frozen);
  });
});

// ---- 性質（fast-check） ----

const NODE_EVENTS: readonly NodeEvent[] = [
  { type: "start" },
  { type: "requestDecision" },
  { type: "resume" },
  { type: "reportDone" },
  { type: "accept" },
  { type: "reject" },
  { type: "stop", mode: "graceful" },
  { type: "stop", mode: "immediate" },
  { type: "stopTimeout" },
  { type: "retryStop" },
  { type: "confirmStopped" },
  { type: "restart", dependenciesDone: false },
  { type: "markReclaimable", discarded: false },
  { type: "markReclaimable", discarded: true },
  { type: "archive" },
];

type Pick3 = readonly [number, number, number];
const stepArb = fc.tuple(fc.nat(), fc.nat(), fc.nat()) as fc.Arbitrary<Pick3>;

/** 候補を順に試し、applyEvent が受け付けたものだけを足した、妥当なログを作る（モデルベース）。 */
function buildLog(steps: readonly Pick3[]): OrchEvent[] {
  const log: OrchEvent[] = [];
  let state = initialState();
  let n = 0;
  const tryAdd = (body: EventBody): void => {
    n += 1;
    const e = {
      seq: n * 2 - 1,
      at: "2026-10-20T00:00:00Z",
      requestId: `r${n}`,
      actor: SYS,
      ...body,
    } as OrchEvent;
    const r = applyEvent(state, e);
    if (r.ok) {
      state = r.value;
      log.push(e);
    }
  };
  tryAdd(created("n0", "integrator", null));
  steps.forEach(([k, a, b], i) => {
    const ids = state.nodes.map((x) => x.id);
    const pick = (x: number): string => ids[x % ids.length] as string;
    switch (k % 6) {
      case 0:
        tryAdd(
          created(
            `n${i + 1}`,
            a % 3 === 0 ? "integrator" : "implement",
            pick(a),
            b % 2 === 0 ? [] : [pick(b)],
          ),
        );
        break;
      case 1:
      case 2:
      case 3:
        tryAdd(changed(pick(a), NODE_EVENTS[b % NODE_EVENTS.length] as NodeEvent));
        break;
      case 4:
        if (b % 3 === 0) {
          tryAdd({
            type: "scope.violation",
            payload: { nodeId: pick(a), reason: "outsideWritable", subject: `/x/${i}` },
          });
          break;
        }
        tryAdd({
          type: "inbox.added",
          payload: {
            id: `i${i}`,
            kind: INBOX_KINDS[b % INBOX_KINDS.length] as never,
            nodeId: pick(a),
            dependsOn: [],
          },
        });
        break;
      default:
        tryAdd(
          b % 2 === 0
            ? { type: "decision.requested", payload: { decisionId: `d${i}`, nodeId: pick(a) } }
            : {
                type: "decision.answered",
                payload: { decisionId: `d${a % (i + 1)}`, answer: `ans${b}` },
              },
        );
    }
  });
  return log;
}

const logArb = fc.array(stepArb, { maxLength: 60, size: "large" }).map(buildLog);

describe("性質（fast-check）", () => {
  it("生成するログは自明でない（多様なイベント型と状態を含む）", () => {
    const logs = fc.sample(logArb, 200);
    const types = new Set(logs.flatMap((l) => l.map((e) => e.type)));
    expect(types.size).toBe(6);
    expect(Math.max(...logs.map((l) => l.length))).toBeGreaterThan(15);
    const states = new Set(logs.flatMap((l) => must(foldEvents(l)).nodes.map((n) => n.state)));
    expect(states.size).toBeGreaterThanOrEqual(6);
  });

  it("fold は、1 件ずつ applyEvent した結果と一致する", () => {
    fc.assert(
      fc.property(logArb, (log) => {
        let s = initialState();
        for (const e of log) {
          const r = applyEvent(s, e);
          expect(r.ok).toBe(true);
          if (r.ok) s = r.value;
        }
        expect(must(foldEvents(log))).toEqual(s);
      }),
    );
  });

  it("入力順を入れ替えても結果は同一（seq の昇順に畳み込む）", () => {
    const shuffled = logArb.chain((l) =>
      fc.tuple(
        fc.constant(l),
        fc.shuffledSubarray([...l], { minLength: l.length, maxLength: l.length }),
      ),
    );
    fc.assert(
      fc.property(shuffled, ([log, perm]) => {
        expect(must(foldEvents(perm))).toEqual(must(foldEvents(log)));
      }),
    );
  });

  it("同じ requestId の重複（seq は元より後）を何件混ぜても、結果は変わらない", () => {
    fc.assert(
      fc.property(logArb, fc.array(fc.nat(), { maxLength: 10 }), (log, picks) => {
        fc.pre(log.length > 0);
        const dups = picks.map(
          (p, i) => ({ ...(log[p % log.length] as OrchEvent), seq: 1000 + i }) as OrchEvent,
        );
        expect(must(foldEvents([...log, ...dups]))).toEqual(must(foldEvents(log)));
      }),
    );
  });

  it("ログの接頭辞の fold は、常に成功する（途中の状態も妥当）", () => {
    fc.assert(
      fc.property(logArb, fc.nat(), (log, cut) => {
        expect(foldEvents(log.slice(0, cut % (log.length + 1))).ok).toBe(true);
      }),
    );
  });

  it("T03 の遷移表と矛盾するイベントを足すと、必ず拒否される（状態は変わらない）", () => {
    fc.assert(
      fc.property(logArb, fc.nat(), fc.nat(), (log, a, b) => {
        const s = must(foldEvents(log));
        const node = s.nodes[a % s.nodes.length];
        fc.pre(node !== undefined);
        const e = NODE_EVENTS[b % NODE_EVENTS.length] as NodeEvent;
        const r = applyEvent(s, ev(changed((node as { id: string }).id, e), { seq: 100000 }));
        if (!r.ok)
          expect([
            "invalidTransition",
            "dependenciesNotVerified",
            "reclaimInvariant",
            "discardRequired",
            "alreadyFinished",
          ]).toContain(r.error.code);
        else expect(r.value.nodes.length).toBe(s.nodes.length);
      }),
    );
  });

  it("導出された木は常に妥当で、全ノードの状態は NodeState", () => {
    fc.assert(
      fc.property(logArb, (log) => {
        const s = must(foldEvents(log));
        const ids = new Set(s.nodes.map((n) => n.id));
        expect(ids.size).toBe(s.nodes.length);
        for (const n of s.nodes) if (n.parentId !== null) expect(ids.has(n.parentId)).toBe(true);
      }),
    );
  });
});
