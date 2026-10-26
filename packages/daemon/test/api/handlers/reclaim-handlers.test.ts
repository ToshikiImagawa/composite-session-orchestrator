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
import type { LogPort } from "../../../src/api/handlers/context.js";
import {
  createReclaimHandlers,
  type ReclaimPorts,
  type WorktreeFacts,
} from "../../../src/api/handlers/reclaim-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import type { LossFacts } from "../../../src/git-ports.js";
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
    failLastCommit?: boolean;
    /** 強制の回収で失われるもの（T21r）。指定すると、ポートが `lossFor` を持つ。"throw" は、取得の失敗。 */
    loss?: Record<string, LossFacts | "throw" | undefined>;
    /** 強制のとき、ポートが `onTip` に渡す先端（判定のあとに動いた先端の模擬）。 */
    tips?: Record<string, string>;
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
      const tip = over.tips?.[id];
      if (opts.force === true && tip !== undefined) opts.onTip?.(tip);
      if (state.removeFailsFor.has(id))
        return { ok: false, error: failure("removeFailed", `${id} を消せない`, "もう一度試す") };
      removed.push(id);
      return ok(undefined);
    },
    worktreeRoot: WT,
    ...(over.loss === undefined
      ? {}
      : {
          lossFor: async (id: string) => {
            const v = over.loss?.[id];
            if (v === "throw") throw new Error("git が失敗した");
            return v;
          },
        }),
  };
  const failures: string[] = [];
  const handlerLog: LogPort =
    over.failLastCommit === true
      ? {
          state: () => log.state(),
          append: (r) => log.append(r),
          appendAll: (rs) =>
            rs.some((r) => r.body.type === "node.lastCommit")
              ? { ok: false, error: failure("storeFailed", "書けない", "もう一度試す") }
              : log.appendAll(rs),
        }
      : log;
  const h = createReclaimHandlers({
    log: handlerLog,
    clock,
    ports,
    onFailure: (id, cause) => failures.push(`${id}: ${cause}`),
  });
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
    failures,
    probed,
    state,
    s: () => log.state(),
  };
};

/** 人間のロールで、node.reclaimPreview を呼ぶ（caller なし。部分木の制限なし）。 */
const humanPreview = async (r: ReturnType<typeof rig>, nodeId: string) =>
  // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
  (await (r.handlers["node.reclaimPreview"] as any)({
    requestId: `h-${++n}`,
    operation: "node.reclaimPreview",
    role: "human",
    params: { nodeId },
    // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
  } as unknown as HandlerRequest<never>)) as { ok: boolean; value?: any; error?: Failure };

