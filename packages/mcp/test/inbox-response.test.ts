import { INBOX_KINDS, type InboxItem, ROLE_OPERATIONS } from "@cso/core";
import { describe, expect, it } from "vitest";
import { nextActionsFor, renderInbox } from "../src/index.js";

const item = (o: Partial<InboxItem> & Pick<InboxItem, "id">): InboxItem => ({
  seq: 1,
  kind: "info",
  nodeId: "n",
  dependsOn: [],
  at: "2026-01-01T00:00:00Z",
  ...o,
});

describe("nextActionsFor（FR_012: 次に取るべき操作の候補）", () => {
  it("すべての種類に定義があり、統合ロールの操作だけを指す", () => {
    const integrator = new Set<string>(ROLE_OPERATIONS.integrator);
    for (const kind of INBOX_KINDS) {
      for (const op of nextActionsFor(kind)) expect(integrator.has(op)).toBe(true);
    }
  });

  it("判断要求は人間への提示、完了は受理／差し戻し、範囲違反は判定を挙げる", () => {
    expect(nextActionsFor("decision")).toContain("decision.present");
    expect(nextActionsFor("done")).toContain("node.review");
    expect(nextActionsFor("violation")).toContain("scope.decide");
    expect(nextActionsFor("stopIncomplete")).toContain("node.stop");
  });
});

describe("renderInbox（NFR_009: 簡潔版・詳細版、分割取得）", () => {
  const items = [
    item({ id: "c", kind: "info", at: "2026-01-01T00:00:03Z" }),
    item({ id: "a", kind: "decision", at: "2026-01-01T00:00:01Z" }),
    item({ id: "b", kind: "done", at: "2026-01-01T00:00:02Z" }),
  ];
  const unwrap = <T>(r: { ok: true; value: T } | { ok: false }): T => {
    if (!r.ok) throw new Error("failure");
    return r.value;
  };

  it("既定は簡潔版で、整列順に並び、次の操作の候補を添える", () => {
    const page = unwrap(renderInbox(items));
    expect(page.entries.map((e) => e.id)).toEqual(["a", "b", "c"]);
    expect(page.entries[0]).toEqual({
      id: "a",
      kind: "decision",
      nodeId: "n",
      nextActions: nextActionsFor("decision"),
    });
    expect(page.total).toBe(3);
    expect(page.nextOffset).toBeUndefined();
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

  it("limit が範囲外・offset が負なら、原因と次の操作つきの失敗にする（NFR_010）", () => {
    for (const opts of [{ limit: 0 }, { limit: 1.5 }, { limit: 1000 }, { offset: -1 }]) {
      const r = renderInbox(items, opts);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("invalid_argument");
        expect(r.error.nextActions.length).toBeGreaterThan(0);
      }
    }
  });
});
