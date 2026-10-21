import {
  type EventBody,
  type Failure,
  failure,
  type NodeEvent,
  ok,
  type ProcessInfo,
  type Result,
  stateOf,
} from "@cso/core";
import { describe, expect, it } from "vitest";
import {
  createReclaimHandlers,
  type ReclaimPorts,
  type WorktreeFacts,
} from "../../../src/api/handlers/reclaim-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-10-20T00:00:00Z";
const WT = "/wt";
let n = 0;

/** root ─ m1 ─ a(verified)、root ─ m2 ─ b(verified)・c(verified)。呼び出し元は既定で m1 */
const rig = (
  over: {
    facts?: Record<string, WorktreeFacts | undefined>;
    processes?: readonly ProcessInfo[] | null;
  } = {},
) => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const node = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
    add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  const verified = (nodeId: string) => {
    ev(nodeId, { type: "start" });
    ev(nodeId, { type: "reportDone" });
    ev(nodeId, { type: "accept" });
  };
  node("root", "integrator", null);
  ev("root", { type: "start" });
  node("m1", "integrator", "root");
  ev("m1", { type: "start" });
  node("a", "implement", "m1");
  verified("a");
  node("m2", "integrator", "root");
  ev("m2", { type: "start" });
  node("b", "implement", "m2");
  verified("b");
  node("c", "implement", "m2");
  verified("c");

  const removed: string[] = [];
  const expectedPaths: [string, string][] = [];
  /** `removeWorktree` に渡された `force`（渡されなければ undefined）。 */
  const forces: [string, boolean | undefined][] = [];
  const probed: string[] = [];
  const state = {
    facts: {
      a: { merged: true, clean: true, worktreePath: `${WT}/a` },
      b: { merged: true, clean: true, worktreePath: `${WT}/b` },
      c: { merged: true, clean: true, worktreePath: `${WT}/c` },
      m1: { merged: true, clean: true, worktreePath: `${WT}/m1` },
      m2: { merged: true, clean: true, worktreePath: `${WT}/m2` },
      ...over.facts,
    } as Record<string, WorktreeFacts | undefined>,
    processes:
      over.processes === undefined ? ([] as readonly ProcessInfo[] | null) : over.processes,
    removeFailsFor: new Set<string>(),
  };
  const ports: ReclaimPorts = {
    factsFor: async (id) => state.facts[id],
    probe: async (path) => {
      probed.push(path);
      return state.processes;
    },
    removeWorktree: async (id, opts): Promise<Result<undefined, Failure>> => {
      expectedPaths.push([id, opts.expectedPath]);
      forces.push([id, opts.force]);
      if (state.removeFailsFor.has(id))
        return { ok: false, error: failure("removeFailed", `${id} を消せない`, "もう一度試す") };
      removed.push(id);
      return ok(undefined);
    },
    worktreeRoot: WT,
  };
  const h = createReclaimHandlers({ log, clock, ports });
  const call = async (
    op: keyof typeof h,
    params: Record<string, unknown>,
    caller = "m1",
    requestId = `q-${++n}`,
  ) => {
    const req = {
      requestId,
      operation: op,
      role: "integrator",
      caller: { nodeId: caller },
      params,
    } as unknown as HandlerRequest<never>;
    // biome-ignore lint/suspicious/noExplicitAny: 操作ごとの型は呼び出し側で保証
    return (await (h[op] as any)(req)) as { ok: boolean; value?: any; error?: Failure };
  };
  return {
    handlers: h,
    log,
    call,
    ev,
    removed,
    expectedPaths,
    forces,
    probed,
    state,
    s: () => log.state(),
  };
};