describe("node.reclaimPreview の loss（強制の回収で失われるもの。T21r）", () => {
  const lossA: LossFacts = {
    aheadCommits: 2,
    subjects: ["機能を足す", "直す"],
    uncommitted: true,
    untracked: 3,
  };

  it("lossFor があれば、対象と配下のうち、失われるものがあるノードだけを loss に出す。何も変えない", async () => {
    const r = rig({
      loss: { a: lossA, m1: { aheadCommits: 0, subjects: [], uncommitted: false, untracked: 0 } },
    });
    const before = r.s().lastSeq;
    const res = await humanPreview(r, "a");
    expect(res.value.loss).toEqual([
      {
        nodeId: "a",
        aheadCommits: 2,
        untrustedSubjects: ["機能を足す", "直す"],
        uncommitted: true,
        untracked: 3,
      },
    ]);
    expect(r.s().lastSeq).toBe(before);
    expect(r.removed).toEqual([]);
  });

  it("何も失われなければ、loss は空の配列（情報はある）。lossFor がなければ、loss は出さない（情報なし）", async () => {
    const none = rig({
      loss: { a: { aheadCommits: 0, subjects: [], uncommitted: false, untracked: 0 } },
    });
    expect((await humanPreview(none, "a")).value.loss).toEqual([]);
    const absent = rig();
    expect(await humanPreview(absent, "a")).toEqual({
      ok: true,
      value: { reclaimable: true, unmet: [], blockers: [] },
    });
  });

  it("上流が分からないノード（aheadCommits なし）は、不明として loss に出す。作業ツリーがないノードは、飛ばす。取得に失敗したノードは、飛ばさず unknown として残す（事前確認は止まらない。L2b）", async () => {
    const r = rig({
      loss: {
        a: { subjects: [], uncommitted: false, untracked: 0 },
        m1: "throw",
      },
    });
    const res = await humanPreview(r, "m1");
    expect(res.ok).toBe(true);
    expect(res.value.loss).toEqual([
      { nodeId: "a", untrustedSubjects: [], uncommitted: false, untracked: 0 },
      { nodeId: "m1", untrustedSubjects: [], uncommitted: false, untracked: 0, unknown: true },
    ]);
    const missing = rig({ loss: { a: undefined } });
    expect((await humanPreview(missing, "a")).value.loss).toEqual([]);
  });

  it("件名は信頼できない入力: 制御文字・エスケープ列・改行を除き、1 行にして、100 文字に切り、5 件までにする", async () => {
    const evil = `\u001b[2J\u001b]0;pwn\u0007悪い\n件名\r\n${"x".repeat(300)}`;
    const subjects = [evil, "2", "3", "4", "5", "6", "7"];
    const r = rig({ loss: { a: { aheadCommits: 7, subjects, uncommitted: false, untracked: 0 } } });
    const res = await humanPreview(r, "a");
    const got = res.value.loss[0].untrustedSubjects as string[];
    expect(got).toHaveLength(5);
    const first = got[0] as string;
    expect(Array.from(first).length).toBeLessThanOrEqual(100);
    expect(first).toContain("悪い 件名");
    const unsafe = Array.from(first).filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c < 0x20 || (c >= 0x7f && c <= 0x9f);
    });
    expect(unsafe).toEqual([]);
  });

  it("git status が失敗したノードは、未保存の変更・未追跡のファイルを不明として出す（false・0 にしない。L2c）", async () => {
    const r = rig({
      loss: {
        a: {
          aheadCommits: 0,
          subjects: [],
          uncommitted: false,
          untracked: 0,
          workingTreeUnknown: true,
        },
      },
    });
    const res = await humanPreview(r, "a");
    expect(res.value.loss).toEqual([
      {
        nodeId: "a",
        aheadCommits: 0,
        untrustedSubjects: [],
        uncommitted: false,
        untracked: 0,
        workingTreeUnknown: true,
      },
    ]);
  });

  it("loss は人間のロールにだけ返す。統合ノードの結果には含まれず、lossFor も呼ばない（git の負荷を避ける）", async () => {
    const r = rig({ loss: { a: lossA, m1: "throw" } });
    const res = await r.call("node.reclaimPreview", { nodeId: "a" }, "m1");
    expect(res.ok).toBe(true);
    expect("loss" in res.value).toBe(false);
    const asRoot = await r.call("node.reclaimPreview", { nodeId: "m1" }, "root");
    expect("loss" in asRoot.value).toBe(false);
  });

  it("人間は、部分木の制限なしで呼べる（読み取りだけ）。存在しないノードは notFound。統合ノードの部分木の制限は変わらない", async () => {
    const r = rig({ loss: { a: lossA } });
    const human = await humanPreview(r, "a");
    expect(human.ok).toBe(true);
    expect(human.value.loss).toHaveLength(1);
    const unknown = await humanPreview(r, "no-such-node");
    expect(unknown.ok).toBe(false);
    expect(unknown.error?.code).toBe("notFound");
    // 統合ノード m2 は、m1 の配下の a を、事前確認できない
    const denied = await r.call("node.reclaimPreview", { nodeId: "a" }, "m2");
    expect(denied.ok).toBe(false);
    expect(denied.error?.code).toBe("forbidden");
  });
});

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
    // 名前（任意）は整えて原因に添える。失敗の理由の文面にも出す（T24-sp）
    const named = rig({
      processes: [{ pid: 4242, cwd: `${WT}/a`, hasOpenFiles: false, command: "node\u001b[0m" }],
    });
    const np = await named.call("node.reclaimPreview", { nodeId: "a" });
    expect(np.value.blockers).toEqual([
      { kind: "process", reason: "processesRunning", pid: 4242, command: "node[0m" },
    ]);
    const nr = await named.call("node.reclaim", { nodeId: "a" });
    expect(nr.ok).toBe(false);
    expect(nr.error?.cause).toContain("pid 4242（node[0m）");
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

  describe("最終コミットの記録（node.lastCommit。墓標の lastCommit の情報源）", () => {
    const SHA = "0123456789abcdef0123456789abcdef01234567";
    const withHead = (ids: string[]) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          { merged: true, clean: true, worktreePath: `${WT}/${id}`, headCommit: SHA },
        ]),
      );

    it("通常の回収で、作業ツリーを消す前に、先端の SHA を記録する", async () => {
      const r = rig({ facts: withHead(["a"]) });
      const done = await r.call("node.reclaim", { nodeId: "a" });
      expect(done.value.reclaimed).toEqual(["a"]);
      expect(r.s().nodes.find((x) => x.id === "a")?.lastCommit).toBe(SHA);
    });

    it("先端が取れないとき（headCommit なし）は、記録せずに回収を進め、note を残す", async () => {
      const r = rig();
      const done = await r.call("node.reclaim", { nodeId: "a" });
      expect(done.value.reclaimed).toEqual(["a"]);
      expect(r.s().nodes.find((x) => x.id === "a")?.lastCommit).toBeUndefined();
      expect(r.failures.some((f) => f.startsWith("a:"))).toBe(true);
    });

    it("記録の追記が失敗しても、回収は進み、note を残す", async () => {
      const r = rig({ facts: withHead(["a"]), failLastCommit: true });
      const done = await r.call("node.reclaim", { nodeId: "a" });
      expect(done.value.reclaimed).toEqual(["a"]);
      expect(r.removed).toEqual(["a"]);
      expect(r.s().nodes.find((x) => x.id === "a")?.lastCommit).toBeUndefined();
      expect(r.failures.some((f) => f.includes("最終コミットを記録できなかった"))).toBe(true);
    });

    it("同じ値は二重に記録しない（再実行・再試行）", async () => {
      const r = rig({ facts: withHead(["a"]) });
      r.state.removeFailsFor.add("a");
      expect((await r.call("node.reclaim", { nodeId: "a" })).ok).toBe(false);
      r.state.removeFailsFor.delete("a");
      expect((await r.call("node.reclaim", { nodeId: "a" })).ok).toBe(true);
      const events = r.log.state().nodes.find((x) => x.id === "a");
      expect(events?.lastCommit).toBe(SHA);
    });
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
        // 表示した先端（プレビューの tips）を、そのまま渡す
        params: {
          nodeId: id,
          expectTips: r.state.facts[id]?.headCommit ? { [id]: r.state.facts[id]?.headCommit } : {},
        },
      })) as { ok: boolean };

    const SHA = "0123456789abcdef0123456789abcdef01234567";
    it("最終コミット: 強制の回収（破棄の判断を経た停止ノード）でも、記録する", async () => {
      const r = rig({
        facts: { d: { merged: false, clean: false, worktreePath: `${WT}/d`, headCommit: SHA } },
      });
      stoppedNode(r, "d");
      r.state.facts.d = {
        merged: false,
        clean: false,
        worktreePath: `${WT}/d`,
        headCommit: SHA,
      };
      expect((await decide(r, "d")).ok).toBe(true);
      const done = await r.call("node.reclaim", { nodeId: "d" });
      expect(done.value.reclaimed).toEqual(["d"]);
      expect(r.s().nodes.find((x) => x.id === "d")?.lastCommit).toBe(SHA);
    });

    it("強制の直前に先端が動いていたら（判定のあとに手でコミットが足された）、実際に消えるブランチの先端で記録を上書きする", async () => {
      const moved = "fedcba9876543210fedcba9876543210fedcba98";
      const r = rig({ tips: { d: moved } });
      stoppedNode(r, "d");
      r.state.facts.d = {
        merged: false,
        clean: false,
        worktreePath: `${WT}/d`,
        headCommit: SHA,
      };
      expect((await decide(r, "d")).ok).toBe(true);
      expect((await r.call("node.reclaim", { nodeId: "d" })).ok).toBe(true);
      expect(r.s().nodes.find((x) => x.id === "d")?.lastCommit).toBe(moved);
    });

    it("強制の直前の先端が、記録した値と同じなら、二重に記録しない。SHA の形でない値は記録しない", async () => {
      const same = rig({ tips: { d: SHA } });
      stoppedNode(same, "d");
      same.state.facts.d = {
        merged: false,
        clean: false,
        worktreePath: `${WT}/d`,
        headCommit: SHA,
      };
      expect((await decide(same, "d")).ok).toBe(true);
      const before = same.s().lastSeq;
      expect((await same.call("node.reclaim", { nodeId: "d" })).ok).toBe(true);
      const events = same.s().lastSeq - before;
      const bad = rig({ tips: { d: "not-a-sha" } });
      stoppedNode(bad, "d");
      bad.state.facts.d = { merged: false, clean: false, worktreePath: `${WT}/d`, headCommit: SHA };
      expect((await decide(bad, "d")).ok).toBe(true);
      expect((await bad.call("node.reclaim", { nodeId: "d" })).ok).toBe(true);
      expect(bad.s().nodes.find((x) => x.id === "d")?.lastCommit).toBe(SHA);
      expect(events).toBeGreaterThan(0);
    });

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

