import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { NODE_STATES, type NodeEvent, type NodeState, transition } from "../src/index.js";

const stopG: NodeEvent = { type: "stop", mode: "graceful" };
const stopI: NodeEvent = { type: "stop", mode: "immediate" };

/** 許可された遷移の全体（状態, イベント → 遷移先と効果）。ここに無い組はすべて拒否される。 */
type Row = readonly [
  NodeState,
  NodeEvent,
  NodeState,
  ("gracefulStop" | "immediateStop" | "cancelStart")?,
];
const ALLOWED: readonly Row[] = [
  ["pending", { type: "start" }, "running"],
  ["running", { type: "requestDecision" }, "waiting"],
  ["waiting", { type: "resume" }, "running"],
  ["running", { type: "reportDone" }, "done"],
  ["done", { type: "accept" }, "verified"],
  ["done", { type: "reject" }, "running"],
  // 停止要求（Q1: waiting は猶予なしの即時停止の指示つき。Q2: pending は起動の取り消しで直行）
  ["running", stopG, "stopping", "gracefulStop"],
  ["running", stopI, "stopping", "immediateStop"],
  ["waiting", stopG, "stopping", "immediateStop"],
  ["waiting", stopI, "stopping", "immediateStop"],
  ["pending", stopG, "stopped", "cancelStart"],
  ["pending", stopI, "stopped", "cancelStart"],
  // 停止の進行（Q3）
  ["stopping", { type: "stopTimeout" }, "stopIncomplete"],
  ["stopIncomplete", { type: "retryStop" }, "stopping", "immediateStop"],
  ["stopping", { type: "confirmStopped" }, "stopped"],
  ["stopIncomplete", { type: "confirmStopped" }, "stopped"],
  // 再開: 依存待ちを飛ばさない。依存先が完了済みなら続けて start して running
  ["stopped", { type: "restart", dependenciesDone: false }, "pending"],
  ["stopped", { type: "restart", dependenciesDone: true }, "running"],
  // 回収
  ["verified", { type: "markReclaimable", discarded: false }, "reclaimable"],
  ["verified", { type: "markReclaimable", discarded: true }, "reclaimable"],
  ["stopped", { type: "markReclaimable", discarded: true }, "reclaimable"],
  ["reclaimable", { type: "archive" }, "archived"],
];

const EVENTS: readonly NodeEvent[] = [
  { type: "start" },
  { type: "requestDecision" },
  { type: "resume" },
  { type: "reportDone" },
  { type: "accept" },
  { type: "reject" },
  stopG,
  stopI,
  { type: "stopTimeout" },
  { type: "retryStop" },
  { type: "confirmStopped" },
  { type: "restart", dependenciesDone: false },
  { type: "restart", dependenciesDone: true },
  { type: "markReclaimable", discarded: false },
  { type: "markReclaimable", discarded: true },
  { type: "archive" },
];

// 停止の対象にならない状態。停止要求は「既に終了」（alreadyFinished）を返す。
const FINISHED: readonly NodeState[] = ["done", "verified", "reclaimable", "archived"];
// 停止要求を一度受け付けた状態。再送は成功（changed: false）で、状態は変わらない。
const STOP_ACCEPTED: readonly NodeState[] = ["stopping", "stopIncomplete", "stopped"];
const isStop = (e: NodeEvent): boolean => e.type === "stop";