describe("node.reclaimPreview（回収の事前確認。何も変えない）", () => {
  it("統合済み・きれい・プロセスなしの子は回収可能", async () => {
    const r = rig();
    const before = r.s().lastSeq;
    expect(await r.call("node.reclaimPreview", { nodeId: "a" })).toEqual({
      ok: true,
      value: { reclaimable: true, unmet: [], blockers: [] },
    });
    expect(r.s().lastSeq).toBe(before);
    expect(r.removed).toEqual([]);
  });

  it("満たしていない条件と原因を、構造で返す（未統合・未保存の変更・プロセス・事実なし）", async () => {
    const dirty = rig({ facts: { a: { merged: true, clean: false, worktreePath: `${WT}/a` } } });
    const d = await dirty.call("node.reclaimPreview", { nodeId: "a" });
    expect(d.ok).toBe(true);
    expect(d.value).toMatchObject({ reclaimable: false, unmet: ["dirty"] });
    const notMerged = rig({
      facts: { a: { merged: false, clean: true, worktreePath: `${WT}/a` } },
    });
    expect((await notMerged.call("node.reclaimPreview", { nodeId: "a" })).value.unmet).toEqual([
      "notMerged",
    ]);
    const running = rig({ processes: [{ pid: 4242, cwd: `${WT}/a`, hasOpenFiles: false }] });
    const p = await running.call("node.reclaimPreview", { nodeId: "a" });
    expect(p.value.unmet).toEqual(["processesRunning"]);
    expect(p.value.blockers).toEqual([{ kind: "process", reason: "processesRunning", pid: 4242 }]);
    const missing = rig({ facts: { a: undefined } });
    expect((await missing.call("node.reclaimPreview", { nodeId: "a" })).value.unmet).toContain(
      "factsMissing",
    );
    const unknown = rig({ processes: null });
    expect((await unknown.call("node.reclaimPreview", { nodeId: "a" })).value.unmet).toContain(
      "processesUnknown",
    );
  });

  it("停止したノードは、破棄の判断（node.reclaimInstruct）の記録なしには回収できない（discardRequired）。記録すれば回収できる", async () => {
    const r = rig();
    r.log.append({
      requestId: "d1",
      actor: SYS,
      body: {
        type: "node.created",
        payload: { nodeId: "d", role: "implement", parentId: "m1", dependsOn: [] },
      },
    });
    r.ev("d", { type: "start" });
    r.ev("d", { type: "stop", mode: "immediate" });
    r.ev("d", { type: "confirmStopped" });
    r.state.facts.d = { merged: false, clean: false, worktreePath: `${WT}/d` };
    const before = await r.call("node.reclaimPreview", { nodeId: "d" });
    expect(before.value.reclaimable).toBe(false);
    expect(before.value.unmet).toContain("discardRequired");
    const bad = await r.call("node.reclaim", { nodeId: "d" });
    expect(bad.error?.code).toBe("notReclaimable");
    expect(bad.error?.nextActions.join(" ")).toContain("人間");
    // 人間の判断を記録する（冪等）
    const human = async (rid: string) =>
      (await (r.handlers["node.reclaimInstruct"] as never as (q: unknown) => unknown)({
        requestId: rid,
        operation: "node.reclaimInstruct",
        role: "human",
        params: { nodeId: "d" },
      })) as { ok: boolean };
    expect((await human("ri-1")).ok).toBe(true);
    expect((await human("ri-2")).ok).toBe(true);
    expect(r.s().nodes.find((n) => n.id === "d")?.discarded).toBeDefined();
    const after = await r.call("node.reclaimPreview", { nodeId: "d" });
    expect(after.value).toMatchObject({ reclaimable: true });
    const done = await r.call("node.reclaim", { nodeId: "d" });
    expect(done.value.reclaimed).toEqual(["d"]);
    expect(stateOf(r.s(), "d")).toBe("archived");
    expect(r.s().nodes.find((n) => n.id === "d")?.archivedAt).toBeDefined();
  });

  describe("強制（force）を渡すかどうかの判断（ハンドラが行う。T10r2）", () => {
    const stoppedNode = (r: ReturnType<typeof rig>, id: string, parent = "m1") => {
      r.log.append({
        requestId: `c-${id}`,
        actor: SYS,
        body: {
          type: "node.created",
          payload: { nodeId: id, role: "implement", parentId: parent, dependsOn: [] },
        },
      });
      r.ev(id, { type: "start" });
      r.ev(id, { type: "stop", mode: "immediate" });
      r.ev(id, { type: "confirmStopped" });
      r.state.facts[id] = { merged: false, clean: false, worktreePath: `${WT}/${id}` };
    };
    const decide = async (r: ReturnType<typeof rig>, id: string) =>
      (await (r.handlers["node.reclaimInstruct"] as never as (q: unknown) => unknown)({
        requestId: `ri-${id}`,
        operation: "node.reclaimInstruct",
        role: "human",
        params: { nodeId: id },
      })) as { ok: boolean };

    it("記録上 discarded（人間が破棄を判断した）の停止ノードは、force: true で消す", async () => {
      const r = rig();
      stoppedNode(r, "d");
      expect((await decide(r, "d")).ok).toBe(true);
      const done = await r.call("node.reclaim", { nodeId: "d" });
      expect(done.value.reclaimed).toEqual(["d"]);
      expect(r.forces).toEqual([["d", true]]);
    });

    it("統合済み・検証済みのノード（破棄の判断なし）は、強制しない（force を渡さない）", async () => {
      const r = rig();
      const done = await r.call("node.reclaim", { nodeId: "a" });
      expect(done.value.reclaimed).toEqual(["a"]);
      expect(r.forces).toEqual([["a", undefined]]);
    });

    it("配下の回収では、破棄の判断のある配下だけ force。ほかの配下・統合ノード自身は強制しない", async () => {
      const r = rig();
      stoppedNode(r, "d", "m2");
      expect((await decide(r, "d")).ok).toBe(true);
      r.ev("m2", { type: "reportDone" });
      r.ev("m2", { type: "accept" });
      const done = await r.call("node.reclaim", { nodeId: "m2" }, "root");
      expect(done.ok).toBe(true);
      const byId = new Map(r.forces);
      expect(byId.get("d")).toBe(true);
      expect(byId.get("b")).toBeUndefined();
      expect(byId.get("c")).toBeUndefined();
      expect(byId.get("m2")).toBeUndefined();
    });

    it("判断を記録した後に再開（restart）したノードは、判断が消えるので、強制しない", async () => {
      const r = rig();
      stoppedNode(r, "d");
      expect((await decide(r, "d")).ok).toBe(true);
      r.ev("d", { type: "restart", dependenciesDone: true });
      expect(r.s().nodes.find((n) => n.id === "d")?.discarded).toBeUndefined();
      r.ev("d", { type: "reportDone" });
      r.ev("d", { type: "accept" });
      r.state.facts.d = { merged: true, clean: true, worktreePath: `${WT}/d` };
      const done = await r.call("node.reclaim", { nodeId: "d" });
      expect(done.value.reclaimed).toEqual(["d"]);
      expect(r.forces).toEqual([["d", undefined]]);
    });

    it("force で消せなかったときの再試行も、force を渡す（記録は回収可能のまま、discarded は残る）", async () => {
      const r = rig();
      stoppedNode(r, "d");
      expect((await decide(r, "d")).ok).toBe(true);
      r.state.removeFailsFor.add("d");
      expect((await r.call("node.reclaim", { nodeId: "d" })).ok).toBe(false);
      r.state.removeFailsFor.delete("d");
      expect((await r.call("node.reclaim", { nodeId: "d" })).ok).toBe(true);
      expect(r.forces).toEqual([
        ["d", true],
        ["d", true],
      ]);
    });
  });

  it("停止していないノードの破棄の判断は、日本語の理由と次の操作つきで失敗する", async () => {
    const r = rig();
    const res = (await (r.handlers["node.reclaimInstruct"] as never as (q: unknown) => unknown)({
      requestId: "ri-x",
      operation: "node.reclaimInstruct",
      role: "human",
      params: { nodeId: "a" },
    })) as { ok: boolean; error?: Failure };
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("notStopped");
    expect(res.error?.cause).toContain("停止済み");
    expect(res.error?.nextActions.length).toBeGreaterThan(0);
    expect(r.s().nodes.find((n) => n.id === "a")?.discarded).toBeUndefined();
  });

  it("統合ノードは、配下の回収可能性を連鎖して見る（配下が回収可能なら、統合ノードも回収可能）。配下に不可があれば名指しする", async () => {
    const r = rig();
    // m2 を verified にする（b・c は verified）
    r.ev("m2", { type: "reportDone" });
    r.ev("m2", { type: "accept" });
    expect(await r.call("node.reclaimPreview", { nodeId: "m2" }, "root")).toEqual({
      ok: true,
      value: { reclaimable: true, unmet: [], blockers: [] },
    });
    const bad = rig({ facts: { c: { merged: true, clean: false, worktreePath: `${WT}/c` } } });
    bad.ev("m2", { type: "reportDone" });
    bad.ev("m2", { type: "accept" });
    const res = await bad.call("node.reclaimPreview", { nodeId: "m2" }, "root");
    expect(res.ok).toBe(true);
    expect(res.value.reclaimable).toBe(false);
    expect(res.value.unmet).toContain("descendantsNotReclaimable");
    expect(res.value.blockers).toContainEqual({ kind: "node", reason: "dirty", nodeId: "c" });
  });

  it("対象が呼び出し元の部分木の外（自分自身・別の部分木）なら forbidden", async () => {
    const r = rig();
    for (const nodeId of ["m1", "b", "root"]) {
      expect((await r.call("node.reclaimPreview", { nodeId })).error?.code, nodeId).toBe(
        "forbidden",
      );
    }
  });
});