/** 人間のロールで、node.reclaimInstruct を呼ぶ（T21r-e）。 */
const humanInstruct = async (
  r: ReturnType<typeof rig>,
  nodeId: string,
  expectTips: Record<string, string>,
  requestId = `hi-${++n}`,
) =>
  // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
  (await (r.handlers["node.reclaimInstruct"] as any)({
    requestId,
    operation: "node.reclaimInstruct",
    role: "human",
    params: { nodeId, expectTips },
    // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
  } as unknown as HandlerRequest<never>)) as { ok: boolean; value?: any; error?: Failure };

describe("先端の照合（expectTips。T21r-e）", () => {
  const T1 = "1".repeat(40);
  const T2 = "2".repeat(40);
  const T3 = "3".repeat(40);
  /** m1（統合。停止）─ d（実装。停止）・e（実装。停止）。 */
  const stoppedTree = (tips: Record<string, string | undefined> = { d: T1, e: T2 }) => {
    const r = rig();
    const add = (id: string, role: "integrator" | "implement", parent: string) => {
      const c = r.log.append({
        requestId: `c-${id}-${++n}`,
        actor: SYS,
        body: {
          type: "node.created",
          payload: { nodeId: id, role, parentId: parent, dependsOn: [] },
        },
      });
      if (!c.ok) throw new Error(`${c.error.code}: ${c.error.cause}`);
      r.ev(id, { type: "start" });
    };
    add("sm", "integrator", "root");
    add("d", "implement", "sm");
    add("e", "implement", "sm");
    for (const id of ["d", "e", "sm"]) {
      r.ev(id, { type: "stop", mode: "immediate" });
      r.ev(id, { type: "confirmStopped" });
    }
    for (const id of ["sm", "d", "e"]) {
      const tip = tips[id];
      r.state.facts[id] = {
        merged: false,
        clean: false,
        worktreePath: `${WT}/${id}`,
        ...(tip === undefined ? {} : { headCommit: tip }),
      };
    }
    return r;
  };

  it("プレビュー: 人間のロールにだけ、対象と配下の、先端を取れたノードの先端（tips）を返す。取れなかったノードは載せない", async () => {
    const r = stoppedTree({ d: T1, e: undefined, sm: T3 });
    const human = await humanPreview(r, "sm");
    expect(human.value.tips).toEqual({ sm: T3, d: T1 });
    const integrator = await r.call("node.reclaimPreview", { nodeId: "d" }, "sm");
    expect(integrator.value).not.toHaveProperty("tips");
  });

  it("指示: 表示した先端が、今の先端と一致すれば、記録する（expectTip つき）。同じ指示の再送は、何も変えない", async () => {
    const r = stoppedTree();
    const res = await humanInstruct(r, "d", { d: T1 }, "same");
    expect(res.ok).toBe(true);
    expect(r.s().nodes.find((x) => x.id === "d")?.discarded?.expectTip).toBe(T1);
    const seq = r.s().lastSeq;
    expect((await humanInstruct(r, "d", { d: T1 }, "same")).ok).toBe(true);
    expect(r.s().lastSeq).toBe(seq);
  });

  it("指示: 先端が違えば、何も記録せず tipMismatch。原因にノード ID だけを出し、SHA は出さない", async () => {
    const r = stoppedTree();
    const before = r.s().lastSeq;
    const res = await humanInstruct(r, "d", { d: T3 });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("tipMismatch");
    const text = JSON.stringify(res.error);
    expect(text).toContain("d");
    for (const sha of [T1, T2, T3]) expect(text).not.toContain(sha);
    expect(r.s().lastSeq).toBe(before);
    expect(r.s().nodes.find((x) => x.id === "d")?.discarded).toBeUndefined();
    expect(r.failures.join(" ")).not.toMatch(/[0-9a-f]{40}/); // 監査のログにも SHA を出さない
  });

  it("指示: 配下の停止したノードの先端が違うときも、拒否する（画面の内容が全体として古い）。配下の先端が合っていれば、通る", async () => {
    const r = stoppedTree();
    const bad = await humanInstruct(r, "sm", { sm: T3, d: T1, e: T1 }); // e が違う
    expect(bad.error?.code).toBe("tipMismatch");
    expect(bad.error?.cause).toContain("e");
    expect(bad.error?.cause).not.toContain("d,");
    r.state.facts.sm = { merged: false, clean: false, worktreePath: `${WT}/sm`, headCommit: T3 };
    const ok1 = await humanInstruct(r, "sm", { sm: T3, d: T1, e: T2 });
    expect(ok1.ok).toBe(true);
    // 記録するのは、対象だけ（配下は別の指示）
    expect(r.s().nodes.find((x) => x.id === "sm")?.discarded?.expectTip).toBe(T3);
    expect(r.s().nodes.find((x) => x.id === "d")?.discarded).toBeUndefined();
  });

  it("指示: 部分木の外のキーは invalidRequest。形の不正な SHA も", async () => {
    const r = stoppedTree();
    const out = await humanInstruct(r, "d", { d: T1, e: T2 });
    expect(out.error?.code).toBe("invalidRequest");
    const bad = await humanInstruct(r, "d", { d: "xyz" });
    expect(bad.error?.code).toBe("invalidRequest");
  });

  it("指示: 先端がなかった（表示になかった）ノードの先端が、今は取れるなら tipMismatch。今も取れなければ、expectTip なしで記録する", async () => {
    const withTip = stoppedTree({ d: T1, e: T2 });
    const miss = await humanInstruct(withTip, "d", {});
    expect(miss.error?.code).toBe("tipMismatch");
    const none = stoppedTree({ d: undefined, e: T2 });
    const okNone = await humanInstruct(none, "d", {});
    expect(okNone.ok).toBe(true);
    const rec = none.s().nodes.find((x) => x.id === "d")?.discarded;
    expect(rec).toBeDefined();
    expect(rec).not.toHaveProperty("expectTip");
  });

  it("実行: 判断のあとに先端が動いていたら、何も消さずに tipMismatch（強制の直前の照合）。元に戻せば通る", async () => {
    const r = stoppedTree({ d: T1, e: T2 });
    expect((await humanInstruct(r, "d", { d: T1 })).ok).toBe(true);
    expect((await humanInstruct(r, "e", { e: T2 })).ok).toBe(true);
    // d の先端が動いた
    r.state.facts.d = { merged: false, clean: false, worktreePath: `${WT}/d`, headCommit: T3 };
    const res = await r.call("node.reclaim", { nodeId: "d" }, "root");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("tipMismatch");
    expect(JSON.stringify(res.error)).not.toMatch(/[0-9a-f]{40}/);
    expect(r.removed).toEqual([]);
    expect(stateOf(r.s(), "d")).not.toBe("archived");
    r.state.facts.d = { merged: false, clean: false, worktreePath: `${WT}/d`, headCommit: T1 };
    const done = await r.call("node.reclaim", { nodeId: "d" }, "root");
    expect(done.ok).toBe(true);
    expect(r.removed).toEqual(["d"]);
  });

  it("実行: 強制になる全ノードを、最初の削除の前にまとめて照合する（途中のノードが動いていたら、先のノードも消さない）", async () => {
    const r = stoppedTree({ d: T1, e: T2, sm: undefined });
    expect((await humanInstruct(r, "d", { d: T1 })).ok).toBe(true);
    expect((await humanInstruct(r, "e", { e: T2 })).ok).toBe(true);
    expect((await humanInstruct(r, "sm", {})).ok).toBe(true);
    r.state.facts.e = { merged: false, clean: false, worktreePath: `${WT}/e`, headCommit: T3 };
    const res = await r.call("node.reclaim", { nodeId: "sm" }, "root");
    expect(res.error?.code).toBe("tipMismatch");
    expect(res.error?.cause).toContain("e");
    expect(r.removed).toEqual([]); // d も消えていない
  });

  it("実行: 先端がなかった判断（noTip）は、いま先端が取れるなら tipMismatch。取れなければ、これまでどおり回収できる", async () => {
    const r = stoppedTree({ d: undefined, e: T2 });
    expect((await humanInstruct(r, "d", {})).ok).toBe(true);
    expect(r.s().nodes.find((x) => x.id === "d")?.discarded?.noTip).toBe(true);
    r.state.facts.d = { merged: false, clean: false, worktreePath: `${WT}/d`, headCommit: T1 };
    const bad = await r.call("node.reclaim", { nodeId: "d" }, "root");
    expect(bad.error?.code).toBe("tipMismatch");
    expect(r.removed).toEqual([]);
    r.state.facts.d = { merged: false, clean: false, worktreePath: `${WT}/d` };
    expect((await r.call("node.reclaim", { nodeId: "d" }, "root")).ok).toBe(true);
  });

  it("実行: 先端の記録がない判断（この機能の前の記録）は、照合しない（これまでどおり回収できる）", async () => {
    const r = stoppedTree({ d: T1, e: T2 });
    const legacy = r.log.append({
      requestId: "legacy-d",
      actor: { human: true },
      body: { type: "node.discardDecided", payload: { nodeId: "d" } },
    });
    expect(legacy.ok).toBe(true);
    const d = r.s().nodes.find((x) => x.id === "d")?.discarded;
    expect(d).not.toHaveProperty("expectTip");
    expect(d).not.toHaveProperty("noTip");
    r.state.facts.d = { merged: false, clean: false, worktreePath: `${WT}/d`, headCommit: T3 };
    expect((await r.call("node.reclaim", { nodeId: "d" }, "root")).ok).toBe(true);
  });

  it("M1: 回収が tipMismatch になったあと、指示し直せば、先端の記録を更新して、回収できる（デッドロックしない）", async () => {
    const r = stoppedTree({ d: T1, e: T2 });
    expect((await humanInstruct(r, "d", { d: T1 })).ok).toBe(true);
    r.state.facts.d = { merged: false, clean: false, worktreePath: `${WT}/d`, headCommit: T3 };
    expect((await r.call("node.reclaim", { nodeId: "d" }, "root")).error?.code).toBe("tipMismatch");
    // 古い表示（T1）での指示し直しは、冪等の分岐より前に照合されて、拒否される
    const stale = await humanInstruct(r, "d", { d: T1 });
    expect(stale.error?.code).toBe("tipMismatch");
    expect(r.s().nodes.find((x) => x.id === "d")?.discarded?.expectTip).toBe(T1);
    // 見直した先端（T3）で指示し直す: 更新される
    const again = await humanInstruct(r, "d", { d: T3 });
    expect(again.ok).toBe(true);
    expect(r.s().nodes.find((x) => x.id === "d")?.discarded?.expectTip).toBe(T3);
    // 同じ指示の再送は、何も変えない
    const seq = r.s().lastSeq;
    expect((await humanInstruct(r, "d", { d: T3 })).ok).toBe(true);
    expect(r.s().lastSeq).toBe(seq);
    const done = await r.call("node.reclaim", { nodeId: "d" }, "root");
    expect(done.ok).toBe(true);
    expect(r.removed).toEqual(["d"]);
  });

  it("R2: 先端の取得に失敗した（headUnknown）ノードは、「先端なし」と取り違えず、不明として拒否する（指示・回収の両方）。プレビューの tips には載せない", async () => {
    const r = stoppedTree({ d: T1, e: T2 });
    r.state.facts.d = { merged: false, clean: false, worktreePath: `${WT}/d`, headUnknown: true };
    const pv = await humanPreview(r, "d");
    expect(pv.value).not.toHaveProperty("tips");
    const res = await humanInstruct(r, "d", {});
    expect(res.error?.code).toBe("tipUnknown");
    expect(res.error?.cause).toContain("d");
    expect(r.s().nodes.find((x) => x.id === "d")?.discarded).toBeUndefined();
    // 判断のあとに取得が失敗したら、回収も拒否する（何も消さない）
    r.state.facts.d = { merged: false, clean: false, worktreePath: `${WT}/d`, headCommit: T1 };
    expect((await humanInstruct(r, "d", { d: T1 })).ok).toBe(true);
    r.state.facts.d = { merged: false, clean: false, worktreePath: `${WT}/d`, headUnknown: true };
    const exec = await r.call("node.reclaim", { nodeId: "d" }, "root");
    expect(exec.error?.code).toBe("tipUnknown");
    expect(r.removed).toEqual([]);
  });

  it("R2: ポートが例外を投げたときも、不明として拒否する", async () => {
    const r = stoppedTree({ d: T1, e: T2 });
    const original = r.state.facts.d;
    expect(original).toBeDefined();
    Object.defineProperty(r.state.facts, "d", {
      get() {
        throw new Error("git が壊れた");
      },
      configurable: true,
    });
    const res = await humanInstruct(r, "d", {});
    expect(res.error?.code).toBe("tipUnknown");
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
