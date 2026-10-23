import { describe, expect, it } from "vitest";
import {
  type EventBody,
  foldEvents,
  type OrchEvent,
  type OrchState,
  UI_LIMITS,
  UI_TEXT_MAX,
  uiText,
  uiViewOf,
} from "../src/index.js";

const SYS = { system: true } as const;
const AT = "2026-10-20T00:00:00Z";
let n = 0;
const ev = (body: EventBody, at = AT): OrchEvent =>
  ({ seq: ++n, at, requestId: `r${n}`, actor: SYS, ...body }) as OrchEvent;
const created = (
  nodeId: string,
  role: "integrator" | "implement",
  parentId: string | null,
  extra = {},
) =>
  ev({
    type: "node.created",
    payload: { nodeId, role, parentId, dependsOn: [], ...extra },
  } as never);
const added = (id: string, kind: string, nodeId: string, extra: Record<string, unknown> = {}) =>
  ev({ type: "inbox.added", payload: { id, kind, nodeId, ...extra } } as never);
const must = (events: OrchEvent[]): OrchState => {
  const r = foldEvents(events);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
  return r.value;
};
const base = (): OrchEvent[] => {
  n = 0;
  return [
    created("root", "integrator", null),
    ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
    created("a", "implement", "root"),
  ];
};

describe("uiViewOf（画面の表示モデル。T23）", () => {
  it("ノード・未解決の項目（優先度の降順）・件数を返す。解決済みの項目は含めない", () => {
    const s = must([
      ...base(),
      added("p1", "progress", "a", { summary: "進んだ" }),
      added("f1", "failure", "a", { summary: "落ちた" }),
      added("i1", "info", "a"),
      ev({ type: "inbox.resolved", payload: { itemId: "i1" } }),
    ]);
    const v = uiViewOf(s);
    expect(v.nodes.map((x) => x.id)).toEqual(["root", "a"]);
    expect(v.nodes.find((x) => x.id === "a")?.openItems).toBe(2);
    expect(v.inbox.map((x) => x.id)).toEqual(["f1", "p1"]);
    expect(v.inbox[0]?.priority).toBe("failed");
    expect(v.lastSeq).toBe(s.lastSeq);
    expect(v.truncated).toEqual([]);
  });

  it("ブリーフ（目的・受け入れ基準・作業範囲）・パス・最終コミットは、表示モデルに入らない", () => {
    const s = must([
      ...base().slice(0, 2),
      created("a", "implement", "root", {
        objective: "SECRET-OBJECTIVE",
        acceptanceCriteria: ["SECRET-CRITERIA"],
        scope: {
          writableLocations: ["src/secret-dir"],
          forbiddenLocations: [".git"],
          allowedCommands: ["pnpm test"],
        },
      }),
    ]);
    const json = JSON.stringify(uiViewOf(s));
    expect(json).not.toContain("SECRET");
    expect(json).not.toContain("secret-dir");
  });

  it("子が書いた文字列は、制御文字を除き、上限（UI_TEXT_MAX）に切る。識別子の形でないものは空にする", () => {
    expect(uiText("a\u0000b\u001bc\u007fd\nE")).toBe("abcdE");
    expect(uiText("あ".repeat(UI_TEXT_MAX + 50))).toHaveLength(UI_TEXT_MAX);
    expect(uiText(undefined)).toBe("");
    const folded = must([...base(), added("p1", "progress", "a", { summary: "xy" })]);
    // 制御文字は、記録の検証で拒まれる。古い記録・壊れた状態に備えて、取り込んだあとの状態で確かめる
    const s: OrchState = {
      ...folded,
      inbox: folded.inbox.map((i) => ({ ...i, summary: "x\u0007y" })),
    };
    expect(uiViewOf(s).inbox[0]?.summary).toBe("xy");
    const bad: OrchState = {
      ...s,
      nodes: s.nodes.map((x) => (x.id === "a" ? { ...x, id: "<img src=x onerror=1>" } : x)),
    };
    expect(uiViewOf(bad).nodes.find((x) => x.role === "implement")?.id).toBe("");
  });

  it("未回答の判断・未判定の拡張要求を返す（回答済み・判定済みは含めない）。目標の場所（パス）は含めない", () => {
    const s = must(base());
    const withOpen: OrchState = {
      ...s,
      decisions: [
        {
          decisionId: "d1",
          nodeId: "a",
          status: "open",
          question: "どれにする？",
          options: ["A", "B"],
          rejected: [],
        } as never,
        { decisionId: "d2", nodeId: "a", status: "answered", rejected: [] } as never,
      ],
      extensions: [
        {
          extensionId: "x1",
          nodeId: "a",
          status: "open",
          reason: "足りない",
          target: { writableLocations: ["src/secret-dir"] },
        } as never,
        { extensionId: "x2", nodeId: "a", status: "approved", reason: "済み" } as never,
      ],
    };
    const v = uiViewOf(withOpen);
    expect(v.decisions).toEqual([
      { id: "d1", nodeId: "a", question: "どれにする？", options: ["A", "B"] },
    ]);
    expect(v.extensions).toEqual([{ id: "x1", nodeId: "a", reason: "足りない" }]);
    expect(JSON.stringify(v)).not.toContain("secret-dir");
  });

  it("件数の上限を超えたら、切って、truncated に種類を入れる", () => {
    const items = Array.from({ length: UI_LIMITS.inbox + 5 }, (_, i) =>
      added(`p${i}`, "progress", "a"),
    );
    const v = uiViewOf(must([...base(), ...items]));
    expect(v.inbox).toHaveLength(UI_LIMITS.inbox);
    expect(v.truncated).toContain("inbox");
  });
});
