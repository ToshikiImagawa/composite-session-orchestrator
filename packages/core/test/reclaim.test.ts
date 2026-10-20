import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  assessReclaim,
  COMPLETED_STATES,
  descendantsOf,
  NODE_STATES,
  type NodeState,
  type ProcessInfo,
  type ReclaimInput,
  type ReclaimNode,
  type ReclaimNodeFacts,
  reclaimInvariantViolations,
  UNMET_REASONS,
  type UnmetReason,
} from "../src/index.js";

const WT = "/wt/a";
const goodFacts = (over: Partial<ReclaimNodeFacts> = {}): ReclaimNodeFacts => ({
  merged: true,
  clean: true,
  discarded: false,
  worktreePath: WT,
  ...over,
});
const node = (id: string, state: NodeState, over: Partial<ReclaimNode> = {}): ReclaimNode => ({
  id,
  role: "implement",
  parentId: "root",
  dependsOn: [],
  state,
  ...over,
});
const root = (state: NodeState = "running"): ReclaimNode => ({
  id: "root",
  role: "integrator",
  parentId: null,
  dependsOn: [],
  state,
});

/** 葉ノード a（verified、すべての条件を満たす）を中心にした入力。 */
const input = (over: Partial<ReclaimInput> = {}): ReclaimInput => ({
  nodes: [root(), node("a", "verified")],
  facts: { a: goodFacts() },
  openDecisionNodeIds: [],
  processes: [],
  ...over,
});
const assess = (inp: ReclaimInput, id = "a") => {
  const r = assessReclaim(inp, id);
  if (!r.ok) throw new Error(`assess failed: ${r.error.code}`);
  return r.value;
};

