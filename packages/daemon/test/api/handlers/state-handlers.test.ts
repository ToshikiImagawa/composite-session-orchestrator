import { type EventBody, isSafeId, type NodeEvent, stateOf } from "@cso/core";
import { describe, expect, it } from "vitest";
import { createStateHandlers } from "../../../src/api/handlers/state-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";

const SYS = { system: true } as const;
let n = 0;
const clock = (): string => "2026-10-20T00:00:00Z";

/** root ─ m1 ─ a(running) / root ─ m2 ─ b(running) */
const rig = () => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const created = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
    add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
  const start = (nodeId: string) =>
    add({ type: "node.stateChanged", payload: { nodeId, event: { type: "start" } } });
  created("root", "integrator", null);
  start("root");
  created("m1", "integrator", "root");
  start("m1");
  created("a", "implement", "m1");
  start("a");
  created("m2", "integrator", "root");
  start("m2");
  created("b", "implement", "m2");
  start("b");
  const h = createStateHandlers({ log, clock });
  const req = <Op extends keyof typeof h>(
    operation: Op,
    params: Record<string, unknown>,
    who: { role: "child" | "integrator"; nodeId: string } | "human",
    requestId = `q-${++n}`,
  ) =>
    ({
      requestId,
      operation,
      role: who === "human" ? "human" : who.role,
      ...(who === "human" ? {} : { caller: { nodeId: who.nodeId } }),
      params,
    }) as unknown as HandlerRequest<never>;
  const call = async (op: keyof typeof h, r: HandlerRequest<never>) =>
    // biome-ignore lint/suspicious/noExplicitAny: 操作ごとの型は呼び出し側で保証
    (await (h[op] as any)(r)) as {
      ok: boolean;
      // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
      value?: any;
      error?: { code: string; cause: string };
    };
  return { log, h, req, call, state: () => log.state() };
};
const A = { role: "child", nodeId: "a" } as const;
const M1 = { role: "integrator", nodeId: "m1" } as const;
const ROOT = { role: "integrator", nodeId: "root" } as const;

describe("tree.list（状態から決定的に生成した木の一覧表。呼び出し側の部分木だけ）", () => {
  it("部分木のノードを、作成順に、役割・状態・親・依存つきの表にする", async () => {
    const r = rig();
    const res = await r.call("tree.list", r.req("tree.list", {}, M1));
    expect(res.ok).toBe(true);
    const lines = (res.value.table as string).split("\n");
    expect(lines[0]).toContain("id");
    expect(lines[0]).toContain("state");
    expect(
      lines.some((l) => l.includes("m1") && l.includes("integrator") && l.includes("running")),
    ).toBe(true);
    expect(lines.some((l) => /\ba\b/.test(l) && l.includes("implement"))).toBe(true);
    expect(res.value.table).not.toContain("m2");
    expect(res.value.table).not.toMatch(/\bb\b/);
  });

  it("根は全体。同じ状態からは同じ表（決定的）", async () => {
    const r = rig();
    const t1 = (await r.call("tree.list", r.req("tree.list", {}, ROOT))).value.table as string;
    const t2 = (await r.call("tree.list", r.req("tree.list", {}, ROOT))).value.table as string;
    expect(t1).toBe(t2);
    for (const id of ["root", "m1", "a", "m2", "b"]) expect(t1).toContain(id);
  });
});

