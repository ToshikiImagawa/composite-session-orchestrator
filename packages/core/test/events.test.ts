import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyEvent,
  type EventBody,
  foldEvents,
  INBOX_KINDS,
  initialState,
  isStopOutcome,
  type NodeEvent,
  type OrchEvent,
  type OrchState,
  STOP_OUTCOMES,
  type StopOutcome,
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
  ev(changed("root", { type: "start" })),
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
      ["root", "running"],
      ["a", "pending"],
      ["b", "pending"],
    ]);
  });

  it("木の不変条件に反する node.created は seq つきで拒否される", () => {
    const bad = foldEvents([
      ev(created("root", "integrator", null)),
      ev(changed("root", { type: "start" })),
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
      ev(changed("root", { type: "start" })),
      ev(created("a", "implement", "root", ["ghost"])),
    ]);
    expect(r1.ok ? null : r1.error.code).toBe("unknownDependency");
    const r2 = foldEvents([
      ev(created("root", "integrator", null)),
      ev(changed("root", { type: "start" })),
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
      ev(changed("root", { type: "start" })),
      ev(created("a", "implement", "root")),
    ];
    const finishRoot = (): OrchEvent[] => [
      ev(changed("root", { type: "reportDone" })),
      ev(changed("root", { type: "accept" })),
    ];
    const bad = foldEvents([
      ...tree,
      ...finishRoot(),
      ...toVerified("a"),
      ev(changed("root", { type: "markReclaimable", discarded: false })),
    ]);
    expect(bad.ok ? null : bad.error.code).toBe("reclaimInvariant");
    const good = must(
      foldEvents([
        ...tree,
        ...finishRoot(),
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
      payload: { id: "i1", kind: "progress", nodeId: "a" },
    });
    const s = must(foldEvents([...b, e]));
    expect(s.inbox).toEqual([
      { seq: e.seq, id: "i1", kind: "progress", nodeId: "a", dependsOn: [], at: e.at },
    ]);
    const dup = foldEvents([
      ...b,
      e,
      ev({ type: "inbox.added", payload: { id: "i1", kind: "info", nodeId: "a" } }),
    ]);
    expect(dup.ok ? null : dup.error.code).toBe("duplicateInboxId");
  });

  it("未知のノード・種類の inbox.added は拒否される", () => {
    const r = foldEvents([
      ...base(),
      ev({
        type: "inbox.added",
        payload: { id: "i", kind: "bogus" as never, nodeId: "a" },
      }),
    ]);
    expect(r.ok ? null : r.error.code).toBe("invalidPayload");
    const r2 = foldEvents([
      ...base(),
      ev({ type: "inbox.added", payload: { id: "i", kind: "info", nodeId: "zzz" } }),
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
      payload: { id: "i", kind: "info", nodeId: "a" },
    });
    const e2 = {
      ...e1,
      seq: e1.seq + 100,
      payload: { nodeId: "a", kind: "info", id: "i" },
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
      state = r.value.state;
      log.push(e);
    }
  };
  tryAdd(created("n0", "integrator", null));
  tryAdd(changed("n0", { type: "start" }));
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
          if (r.ok) {
            expect(r.value.applied).toBe(true);
            s = r.value.state;
          }
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
            "parentNotActive",
            "reclaimInvariant",
            "discardRequired",
            "alreadyFinished",
          ]).toContain(r.error.code);
        else expect(r.value.state.nodes.length).toBe(s.nodes.length);
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

describe("親の状態・依存の制約", () => {
  const tree = (): OrchEvent[] => [
    ev(created("root", "integrator", null)),
    ev(changed("root", { type: "start" })),
  ];

  it("子を作れるのは、親が running か waiting のときだけ", () => {
    const pendingParent = foldEvents([
      ...tree(),
      ev(created("m", "integrator", "root")), // pending のまま
      ev(created("c", "implement", "m")),
    ]);
    expect(pendingParent.ok ? null : pendingParent.error.code).toBe("parentNotActive");

    const waiting = must(
      foldEvents([
        ...tree(),
        ev(changed("root", { type: "requestDecision" })),
        ev(created("c", "implement", "root")),
      ]),
    );
    expect(stateOf(waiting, "c")).toBe("pending");

    for (const [steps, label] of [
      [[{ type: "reportDone" }], "done"],
      [[{ type: "reportDone" }, { type: "accept" }], "verified"],
      [[{ type: "stop", mode: "immediate" }], "stopping"],
      [[{ type: "stop", mode: "immediate" }, { type: "confirmStopped" }], "stopped"],
    ] as const) {
      const r = foldEvents([
        ...tree(),
        ...steps.map((e) => ev(changed("root", e as NodeEvent))),
        ev(created("c", "implement", "root")),
      ]);
      expect(r.ok ? null : r.error.code, label).toBe("parentNotActive");
    }
  });

  it("依存先に、自分の親・祖先は指定できない（相互待ちの防止）", () => {
    const withMid = [
      ...tree(),
      ev(created("m", "integrator", "root")),
      ev(changed("m", { type: "start" })),
      ev(created("sib", "implement", "root")),
    ];
    for (const dep of ["m", "root"]) {
      const r = foldEvents([...withMid, ev(created("c", "implement", "m", [dep]))]);
      expect(r.ok ? null : r.error.code, dep).toBe("dependsOnAncestor");
    }
    const ok1 = must(foldEvents([...withMid, ev(created("c", "implement", "m", ["sib"]))]));
    expect(stateOf(ok1, "c")).toBe("pending");
  });

  it("依存先の完了は verified 以降（verified・reclaimable・archived）。done では起動できない", () => {
    const b = base();
    const toArchived: OrchEvent[] = [
      ev(changed("a", { type: "start" })),
      ev(changed("a", { type: "reportDone" })),
      ev(changed("a", { type: "accept" })),
      ev(changed("a", { type: "markReclaimable", discarded: false })),
      ev(changed("a", { type: "archive" })),
    ];
    const s = must(foldEvents([...b, ...toArchived, ev(changed("b", { type: "start" }))]));
    expect(stateOf(s, "a")).toBe("archived");
    expect(stateOf(s, "b")).toBe("running");
  });
});

describe("applyEvent の結果と不変性", () => {
  it("新しいイベントは applied: true、重複は applied: false で状態は同一", () => {
    const s = must(foldEvents(base()));
    const e = ev({
      type: "scope.violation",
      payload: { nodeId: "a", reason: "outsideWritable", subject: "/x" },
    });
    const r1 = applyEvent(s, e);
    expect(r1.ok && r1.value.applied).toBe(true);
    if (!r1.ok) throw new Error("unexpected");
    const dup = applyEvent(r1.value.state, { ...e, seq: e.seq + 1000 } as OrchEvent);
    expect(dup.ok && dup.value.applied).toBe(false);
    expect(dup.ok && dup.value.state).toBe(r1.value.state);
  });

  it("導出した状態は凍結されている（入力の状態も変更されない）", () => {
    const s = must(foldEvents(base()));
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.isFrozen(s.nodes)).toBe(true);
    expect(Object.isFrozen(s.nodes[0])).toBe(true);
    const before = JSON.stringify(s);
    applyEvent(s, ev(created("z", "implement", "root")));
    expect(JSON.stringify(s)).toBe(before);
  });

  it("inbox.added の依存先はノードの記録から導き、payload の値は使わない", () => {
    const b = base();
    const e = ev({
      type: "inbox.added",
      payload: { id: "i", kind: "info", nodeId: "b", dependsOn: ["root"] } as never,
    });
    const s = must(foldEvents([...b, e]));
    expect(s.inbox[0]?.dependsOn).toEqual(["a"]);
  });

  it("inbox.added の at は ISO 8601 UTC でなければ拒否される", () => {
    const b = base();
    const e = {
      ...ev({ type: "inbox.added", payload: { id: "i", kind: "info", nodeId: "a" } }),
      at: "yesterday",
    } as OrchEvent;
    const r = foldEvents([...b, e]);
    expect(r.ok ? null : r.error.code).toBe("invalidPayload");
  });

  it("スナップショットからの再開: 接頭辞の状態に残りを畳み込むと、全体の畳み込みと一致する", () => {
    fc.assert(
      fc.property(logArb, fc.nat(), (log, cut) => {
        const k = cut % (log.length + 1);
        const snapshot = must(foldEvents(log.slice(0, k)));
        expect(must(foldEvents(log.slice(k), snapshot))).toEqual(must(foldEvents(log)));
      }),
    );
  });

  it("大きなログでも現実的な時間で畳み込める（3000 ノード）", () => {
    const log: OrchEvent[] = [
      {
        seq: 1,
        at: "2026-10-20T00:00:00Z",
        requestId: "r1",
        actor: SYS,
        ...created("root", "integrator", null),
      },
      {
        seq: 2,
        at: "2026-10-20T00:00:00Z",
        requestId: "r2",
        actor: SYS,
        ...changed("root", { type: "start" }),
      },
    ];
    for (let i = 0; i < 3000; i++) {
      log.push({
        seq: i + 3,
        at: "2026-10-20T00:00:00Z",
        requestId: `c${i}`,
        actor: SYS,
        ...created(`n${i}`, "implement", "root"),
      });
    }
    const t0 = Date.now();
    const s = must(foldEvents(log));
    expect(s.nodes).toHaveLength(3001);
    expect(Date.now() - t0).toBeLessThan(5000);
  });
});