describe("条件 1〜6（spec 5.8）", () => {
  it("すべて満たす verified のノードは回収可能", () => {
    expect(assess(input())).toEqual({ nodeId: "a", reclaimable: true, unmet: [], blockers: [] });
  });

  it("条件 1: 成果が親ブランチに統合済みでない", () => {
    const a = assess(input({ facts: { a: goodFacts({ merged: false }) } }));
    expect(a.unmet).toEqual(["notMerged"]);
    expect(a.reclaimable).toBe(false);
  });

  it("条件 2: 作業ツリーに未保存の変更がある", () => {
    expect(assess(input({ facts: { a: goodFacts({ clean: false }) } })).unmet).toEqual(["dirty"]);
  });

  it("条件 3: 依存する未完了ノードがある（別サブツリーからの依存を含む）。原因のノードを名指しする", () => {
    const nodes = [
      root(),
      node("a", "verified"),
      node("other", "running", { role: "integrator", parentId: "root" }),
      node("x", "running", { parentId: "other", dependsOn: ["a"] }),
      node("y", "verified", { parentId: "other", dependsOn: ["a"] }),
      node("z", "done", { parentId: "other", dependsOn: ["a"] }),
    ];
    const a = assess(input({ nodes }));
    expect(a.unmet).toEqual(["dependentsIncomplete"]);
    expect(a.blockers).toEqual([
      { kind: "node", reason: "dependentsIncomplete", nodeId: "x" },
      { kind: "node", reason: "dependentsIncomplete", nodeId: "z" },
    ]);
  });

  it("条件 3: 依存元が verified / reclaimable / archived なら妨げない", () => {
    for (const s of ["verified", "reclaimable", "archived"] as const) {
      const nodes = [root(), node("a", "verified"), node("d", s, { dependsOn: ["a"] })];
      expect(assess(input({ nodes })).reclaimable, s).toBe(true);
    }
  });

  it("条件 3: 依存元が妨げるかは、共通定数 COMPLETED_STATES と全状態で一致する", () => {
    for (const st of NODE_STATES) {
      const nodes = [root(), node("a", "verified"), node("d", st, { dependsOn: ["a"] })];
      expect(assess(input({ nodes })).reclaimable, st).toBe(COMPLETED_STATES.has(st));
    }
  });

  it("条件 4: このノードに紐づく未回答の判断がある", () => {
    const a = assess(input({ openDecisionNodeIds: ["a"] }));
    expect(a.unmet).toEqual(["openDecision"]);
    expect(assess(input({ openDecisionNodeIds: ["other"] })).reclaimable).toBe(true);
  });

  it("条件 5: 統合ノードは、配下がすべて回収可能以降のときだけ。原因の配下を名指しする", () => {
    const nodes: ReclaimNode[] = [
      { ...root("verified") },
      node("a", "reclaimable"),
      node("b", "archived"),
      node("c", "verified"),
      node("d", "stopped"),
    ];
    const facts = { root: goodFacts({ worktreePath: "/wt/root" }) };
    const a = assess({ nodes, facts, openDecisionNodeIds: [], processes: [] }, "root");
    expect(a.unmet).toEqual(["descendantsNotReclaimable"]);
    expect(a.blockers).toEqual([
      { kind: "node", reason: "descendantsNotReclaimable", nodeId: "c" },
      { kind: "node", reason: "descendantsNotReclaimable", nodeId: "d" },
    ]);
    const ok = assess(
      {
        nodes: nodes.map((n) =>
          n.id === "c" || n.id === "d" ? { ...n, state: "reclaimable" as const } : n,
        ),
        facts,
        openDecisionNodeIds: [],
        processes: [],
      },
      "root",
    );
    expect(ok.reclaimable).toBe(true);
  });

  it("条件 6: 作業ツリー配下で動作中のプロセスがある。pid を名指しする", () => {
    const processes: ProcessInfo[] = [
      { pid: 20, cwd: "/wt/a/sub", hasOpenFiles: false },
      { pid: 10, cwd: "/wt/a", hasOpenFiles: false },
      { pid: 30, cwd: "/elsewhere", hasOpenFiles: false },
    ];
    const a = assess(input({ processes }));
    expect(a.unmet).toEqual(["processesRunning"]);
    expect(a.blockers).toEqual([
      { kind: "process", reason: "processesRunning", pid: 10 },
      { kind: "process", reason: "processesRunning", pid: 20 },
    ]);
  });

  it("条件 6: cwd は作業ツリーの外でも、配下のファイルを開いていれば動作中", () => {
    const a = assess(input({ processes: [{ pid: 5, cwd: "/", hasOpenFiles: true }] }));
    expect(a.unmet).toEqual(["processesRunning"]);
  });

  it("条件 6: ディレクトリ境界で判定し、大文字小文字・Unicode 正規形の違いは同一視する", () => {
    expect(
      assess(input({ processes: [{ pid: 1, cwd: "/wt/ab", hasOpenFiles: false }] })).reclaimable,
    ).toBe(true);
    expect(
      assess(input({ processes: [{ pid: 1, cwd: "/WT/A/x", hasOpenFiles: false }] })).reclaimable,
    ).toBe(false);
    const nfd = "/wt/café";
    const facts = { a: goodFacts({ worktreePath: nfd }) };
    expect(
      assess(input({ facts, processes: [{ pid: 1, cwd: "/wt/café/x", hasOpenFiles: false }] }))
        .reclaimable,
    ).toBe(false);
    expect(
      assess(input({ processes: [{ pid: 1, cwd: "/wt/a/../a/x", hasOpenFiles: false }] }))
        .reclaimable,
    ).toBe(false);
  });

  it("条件 6: プロセス一覧が取得できない（null）なら安全側で回収不可", () => {
    const a = assess(input({ processes: null }));
    expect(a.unmet).toEqual(["processesUnknown"]);
  });

  it("条件 6: cwd が不明（絶対パスでない）なプロセスは動作中として扱う", () => {
    const a = assess(input({ processes: [{ pid: 1, cwd: "", hasOpenFiles: false }] }));
    expect(a.unmet).toEqual(["processesRunning"]);
  });
});