describe("遷移表（表駆動）", () => {
  it.each(ALLOWED.map((row) => [...row]))("%s + %j → %s", (...row) => {
    const [from, event, to, effect] = row as unknown as Row;
    const r = transition(from, event);
    expect(r).toEqual({
      ok: true,
      value: { state: to, changed: true, ...(effect ? { effect } : {}) },
    });
  });

  it("表にない（状態, イベント）の組は拒否する（停止要求の冪等・終了を除く）", () => {
    const allowedKey = new Set(ALLOWED.map(([s, e]) => `${s}|${JSON.stringify(e)}`));
    for (const s of NODE_STATES) {
      for (const e of EVENTS) {
        if (allowedKey.has(`${s}|${JSON.stringify(e)}`)) continue;
        if (isStop(e) && (STOP_ACCEPTED.includes(s) || FINISHED.includes(s))) continue;
        if (s === "stopped" && e.type === "markReclaimable") continue; // discardRequired（別テスト）
        const r = transition(s, e);
        expect(r.ok, `${s} + ${JSON.stringify(e)}`).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe("invalidTransition");
          expect(r.error.nextActions.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("停止した子を回収可能にするには破棄の判断が必要", () => {
    const r = transition("stopped", { type: "markReclaimable", discarded: false });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("discardRequired");
  });
});

describe("停止要求", () => {
  it("停止要求を受け付けた状態（stopping / stopIncomplete / stopped）への再送は成功で、状態は不変（冪等）", () => {
    for (const s of STOP_ACCEPTED) {
      for (const e of [stopG, stopI]) {
        const r = transition(s, e);
        expect(r.ok, s).toBe(true);
        if (r.ok) {
          expect(r.value.state).toBe(s);
          expect(r.value.changed).toBe(false);
        }
      }
    }
  });

  it("stopping に即時の停止要求が来たら、即時停止へ切り替える（穏当な要求は進行中の停止を継続）", () => {
    expect(transition("stopping", stopI)).toEqual({
      ok: true,
      value: { state: "stopping", changed: false, effect: "immediateStop" },
    });
    expect(transition("stopping", stopG)).toEqual({
      ok: true,
      value: { state: "stopping", changed: false },
    });
  });

  it("停止の対象にならない状態は「既に終了」を返し、何も起こさない", () => {
    for (const s of FINISHED) {
      for (const e of [stopG, stopI]) {
        const r = transition(s, e);
        expect(r.ok, s).toBe(false);
        if (!r.ok) {
          expect(r.error.code).toBe("alreadyFinished");
          expect(r.error.nextActions.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("性質（fast-check）", () => {
  const eventArb = fc.constantFrom(...EVENTS);

  /** 拒否は状態を変えない。許可された遷移だけが状態を進める。 */
  const run = (start: NodeState, events: readonly NodeEvent[]): NodeState =>
    events.reduce<NodeState>((s, e) => {
      const r = transition(s, e);
      return r.ok ? r.value.state : s;
    }, start);

  it("任意のイベント列で、結果の状態は常に NodeState。changed は状態の変化と一致", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...NODE_STATES),
        fc.array(eventArb, { maxLength: 30 }),
        (start, events) => {
          let s = start;
          for (const e of events) {
            const r = transition(s, e);
            if (r.ok) {
              expect(NODE_STATES).toContain(r.value.state);
              expect(r.value.changed).toBe(r.value.state !== s);
              s = r.value.state;
            }
          }
        },
      ),
    );
  });

  it("停止の対象にならない状態は停止要求で不変", () => {
    fc.assert(
      fc.property(fc.constantFrom(...FINISHED), fc.constantFrom(stopG, stopI), (s, e) => {
        expect(run(s, [e])).toBe(s);
      }),
    );
  });

  it("同じ停止要求を 2 回送っても結果は同一。再送の応答は、成功なら成功（changed: false）、失敗なら同じ失敗", () => {
    fc.assert(
      fc.property(fc.constantFrom(...NODE_STATES), fc.constantFrom(stopG, stopI), (s, e) => {
        expect(run(s, [e, e])).toBe(run(s, [e]));
        const first = transition(s, e);
        if (first.ok) {
          const again = transition(first.value.state, e);
          expect(again.ok).toBe(true);
          if (again.ok) {
            expect(again.value.state).toBe(first.value.state);
            expect(again.value.changed).toBe(false);
          }
        } else {
          expect(transition(s, e)).toEqual(first);
        }
      }),
    );
  });

  it("archived は吸収状態（どのイベントでも出られない）", () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 10 }), (events) => {
        expect(run("archived", events)).toBe("archived");
      }),
    );
  });

  it("許可された遷移だけをたどって、pending から全状態に到達でき、全状態から archived に到達できる", () => {
    const next = (s: NodeState): NodeState[] =>
      ALLOWED.filter(([from]) => from === s).map(([, , to]) => to);
    const reach = (from: NodeState): Set<NodeState> => {
      const seen = new Set<NodeState>([from]);
      const queue: NodeState[] = [from];
      while (queue.length > 0) {
        for (const n of next(queue.shift() as NodeState)) {
          if (!seen.has(n)) {
            seen.add(n);
            queue.push(n);
          }
        }
      }
      return seen;
    };
    expect([...reach("pending")].sort()).toEqual([...NODE_STATES].sort());
    for (const s of NODE_STATES) expect(reach(s).has("archived"), s).toBe(true);
  });

  it("running・waiting から stopped への経路は必ず confirmStopped を通る（それを除いた遷移では到達不能）", () => {
    const edges = ALLOWED.filter(([, e]) => e.type !== "confirmStopped");
    for (const start of ["running", "waiting"] as const) {
      const seen = new Set<NodeState>([start]);
      const queue: NodeState[] = [start];
      while (queue.length > 0) {
        const cur = queue.shift() as NodeState;
        for (const [from, , to] of edges) {
          if (from === cur && !seen.has(to)) {
            seen.add(to);
            queue.push(to);
          }
        }
      }
      expect(seen.has("stopped"), start).toBe(false);
    }
  });

  it("表の遷移は transition の実装と一致する（実装にだけある遷移がない）", () => {
    fc.assert(
      fc.property(fc.constantFrom(...NODE_STATES), eventArb, (s, e) => {
        const r = transition(s, e);
        const row = ALLOWED.find(
          ([from, ev]) => from === s && JSON.stringify(ev) === JSON.stringify(e),
        );
        if (r.ok && r.value.changed) expect(row?.[2]).toBe(r.value.state);
        if (row) expect(r.ok && r.value.state).toBe(row[2]);
      }),
    );
  });
});