describe("壊れたイベントでも例外を出さない（全域関数）", () => {
  it("任意の値をイベントとして渡しても、foldEvents・applyEvent は例外を出さず、失敗か成功を返す", () => {
    fc.assert(
      fc.property(fc.array(fc.anything(), { maxLength: 6 }), (junk) => {
        const r = foldEvents(junk as never);
        expect(typeof r.ok).toBe("boolean");
        for (const j of junk) {
          const a = applyEvent(initialState(), j as never);
          expect(typeof a.ok).toBe("boolean");
        }
      }),
    );
  });

  it("妥当なイベントの一部の項目を壊しても、例外を出さず、失敗する", () => {
    const junkValue = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.integer(),
      fc.string(),
      fc.array(fc.anything()),
      fc.object(),
    );
    const mutate = (e: OrchEvent, key: string, v: unknown): OrchEvent => {
      const copy: Record<string, unknown> = { ...e };
      if (key.startsWith("payload."))
        copy.payload = { ...(e.payload as object), [key.slice(8)]: v };
      else copy[key] = v;
      return copy as unknown as OrchEvent;
    };
    fc.assert(
      fc.property(
        logArb,
        fc.nat(),
        junkValue,
        fc.constantFrom(
          "seq",
          "at",
          "requestId",
          "actor",
          "type",
          "payload",
          "payload.nodeId",
          "payload.event",
          "payload.kind",
          "payload.role",
          "payload.dependsOn",
          "payload.answer",
          "payload.decisionId",
        ),
        (log, pick, v, key) => {
          fc.pre(log.length > 0);
          const target = pick % log.length;
          const broken = log.map((e, i) => (i === target ? mutate(e, key, v) : e));
          const r = foldEvents(broken);
          expect(typeof r.ok).toBe("boolean");
        },
      ),
    );
  });

  it("undefined を含む複数のイベントでも失敗を返す（回帰: 並べ替えで例外になった）", () => {
    const b = base();
    for (const j of [undefined, null]) {
      expect(foldEvents([j as never, ...b]).ok).toBe(false);
      expect(foldEvents([...b, j as never]).ok).toBe(false);
    }
  });

  it("イベントが null や配列でも失敗を返す", () => {
    for (const j of [null, undefined, 1, "x", [], {}, { seq: 1 }, { seq: 1, requestId: "r" }]) {
      const r = foldEvents([j as never]);
      expect(r.ok, JSON.stringify(j)).toBe(false);
    }
  });

  it("payload の値を型ガードで検証する（role・mode・discarded・answer・reason）", () => {
    const b = base();
    const bad: EventBody[] = [
      {
        type: "node.created",
        payload: { nodeId: "x", role: "boss" as never, parentId: "root", dependsOn: [] },
      },
      {
        type: "node.stateChanged",
        payload: { nodeId: "a", event: { type: "stop", mode: "soon" } as never },
      },
      {
        type: "node.stateChanged",
        payload: { nodeId: "a", event: { type: "markReclaimable", discarded: "yes" } as never },
      },
      { type: "node.stateChanged", payload: { nodeId: "a", event: { type: "teleport" } as never } },
      { type: "decision.answered", payload: { decisionId: "d", answer: 5 as never } },
      {
        type: "scope.violation",
        payload: { nodeId: "a", reason: "whatever" as never, subject: "s" },
      },
    ];
    for (const body of bad) {
      const r = foldEvents([...b, ev(body)]);
      expect(r.ok ? null : r.error.code, JSON.stringify(body)).toBe("invalidPayload");
    }
  });
});

