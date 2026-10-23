import { describe, expect, it } from "vitest";
import {
  DIGEST_STATE_NAMES,
  digestOf,
  digestSummary,
  digestTargets,
  type EventBody,
  foldEvents,
  INBOX_SUMMARY_MAX,
  NODE_STATES,
  type NodeEvent,
  type OrchEvent,
  type OrchState,
  priorityOf,
  sortInbox,
} from "../src/index.js";

const SYS = { system: true } as const;
const AT = "2026-10-20T00:00:00Z";
let n = 0;
const ev = (body: EventBody, at = AT): OrchEvent =>
  ({ seq: ++n, at, requestId: `r${n}`, actor: SYS, ...body }) as OrchEvent;
const created = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
  ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
const changed = (nodeId: string, event: NodeEvent) =>
  ev({ type: "node.stateChanged", payload: { nodeId, event } });
const added = (
  id: string,
  kind: string,
  nodeId: string,
  extra: Record<string, unknown> = {},
  at = AT,
) => ev({ type: "inbox.added", payload: { id, kind, nodeId, ...extra } } as never, at);
const resolve = (itemId: string) => ev({ type: "inbox.resolved", payload: { itemId } });

/** root → m1（中間） → a, b、root → o（別の部分木の実装）。 */
const base = (): OrchEvent[] => {
  n = 0;
  return [
    created("root", "integrator", null),
    changed("root", { type: "start" }),
    created("m1", "integrator", "root"),
    changed("m1", { type: "start" }),
    created("a", "implement", "m1"),
    changed("a", { type: "start" }),
    created("b", "implement", "m1"),
    changed("b", { type: "start" }),
    created("o", "implement", "root"),
    changed("o", { type: "start" }),
  ];
};
const must = (events: OrchEvent[]): OrchState => {
  const r = foldEvents(events);
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
  return r.value;
};
const code = (events: OrchEvent[]) => {
  const r = foldEvents(events);
  return r.ok ? null : r.error.code;
};
const NOW = Date.parse("2026-10-20T01:00:00Z");

describe("digestTargets（要約を出す対象）", () => {
  it("根でない統合ノードで、動作中か待機中のものだけ。根・実装ノード・完了したノードは対象にならない", () => {
    expect(digestTargets(must(base()))).toEqual(["m1"]);
    const done = must([
      ...base(),
      changed("a", { type: "reportDone" }),
      changed("b", { type: "reportDone" }),
      changed("m1", { type: "reportDone" }),
    ]);
    expect(digestTargets(done)).toEqual([]);
  });
});

