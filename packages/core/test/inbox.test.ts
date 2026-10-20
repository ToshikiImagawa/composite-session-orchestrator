import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { INBOX_KINDS, type InboxItem, inboxSince, sortInbox } from "../src/index.js";

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

  const arbItem = fc.record({
    id: fc.string({ minLength: 1, maxLength: 3 }),
    seq: fc.nat(),
    kind: fc.constantFrom(...INBOX_KINDS),
    nodeId: fc.constantFrom("A", "B", "C", "D"),
    dependsOn: fc.subarray(["A", "B", "C", "D"]),
    at: fc.integer({ min: 0, max: 5 }).map((s) => new Date(s * 1000).toISOString()),
  });
  const arbItems = fc
    .uniqueArray(arbItem, { selector: (x) => x.id, maxLength: 12 })
    .map((xs) => xs as InboxItem[]);

  it("性質: 入力の順序に依らず同じ結果（決定性）で、要素を保つ", () => {
    fc.assert(
      fc.property(arbItems, fc.nat(), (xs, k) => {
        const shuffled = [...xs.slice(k % (xs.length + 1)), ...xs.slice(0, k % (xs.length + 1))];
        const a = sortInbox(xs);
        expect(ids(a)).toEqual(ids(sortInbox(shuffled)));
        expect([...ids(a)].sort()).toEqual([...ids(xs)].sort());
      }),
    );
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