describe("report.*（子 → 親への報告。報告の保存と、受信箱への追加）", () => {
  it("report.progress: 報告を保存し、受信箱に progress の項目（ref つき）を足す", async () => {
    const r = rig();
    const res = await r.call(
      "report.progress",
      r.req("report.progress", { text: "半分終わった" }, A),
    );
    expect(res).toEqual({ ok: true, value: { accepted: true } });
    const s = r.state();
    expect(s.reports).toHaveLength(1);
    expect(s.reports[0]).toMatchObject({
      nodeId: "a",
      kind: "progress",
      text: "半分終わった",
      actor: { nodeId: "a" },
    });
    const item = s.inbox.at(-1);
    expect(item).toMatchObject({ kind: "progress", nodeId: "a", ref: s.reports[0]?.reportId });
    expect(item?.summary).toContain("半分");
    expect(isSafeId(item?.id)).toBe(true);
    expect(isSafeId(s.reports[0]?.reportId)).toBe(true);
    expect(stateOf(s, "a")).toBe("running");
  });

  it("report.outOfScope: info の項目", async () => {
    const r = rig();
    await r.call("report.outOfScope", r.req("report.outOfScope", { text: "別件を見つけた" }, A));
    expect(r.state().reports[0]?.kind).toBe("outOfScope");
    expect(r.state().inbox.at(-1)?.kind).toBe("info");
  });

  it("要約は 1 行にして上限に収める。本文の全文は報告に残る", async () => {
    const r = rig();
    const text = `${"長い".repeat(300)}\n二行目\n\t三行目`;
    await r.call("report.progress", r.req("report.progress", { text }, A));
    const item = r.state().inbox.at(-1);
    expect(item?.summary).not.toContain("\n");
    expect([...(item?.summary ?? "")].length).toBeLessThanOrEqual(200);
    expect(r.state().reports[0]?.text).toBe(text);
  });

  it("report.done: 完了報告（根拠つき）を保存し、done に遷移し、done の項目を足す", async () => {
    const r = rig();
    const evidence = [{ criterion: "テスト", evidence: "pnpm test 通過" }];
    const res = await r.call("report.done", r.req("report.done", { evidence }, A));
    expect(res.ok).toBe(true);
    const s = r.state();
    expect(stateOf(s, "a")).toBe("done");
    expect(s.reports[0]).toMatchObject({ kind: "done", evidence });
    expect(s.inbox.at(-1)).toMatchObject({
      kind: "done",
      nodeId: "a",
      ref: s.reports[0]?.reportId,
    });
  });

  it("動作中でない子の報告は、何も書かずに失敗する（pending・done など）", async () => {
    const r = rig();
    await r.call("report.done", r.req("report.done", { evidence: [] }, A));
    const before = r.state().lastSeq;
    const res = await r.call("report.progress", r.req("report.progress", { text: "x" }, A));
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("notActive");
    expect(r.state().lastSeq).toBe(before);
  });

  it("同じ requestId の再試行は、重複して記録しない（冪等）", async () => {
    const r = rig();
    const rq = () => r.req("report.progress", { text: "x" }, A, "same-request");
    const a = await r.call("report.progress", rq());
    const b = await r.call("report.progress", rq());
    expect(a.ok && b.ok).toBe(true);
    expect(r.state().reports).toHaveLength(1);
    expect(r.state().inbox).toHaveLength(1);
  });

  it("report.decision: 判断要求を作り、子を waiting にし、decision の項目（ref は decisionId）を足す", async () => {
    const r = rig();
    const res = await r.call(
      "report.decision",
      r.req("report.decision", { question: "どちら？", options: ["A", "B"] }, A),
    );
    expect(res.ok).toBe(true);
    const s = r.state();
    const d = s.decisions[0];
    expect(d).toMatchObject({
      nodeId: "a",
      status: "open",
      question: "どちら？",
      options: ["A", "B"],
    });
    expect(res.value).toEqual({ decisionId: d?.decisionId });
    expect(stateOf(s, "a")).toBe("waiting");
    expect(s.inbox.at(-1)).toMatchObject({ kind: "decision", nodeId: "a", ref: d?.decisionId });
  });
});