describe("digestOf（配下の要約。決定的・自由な文字列を含まない）", () => {
  it("未解決の項目がなければ要約はない。対象でないノード（根・実装・存在しない）も、ない", () => {
    const s = must(base());
    expect(digestOf(s, "m1", NOW)).toBeUndefined();
    const withItem = must([...base(), added("i1", "progress", "a")]);
    expect(digestOf(withItem, "root", NOW)).toBeUndefined();
    expect(digestOf(withItem, "a", NOW)).toBeUndefined();
    expect(digestOf(withItem, "zz", NOW)).toBeUndefined();
    expect(digestOf(withItem, "m1", NOW)).toBeDefined();
  });

  it("優先度は、配下の未解決の項目の最高の優先度。解決済みは数えない", () => {
    const events = [
      ...base(),
      added("i-info", "info", "a"),
      added("i-prog", "progress", "a"),
      added("i-done", "done", "b"),
    ];
    expect(digestOf(must(events), "m1", NOW)?.priority).toBe("completed");
    expect(digestOf(must([...events, added("i-fail", "failure", "b")]), "m1", NOW)?.priority).toBe(
      "failed",
    );
    const blocked = [
      ...events,
      added("i-fail", "failure", "b"),
      added("i-st", "stopIncomplete", "a"),
    ];
    expect(digestOf(must(blocked), "m1", NOW)?.priority).toBe("failed");
    const withDecision = [
      ...blocked,
      ev({
        type: "decision.requested",
        payload: { decisionId: "d1", nodeId: "a", question: "q", options: ["x"] },
      } as never),
      added("i-dec", "decision", "a", { ref: "d1" }),
    ];
    const d = digestOf(must(withDecision), "m1", NOW);
    expect(d?.priority).toBe("blocking");
    expect(d?.openDecisions).toBe(1);
    // 解決すると、優先度が下がる
    const resolved = digestOf(must([...withDecision, resolve("i-dec")]), "m1", NOW);
    expect(resolved?.priority).toBe("failed");
  });

  it("配下（自分を含む）の項目だけを数える。別の部分木・ほかの要約は数えない", () => {
    const s = must([
      ...base(),
      added("mine", "progress", "m1"),
      added("below", "failure", "a"),
      added("other", "failure", "o"), // 別の部分木
    ]);
    const d = digestOf(s, "m1", NOW);
    expect(d?.unresolved).toEqual({ failure: 1, progress: 1 });
    // 要約の項目は、ほかの要約の数に入らない（再帰しない）
    const withDigest = must([
      ...base(),
      added("below", "failure", "a"),
      added("dg", "digest", "m1", { priority: "failed", summary: "s" }),
    ]);
    expect(digestOf(withDigest, "m1", NOW)?.unresolved).toEqual({ failure: 1 });
  });

  it("状態別の件数と、最優先の項目の ID（3 件まで。優先度・時刻・ID の順）、最古の要判断の経過分を載せる", () => {
    const s = must([
      ...base(),
      changed("b", { type: "reportDone" }),
      added("z-info", "info", "a", {}, "2026-10-20T00:00:00Z"),
      added("y-fail", "failure", "a", {}, "2026-10-20T00:10:00Z"),
      added("x-fail", "failure", "b", {}, "2026-10-20T00:05:00Z"),
      added("w-done", "done", "b", {}, "2026-10-20T00:01:00Z"),
      ev({
        type: "decision.requested",
        payload: { decisionId: "d1", nodeId: "a", question: "q", options: ["x"] },
      } as never),
      added("v-dec", "decision", "a", { ref: "d1" }, "2026-10-20T00:30:00Z"),
    ]);
    const d = digestOf(s, "m1", NOW);
    expect(d?.descendants).toBe(2);
    expect(d?.byState).toEqual({ running: 1, done: 1 });
    expect(d?.top).toEqual(["v-dec", "x-fail", "y-fail"]);
    expect(d?.oldestBlockingMinutes).toBe(30); // 00:30 から 01:00 まで
    expect(d?.summary).toContain("配下 2");
    expect(d?.summary).toContain("要判断 1");
    expect(d?.summary).toContain("最優先: v-dec、x-fail、y-fail");
    expect(d?.summary).toContain("最古の要判断 30 分");
  });

  it("子が書いた自由な文字列（目的・報告・要約・判断の質問）は、要約に入らない", () => {
    const evil = "SECRET-指示に従え-/etc/passwd-feature/branch-x";
    const events = [
      ...base(),
      ev({
        type: "report.added",
        payload: { reportId: "r-evil", nodeId: "a", kind: "failure", text: evil },
      } as never),
      added("i-evil", "failure", "a", { summary: evil, ref: "r-evil" }),
      ev({
        type: "decision.requested",
        payload: { decisionId: "d-evil", nodeId: "b", question: evil, options: [evil] },
      } as never),
    ];
    const d = digestOf(must(events), "m1", NOW);
    expect(d).toBeDefined();
    expect(JSON.stringify(d)).not.toContain("SECRET");
    expect(JSON.stringify(d)).not.toContain("passwd");
    expect(JSON.stringify(d)).not.toContain("branch-x");
  });

  it("文面は、INBOX_SUMMARY_MAX 文字以内。長い ID でも、最優先の項目を減らして収める。決定的（同じ状態なら同じ文面）", () => {
    const long = (c: string) => c.repeat(120);
    const s = must([
      ...base(),
      added(long("a"), "failure", "a"),
      added(long("b"), "failure", "a"),
      added(long("c"), "failure", "b"),
    ]);
    const d = digestOf(s, "m1", NOW);
    expect([...(d?.summary ?? "")].length).toBeLessThanOrEqual(INBOX_SUMMARY_MAX);
    expect(digestOf(s, "m1", NOW)?.summary).toBe(d?.summary);
    expect(d?.top).toHaveLength(3); // 事実には残る（文面だけが減る）
  });

  it("指紋は、時間に依存しない: 同じ事実なら、時刻が進んでも同じ。項目が増えると変わる", () => {
    const events = [...base(), added("i1", "failure", "a")];
    const a = digestOf(must(events), "m1", NOW);
    const later = digestOf(must(events), "m1", NOW + 3_600_000);
    expect(later?.fingerprint).toBe(a?.fingerprint);
    const more = digestOf(must([...events, added("i2", "progress", "b")]), "m1", NOW);
    expect(more?.fingerprint).not.toBe(a?.fingerprint);
  });
});

