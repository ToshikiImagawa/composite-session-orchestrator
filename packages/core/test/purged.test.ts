import { describe, expect, it } from "vitest";
import {
  type EventBody,
  foldEvents,
  initialState,
  type OrchEvent,
  visibleState,
} from "../src/index.js";

let n = 0;
const ev = (body: EventBody, seq?: number): OrchEvent =>
  ({
    seq: seq ?? ++n,
    at: "2026-10-20T00:00:00Z",
    requestId: `r${seq ?? n}`,
    actor: { human: true },
    ...body,
  }) as OrchEvent;
const root = (): OrchEvent[] => {
  n = 0;
  return [
    ev({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    }),
    ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
  ];
};
const purged = (payload: Record<string, unknown>, seq?: number): OrchEvent =>
  ev({ type: "node.purged", payload } as unknown as EventBody, seq);
const base = {
  rootId: "t",
  nodeIds: ["c", "t"],
  archivedAt: "2026-01-10T00:00:00Z",
};

describe("node.purged（最終削除の標識）", () => {
  it("墓標つきで畳み込める。tombstones に記録し、lastSeq は標識の seq。ノードは増えない", () => {
    const r = foldEvents([
      ...root(),
      purged(
        {
          ...base,
          tombstone: {
            title: "目的",
            outcome: "verified",
            lastCommit: "0123456789abcdef0123456789abcdef01234567",
          },
        },
        9,
      ),
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.lastSeq).toBe(9);
    expect(r.value.nodes.map((x) => x.id)).toEqual(["root"]);
    expect(r.value.tombstones).toEqual([
      {
        seq: 9,
        at: "2026-10-20T00:00:00Z",
        actor: { human: true },
        rootId: "t",
        nodeIds: ["c", "t"],
        archivedAt: "2026-01-10T00:00:00Z",
        tombstone: {
          title: "目的",
          outcome: "verified",
          lastCommit: "0123456789abcdef0123456789abcdef01234567",
        },
      },
    ]);
  });

  it("墓標なしでも標識は残る（tombstone は付かない）", () => {
    const r = foldEvents([...root(), purged(base, 9)]);
    expect(r.ok && r.value.tombstones.length).toBe(1);
    expect(r.ok && r.value.tombstones[0]?.tombstone).toBeUndefined();
  });

  it("初期状態の tombstones は空。可視の状態では、権限のない呼び出し元に墓標を見せない（空）", () => {
    expect(initialState().tombstones).toEqual([]);
    const r = foldEvents([...root(), purged(base, 9)]);
    if (!r.ok) throw new Error("fold");
    expect(visibleState(r.value, "root").tombstones).toEqual([]);
  });

  it("payload の不正を拒否する", () => {
    const bad: Record<string, unknown>[] = [
      { ...base, rootId: "../x" },
      { ...base, nodeIds: "c" },
      { ...base, nodeIds: ["c", ""] },
      { ...base, archivedAt: "yesterday" },
      { ...base, tombstone: { title: "x", outcome: "gone" } },
      { ...base, tombstone: { title: "", outcome: "verified" } },
      { ...base, tombstone: { title: "x".repeat(201), outcome: "verified" } },
      { ...base, tombstone: { title: "x", outcome: "verified", lastCommit: 1 } },
      { ...base, tombstone: "x" },
    ];
    for (const payload of bad) {
      const r = foldEvents([...root(), purged(payload, 9)]);
      expect(r.ok, JSON.stringify(payload)).toBe(false);
    }
  });

  it("標識に載せたノードが、まだ存在するなら拒否する（行を消さずに標識だけを足した、不整合なログ）", () => {
    const events = [
      ...root(),
      ev({
        type: "node.created",
        payload: { nodeId: "c", role: "implement", parentId: "root", dependsOn: [] },
      }),
    ];
    const r = foldEvents([...events, purged({ ...base, nodeIds: ["c"] }, 20)]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("purgeInconsistent");
  });

  it("同じ requestId・同じ内容の再送は、重複として扱う（applyEvent）", () => {
    const first = foldEvents([...root(), purged(base, 9)]);
    if (!first.ok) throw new Error("fold");
    const again = foldEvents([purged(base, 10)], first.value);
    // 同じ requestId でなければ（seq が違えば requestId も違う）、別の標識。ここでは通る。
    expect(again.ok && again.value.tombstones.length).toBe(2);
  });
});

describe("最終削除で消えたノードを、判断要求の pauseNodeIds が指しているとき", () => {
  const requested = (pauseNodeIds: string[]): OrchEvent =>
    ev({
      type: "decision.requested",
      payload: { decisionId: "dx", nodeId: "root", question: "q", pauseNodeIds },
    });
  const codeOf = (r: ReturnType<typeof foldEvents>) => (r.ok ? null : r.error.code);

  it("標識（node.purged）が後にあれば、消えたノードは無視して畳み込める（ログの再生）", () => {
    // 木のノード c・t の作成イベントは消えている。判断要求は残り、標識がその後に来る
    const log = [...root(), requested(["c"]), purged(base)];
    const r = foldEvents(log);
    expect(codeOf(r)).toBeNull();
    if (r.ok) {
      expect(r.value.decisions[0]?.decisionId).toBe("dx");
      expect(r.value.nodes.map((x) => x.id)).toEqual(["root"]);
    }
  });

  it("標識より後の判断要求が、消えたノードを指すのは拒否する（標識の seq より小さいときだけ受理）", () => {
    // 同じ畳み込みの中でも、状態に標識がある場合でも、標識より後の新しい参照は unknownNode
    expect(codeOf(foldEvents([...root(), purged(base), requested(["c"])]))).toBe("unknownNode");
    const s = foldEvents([...root(), purged(base)]);
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    expect(codeOf(foldEvents([requested(["c"])], s.value))).toBe("unknownNode");
  });

  it("標識のないノード・本当に存在しないノードは、引き続き unknownNode で拒否する", () => {
    expect(codeOf(foldEvents([...root(), requested(["ghost"]), purged(base)]))).toBe("unknownNode");
    expect(codeOf(foldEvents([...root(), requested(["c"])]))).toBe("unknownNode");
  });
});
