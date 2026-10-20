import { INBOX_KINDS, type InboxItem, type InboxKind } from "@cso/core";
import { describe, expect, it } from "vitest";
import { MCP_ROLES, nextActionsFor, renderInbox, toolsFor } from "../src/index.js";

const item = (o: Partial<InboxItem> & Pick<InboxItem, "id">): InboxItem => ({
  seq: 1,
  kind: "info",
  nodeId: "n",
  dependsOn: [],
  at: "2026-01-01T00:00:00Z",
  ...o,
});

// 次の操作の候補の対応表（design 9.1）。ツール名で返す。変えるときは design と合わせて更新する。
const NEXT_ACTIONS: Record<InboxKind, readonly string[]> = {
  decision: ["decision_get", "decision_present", "node_send"],
  answer: ["decision_get", "node_send"],
  violation: ["scope_decide", "node_send", "node_stop"],
  failure: ["report_get", "node_send", "node_split", "node_stop"],
  stopIncomplete: ["node_stop", "node_capabilities", "decision_present"],
  done: ["report_get", "node_review"],
  progress: ["report_get"],
  info: [],
};

describe("nextActionsFor（FR_012: 次に取るべき操作の候補）", () => {
  it.each(INBOX_KINDS)("%s の対応表が固定されている", (kind) => {
    expect(nextActionsFor(kind)).toEqual(NEXT_ACTIONS[kind]);
  });

  it("すべての種類に定義があり、統合ロールに公開されたツール名だけを指す", () => {
    const exposed = new Set(toolsFor("integrator").map((t) => t.name));
    for (const kind of INBOX_KINDS) {
      for (const name of nextActionsFor(kind)) expect(exposed.has(name)).toBe(true);
    }
    expect(MCP_ROLES).toContain("integrator");
  });
});

describe("renderInbox（NFR_009: 簡潔版・詳細版、分割取得）", () => {
  const items = [
    item({ id: "c", seq: 3, kind: "info", at: "2026-01-01T00:00:03Z" }),
    item({ id: "a", seq: 1, kind: "decision", at: "2026-01-01T00:00:01Z" }),
    item({ id: "b", seq: 2, kind: "done", at: "2026-01-01T00:00:02Z" }),
  ];
  const unwrap = <T>(r: { ok: true; value: T } | { ok: false }): T => {
    if (!r.ok) throw new Error("failure");
    return r.value;
  };

  it("既定は簡潔版で、整列順に並び、次の操作の候補（ツール名）を添える", () => {
    const page = unwrap(renderInbox(items));
    expect(page.entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(page.entries[0]).toEqual({
      id: "a",
      kind: "decision",
      nodeId: "n",
      nextActions: NEXT_ACTIONS.decision,
    });
    expect(page.total).toBe(3);
    expect(page.asOfSeq).toBe(3);
    expect(page.nextOffset).toBeUndefined();
  });

  it("簡潔版でも要約と参照 ID があれば含める（全文は *_get で読む）", () => {
    const page = unwrap(
      renderInbox([item({ id: "d", kind: "decision", summary: "どちらにする？", ref: "dec-1" })]),
    );
    expect(page.entries[0]).toMatchObject({ summary: "どちらにする？", ref: "dec-1" });
  });

  it("詳細版は項目の全体を含む", () => {
    const page = unwrap(renderInbox(items, { detail: "full" }));
    expect(page.entries[0]).toMatchObject({ id: "a", seq: 1, at: "2026-01-01T00:00:01Z" });
  });

  it("limit と offset で分割して取得でき、続きがあれば nextOffset を返す", () => {
    const p1 = unwrap(renderInbox(items, { limit: 2 }));
    expect(p1.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(p1.nextOffset).toBe(2);
    const p2 = unwrap(renderInbox(items, { limit: 2, offset: 2 }));
    expect(p2.entries.map((e) => e.id)).toEqual(["c"]);
    expect(p2.nextOffset).toBeUndefined();
  });

  it("続きの取得は asOfSeq 以下の項目だけで整列する（新着で重複・欠落しない）", () => {
    const p1 = unwrap(renderInbox(items, { limit: 2 }));
    // 取得の合間に、最優先の項目が届いた
    const later = [
      ...items,
      item({ id: "z", seq: 4, kind: "decision", at: "2026-01-01T00:00:00Z" }),
    ];
    const p2 = unwrap(renderInbox(later, { limit: 2, offset: 2, asOfSeq: p1.asOfSeq }));
    expect(p2.entries.map((e) => e.id)).toEqual(["c"]);
    expect(p2.total).toBe(3);
    expect(p2.asOfSeq).toBe(p1.asOfSeq);
    // 新着は、次の sinceSeq = asOfSeq の差分取得で拾える
    const diff = unwrap(renderInbox(later.filter((i) => i.seq > p1.asOfSeq)));
    expect(diff.entries.map((e) => e.id)).toEqual(["z"]);
  });

  it("項目がなければ asOfSeq は 0", () => {
    expect(unwrap(renderInbox([])).asOfSeq).toBe(0);
  });
});

describe("入口の検査（invalid_argument, NFR_010）", () => {
  const bad = (r: ReturnType<typeof renderInbox>) => {
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("invalid_argument");
      expect(r.error.nextActions.length).toBeGreaterThan(0);
    }
  };
  const ok1 = [item({ id: "a" })];

  it.each([
    { limit: 0 },
    { limit: 1.5 },
    { limit: 1000 },
    { limit: Number.NaN },
    { offset: -1 },
    { offset: 0.5 },
    { asOfSeq: -1 },
    { asOfSeq: 1.5 },
    { detail: "verbose" },
  ])("opts %j は拒否する", (opts) => {
    bad(renderInbox(ok1, opts as never));
  });

  it("opts が null や配列でも拒否する", () => {
    bad(renderInbox(ok1, null as never));
    bad(renderInbox(ok1, [] as never));
  });

  it.each([
    [{ ...item({ id: "a" }), kind: "unknown" }],
    [{ ...item({ id: "a" }), id: 1 }],
    [{ ...item({ id: "a" }), nodeId: undefined }],
    [{ ...item({ id: "a" }), seq: "1" }],
    [{ ...item({ id: "a" }), dependsOn: "x" }],
    [{ ...item({ id: "a" }), summary: 5 }],
    [null],
    ["str"],
  ])("不正な項目 %j は拒否する", (bad1) => {
    bad(renderInbox([bad1 as never]));
  });

  it("items が配列でなければ拒否する", () => {
    bad(renderInbox(undefined as never));
    bad(renderInbox({} as never));
  });
});
