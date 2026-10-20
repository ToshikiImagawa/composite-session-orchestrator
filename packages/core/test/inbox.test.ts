import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  INBOX_KIND_PRIORITY,
  INBOX_KINDS,
  type InboxItem,
  inboxSince,
  isValidInboxTime,
  PRIORITIES,
  sortInbox,
} from "../src/index.js";

const item = (o: Partial<InboxItem> & Pick<InboxItem, "id">): InboxItem => ({
  seq: 1,
  kind: "info",
  nodeId: "n",
  dependsOn: [],
  at: "2026-01-01T00:00:00.000Z",
  ...o,
});
const ids = (xs: readonly InboxItem[]) => xs.map((x) => x.id);

describe("sortInbox（FR_012）", () => {
  it("優先度順: 要判断 > 失敗 > 完了 > 進捗 > 情報", () => {
    const sorted = sortInbox([
      item({ id: "i", kind: "info" }),
      item({ id: "p", kind: "progress" }),
      item({ id: "d", kind: "done" }),
      item({ id: "f", kind: "failure" }),
      item({ id: "a", kind: "answer" }),
    ]);
    expect(ids(sorted)).toEqual(["a", "f", "d", "p", "i"]);
  });

  it("停止未完了は失敗の帯、判断要求と回答は同じ最上位", () => {
    const sorted = sortInbox([
      item({ id: "s", kind: "stopIncomplete", at: "2026-01-01T00:00:01Z" }),
      item({ id: "q", kind: "decision", at: "2026-01-01T00:00:02Z" }),
      item({ id: "a", kind: "answer", at: "2026-01-01T00:00:03Z" }),
    ]);
    expect(ids(sorted)).toEqual(["q", "a", "s"]);
  });

  it("同じ優先度では、依存先のノードの項目が先", () => {
    const sorted = sortInbox([
      item({ id: "b", kind: "done", nodeId: "B", dependsOn: ["A"], at: "2026-01-01T00:00:00Z" }),
      item({ id: "a", kind: "done", nodeId: "A", at: "2026-01-01T00:00:09Z" }),
      item({ id: "c", kind: "done", nodeId: "C", dependsOn: ["B"], at: "2026-01-01T00:00:00Z" }),
    ]);
    expect(ids(sorted)).toEqual(["a", "b", "c"]);
  });

  it("優先度は依存関係より優先する", () => {
    const sorted = sortInbox([
      item({ id: "a", kind: "info", nodeId: "A" }),
      item({ id: "b", kind: "decision", nodeId: "B", dependsOn: ["A"] }),
    ]);
    expect(ids(sorted)).toEqual(["b", "a"]);
  });

  it("同順位は時刻の昇順、さらに id で決める", () => {
    const sorted = sortInbox([
      item({ id: "z", at: "2026-01-01T00:00:02Z" }),
      item({ id: "y", at: "2026-01-01T00:00:01Z" }),
      item({ id: "x", at: "2026-01-01T00:00:01Z" }),
    ]);
    expect(ids(sorted)).toEqual(["x", "y", "z"]);
  });

  it("依存の循環があっても終了し、決定的", () => {
    const xs = [
      item({ id: "a", nodeId: "A", dependsOn: ["B"] }),
      item({ id: "b", nodeId: "B", dependsOn: ["A"] }),
    ];
    expect(ids(sortInbox(xs))).toEqual(ids(sortInbox([...xs].reverse())));
  });

  it("入力を変更しない", () => {
    const xs = [item({ id: "b", kind: "info" }), item({ id: "a", kind: "decision" })];
    const copy = structuredClone(xs);
    sortInbox(xs);
    expect(xs).toEqual(copy);
  });

  it("項目を持たない中間ノード経由の推移的依存も、nodeDeps で渡せば守る", () => {
    // A <- M <- C。M の項目はない。
    const xs = [
      item({ id: "c", kind: "done", nodeId: "C", at: "2026-01-01T00:00:00Z" }),
      item({ id: "a", kind: "done", nodeId: "A", at: "2026-01-01T00:00:09Z" }),
    ];
    expect(ids(sortInbox(xs))).toEqual(["c", "a"]);
    const nodeDeps = new Map([
      ["C", ["M"]],
      ["M", ["A"]],
    ]);
    expect(ids(sortInbox(xs, nodeDeps))).toEqual(["a", "c"]);
  });

  it("依存のない組は時刻順のまま（依存の深さでは並べ替えない）", () => {
    // B は A に依存するが、X とは無関係。時刻が早い X が B より先でよい。
    const sorted = sortInbox([
      item({ id: "b", kind: "done", nodeId: "B", dependsOn: ["A"], at: "2026-01-01T00:00:03Z" }),
      item({ id: "x", kind: "done", nodeId: "X", at: "2026-01-01T00:00:01Z" }),
      item({ id: "a", kind: "done", nodeId: "A", at: "2026-01-01T00:00:05Z" }),
    ]);
    expect(ids(sorted)).toEqual(["x", "a", "b"]);
  });

  it("不正な at は時刻の最後に置く（決定的）", () => {
    const sorted = sortInbox([
      item({ id: "bad", at: "not-a-date" }),
      item({ id: "ok", at: "2026-01-01T00:00:01Z" }),
    ]);
    expect(ids(sorted)).toEqual(["ok", "bad"]);
  });

  it("id が重複したら seq が大きい方だけを残す", () => {
    const sorted = sortInbox([
      item({ id: "d", seq: 1, kind: "info" }),
      item({ id: "d", seq: 2, kind: "decision" }),
    ]);
    expect(sorted.map((x) => [x.id, x.seq])).toEqual([["d", 2]]);
  });

  const NODES = ["A", "B", "C", "D"] as const;
  const arbItem = fc.record({
    id: fc.string({ minLength: 1, maxLength: 3 }),
    seq: fc.nat(),
    kind: fc.constantFrom(...INBOX_KINDS),
    nodeId: fc.constantFrom(...NODES),
    dependsOn: fc.subarray([...NODES]),
    at: fc.integer({ min: 0, max: 5 }).map((s) => new Date(s * 1000).toISOString()),
  });
  const arbItems = fc
    .uniqueArray(arbItem, { selector: (x) => x.id, maxLength: 12 })
    .map((xs) => xs as InboxItem[]);
  const arbCase = arbItems.chain((xs) =>
    fc.tuple(
      fc.constant(xs),
      fc.shuffledSubarray(xs, { minLength: xs.length, maxLength: xs.length }),
    ),
  );
  const rank = (x: InboxItem) => PRIORITIES.indexOf(INBOX_KIND_PRIORITY[x.kind]);

  it("性質: 任意の順列で同じ結果（決定性）、要素を保ち、冪等", () => {
    fc.assert(
      fc.property(arbCase, ([xs, shuffled]) => {
        const a = sortInbox(xs);
        expect(sortInbox(shuffled)).toEqual(a);
        expect([...ids(a)].sort()).toEqual([...ids(xs)].sort());
        expect(sortInbox(a)).toEqual(a);
      }),
    );
  });

  it("性質: 優先度は単調で、同優先度内の依存先は必ず先（推移的）", () => {
    fc.assert(
      fc.property(arbItems, (xs) => {
        const a = sortInbox(xs);
        for (let i = 1; i < a.length; i++) {
          expect(rank(a[i - 1] as InboxItem)).toBeLessThanOrEqual(rank(a[i] as InboxItem));
        }
        // 推移的な依存（相互に依存するものは除く）: 依存先の項目が後ろに来てはならない
        const direct = (n: string) =>
          new Set(xs.filter((x) => x.nodeId === n).flatMap((x) => x.dependsOn));
        const reaches = (from: string, to: string): boolean => {
          const seen = new Set<string>();
          const stack = [...direct(from)];
          for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
            if (n === to) return true;
            if (seen.has(n)) continue;
            seen.add(n);
            stack.push(...direct(n));
          }
          return false;
        };
        a.forEach((later, j) => {
          for (const after of a.slice(j + 1)) {
            if (rank(after) !== rank(later) || after.nodeId === later.nodeId) continue;
            if (reaches(later.nodeId, after.nodeId) && !reaches(after.nodeId, later.nodeId)) {
              expect.fail(`${later.id} は ${after.id} に依存するのに先にある`);
            }
          }
        });
      }),
    );
  });
});

describe("isValidInboxTime", () => {
  it.each([
    ["2026-01-01T00:00:00Z", true],
    ["2026-01-01T00:00:00.123Z", true],
    ["2026-01-01T00:00:00+09:00", false],
    ["2026-01-01", false],
    ["2026-02-30T00:00:00Z", false],
    ["", false],
  ])("%s → %s", (at, expected) => {
    expect(isValidInboxTime(at)).toBe(expected);
  });
});

describe("inboxSince（前回取得以降の差分）", () => {
  it("seq が cursor より大きい項目だけを整列して返す", () => {
    const xs = [
      item({ id: "a", seq: 1 }),
      item({ id: "b", seq: 2, kind: "decision" }),
      item({ id: "c", seq: 3 }),
    ];
    expect(ids(inboxSince(xs, 1))).toEqual(["b", "c"]);
    expect(inboxSince(xs, 3)).toEqual([]);
  });
});