describe("requestId・seq の性質（fast-check）", () => {
  it("同じ requestId で内容が違うイベントは、必ず requestIdConflict", () => {
    fc.assert(
      fc.property(logArb, fc.nat(), (log, pick) => {
        fc.pre(log.length > 0);
        const first = log[pick % log.length] as OrchEvent;
        const clash = {
          seq: 1_000_000,
          at: first.at,
          requestId: first.requestId,
          actor: first.actor,
          type: "scope.violation",
          payload: { nodeId: "n0", reason: "outsideWritable", subject: `clash-${first.requestId}` },
        } as OrchEvent;
        const r = foldEvents([...log, clash]);
        expect(r.ok ? null : r.error.code).toBe("requestIdConflict");
      }),
    );
  });

  it("seq が重複すれば、入力順にかかわらず必ず duplicateSeq", () => {
    fc.assert(
      fc.property(logArb, fc.nat(), fc.boolean(), (log, pick, front) => {
        fc.pre(log.length > 0);
        const first = log[pick % log.length] as OrchEvent;
        const twin = { ...first, requestId: `twin-${first.requestId}` } as OrchEvent;
        const r = foldEvents(front ? [twin, ...log] : [...log, twin]);
        expect(r.ok ? null : r.error.code).toBe("duplicateSeq");
      }),
    );
  });
});

