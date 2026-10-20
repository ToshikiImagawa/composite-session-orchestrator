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

  it("全ての種類が定義済みの優先度に対応する（性質ベース）", () => {
    fc.assert(
      fc.property(fc.constantFrom(...INBOX_KINDS), (kind: InboxKind) => {
        expect(PRIORITIES).toContain(INBOX_KIND_PRIORITY[kind]);
      }),
    );
  });

  it("優先度は高い順に並ぶ", () => {
    expect([...PRIORITIES]).toEqual(["blocking", "failed", "completed", "progress", "info"]);
  });
});
