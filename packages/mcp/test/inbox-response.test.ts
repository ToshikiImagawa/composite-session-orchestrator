import {
  INBOX_KIND_PRIORITY,
  INBOX_KINDS,
  type InboxItem,
  type InboxKind,
  PRIORITIES,
} from "@cso/core";
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
  stopIncomplete: ["node_stop", "node_confirmStopped", "node_capabilities", "decision_present"],
  done: ["report_get", "node_review"],
  progress: ["report_get"],
  info: [],
  digest: ["inbox_fetch", "tree_list"],
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

  it("items が配列でなければ、保存データの不備として internal_data を返す（管理者に知らせる）", () => {
    for (const items of [undefined, {}, "x"]) {
      const r = renderInbox(items as never);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("internal_data");
        expect(r.error.nextActions.join(" ")).toContain("管理者");
        expect(r.error.nextActions.join(" ")).toContain("ログ");
      }
    }
  });
});

describe("不正な項目は、その項目だけを除外する（受信箱全体は失敗にしない）", () => {
  const valid = (id: string, seq: number) => item({ id, seq });
  const run = (...items: unknown[]) => {
    const r = renderInbox(items as InboxItem[]);
    if (!r.ok) throw new Error(`failure: ${r.error.code}`);
    return r.value;
  };

  it.each([
    [{ ...item({ id: "x" }), kind: "unknown" }],
    [{ ...item({ id: "x" }), id: 1 }],
    [{ ...item({ id: "x" }), nodeId: undefined }],
    [{ ...item({ id: "x" }), seq: "1" }],
    [{ ...item({ id: "x" }), dependsOn: "x" }],
    [{ ...item({ id: "x" }), id: "i d" }],
    [{ ...item({ id: "x" }), id: "../x" }],
    [{ ...item({ id: "x" }), id: "" }],
    [{ ...item({ id: "x" }), nodeId: "n/1" }],
    [{ ...item({ id: "x" }), nodeId: "*" }],
    [{ ...item({ id: "x" }), ref: "dec 1" }],
    [{ ...item({ id: "x" }), dependsOn: ["ok", "a;b"] }],
    // 優先度（T24）: digest だけが持ち、必ず持つ。PRIORITIES のどれか
    [{ ...item({ id: "x" }), kind: "digest" }],
    [{ ...item({ id: "x" }), kind: "digest", priority: "urgent" }],
    [{ ...item({ id: "x" }), kind: "failure", priority: "failed" }],
    [null],
    ["str"],
  ])("不正な項目 %j だけを除外し、除外した件数を知らせる", (bad1) => {
    const page = run(valid("a", 1), bad1, valid("b", 2));
    expect(page.entries.map((e) => e.id)).toEqual(["a", "b"]);
    expect(page.excluded).toBe(1);
    expect(page.total).toBe(2);
  });

  it("digest は、priority（PRIORITIES のどれか）を持てば受け付け、簡潔版に priority を出す", () => {
    const page = run(
      item({
        id: "dg",
        kind: "digest",
        priority: "failed",
        summary: "要約",
        nodeId: "m1",
      } as never),
    );
    expect(page.excluded).toBe(0);
    expect(page.entries[0]).toMatchObject({ id: "dg", kind: "digest", priority: "failed" });
  });

  it("digest は、項目の priority の帯に整列する（種類の既定の info に置かない）。同じ帯では、時刻・ID の順", () => {
    const digest = (id: string, priority: string, at: string) =>
      item({
        id,
        kind: "digest",
        priority,
        summary: "配下の要約",
        nodeId: "m1",
        seq: 5,
        at,
      } as never);
    const page = run(
      item({ id: "i1", kind: "info", at: "2026-01-01T00:00:00Z" }),
      item({ id: "f1", kind: "failure", at: "2026-01-01T00:00:02Z" }),
      item({ id: "d1", kind: "decision", at: "2026-01-01T00:00:03Z" }),
      digest("dg-info", "info", "2026-01-01T00:00:01Z"),
      digest("dg-failed", "failed", "2026-01-01T00:00:01Z"),
      digest("dg-block", "blocking", "2026-01-01T00:00:09Z"),
    );
    expect(page.entries.map((e) => e.id)).toEqual([
      "d1", // blocking（時刻が早い）
      "dg-block", // blocking（digest の priority）
      "dg-failed", // failed（時刻の順。f1 より早い）
      "f1",
      "i1", // info（時刻が早い）
      "dg-info",
    ]);
  });

  it("同じ帯で、同じ at の digest は、ID の順に並ぶ（入力の順に依らない）。依存の順は、core の試験（sortInbox）で確かめている", () => {
    const dg = (id: string) =>
      item({
        id,
        kind: "digest",
        priority: "failed",
        summary: "配下の要約",
        nodeId: "m1",
        seq: 5,
        at: "2026-01-01T00:00:05Z",
      } as never);
    for (const input of [
      [dg("dg-a"), dg("dg-b")],
      [dg("dg-b"), dg("dg-a")],
    ]) {
      const page = run(...input);
      expect(page.entries.map((e) => e.id)).toEqual(["dg-a", "dg-b"]);
    }
  });

  it.each(PRIORITIES)(
    "priority が %s の digest は、同じ帯の既存の種類の項目と並び、下の帯の項目より前に出る",
    (priority) => {
      const sameBand = INBOX_KINDS.find(
        (k) => k !== "digest" && INBOX_KIND_PRIORITY[k] === priority,
      );
      const lowerBand = PRIORITIES.slice(PRIORITIES.indexOf(priority) + 1)
        .map((p) => INBOX_KINDS.find((k) => k !== "digest" && INBOX_KIND_PRIORITY[k] === p))
        .find((k) => k !== undefined);
      if (sameBand === undefined) throw new Error(`帯 ${priority} に既存の種類がない`);
      const items = [
        // 下の帯の項目は、時刻が最も早い（帯の違いで、先に出ないことを確かめる）
        ...(lowerBand === undefined
          ? []
          : [item({ id: "lower", kind: lowerBand, seq: 1, at: "2026-01-01T00:00:00Z" })]),
        item({ id: "same", kind: sameBand, seq: 2, at: "2026-01-01T00:00:01Z" }),
        item({
          id: "dg",
          kind: "digest",
          priority,
          summary: "配下の要約",
          nodeId: "m1",
          seq: 3,
          at: "2026-01-01T00:00:02Z",
        } as never),
      ];
      const page = run(...items);
      expect(page.entries.map((e) => e.id)).toEqual([
        "same", // 同じ帯（時刻が早い）
        "dg", // digest（同じ帯。時刻が遅い）
        ...(lowerBand === undefined ? [] : ["lower"]),
      ]);
    },
  );

  it("詳細版にも、digest の priority と summary が出る。digest 以外には priority がない", () => {
    const r = renderInbox(
      [
        item({
          id: "dg",
          kind: "digest",
          priority: "blocking",
          summary: "要約",
          nodeId: "m1",
        } as never),
        item({ id: "x", kind: "info", seq: 2 }),
      ],
      { detail: "full" },
    );
    if (!r.ok) throw new Error("failure");
    const dg = r.value.entries.find((e) => e.id === "dg");
    expect(dg).toMatchObject({ kind: "digest", priority: "blocking", summary: "要約" });
    const x = r.value.entries.find((e) => e.id === "x");
    expect(x && "priority" in x).toBe(false);
  });

  it("digest は、空でない summary を必ず持つ（core が書き込み時に保証する）。持たない・空のものは除外する", () => {
    const page = run(
      item({ id: "ok", kind: "digest", priority: "info", summary: "要約", nodeId: "m1" } as never),
      item({ id: "bad", kind: "digest", priority: "info", nodeId: "m1", seq: 2 } as never),
      item({
        id: "empty",
        kind: "digest",
        priority: "info",
        summary: "",
        nodeId: "m1",
        seq: 3,
      } as never),
    );
    expect(page.entries.map((e) => e.id)).toEqual(["ok"]);
    expect(page.excluded).toBe(2);
  });

  it("除外がなければ excluded は 0", () => {
    expect(run(valid("a", 1)).excluded).toBe(0);
  });

  it("除外した項目の seq は asOfSeq に含めない", () => {
    const page = run(valid("a", 1), { ...valid("b", 99), id: "b d" });
    expect(page.asOfSeq).toBe(1);
  });

  it("isSafeId に合う識別子（. _ : - を含む）は受け付ける", () => {
    const page = run(
      item({ id: "inbox-1.a_b:c", nodeId: "node-1", ref: "dec:1", dependsOn: ["n.0"] }),
    );
    expect(page.excluded).toBe(0);
    expect(page.entries).toHaveLength(1);
  });

  it("summary と at は読み取り側で検査しない（core が書き込み時に保証し、at は整列が不正値を最後に置く）", () => {
    const page = run(item({ id: "a", at: "not-a-date" }), item({ id: "b" }));
    expect(page.excluded).toBe(0);
    expect(page.entries.map((e) => e.id)).toEqual(["b", "a"]);
  });
});