describe("停止の記録（node.stopObserved）と猶予時間（graceMs）", () => {
  /** a を running にし、穏当な停止を要求したログ。`stopSeq` は停止要求のイベントの seq。 */
  const stoppingLog = (graceMs: number | undefined = 60000) => {
    const b = base();
    const start = ev(changed("a", { type: "start" }));
    const stop = ev(
      changed(
        "a",
        graceMs === undefined
          ? { type: "stop", mode: "graceful" }
          : { type: "stop", mode: "graceful", graceMs },
      ),
    );
    return { log: [...b, start, stop], stopSeq: stop.seq };
  };
  const observed = (
    nodeId: string,
    outcome: StopOutcome | string,
    stopSeq: number,
    graceMs?: number,
  ): EventBody =>
    ({
      type: "node.stopObserved",
      payload: { nodeId, outcome, stopSeq, ...(graceMs === undefined ? {} : { graceMs }) },
    }) as EventBody;
  const code = (r: ReturnType<typeof foldEvents>): string | null => (r.ok ? null : r.error.code);

  it("停止要求の猶予時間（graceMs）は記録でき、遷移は graceMs の有無で変わらない", () => {
    const { log } = stoppingLog(60000);
    expect(stateOf(must(foldEvents(log)), "a")).toBe("stopping");
    const { log: plain } = stoppingLog(undefined);
    expect(stateOf(must(foldEvents(plain)), "a")).toBe("stopping");
  });

  it("graceMs は 1 以上 3,600,000 以下の整数。それ以外は invalidPayload", () => {
    for (const bad of [
      0,
      -1,
      1.5,
      3_600_001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      "60" as never,
      null as never,
    ]) {
      const { log } = stoppingLog(undefined);
      const r = foldEvents([
        ...log.slice(0, -1),
        ev(changed("a", { type: "stop", mode: "graceful", graceMs: bad })),
      ]);
      expect(code(r), String(bad)).toBe("invalidPayload");
    }
    for (const good of [1, 60000, 3_600_000]) {
      const { log } = stoppingLog(good);
      expect(foldEvents(log).ok, String(good)).toBe(true);
    }
  });

  it("即時停止（mode: immediate）と、判断待ち（waiting）への停止要求では graceMs を指定できない", () => {
    const { log } = stoppingLog(undefined);
    const immediate = foldEvents([
      ...log.slice(0, -1),
      ev(changed("a", { type: "stop", mode: "immediate", graceMs: 1000 })),
    ]);
    expect(code(immediate)).toBe("invalidPayload");
    const waiting = foldEvents([
      ...base(),
      ev(changed("a", { type: "start" })),
      ev(changed("a", { type: "requestDecision" })),
      ev(changed("a", { type: "stop", mode: "graceful", graceMs: 1000 })),
    ]);
    expect(code(waiting)).toBe("invalidPayload");
    const waitingOk = foldEvents([
      ...base(),
      ev(changed("a", { type: "start" })),
      ev(changed("a", { type: "requestDecision" })),
      ev(changed("a", { type: "stop", mode: "graceful" })),
    ]);
    expect(waitingOk.ok).toBe(true);
  });

  it("stopping 中に別の graceMs の停止要求が来ても、状態は変えず、無視されたことが応答で分かる", () => {
    const { log } = stoppingLog(60000);
    const s = must(foldEvents(log));
    const other = applyEvent(
      s,
      ev(changed("a", { type: "stop", mode: "graceful", graceMs: 5000 })),
    );
    expect(other.ok && other.value.applied).toBe(true); // イベントとしては記録される
    expect(other.ok && other.value.ignored).toBe("graceMsIgnored");
    expect(other.ok && stateOf(other.value.state, "a")).toBe("stopping");
    expect(other.ok && other.value.state.stopRequests).toEqual(s.stopRequests); // 進行中の停止の猶予は変わらない
    const same = applyEvent(
      s,
      ev(changed("a", { type: "stop", mode: "graceful", graceMs: 60000 })),
    );
    expect(same.ok && same.value.ignored).toBeUndefined();
    const none = applyEvent(s, ev(changed("a", { type: "stop", mode: "graceful" })));
    expect(none.ok && none.value.ignored).toBeUndefined();
  });

  it("停止要求は状態に残る（seq・ノード・種別・mode・graceMs）。retryStop も停止の試行として残る", () => {
    const { log, stopSeq } = stoppingLog(60000);
    const s = must(foldEvents(log));
    expect(s.stopRequests).toEqual([
      { seq: stopSeq, nodeId: "a", kind: "stop", mode: "graceful", graceMs: 60000 },
    ]);
    const timeout = ev(changed("a", { type: "stopTimeout" }));
    const retry = ev(changed("a", { type: "retryStop" }));
    const s2 = must(foldEvents([...log, timeout, retry]));
    expect(s2.stopRequests.at(-1)).toEqual({
      seq: retry.seq,
      nodeId: "a",
      kind: "retryStop",
      mode: "immediate",
    });
  });

  it("stopObserved は記録のみで、状態を変えない。停止要求の seq（stopSeq）と、そのときの graceMs を持つ", () => {
    const { log, stopSeq } = stoppingLog(60000);
    const before = must(foldEvents(log));
    const e = ev(observed("a", "interrupted", stopSeq, 60000));
    const s = must(foldEvents([...log, e]));
    expect(s.nodes).toEqual(before.nodes);
    expect(s.stopObservations).toEqual([
      {
        seq: e.seq,
        at: e.at,
        nodeId: "a",
        outcome: "interrupted",
        stopSeq,
        graceMs: 60000,
        actor: SYS,
      },
    ]);
  });

  it("同じ停止要求（stopSeq）につき観測は 1 件だけ（2 件目は observationAlreadyRecorded）。冪等な再送は無視される", () => {
    const { log, stopSeq } = stoppingLog(60000);
    const first = ev(observed("a", "withinGrace", stopSeq, 60000));
    const second = ev(observed("a", "aborted", stopSeq));
    expect(code(foldEvents([...log, first, second]))).toBe("observationAlreadyRecorded");
    const dup = must(foldEvents([...log, first, { ...first, seq: first.seq + 1000 } as OrchEvent]));
    expect(dup.stopObservations).toHaveLength(1);
  });

  it("stopSeq が当該ノードの停止要求でなければ拒否される（存在しない・別のノード・停止要求でないイベント）", () => {
    const { log } = stoppingLog(60000);
    expect(code(foldEvents([...log, ev(observed("a", "aborted", 99999))]))).toBe(
      "unknownStopRequest",
    );
    expect(code(foldEvents([...log, ev(observed("a", "aborted", 1))]))).toBe("unknownStopRequest"); // 停止要求でないイベント
    for (const bad of [0, -1, 1.5, "x" as never, undefined as never]) {
      expect(code(foldEvents([...log, ev(observed("a", "aborted", bad))])), String(bad)).toBe(
        "invalidPayload",
      );
    }
    // 別のノードの停止要求の seq
    const two = [
      ...base(),
      ev(changed("a", { type: "start" })),
      ev(created("c", "implement", "root")),
      ev(changed("c", { type: "start" })),
    ];
    const stopC = ev(changed("c", { type: "stop", mode: "immediate" }));
    const stopA = ev(changed("a", { type: "stop", mode: "immediate" }));
    expect(code(foldEvents([...two, stopC, stopA, ev(observed("a", "aborted", stopC.seq))]))).toBe(
      "unknownStopRequest",
    );
    expect(foldEvents([...two, stopC, stopA, ev(observed("a", "aborted", stopA.seq))]).ok).toBe(
      true,
    );
  });

  it("retryStop の後の観測は、retryStop の seq に結び付く", () => {
    const { log } = stoppingLog(60000);
    const timeout = ev(changed("a", { type: "stopTimeout" }));
    const retry = ev(changed("a", { type: "retryStop" }));
    const obs = ev(observed("a", "aborted", retry.seq));
    const s = must(foldEvents([...log, timeout, retry, obs]));
    expect(s.stopObservations.at(-1)?.stopSeq).toBe(retry.seq);
  });

  it("停止に関する状態（stopping・stopIncomplete・stopped）のノードにだけ記録できる", () => {
    const { log, stopSeq } = stoppingLog(60000);
    const stopped = must(
      foldEvents([
        ...log,
        ev(changed("a", { type: "confirmStopped" })),
        ev(observed("a", "withinGrace", stopSeq, 60000)),
      ]),
    );
    expect(stopped.stopObservations).toHaveLength(1);
    // 再開して running に戻ったノードには、過去の停止要求の観測を記録できない
    const resumed = foldEvents([
      ...log,
      ev(changed("a", { type: "confirmStopped" })),
      ev(changed("a", { type: "restart", dependenciesDone: true })),
      ev(observed("a", "withinGrace", stopSeq, 60000)),
    ]);
    expect(code(resumed)).toBe("invalidTransition");
  });

  it("未知のノード・不正な outcome・不正な graceMs は拒否される。未知の type は引き続き拒否される", () => {
    const { log, stopSeq } = stoppingLog(60000);
    expect(code(foldEvents([...log, ev(observed("zzz", "aborted", stopSeq))]))).toBe("unknownNode");
    expect(code(foldEvents([...log, ev(observed("a", "gracefully", stopSeq))]))).toBe(
      "invalidPayload",
    );
    expect(code(foldEvents([...log, ev(observed("a", "aborted", stopSeq, 0))]))).toBe(
      "invalidPayload",
    );
    expect(code(foldEvents([...log, ev(observed("a", "aborted", stopSeq, 3_600_001))]))).toBe(
      "invalidPayload",
    );
    expect(code(foldEvents([ev({ type: "node.stopObserved2", payload: {} } as never)]))).toBe(
      "unknownEventType",
    );
  });

  it("isStopOutcome は型ガード", () => {
    expect(STOP_OUTCOMES.every(isStopOutcome)).toBe(true);
    for (const x of ["x", "", null, undefined, 1, {}, ["withinGrace"]])
      expect(isStopOutcome(x)).toBe(false);
  });
});