describe("状態の前提と破棄判断（T03 と整合）", () => {
  it("判定の対象は verified・stopped・reclaimable（回収の実行直前の再判定を含む）だけ", () => {
    for (const s of NODE_STATES) {
      const a = assess(
        input({ nodes: [root(), node("a", s)], facts: { a: goodFacts({ discarded: true }) } }),
      );
      expect(a.reclaimable, s).toBe(s === "verified" || s === "stopped" || s === "reclaimable");
    }
  });

  it("判定の対象でない状態は stateNotEligible だけを返す（stopping / stopIncomplete / done / archived を含む）", () => {
    for (const s of [
      "pending",
      "running",
      "waiting",
      "done",
      "stopping",
      "stopIncomplete",
      "archived",
    ] as const) {
      const a = assess(
        input({
          nodes: [root(), node("a", s)],
          facts: { a: goodFacts({ merged: false, clean: false }) },
        }),
      );
      expect(a.unmet, s).toEqual(["stateNotEligible"]);
    }
  });

  it("停止したノードは、破棄の判断がなければ discardRequired。判断済みなら条件 1・2 を免除する", () => {
    const stopped = (over: Partial<ReclaimNodeFacts>) =>
      assess(
        input({
          nodes: [root(), node("a", "stopped")],
          facts: { a: goodFacts({ merged: false, ...over }) },
        }),
      );
    expect(stopped({ discarded: false }).unmet).toEqual(["discardRequired"]);
    expect(stopped({ discarded: true }).reclaimable).toBe(true);
    // 破棄の判断を経た停止は、未保存の変更も捨てることを含めて判断済み（条件 2 も免除）
    expect(stopped({ discarded: true, clean: false }).reclaimable).toBe(true);
    // 条件 3 以降は免除されない
    expect(stopped({ discarded: true, openDecision: true } as never).reclaimable).toBe(true);
  });

  it("verified のノードの discarded は条件 1 を免除しない", () => {
    expect(
      assess(input({ facts: { a: goodFacts({ merged: false, discarded: true }) } })).unmet,
    ).toEqual(["notMerged"]);
  });
});

describe("入力が欠ける・不正なときは安全側（フェイルクローズ）", () => {
  it("事実がないノードは回収不可（factsMissing）。事実に依らない条件は評価する", () => {
    const a = assess(input({ facts: {}, openDecisionNodeIds: ["a"] }));
    expect(a.unmet).toEqual(["factsMissing", "openDecision"]);
  });

  it("作業ツリーのパスが絶対パスでない・根・空は factsMissing", () => {
    for (const wt of ["", "relative/x", "/", "/wt/\0"]) {
      expect(assess(input({ facts: { a: goodFacts({ worktreePath: wt }) } })).unmet, wt).toEqual([
        "factsMissing",
      ]);
    }
  });

  it("存在しないノードは失敗（Failure）", () => {
    const r = assessReclaim(input(), "nope");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("unknownNode");
      expect(r.error.nextActions.length).toBeGreaterThan(0);
    }
  });

  it("理由コードは列挙型で、すべてが少なくとも 1 つの入力で現れる", () => {
    const seen = new Set<UnmetReason>();
    const scenarios: ReclaimInput[] = [
      input({ facts: { a: goodFacts({ merged: false }) } }),
      input({ facts: { a: goodFacts({ clean: false }) } }),
      input({ nodes: [root(), node("a", "verified"), node("d", "running", { dependsOn: ["a"] })] }),
      input({ openDecisionNodeIds: ["a"] }),
      input({ processes: [{ pid: 1, cwd: WT, hasOpenFiles: false }] }),
      input({ processes: null }),
      input({ nodes: [root(), node("a", "running")] }),
      input({ nodes: [root(), node("a", "stopped")] }),
      input({ facts: {} }),
    ];
    for (const s of scenarios) for (const u of assess(s).unmet) seen.add(u);
    const tree = assess(
      {
        nodes: [root("verified"), node("a", "running")],
        facts: { root: goodFacts({ worktreePath: "/wt/r" }) },
        openDecisionNodeIds: [],
        processes: [],
      },
      "root",
    );
    for (const u of tree.unmet) seen.add(u);
    expect([...seen].sort()).toEqual([...UNMET_REASONS].sort());
  });
});

