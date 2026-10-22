import { describe, expect, it } from "vitest";
import {
  type EventBody,
  foldEvents,
  LIMITS,
  type NodeEvent,
  type OrchEvent,
  type OrchState,
  purgeEventSeqs,
  purgeHoldActive,
} from "../src/index.js";

const SYS = { system: true } as const;
const HUMAN = { human: true } as const;
const AT = "2026-01-10T00:00:00.000Z";
let counter = 0;
const ev = (body: EventBody, over: { at?: string; actor?: OrchEvent["actor"] } = {}): OrchEvent => {
  counter += 1;
  return {
    seq: counter,
    at: over.at ?? AT,
    requestId: `req-${counter}`,
    actor: over.actor ?? SYS,
    ...body,
  } as OrchEvent;
};
const created = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
  ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
const changed = (nodeId: string, event: NodeEvent) =>
  ev({ type: "node.stateChanged", payload: { nodeId, event } });
const archive = (nodeId: string): OrchEvent[] => [
  changed(nodeId, { type: "reportDone" }),
  changed(nodeId, { type: "accept" }),
  changed(nodeId, { type: "markReclaimable", discarded: false }),
  changed(nodeId, { type: "archive" }),
];
/** root(running) → t(アーカイブ済み。木の根) → c(アーカイブ済み) と、root → o（実行中）。 */
const base = (): OrchEvent[] => {
  counter = 0;
  return [
    created("root", "integrator", null),
    changed("root", { type: "start" }),
    created("t", "integrator", "root"),
    changed("t", { type: "start" }),
    created("c", "implement", "t"),
    changed("c", { type: "start" }),
    created("o", "implement", "root"),
    changed("o", { type: "start" }),
    ...archive("c"),
    ...archive("t"),
  ];
};
const hold = (nodeId: string, payload: Record<string, unknown> = {}, at = AT) =>
  ev({ type: "node.purgeHeld", payload: { nodeId, ...payload } } as never, { at, actor: HUMAN });
const release = (nodeId: string) =>
  ev({ type: "node.purgeHoldReleased", payload: { nodeId } } as never, { actor: HUMAN });
const code = (r: ReturnType<typeof foldEvents>) => (r.ok ? null : r.error.code);
const must = (r: ReturnType<typeof foldEvents>): OrchState => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
  return r.value;
};
const nodeOf = (s: OrchState, id: string) => s.nodes.find((n) => n.id === id);
const DAY = 86_400_000;