describe("decision.present（統合ノード → 人間への判断要求）", () => {
  it("判断要求を作り、decision の項目を足す。呼び出した統合ノード自身は止めない", async () => {
    const r = rig();
    const res = await r.call(
      "decision.present",
      r.req("decision.present", { question: "DB は？", options: ["pg", "sqlite"] }, M1),
    );
    expect(res.ok).toBe(true);
    const s = r.state();
    expect(s.decisions[0]).toMatchObject({
      nodeId: "m1",
      question: "DB は？",
      options: ["pg", "sqlite"],
    });
    expect(stateOf(s, "m1")).toBe("running");
    expect(s.inbox.at(-1)).toMatchObject({
      kind: "decision",
      nodeId: "m1",
      ref: s.decisions[0]?.decisionId,
    });
  });

  it("pauseNodeIds（子の一時停止）は、再開の記録先が core にないため、まだ使えない（notSupported。何も書かない）", async () => {
    const r = rig();
    const before = r.state().lastSeq;
    const res = await r.call(
      "decision.present",
      r.req("decision.present", { question: "q", options: ["A"], pauseNodeIds: ["a"] }, M1),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("notSupported");
    expect(r.state().lastSeq).toBe(before);
    const empty = await r.call(
      "decision.present",
      r.req("decision.present", { question: "q", options: ["A"], pauseNodeIds: [] }, M1),
    );
    expect(empty.ok).toBe(true);
  });
});

describe("decision.answer（人間の回答。一本化）", () => {
  const ask = async (r: ReturnType<typeof rig>) =>
    (
      await r.call(
        "report.decision",
        r.req("report.decision", { question: "どちら？", options: ["A", "B"] }, A),
      )
    ).value.decisionId as string;

  it("選択肢から回答すると、回答を記録し、待っていた子を再開し、answer の項目を足す", async () => {
    const r = rig();
    const decisionId = await ask(r);
    const res = await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId, choice: "A" }, "human"),
    );
    expect(res).toEqual({ ok: true, value: { accepted: true } });
    const s = r.state();
    expect(s.decisions[0]).toMatchObject({
      status: "answered",
      answer: "A",
      answeredBy: { human: true },
    });
    expect(stateOf(s, "a")).toBe("running");
    expect(s.inbox.at(-1)).toMatchObject({ kind: "answer", nodeId: "a", ref: decisionId });
  });

  it("自由入力でも回答できる。選択肢にない choice は拒否する（何も書かない）", async () => {
    const r = rig();
    const decisionId = await ask(r);
    const before = r.state().lastSeq;
    const bad = await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId, choice: "C" }, "human"),
    );
    expect(bad.ok).toBe(false);
    expect(bad.error?.code).toBe("choiceNotInOptions");
    expect(r.state().lastSeq).toBe(before);
    const free = await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId, text: "Z にする" }, "human"),
    );
    expect(free.ok).toBe(true);
    expect(r.state().decisions[0]?.answer).toBe("Z にする");
  });

  it("後から来た回答は採用されず、採用された回答を伝える（alreadyAnswered。却下として記録する）", async () => {
    const r = rig();
    const decisionId = await ask(r);
    await r.call("decision.answer", r.req("decision.answer", { decisionId, choice: "A" }, "human"));
    const late = await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId, choice: "B" }, "human"),
    );
    expect(late.ok).toBe(false);
    expect(late.error?.code).toBe("alreadyAnswered");
    expect(late.error?.cause).toContain("A");
    const d = r.state().decisions[0];
    expect(d?.answer).toBe("A");
    expect(d?.rejected.map((x) => x.answer)).toEqual(["B"]);
    expect(stateOf(r.state(), "a")).toBe("running"); // 二重に再開しない
  });

  it("未知の判断要求は notFound。統合ノードの判断要求への回答は、子を再開しようとしない", async () => {
    const r = rig();
    const none = await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId: "nope", choice: "A" }, "human"),
    );
    expect(none.error?.code).toBe("notFound");
    const present = await r.call(
      "decision.present",
      r.req("decision.present", { question: "q", options: ["A"] }, M1),
    );
    const ok = await r.call(
      "decision.answer",
      r.req("decision.answer", { decisionId: present.value.decisionId, choice: "A" }, "human"),
    );
    expect(ok.ok).toBe(true);
    expect(stateOf(r.state(), "m1")).toBe("running");
  });

  it("同じ requestId の再試行は冪等", async () => {
    const r = rig();
    const decisionId = await ask(r);
    const rq = () => r.req("decision.answer", { decisionId, choice: "A" }, "human", "ans-1");
    expect((await r.call("decision.answer", rq())).ok).toBe(true);
    const lastSeq = r.state().lastSeq;
    expect((await r.call("decision.answer", rq())).ok).toBe(true);
    expect(r.state().lastSeq).toBe(lastSeq);
  });
});