describe("フェイルクローズと回収の実行直前の再判定", () => {
  it("事実は === true のときだけ満たしたとみなす（truthy な値は満たさない）", () => {
    const a = assess(
      input({
        facts: { a: { merged: "yes", clean: 1, discarded: true, worktreePath: WT } as never },
      }),
    );
    expect(a.unmet).toEqual(["notMerged", "dirty"]);
  });

  it("hasOpenFiles は === false のときだけ開いていないとみなす（unknown・未定義・null は動作中）", () => {
    for (const v of ["unknown", undefined, null, 0, "no"]) {
      const a = assess(
        input({ processes: [{ pid: 3, cwd: "/elsewhere", hasOpenFiles: v as never }] }),
      );
      expect(a.unmet, String(v)).toEqual(["processesRunning"]);
    }
    expect(
      assess(input({ processes: [{ pid: 3, cwd: "/elsewhere", hasOpenFiles: false }] }))
        .reclaimable,
    ).toBe(true);
  });

  it("reclaimable の再判定: 統合済みで条件を満たせば回収可能。未保存の変更・動作中のプロセスがあれば不可", () => {
    const nodes = [root(), node("a", "reclaimable")];
    expect(assess(input({ nodes })).reclaimable).toBe(true);
    expect(assess(input({ nodes, facts: { a: goodFacts({ clean: false }) } })).unmet).toEqual([
      "dirty",
    ]);
    expect(
      assess(input({ nodes, processes: [{ pid: 1, cwd: WT, hasOpenFiles: false }] })).unmet,
    ).toEqual(["processesRunning"]);
  });

  it("reclaimable の再判定: 統合済みでなければ破棄の経路とみなし、discarded を要する", () => {
    const nodes = [root(), node("a", "reclaimable")];
    const f = (over: Partial<ReclaimNodeFacts>) =>
      assess(input({ nodes, facts: { a: goodFacts({ merged: false, ...over }) } }));
    expect(f({ discarded: false }).unmet).toEqual(["notMerged"]);
    expect(f({ discarded: true, clean: false }).reclaimable).toBe(true);
  });

  it("archived は判定の対象外（stateNotEligible）", () => {
    expect(assess(input({ nodes: [root(), node("a", "archived")] })).unmet).toEqual([
      "stateNotEligible",
    ]);
  });

  it("facts は自前のプロパティだけを見る（ノード ID が constructor / __proto__ でも例外にならず factsMissing）", () => {
    for (const id of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const nodes = [root(), node(id, "verified")];
      const r = assessReclaim(input({ nodes, facts: {} }), id);
      expect(r.ok && r.value.unmet, id).toEqual(["factsMissing"]);
    }
  });

  it("worktreeRoot を渡すと、作業ツリーのパスがその配下でなければ factsMissing", () => {
    expect(assess(input({ worktreeRoot: "/wt" })).reclaimable).toBe(true);
    expect(assess(input({ worktreeRoot: "/other" })).unmet).toEqual(["factsMissing"]);
    expect(assess(input({ worktreeRoot: "relative" })).unmet).toEqual(["factsMissing"]);
  });

  it("壊れた入力では例外を出さず、Failure（invalidInput）を返す", () => {
    for (const bad of [
      null,
      undefined,
      1,
      "x",
      [],
      {},
      { nodes: 1 },
      { nodes: [null], facts: {}, openDecisionNodeIds: [], processes: [] },
      { nodes: [], facts: {}, openDecisionNodeIds: "a", processes: [] },
    ]) {
      const r = assessReclaim(bad as never, "a");
      expect(r.ok, JSON.stringify(bad)).toBe(false);
      if (!r.ok) expect(["invalidInput", "unknownNode"]).toContain(r.error.code);
    }
  });

  it("任意の値を入力にしても、例外を出さず結果を返す（全域関数）", () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (inp, id) => {
        expect(typeof assessReclaim(inp as never, id as never).ok).toBe("boolean");
      }),
    );
  });

  it("入力の一部を壊しても例外を出さず、回収可能にはならない", () => {
    const junk = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.integer(),
      fc.string(),
      fc.array(fc.anything()),
      fc.object(),
    );
    fc.assert(
      fc.property(
        junk,
        fc.constantFrom("facts", "processes", "openDecisionNodeIds", "nodes", "worktreeRoot"),
        (v, key) => {
          const r = assessReclaim({ ...input(), [key]: v } as never, "a");
          expect(typeof r.ok).toBe("boolean");
          // 配列は妥当な値になりうる（空の一覧など）ので、配列以外の壊れた値だけを検査する
          if (r.ok && key !== "worktreeRoot" && !Array.isArray(v)) {
            expect(r.value.reclaimable, key).toBe(false);
          }
        },
      ),
    );
  });
});