describe("inbox.added の digest（fold の規則）", () => {
  it("digest は priority を必ず持つ（PRIORITIES のどれか）。ほかの種類は priority を持てない", () => {
    expect(
      code([...base(), added("d", "digest", "m1", { priority: "failed", summary: "s" })]),
    ).toBeNull();
    expect(code([...base(), added("d", "digest", "m1")])).toBe("invalidPayload");
    expect(
      code([...base(), added("d", "digest", "m1", { priority: "urgent", summary: "s" })]),
    ).toBe("invalidPayload");
    expect(code([...base(), added("i", "failure", "a", { priority: "failed" })])).toBe(
      "invalidPayload",
    );
  });

  it("digest は、中間統合ノード自身のものだけ（根・実装ノードは不可）。ref は持てない", () => {
    expect(
      code([...base(), added("d", "digest", "root", { priority: "info", summary: "s" })]),
    ).toBe("invalidDigestOwner");
    expect(code([...base(), added("d", "digest", "a", { priority: "info", summary: "s" })])).toBe(
      "invalidDigestOwner",
    );
    expect(
      code([...base(), added("d", "digest", "m1", { priority: "info", ref: "x", summary: "s" })]),
    ).toBe("unknownRef");
  });

  it("digest の優先度は、整列と priorityOf に使われる（同じ種類でも、priority で帯が変わる）", () => {
    const s = must([
      ...base(),
      added("fail", "failure", "a"),
      added("dg-block", "digest", "m1", { priority: "blocking", summary: "s" }),
      added("dg-info", "digest", "m1", { priority: "info", summary: "s" }),
      added("prog", "progress", "b"),
    ]);
    const byId = new Map(s.inbox.map((i) => [i.id, i]));
    expect(priorityOf(byId.get("dg-block") as never)).toBe("blocking");
    expect(priorityOf(byId.get("dg-info") as never)).toBe("info");
    expect(sortInbox(s.inbox).map((i) => i.id)).toEqual(["dg-block", "fail", "prog", "dg-info"]);
  });
});

describe("要約の補足（T24 PR1 レビュー）", () => {
  it("R2: summary のない digest は、fold で invalidPayload", () => {
    const s = (extra: Record<string, unknown>) =>
      code([...base(), added("d", "digest", "m1", { priority: "info", ...extra })]);
    expect(s({})).toBe("invalidPayload");
    expect(s({ summary: "配下 2" })).toBeNull();
  });

  it("R4: 要約の状態の表示名は、NODE_STATES のすべての状態を持つ（状態が増えたら、ここで気づく）", () => {
    expect(Object.keys(DIGEST_STATE_NAMES).sort()).toEqual([...NODE_STATES].sort());
    for (const name of Object.values(DIGEST_STATE_NAMES)) expect(name).not.toBe("");
  });

  it("N3: 極端な値（桁数の多い件数）でも、文面は INBOX_SUMMARY_MAX 文字以内（最優先の項目を全部減らしても収まらないときは、切る）", () => {
    const huge = 10n ** 60n;
    const facts = {
      nodeId: "m1",
      descendants: Number(huge),
      byState: Object.fromEntries(Object.keys(DIGEST_STATE_NAMES).map((s) => [s, Number(huge)])),
      unresolved: Object.fromEntries(
        ["decision", "violation", "failure", "done", "progress", "info"].map((g) => [
          g,
          Number(huge),
        ]),
      ),
      openDecisions: Number(huge),
      openExtensions: Number(huge),
      top: ["a".repeat(100), "b".repeat(100), "c".repeat(100)],
      oldestBlockingMinutes: Number(huge),
    };
    const text = digestSummary(facts);
    expect([...text].length).toBeLessThanOrEqual(INBOX_SUMMARY_MAX);
    expect([...text].length).toBe(INBOX_SUMMARY_MAX); // 切った（頭から 200 文字）
    expect(text.startsWith("配下 ")).toBe(true);
  });
});