describe("node.review（完了の判定。受理か差し戻し）", () => {
  const done = async (r: ReturnType<typeof rig>) => {
    await r.call("report.done", r.req("report.done", { evidence: [] }, A));
  };
  it("accept: done → verified。reject: done → running。結果は新しい状態", async () => {
    const r = rig();
    await done(r);
    const acc = await r.call(
      "node.review",
      r.req("node.review", { nodeId: "a", verdict: "accept" }, M1),
    );
    expect(acc).toEqual({ ok: true, value: { state: "verified" } });
    const r2 = rig();
    await done(r2);
    const rej = await r2.call(
      "node.review",
      r2.req("node.review", { nodeId: "a", verdict: "reject" }, M1),
    );
    expect(rej).toEqual({ ok: true, value: { state: "running" } });
  });

  it("done でないノードの判定は、何も書かずに失敗する（invalidTransition）", async () => {
    const r = rig();
    const before = r.state().lastSeq;
    const res = await r.call(
      "node.review",
      r.req("node.review", { nodeId: "a", verdict: "accept" }, M1),
    );
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("invalidTransition");
    expect(r.state().lastSeq).toBe(before);
  });
});

describe("inbox.fetch（呼び出し側の部分木の受信箱。差分取得）", () => {
  it("部分木の項目だけを、seq の昇順で返す。sinceSeq より後だけに絞れる", async () => {
    const r = rig();
    await r.call("report.progress", r.req("report.progress", { text: "a1" }, A));
    await r.call(
      "report.progress",
      r.req("report.progress", { text: "b1" }, { role: "child", nodeId: "b" }),
    );
    await r.call("report.progress", r.req("report.progress", { text: "a2" }, A));
    const m1 = await r.call("inbox.fetch", r.req("inbox.fetch", {}, M1));
    expect(m1.value.items.map((i: { nodeId: string }) => i.nodeId)).toEqual(["a", "a"]);
    const seqs = m1.value.items.map((i: { seq: number }) => i.seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    const since = await r.call("inbox.fetch", r.req("inbox.fetch", { sinceSeq: seqs[0] }, M1));
    expect(since.value.items).toHaveLength(1);
    const all = await r.call("inbox.fetch", r.req("inbox.fetch", {}, ROOT));
    expect(all.value.items).toHaveLength(3);
  });
});

describe("共通の性質", () => {
  it("操作で生成する ID は、すべて isSafeId を満たし、要求ごとに異なる", async () => {
    const r = rig();
    const sweep = ["x/y z", "日本語", "a".repeat(120)];
    for (const rq of sweep) {
      await r.call("report.progress", r.req("report.progress", { text: "t" }, A, rq));
    }
    const ids = [...r.state().reports.map((x) => x.reportId), ...r.state().inbox.map((x) => x.id)];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(isSafeId(id), id).toBe(true);
  });

  it("途中で失敗する操作は、何も書かない（事前に全体を検査する）", async () => {
    const r = rig();
    await r.call("report.done", r.req("report.done", { evidence: [] }, A)); // a は done
    const before = r.state().lastSeq;
    const res = await r.call(
      "report.decision",
      r.req("report.decision", { question: "q", options: ["A"] }, A),
    );
    expect(res.ok).toBe(false);
    expect(r.state().lastSeq).toBe(before);
    expect(r.state().decisions).toHaveLength(0);
  });
});

void (null as unknown as NodeEvent);
