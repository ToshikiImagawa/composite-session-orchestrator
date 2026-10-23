import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  INBOX_KIND_PRIORITY,
  INBOX_KINDS,
  type InboxKind,
  NODE_STATES,
  type NodeState,
  PRIORITIES,
} from "../src/index.js";

// spec 4.2 の型定義に対応する。名称・順序は spec と一致させる。
describe("NodeState（spec 4.2）", () => {
  it("spec の状態をすべて持ち、旧名と merged を持たない", () => {
    const expected: readonly NodeState[] = [
      "pending",
      "running",
      "waiting",
      "done",
      "verified",
      "stopping",
      "stopIncomplete",
      "stopped",
      "reclaimable",
      "archived",
    ];
    expect([...NODE_STATES]).toEqual(expected);
    for (const old of ["queued", "paused", "completed", "merged"]) {
      expect(NODE_STATES as readonly string[]).not.toContain(old);
    }
  });
});

describe("InboxKind と Priority の対応（spec 4.2, FR_012）", () => {
  it("spec の項目の種類をすべて持つ", () => {
    expect([...INBOX_KINDS]).toEqual([
      "decision",
      "answer",
      "violation",
      "failure",
      "stopIncomplete",
      "done",
      "progress",
      "info",
      "digest",
    ]);
  });

  it.each([
    ["decision", "blocking"],
    ["answer", "blocking"],
    ["violation", "failed"],
    ["failure", "failed"],
    ["stopIncomplete", "failed"],
    ["done", "completed"],
    ["progress", "progress"],
    ["info", "info"],
  ] as const)("%s は %s の帯", (kind, priority) => {
    expect(INBOX_KIND_PRIORITY[kind]).toBe(priority);
  });

  it("優先度の帯は spec の順序（要判断 ＞ 失敗 ＞ 完了 ＞ 進捗 ＞ 情報）を守る（性質ベース）", () => {
    // spec 4.2 の種類の並びは優先度の高い順。帯の順位が単調非減少であること。
    const rank = (k: InboxKind): number => PRIORITIES.indexOf(INBOX_KIND_PRIORITY[k]);
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: INBOX_KINDS.length - 1 }),
        fc.integer({ min: 0, max: INBOX_KINDS.length - 1 }),
        (i, j) => {
          const [lo, hi] = i <= j ? [i, j] : [j, i];
          expect(rank(INBOX_KINDS[lo] as InboxKind)).toBeLessThanOrEqual(
            rank(INBOX_KINDS[hi] as InboxKind),
          );
        },
      ),
    );
  });

  it("優先度は高い順に並ぶ", () => {
    expect([...PRIORITIES]).toEqual(["blocking", "failed", "completed", "progress", "info"]);
  });
});
