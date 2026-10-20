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
  ["stopIncomplete", { type: "retryStop" }, "stopping"],
  ["stopping", { type: "confirmStopped" }, "stopped"],
  ["stopIncomplete", { type: "confirmStopped" }, "stopped"],
  ["stopped", { type: "restart" }, "running"],
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
  { type: "restart" },
  { type: "markReclaimable", discarded: false },
  { type: "markReclaimable", discarded: true },
  { type: "archive" },
];

// Q4: 終了状態。停止要求は「既に終了」を返す。
const TERMINAL: readonly NodeState[] = ["done", "verified", "stopped", "reclaimable", "archived"];
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
        if (isStop(e) && (s === "stopping" || s === "stopIncomplete" || TERMINAL.includes(s)))
          continue;
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
  it("stopping / stopIncomplete は受け付けず、進行中の停止を継続する（冪等。状態は不変）", () => {
    for (const s of ["stopping", "stopIncomplete"] as const) {
      for (const e of [stopG, stopI]) {
        expect(transition(s, e)).toEqual({ ok: true, value: { state: s, changed: false } });
      }
    }
  });

  it("終了状態は「既に終了」を返し、何も起こさない", () => {
    for (const s of TERMINAL) {
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

  it("終了状態は停止要求で不変", () => {
    fc.assert(
      fc.property(fc.constantFrom(...TERMINAL), fc.constantFrom(stopG, stopI), (s, e) => {
        expect(run(s, [e])).toBe(s);
      }),
    );
  });

  it("同じ停止要求を 2 回送っても、結果は 1 回と同一", () => {
    fc.assert(
      fc.property(fc.constantFrom(...NODE_STATES), fc.constantFrom(stopG, stopI), (s, e) => {
        expect(run(s, [e, e])).toBe(run(s, [e]));
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
