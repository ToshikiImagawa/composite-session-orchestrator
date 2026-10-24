import { describe, expect, it } from "vitest";
import {
  type EventBody,
  foldEvents,
  LIMITS,
  type NodeEvent,
  type OrchEvent,
  type OrchState,
  purgeEventSeqs,
  visibleState,
} from "../src/index.js";

const SYS = { system: true } as const;
const HUMAN = { human: true } as const;
let counter = 1000;
const ev = (body: EventBody, over: Partial<Pick<OrchEvent, "seq" | "actor">> = {}): OrchEvent => {
  counter += 1;
  return {
    seq: over.seq ?? counter,
    at: "2026-10-20T00:00:00Z",
    requestId: `req-${counter}`,
    actor: over.actor ?? SYS,
    ...body,
  } as OrchEvent;
};
const created = (n: number, nodeId: string, parentId: string | null) =>
  ev(
    {
      type: "node.created",
      payload: {
        nodeId,
        role: parentId === null ? "integrator" : "implement",
        parentId,
        dependsOn: [],
      },
    },
    { seq: n },
  );
const changed = (n: number, nodeId: string, event: NodeEvent) =>
  ev({ type: "node.stateChanged", payload: { nodeId, event } }, { seq: n });
const declared = (n: number, nodeId: string, note?: string) =>
  ev(
    { type: "node.stopDeclared", payload: { nodeId, ...(note === undefined ? {} : { note }) } },
    { seq: n, actor: HUMAN },
  );
const must = (r: ReturnType<typeof foldEvents>): OrchState => {
  if (!r.ok) throw new Error(`fold failed: ${r.error.code} ${r.error.cause}`);
  return r.value;
};
/** root ─ a（stopIncomplete）。 */
const base = (): OrchEvent[] => [
  created(1, "root", null),
  changed(2, "root", { type: "start" }),
  created(3, "a", "root"),
  changed(4, "a", { type: "start" }),
  changed(5, "a", { type: "stop", mode: "immediate" }),
  changed(6, "a", { type: "stopTimeout" }),
];

describe("node.stopDeclared（停止の宣言。記録のみ）", () => {
  it("stopIncomplete のノードに記録し、宣言者（actor）と根拠を残す。状態は変えない", () => {
    const s = must(foldEvents([...base(), declared(7, "a", "Desktop でアーカイブした")]));
    expect(s.stopDeclarations).toEqual([
      {
        seq: 7,
        at: "2026-10-20T00:00:00Z",
        nodeId: "a",
        note: "Desktop でアーカイブした",
        actor: HUMAN,
      },
    ]);
    expect(s.nodes.find((n) => n.id === "a")?.state).toBe("stopIncomplete");
  });

  it("宣言の後の confirmStopped で stopped に進む（ログの再生でも同じ）", () => {
    const events = [...base(), declared(7, "a"), changed(8, "a", { type: "confirmStopped" })];
    const s = must(foldEvents(events));
    expect(s.nodes.find((n) => n.id === "a")?.state).toBe("stopped");
    expect(s.stopDeclarations).toHaveLength(1);
    // 途中までの状態から続きを畳んでも、同じ結果
    const mid = must(foldEvents(events.slice(0, 7)));
    expect(must(foldEvents(events.slice(7), mid))).toEqual(s);
  });

  it("stopIncomplete でないノード・未知のノード・不正な payload は拒否する", () => {
    const running = [
      created(1, "root", null),
      changed(2, "root", { type: "start" }),
      created(3, "a", "root"),
      changed(4, "a", { type: "start" }),
    ];
    const r1 = foldEvents([...running, declared(5, "a")]);
    expect(r1.ok ? null : r1.error.code).toBe("invalidTransition");
    const r2 = foldEvents([...base(), declared(7, "zz")]);
    expect(r2.ok).toBe(false);
    const r3 = foldEvents([...base(), declared(7, "a", "x".repeat(LIMITS.summary + 1))]);
    expect(r3.ok).toBe(false);
  });

  it("スナップショット: 古いもの（項目なし）は空として受け入れ、JSON の往復で保たれる", () => {
    const s = must(foldEvents([...base(), declared(7, "a", "n")]));
    const { stopDeclarations: _drop, ...old } = s;
    expect(must(foldEvents([], old as unknown as OrchState)).stopDeclarations).toEqual([]);
    const round = JSON.parse(JSON.stringify(s)) as OrchState;
    expect(must(foldEvents([], round)).stopDeclarations).toEqual(s.stopDeclarations);
    const broken = { ...round, stopDeclarations: [{ seq: 1 }] } as unknown as OrchState;
    expect(foldEvents([], broken).ok).toBe(false);
  });

  it("最終削除: 対象のノードの宣言のイベントは消す対象に入る", () => {
    const events = [...base(), declared(7, "a")];
    expect(purgeEventSeqs(events, new Set(["a"]))).toContain(7);
  });

  it("見える範囲: 呼び出し元の部分木のノードの宣言だけ見える", () => {
    const s = must(foldEvents([...base(), created(7, "b", "root"), declared(8, "a")]));
    expect(visibleState(s, "a").stopDeclarations).toHaveLength(1);
    expect(visibleState(s, "b").stopDeclarations).toHaveLength(0);
  });
});
