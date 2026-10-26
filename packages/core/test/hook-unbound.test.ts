import { describe, expect, it } from "vitest";
import { type EventBody, foldEvents, type OrchEvent, purgeEventSeqs } from "../src/index.js";

const SYS = { system: true } as const;
let counter = 0;
const ev = (body: EventBody, actor: OrchEvent["actor"] = SYS): OrchEvent => {
  counter += 1;
  return {
    seq: counter,
    at: "2026-10-24T00:00:00Z",
    requestId: `req-${counter}`,
    actor,
    ...body,
  } as OrchEvent;
};
const base = (): OrchEvent[] => {
  counter = 0;
  return [
    ev({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    }),
    ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
    ev({
      type: "node.created",
      payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
    }),
  ];
};
const unbound = (nodeId: string, hadBinding: unknown, actor: OrchEvent["actor"]) =>
  ev({ type: "node.hookUnbound", payload: { nodeId, hadBinding } } as unknown as EventBody, actor);

describe("node.hookUnbound（フックの結び付けを外した記録。T22-hu）", () => {
  it("記録のみで、ノードの状態は変えない（lastSeq と要求の記録だけ進む）", () => {
    const events = base();
    const before = foldEvents(events);
    events.push(unbound("a", true, { human: true }));
    const after = foldEvents(events);
    if (!before.ok || !after.ok) throw new Error("fold failed");
    expect(after.value.nodes).toEqual(before.value.nodes);
    expect(after.value.lastSeq).toBe(4);
    expect(Object.keys(after.value.requests).length).toBe(
      Object.keys(before.value.requests).length + 1,
    );
  });

  it("payload の形が違う・未知のノードは、拒否する", () => {
    for (const bad of [unbound("a", "yes", SYS), unbound("", true, SYS)]) {
      const r = foldEvents([...base(), bad]);
      expect(r.ok).toBe(false);
    }
    const r = foldEvents([...base(), unbound("zzz", false, { nodeId: "root" })]);
    expect(r.ok ? null : r.error.code).toBe("unknownNode");
  });

  it("最終削除の対象（木のノードを主語とするイベント）に入る", () => {
    const events = [...base(), unbound("a", false, { nodeId: "root" })];
    expect(purgeEventSeqs(events, new Set(["a"]))).toEqual([3, 4]);
  });
});

describe("node.hookTokenIssued（フック専用のトークンを発行した記録。T22-ht）", () => {
  const issued = (nodeId: string) =>
    ev({ type: "node.hookTokenIssued", payload: { nodeId } } as unknown as EventBody, {
      human: true,
    });
  it("記録のみで、状態は変えない。未知のノード・形の誤りは拒否。最終削除の対象", () => {
    const events = base();
    const before = foldEvents(events);
    events.push(issued("a"));
    const after = foldEvents(events);
    if (!before.ok || !after.ok) throw new Error("fold failed");
    expect(after.value.nodes).toEqual(before.value.nodes);
    expect(after.value.lastSeq).toBe(4);
    const unknown = foldEvents([...base(), issued("zzz")]);
    expect(unknown.ok ? null : unknown.error.code).toBe("unknownNode");
    const bad = foldEvents([...base(), issued("")]);
    expect(bad.ok).toBe(false);
    expect(purgeEventSeqs([...base(), issued("a")], new Set(["a"]))).toEqual([3, 4]);
  });
});