describe("node.purgeHeld・node.purgeHoldReleased（自動の最終削除の保留。T13f-h）", () => {
  it("木の根（親がアーカイブされていない、アーカイブ済みのノード）に保留を置く。無期限・期限つき・理由つき", () => {
    const s = must(foldEvents([...base(), hold("t")]));
    expect(nodeOf(s, "t")?.purgeHold).toMatchObject({ by: HUMAN, at: AT });
    expect(nodeOf(s, "t")?.purgeHold?.until).toBeUndefined();
    const u = must(
      foldEvents([...base(), hold("t", { until: "2026-02-01T00:00:00Z", reason: "調査中" })]),
    );
    expect(nodeOf(u, "t")?.purgeHold).toMatchObject({
      until: "2026-02-01T00:00:00Z",
      reason: "調査中",
    });
  });

  it("木の根でないノード（配下のアーカイブ済みのノード・実行中のノード・根）は拒否する", () => {
    expect(code(foldEvents([...base(), hold("c")]))).toBe("notPurgeRoot"); // 親 t がアーカイブ済み
    expect(code(foldEvents([...base(), hold("o")]))).toBe("notPurgeRoot"); // アーカイブでない
    expect(code(foldEvents([...base(), hold("root")]))).toBe("notPurgeRoot");
    expect(code(foldEvents([...base(), hold("zz")]))).toBe("unknownNode");
  });

  it("期限は、イベントの時刻より後で、365 日先まで。形が不正なら invalidPayload", () => {
    const limit = new Date(Date.parse(AT) + LIMITS.purgeHoldMaxDays * DAY).toISOString();
    expect(code(foldEvents([...base(), hold("t", { until: limit })]))).toBeNull();
    const over = new Date(Date.parse(AT) + LIMITS.purgeHoldMaxDays * DAY + 1000).toISOString();
    expect(code(foldEvents([...base(), hold("t", { until: over })]))).toBe("invalidPurgeHoldUntil");
    expect(code(foldEvents([...base(), hold("t", { until: AT })]))).toBe("invalidPurgeHoldUntil");
    expect(code(foldEvents([...base(), hold("t", { until: "2025-01-01T00:00:00Z" })]))).toBe(
      "invalidPurgeHoldUntil",
    );
    expect(code(foldEvents([...base(), hold("t", { until: "明日" })]))).toBe("invalidPayload");
    expect(code(foldEvents([...base(), hold("t", { until: 5 })]))).toBe("invalidPayload");
  });

  it("理由は上限以下の文字列", () => {
    expect(
      code(foldEvents([...base(), hold("t", { reason: "x".repeat(LIMITS.purgeHoldReason) })])),
    ).toBeNull();
    expect(
      code(foldEvents([...base(), hold("t", { reason: "x".repeat(LIMITS.purgeHoldReason + 1) })])),
    ).toBe("invalidPayload");
    expect(code(foldEvents([...base(), hold("t", { reason: "a\u0000b" })]))).toBe("invalidPayload");
  });

  it("保留があれば置き換える（延期・短縮）。解除すると保留がなくなる。保留がなければ解除は拒否する", () => {
    const s = must(
      foldEvents([
        ...base(),
        hold("t", { until: "2026-02-01T00:00:00Z" }),
        hold("t", { until: "2026-03-01T00:00:00Z" }),
      ]),
    );
    expect(nodeOf(s, "t")?.purgeHold?.until).toBe("2026-03-01T00:00:00Z");
    const r = must(foldEvents([...base(), hold("t"), release("t")]));
    expect(nodeOf(r, "t")?.purgeHold).toBeUndefined();
    expect(code(foldEvents([...base(), release("t")]))).toBe("noPurgeHold");
  });

  it("保留は、木のノードを主語とするイベントとして、最終削除の対象の行に含まれる", () => {
    const events = [...base(), hold("t"), release("t"), hold("o".replace("o", "root"), {})];
    const seqs = purgeEventSeqs(events.slice(0, -1), new Set(["t", "c"]));
    const heldSeq = events[events.length - 3]?.seq;
    const releasedSeq = events[events.length - 2]?.seq;
    expect(seqs).toContain(heldSeq);
    expect(seqs).toContain(releasedSeq);
  });
});

describe("purgeHoldActive（保留が有効か）", () => {
  const nodeWith = (until?: string) => {
    const s = must(foldEvents([...base(), hold("t", until === undefined ? {} : { until })]));
    return nodeOf(s, "t") as NonNullable<ReturnType<typeof nodeOf>>;
  };
  it("保留がなければ無効。無期限なら常に有効。期限つきは、期限まで有効（期限の時刻からは無効）", () => {
    const none = nodeOf(must(foldEvents(base())), "t");
    expect(purgeHoldActive(none as never, Date.parse(AT))).toBe(false);
    expect(purgeHoldActive(nodeWith(), Date.parse(AT) + 1000 * DAY)).toBe(true);
    const n = nodeWith("2026-02-01T00:00:00Z");
    const until = Date.parse("2026-02-01T00:00:00Z");
    expect(purgeHoldActive(n, until - 1)).toBe(true);
    expect(purgeHoldActive(n, until)).toBe(false);
  });
  it("時刻を読めなければ、有効のまま（迷ったら保留のまま）", () => {
    const n = nodeWith("2026-02-01T00:00:00Z");
    expect(purgeHoldActive(n, Number.NaN)).toBe(true);
    const broken = { ...n, purgeHold: { ...n.purgeHold, until: "壊れた" } } as never;
    expect(purgeHoldActive(broken, Date.parse(AT))).toBe(true);
  });
});