describe("性質（fast-check）", () => {
  const facts = fc.record({
    merged: fc.boolean(),
    clean: fc.boolean(),
    dependentIncomplete: fc.boolean(),
    openDecision: fc.boolean(),
    running: fc.boolean(),
    processesUnknown: fc.boolean(),
  });

  /** 独立したオラクル: 葉の verified ノードの理由。 */
  const oracle = (f: {
    merged: boolean;
    clean: boolean;
    dependentIncomplete: boolean;
    openDecision: boolean;
    running: boolean;
    processesUnknown: boolean;
  }): UnmetReason[] => {
    const out: UnmetReason[] = [];
    if (!f.merged) out.push("notMerged");
    if (!f.clean) out.push("dirty");
    if (f.dependentIncomplete) out.push("dependentsIncomplete");
    if (f.openDecision) out.push("openDecision");
    if (f.processesUnknown) out.push("processesUnknown");
    else if (f.running) out.push("processesRunning");
    return out;
  };

  it("葉の verified ノード: 理由は条件の充足と一対一に対応し、reclaimable は理由が空と同値", () => {
    fc.assert(
      fc.property(facts, (f) => {
        const nodes = [
          root(),
          node("a", "verified"),
          ...(f.dependentIncomplete ? [node("d", "running", { dependsOn: ["a"] })] : []),
        ];
        const processes = f.processesUnknown
          ? null
          : f.running
            ? [{ pid: 7, cwd: "/wt/a/x", hasOpenFiles: false }]
            : [];
        const a = assess({
          nodes,
          facts: { a: goodFacts({ merged: f.merged, clean: f.clean }) },
          openDecisionNodeIds: f.openDecision ? ["a"] : [],
          processes,
        });
        expect([...a.unmet].sort()).toEqual(oracle(f).sort());
        expect(a.reclaimable).toBe(a.unmet.length === 0);
      }),
    );
  });

  const states = fc.constantFrom(...NODE_STATES);
  /** 根 n0 の下に、統合ノードと作業ノードがランダムに並ぶ木。 */
  const treeArb = fc
    .array(fc.tuple(fc.nat(), fc.boolean(), states), { minLength: 0, maxLength: 12 })
    .chain((items) =>
      fc.tuple(fc.constant(items), states).map(([its, rootState]) => {
        const nodes: ReclaimNode[] = [
          { id: "n0", role: "integrator", parentId: null, dependsOn: [], state: rootState },
        ];
        for (const [i, [pick, isInteg, st]] of its.entries()) {
          const integrators = nodes.filter((x) => x.role === "integrator");
          const parent = integrators[pick % integrators.length] as ReclaimNode;
          nodes.push({
            id: `n${i + 1}`,
            role: isInteg ? "integrator" : "implement",
            parentId: parent.id,
            dependsOn: [],
            state: st,
          });
        }
        return nodes;
      }),
    );

  const allFacts = (nodes: readonly ReclaimNode[]): Record<string, ReclaimNodeFacts> =>
    Object.fromEntries(
      nodes.map((n) => [n.id, goodFacts({ discarded: true, worktreePath: `/wt/${n.id}` })]),
    );

  it("回収可能と判定された統合ノードの配下は、すべて回収可能以降の状態（親子の不変条件, FR_028）", () => {
    fc.assert(
      fc.property(treeArb, (nodes) => {
        const inp: ReclaimInput = {
          nodes,
          facts: allFacts(nodes),
          openDecisionNodeIds: [],
          processes: [],
        };
        const reclaimableNow = new Set(
          nodes.filter((n) => assess(inp, n.id).reclaimable).map((n) => n.id),
        );
        for (const n of nodes) {
          if (!reclaimableNow.has(n.id)) continue;
          for (const d of descendantsOf(nodes, n.id)) {
            const st = nodes.find((x) => x.id === d.id)?.state;
            expect(st === "reclaimable" || st === "archived", `${n.id} → ${d.id}`).toBe(true);
          }
        }
        // T02 の不変条件の検査にも通る: 判定された集合に、すでに回収済みの配下を足す
        const closed = new Set(reclaimableNow);
        for (const id of reclaimableNow) for (const d of descendantsOf(nodes, id)) closed.add(d.id);
        expect(reclaimInvariantViolations(nodes, closed)).toEqual([]);
      }),
    );
  });

  it("条件 5 の名指しは、回収可能以降でない配下と一致する", () => {
    fc.assert(
      fc.property(treeArb, (nodes) => {
        const verifiedRoot = nodes.map((n) =>
          n.id === "n0" ? { ...n, state: "verified" as const } : n,
        );
        const inp: ReclaimInput = {
          nodes: verifiedRoot,
          facts: allFacts(nodes),
          openDecisionNodeIds: [],
          processes: [],
        };
        const a = assess(inp, "n0");
        const expected = nodes
          .slice(1)
          .filter((n) => n.state !== "reclaimable" && n.state !== "archived")
          .map((n) => n.id);
        const named = a.blockers
          .filter((b) => b.reason === "descendantsNotReclaimable")
          .map((b) => ("nodeId" in b ? b.nodeId : ""));
        expect([...named].sort()).toEqual([...expected].sort());
        expect(a.unmet.includes("descendantsNotReclaimable")).toBe(expected.length > 0);
      }),
    );
  });

  it("決定的: 同じ入力は同じ結果。入力を変更しない", () => {
    fc.assert(
      fc.property(treeArb, (nodes) => {
        const inp: ReclaimInput = {
          nodes,
          facts: allFacts(nodes),
          openDecisionNodeIds: [],
          processes: [],
        };
        const before = JSON.stringify(inp);
        expect(assess(inp, "n0")).toEqual(assess(inp, "n0"));
        expect(JSON.stringify(inp)).toBe(before);
      }),
    );
  });

  it("プロセスを増やしても、回収可能な集合は広がらない（単調）", () => {
    const proc = fc.record({
      pid: fc.nat(),
      cwd: fc.constantFrom("/wt/a", "/wt/a/x", "/wt/b", "/", ""),
      hasOpenFiles: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(proc, { maxLength: 5 }), proc, (ps, extra) => {
        const base = assess(input({ processes: ps })).reclaimable;
        const more = assess(input({ processes: [...ps, extra] })).reclaimable;
        if (!base) expect(more).toBe(false);
      }),
    );
  });
});