describe("状態の壊れた値（スナップショットなど）で例外にならない", () => {
  const goodState = (): OrchState => must(foldEvents(base()));
  const corrupt = (patch: Record<string, unknown>): OrchState =>
    ({ ...goodState(), ...patch }) as unknown as OrchState;
  const junks: unknown[] = [5, {}, "abc", true, null, [null], [5], [{}], [{ seq: "x" }], [[]]];

  it("stopObservations・stopRequests・他の配列が壊れていれば、applyEvent・foldEvents は例外でなく invalidState の失敗を返す", () => {
    for (const key of [
      "stopObservations",
      "stopRequests",
      "nodes",
      "inbox",
      "decisions",
      "violations",
    ]) {
      for (const junk of junks) {
        const state = corrupt({ [key]: junk });
        const next = ev(changed("a", { type: "start" }));
        const a = applyEvent(state, next);
        expect(a.ok, `${key}=${JSON.stringify(junk)}`).toBe(false);
        expect(a.ok ? null : a.error.code).toBe("invalidState");
        const f = foldEvents([next], state);
        expect(f.ok ? null : f.error.code, key).toBe("invalidState");
      }
    }
  });

  it("requests が壊れていても invalidState", () => {
    for (const junk of [5, "x", null, [], [1]]) {
      const r = applyEvent(corrupt({ requests: junk }), ev(changed("a", { type: "start" })));
      expect(r.ok ? null : r.error.code, JSON.stringify(junk)).toBe("invalidState");
    }
  });

  it("欠けている項目（古いスナップショット）は空として受け入れる", () => {
    const { stopObservations: _a, stopRequests: _b, ...old } = goodState();
    const r = foldEvents([ev(changed("a", { type: "start" }))], old as unknown as OrchState);
    expect(r.ok).toBe(true);
    expect(r.ok && r.value.stopRequests).toEqual([]);
  });

  it("任意の値を状態にしても、例外を出さない", () => {
    fc.assert(
      fc.property(fc.anything(), (state) => {
        const a = applyEvent(state as never, ev(changed("a", { type: "start" })));
        expect(typeof a.ok).toBe("boolean");
        expect(typeof foldEvents([], state as never).ok).toBe("boolean");
      }),
    );
  });

  it("初期状態は stopObservations・stopRequests が空", () => {
    expect(initialState().stopObservations).toEqual([]);
    expect(initialState().stopRequests).toEqual([]);
  });
});