describe("node.reclaim（回収の実行。実行時に再判定し、配下から順に）", () => {
  it("子を回収する: 回収可能にし、作業ツリーを消し、アーカイブする。回収したノードの ID を返す", async () => {
    const r = rig();
    const res = await r.call("node.reclaim", { nodeId: "a" });
    expect(res).toEqual({ ok: true, value: { reclaimed: ["a"] } });
    expect(stateOf(r.s(), "a")).toBe("archived");
    expect(r.removed).toEqual(["a"]);
  });

  it("統合ノードは、配下から先に回収する（連鎖。配下 → 統合ノードの順）", async () => {
    const r = rig();
    r.ev("m2", { type: "reportDone" });
    r.ev("m2", { type: "accept" });
    const res = await r.call("node.reclaim", { nodeId: "m2" }, "root");
    expect(res.ok).toBe(true);
    expect(res.value.reclaimed).toEqual(["b", "c", "m2"]);
    expect(r.removed).toEqual(["b", "c", "m2"]);
    for (const id of ["b", "c", "m2"]) expect(stateOf(r.s(), id)).toBe("archived");
    expect(stateOf(r.s(), "a")).toBe("verified"); // 別の部分木は触らない
  });

  it("実行時に再判定する: 事前確認の後にプロセスが現れたら、何もせずに失敗する", async () => {
    const r = rig();
    expect((await r.call("node.reclaimPreview", { nodeId: "a" })).ok).toBe(true);
    r.state.processes = [{ pid: 7, cwd: `${WT}/a`, hasOpenFiles: false }];
    const before = r.s().lastSeq;
    const res = await r.call("node.reclaim", { nodeId: "a" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("notReclaimable");
    expect(r.s().lastSeq).toBe(before);
    expect(r.removed).toEqual([]);
  });

  it("配下に回収できないノードが 1 つでもあれば、何もしない（全体を事前に検査する）", async () => {
    const r = rig({ facts: { c: { merged: false, clean: true, worktreePath: `${WT}/c` } } });
    r.ev("m2", { type: "reportDone" });
    r.ev("m2", { type: "accept" });
    const before = r.s().lastSeq;
    const res = await r.call("node.reclaim", { nodeId: "m2" }, "root");
    expect(res.ok).toBe(false);
    expect(r.s().lastSeq).toBe(before);
    expect(r.removed).toEqual([]);
  });

  it("作業ツリーの削除に失敗したら、そこで止めて失敗を返す（記録は回収可能のまま）。直したあとの再試行で完了する", async () => {
    const r = rig();
    r.ev("m2", { type: "reportDone" });
    r.ev("m2", { type: "accept" });
    r.state.removeFailsFor.add("c");
    const res = await r.call("node.reclaim", { nodeId: "m2" }, "root");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("removeFailed");
    expect(stateOf(r.s(), "b")).toBe("archived");
    expect(stateOf(r.s(), "c")).toBe("reclaimable");
    expect(stateOf(r.s(), "m2")).toBe("verified");
    r.state.removeFailsFor.clear();
    const retry = await r.call("node.reclaim", { nodeId: "m2" }, "root");
    expect(retry.ok).toBe(true);
    expect(retry.value.reclaimed).toEqual(["b", "c", "m2"]);
    for (const id of ["b", "c", "m2"]) expect(stateOf(r.s(), id)).toBe("archived");
  });

  it("記録の直前に、そのノードだけ取り直して再判定する: 途中でプロセスが現れたら、そこで止めて回収済みを示す", async () => {
    const r = rig();
    r.ev("m2", { type: "reportDone" });
    r.ev("m2", { type: "accept" });
    const original = r.state.processes;
    let calls = 0;
    // 最初の一括判定のあと、c の記録の直前の取り直しで、c の作業ツリーにプロセスが現れる
    r.state.facts.c = { merged: true, clean: true, worktreePath: `${WT}/c` };
    Object.defineProperty(r.state, "processes", {
      get: () => (++calls > 2 ? [{ pid: 9, cwd: `${WT}/c`, hasOpenFiles: false }] : original),
    });
    const res = await r.call("node.reclaim", { nodeId: "m2" }, "root");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("notReclaimable");
    expect(res.error?.cause).toContain("回収済み: b");
    expect(stateOf(r.s(), "b")).toBe("archived");
    expect(stateOf(r.s(), "c")).toBe("verified");
  });

  it("作業ツリーの削除には、判定に使ったパスを expectedPath で渡す", async () => {
    const r = rig();
    await r.call("node.reclaim", { nodeId: "a" });
    expect(r.expectedPaths).toEqual([["a", `${WT}/a`]]);
  });

  it("削除が例外を投げたら Failure に変え、回収済みを示す。生の原因は応答に出さない", async () => {
    const r = rig();
    r.ev("m2", { type: "reportDone" });
    r.ev("m2", { type: "accept" });
    r.state.removeFailsFor.add("b");
    const res = await r.call("node.reclaim", { nodeId: "m2" }, "root");
    expect(res.error?.code).toBe("removeFailed");
    expect(res.error?.cause).not.toContain("消せない");
  });

  it("回収は直列: 実行中の回収があれば、後の要求は busy を返す", async () => {
    const r = rig();
    const [first, second] = await Promise.all([
      r.call("node.reclaim", { nodeId: "a" }),
      r.call("node.reclaim", { nodeId: "a" }),
    ]);
    expect([first.ok, second.ok].sort()).toEqual([false, true]);
    expect([first, second].find((x) => !x.ok)?.error?.code).toBe("busy");
  });

  it("事実の取得が例外なら、回収不可（安全側）で失敗する", async () => {
    const r = rig();
    r.state.facts = new Proxy(r.state.facts, {
      get: () => {
        throw new Error("git が壊れた");
      },
    });
    const res = await r.call("node.reclaimPreview", { nodeId: "a" });
    expect(res.value.reclaimable).toBe(false);
    expect(res.value.unmet).toContain("factsMissing");
  });

  it("同じ requestId の再試行は、記録を重複させない", async () => {
    const r = rig();
    await r.call("node.reclaim", { nodeId: "a" }, "m1", "rec-1");
    const seq = r.s().lastSeq;
    const again = await r.call("node.reclaim", { nodeId: "a" }, "m1", "rec-1");
    expect(again.ok).toBe(true);
    expect(r.s().lastSeq).toBe(seq);
  });

  it("部分木の外は forbidden。回収できない状態（running など）は notReclaimable", async () => {
    const r = rig();
    expect((await r.call("node.reclaim", { nodeId: "b" })).error?.code).toBe("forbidden");
    const r2 = rig();
    r2.ev("m1", { type: "stop", mode: "immediate" }); // m1 自体は対象外。a を停止して確かめる代わりに root から m1 を見る
    const res = await r2.call("node.reclaim", { nodeId: "m1" }, "root");
    expect(res.ok).toBe(false);
  });
});

describe("未整備の操作（reclaimInstruct・purge・purgePreview）", () => {
  it("何も書かずに notSupported で失敗する", async () => {
    const r = rig();
    const before = r.s().lastSeq;
    for (const op of ["node.purge", "node.purgePreview"] as const) {
      expect((await r.call(op, { nodeId: "a" })).error?.code, op).toBe("notSupported");
    }
    expect(r.s().lastSeq).toBe(before);
  });
});
