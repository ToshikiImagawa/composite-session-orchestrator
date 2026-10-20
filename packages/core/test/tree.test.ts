import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addChild,
  ancestors,
  childrenOf,
  countByState,
  depthOf,
  descendantsOf,
  isDirectChild,
  isInSubtree,
  isStrictDescendant,
  NODE_STATES,
  type NodeRole,
  type NodeState,
  reclaimInvariantViolations,
  type TreeNode,
  type TreeViolation,
  validateTree,
} from "../src/index.js";

const n = (id: string, role: NodeRole, parentId: string | null): TreeNode => ({
  id,
  role,
  parentId,
});

// root(i) ─ mid(i) ─ w1(implement)
//        └─ w2(review)
const sample: readonly TreeNode[] = [
  n("root", "integrator", null),
  n("mid", "integrator", "root"),
  n("w1", "implement", "mid"),
  n("w2", "review", "root"),
];

describe("validateTree（FR_001, FR_002）", () => {
  it("空の木は妥当", () => {
    expect(validateTree([])).toEqual([]);
  });

  it("3 階層以上の入れ子（統合ノードの子に統合ノード）は妥当", () => {
    expect(validateTree(sample)).toEqual([]);
  });

  it("識別子の重複を検出する", () => {
    const v = validateTree([n("a", "integrator", null), n("a", "implement", "a")]);
    expect(v).toContainEqual({ kind: "duplicateId", nodeId: "a" });
  });

  it("根が複数あると検出する", () => {
    const v = validateTree([n("a", "integrator", null), n("b", "integrator", null)]);
    expect(v.map((x) => x.kind)).toContain("multipleRoots");
  });

  it("根がない（空でない）木を検出する", () => {
    const v = validateTree([n("a", "integrator", "b"), n("b", "integrator", "a")]);
    expect(v.map((x) => x.kind)).toContain("noRoot");
  });

  it("根が統合ノードでないと検出する", () => {
    const v = validateTree([n("a", "implement", null)]);
    expect(v).toContainEqual({ kind: "rootNotIntegrator", nodeId: "a" });
  });

  it("存在しない親を検出する", () => {
    const v = validateTree([n("a", "integrator", null), n("b", "implement", "zzz")]);
    expect(v).toContainEqual({ kind: "missingParent", nodeId: "b", parentId: "zzz" });
  });

  it("作業ノードを親にできない", () => {
    const v = validateTree([
      n("a", "integrator", null),
      n("b", "implement", "a"),
      n("c", "review", "b"),
    ]);
    expect(v).toContainEqual({ kind: "parentNotIntegrator", nodeId: "c", parentId: "b" });
  });

  it("循環を検出する", () => {
    const v = validateTree([
      n("r", "integrator", null),
      n("a", "integrator", "b"),
      n("b", "integrator", "a"),
    ]);
    expect(v.map((x) => x.kind)).toContain("cycle");
  });

  it("自分を親にできない", () => {
    const v = validateTree([n("r", "integrator", null), n("a", "integrator", "a")]);
    expect(v.map((x) => x.kind)).toContain("cycle");
  });
});

describe("走査", () => {
  it("childrenOf は入力順", () => {
    expect(childrenOf(sample, "root").map((x) => x.id)).toEqual(["mid", "w2"]);
    expect(childrenOf(sample, "w1")).toEqual([]);
  });

  it("descendantsOf は先行順（入力順の深さ優先）で自身を含まない", () => {
    expect(descendantsOf(sample, "root").map((x) => x.id)).toEqual(["mid", "w1", "w2"]);
    expect(descendantsOf(sample, "w2")).toEqual([]);
  });

  it("ancestors は親から根の順", () => {
    expect(ancestors(sample, "w1").map((x) => x.id)).toEqual(["mid", "root"]);
    expect(ancestors(sample, "root")).toEqual([]);
  });

  it("depthOf は根が 0。存在しない ID は undefined", () => {
    expect(depthOf(sample, "root")).toBe(0);
    expect(depthOf(sample, "w1")).toBe(2);
    expect(depthOf(sample, "nope")).toBeUndefined();
  });
});

describe("addChild", () => {
  it("統合ノードの下に追加できる（入力は不変）", () => {
    const before = [...sample];
    const r = addChild(sample, n("w3", "investigate", "mid"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.nodes).toHaveLength(5);
    expect(sample).toEqual(before);
  });

  it("作業ノードの下への追加は拒否し、木を変えない", () => {
    const r = addChild(sample, n("x", "implement", "w1"));
    expect(r).toEqual({
      ok: false,
      violation: { kind: "parentNotIntegrator", nodeId: "x", parentId: "w1" },
    });
  });

  it("重複 ID・親なし（2 つ目の根）は拒否する", () => {
    expect(addChild(sample, n("w1", "implement", "mid")).ok).toBe(false);
    expect(addChild(sample, n("r2", "integrator", null)).ok).toBe(false);
  });

  it("追加前から壊れている木でも、新たな違反を生まない追加は受け付け、生む追加は拒否する", () => {
    const broken = [n("r", "integrator", null), n("x", "integrator", "ghost")]; // 親が存在しない
    expect(addChild(broken, n("w", "implement", "r")).ok).toBe(true);
    const r = addChild(broken, n("y", "implement", "nope"));
    expect(r).toEqual({
      ok: false,
      violation: { kind: "missingParent", nodeId: "y", parentId: "nope" },
    });
  });

  it("空の木には統合ノードの根だけ追加できる", () => {
    expect(addChild([], n("r", "integrator", null)).ok).toBe(true);
    expect(addChild([], n("r", "implement", null)).ok).toBe(false);
  });
});

describe("countByState（集計。決定的）", () => {
  it("部分木の状態別の数を返す", () => {
    const states: Record<string, NodeState> = {
      root: "running",
      mid: "running",
      w1: "done",
      w2: "waiting",
    };
    const c = countByState(sample, "mid", (id) => states[id] as NodeState);
    expect(c.running).toBe(1);
    expect(c.done).toBe(1);
    expect(c.waiting).toBe(0);
    expect(Object.keys(c).sort()).toEqual([...NODE_STATES].sort());
  });
});

describe("reclaimInvariantViolations（FR_028: 親が回収可能なら配下はすべて回収可能）", () => {
  it("親が回収可能で配下に不可がいると、その配下を返す", () => {
    expect(reclaimInvariantViolations(sample, new Set(["root", "mid"]))).toEqual(["w1", "w2"]);
  });

  it("配下がすべて回収可能なら違反なし", () => {
    expect(reclaimInvariantViolations(sample, new Set(["root", "mid", "w1", "w2"]))).toEqual([]);
  });

  it("親が不可なら配下は任意", () => {
    expect(reclaimInvariantViolations(sample, new Set(["w1"]))).toEqual([]);
  });
});

// 任意の妥当な木を生成: i 番目のノードの親は、先行する統合ノードから選ぶ
const treeArb = fc
  .array(
    fc.tuple(
      fc.nat(),
      fc.constantFrom<NodeRole>("integrator", "implement", "review", "investigate", "merge"),
    ),
    {
      maxLength: 30,
    },
  )
  .map((items) => {
    const nodes: TreeNode[] = [n("n0", "integrator", null)];
    for (const [i, [pick, role]] of items.entries()) {
      const integrators = nodes.filter((x) => x.role === "integrator");
      const parent = integrators[pick % integrators.length] as TreeNode;
      nodes.push(n(`n${i + 1}`, role, parent.id));
    }
    return nodes as readonly TreeNode[];
  });

describe("性質（fast-check）", () => {
  it("生成した木は常に妥当で、addChild の結果も妥当", () => {
    fc.assert(
      fc.property(treeArb, fc.nat(), (tree, pick) => {
        expect(validateTree(tree)).toEqual([]);
        const integrators = tree.filter((x) => x.role === "integrator");
        const parent = integrators[pick % integrators.length] as TreeNode;
        const r = addChild(tree, n("new", "implement", parent.id));
        expect(r.ok).toBe(true);
        if (r.ok) expect(validateTree(r.nodes)).toEqual([]);
      }),
    );
  });

  it("作業ノードを親にする追加は常に拒否され、木は変わらない", () => {
    fc.assert(
      fc.property(treeArb, fc.nat(), (tree, pick) => {
        const workers = tree.filter((x) => x.role !== "integrator");
        fc.pre(workers.length > 0);
        const parent = workers[pick % workers.length] as TreeNode;
        expect(addChild(tree, n("new", "implement", parent.id)).ok).toBe(false);
      }),
    );
  });

  it("descendantsOf(root) は根以外の全ノード。各ノードは自身の祖先の子孫", () => {
    fc.assert(
      fc.property(treeArb, (tree) => {
        expect(
          descendantsOf(tree, "n0")
            .map((x) => x.id)
            .sort(),
        ).toEqual(
          tree
            .slice(1)
            .map((x) => x.id)
            .sort(),
        );
        for (const node of tree) {
          for (const a of ancestors(tree, node.id)) {
            expect(descendantsOf(tree, a.id).map((x) => x.id)).toContain(node.id);
          }
        }
      }),
    );
  });

  it("集計の合計は部分木のノード数（自身を含む）", () => {
    fc.assert(
      fc.property(treeArb, fc.constantFrom(...NODE_STATES), (tree, st) => {
        const c = countByState(tree, "n0", () => st);
        const total = Object.values(c).reduce((a, b) => a + b, 0);
        expect(total).toBe(tree.length);
      }),
    );
  });

  it("回収可能集合を「部分木で閉じる」と違反なし。親だけ足すと違反が出る", () => {
    fc.assert(
      fc.property(treeArb, fc.nat(), (tree, pick) => {
        const target = tree[pick % tree.length] as TreeNode;
        const closed = new Set([target.id, ...descendantsOf(tree, target.id).map((x) => x.id)]);
        expect(reclaimInvariantViolations(tree, closed)).toEqual([]);
        const kids = childrenOf(tree, target.id);
        fc.pre(kids.length > 0);
        expect(reclaimInvariantViolations(tree, new Set([target.id]))).not.toEqual([]);
      }),
    );
  });

  it("兄弟順を含む入力順を入れ替えても、妥当性・子孫の集合・集計は変わらない", () => {
    const shuffled = treeArb.chain((t) =>
      fc.tuple(
        fc.constant(t),
        fc.shuffledSubarray([...t], { minLength: t.length, maxLength: t.length }),
      ),
    );
    fc.assert(
      fc.property(shuffled, ([tree, perm]) => {
        expect(validateTree(perm)).toEqual([]);
        for (const node of tree) {
          const a = descendantsOf(tree, node.id)
            .map((x) => x.id)
            .sort();
          const b = descendantsOf(perm, node.id)
            .map((x) => x.id)
            .sort();
          expect(b).toEqual(a);
        }
        const states = (id: string): NodeState =>
          NODE_STATES[id.length % NODE_STATES.length] as NodeState;
        expect(countByState(perm, "n0", states)).toEqual(countByState(tree, "n0", states));
      }),
    );
  });

  // 独立した単純なオラクル。壊れうる任意の配列に対して validateTree と同じ違反の多重集合を返す。
  const oracle = (nodes: readonly TreeNode[]): string[] => {
    const out: string[] = [];
    const first = (id: string): TreeNode | undefined => nodes.find((x) => x.id === id);
    nodes.forEach((x, i) => {
      if (nodes.findIndex((y) => y.id === x.id) !== i) out.push(`duplicateId:${x.id}`);
    });
    const roots = nodes.filter((x) => x.parentId === null);
    if (nodes.length > 0 && roots.length === 0) out.push("noRoot");
    if (roots.length > 1) out.push(`multipleRoots:${roots.map((x) => x.id).join(",")}`);
    for (const r of roots) if (r.role !== "integrator") out.push(`rootNotIntegrator:${r.id}`);
    for (const x of nodes) {
      if (x.parentId === null) continue;
      const parent = first(x.parentId);
      if (parent === undefined) out.push(`missingParent:${x.id}:${x.parentId}`);
      else if (parent.role !== "integrator") out.push(`parentNotIntegrator:${x.id}:${x.parentId}`);
      let cur: TreeNode | undefined = x;
      for (let step = 0; step <= nodes.length && cur?.parentId != null; step++) {
        if (cur.parentId === x.id) {
          out.push(`cycle:${x.id}`);
          break;
        }
        cur = first(cur.parentId);
      }
    }
    return out.sort();
  };
  const show = (v: TreeViolation): string => {
    switch (v.kind) {
      case "noRoot":
        return "noRoot";
      case "multipleRoots":
        return `multipleRoots:${v.nodeIds.join(",")}`;
      case "duplicateId":
      case "rootNotIntegrator":
      case "cycle":
        return `${v.kind}:${v.nodeId}`;
      case "missingParent":
      case "parentNotIntegrator":
        return `${v.kind}:${v.nodeId}:${v.parentId}`;
    }
  };

  const anyNode = fc.record({
    id: fc.constantFrom("a", "b", "c", "d"),
    role: fc.constantFrom<NodeRole>("integrator", "implement", "review", "investigate", "merge"),
    parentId: fc.option(fc.constantFrom("a", "b", "c", "d", "z"), { nil: null }),
  });

  it("任意の（壊れうる）配列で、validateTree は独立したオラクルと同じ違反を返す", () => {
    fc.assert(
      fc.property(fc.array(anyNode, { maxLength: 8 }), (nodes) => {
        expect(validateTree(nodes).map(show).sort()).toEqual(oracle(nodes));
      }),
      { numRuns: 1000 },
    );
  });

  it("addChild: 新たな違反がなければ追加され、あれば木を変えない（オラクルと一致）", () => {
    fc.assert(
      fc.property(fc.array(anyNode, { maxLength: 6 }), anyNode, (nodes, node) => {
        const before = oracle(nodes);
        const after = oracle([...nodes, node]);
        const left = [...before];
        const fresh = after.filter((k) => {
          const i = left.indexOf(k);
          if (i >= 0) left.splice(i, 1);
          return i < 0;
        });
        expect(addChild(nodes, node).ok).toBe(fresh.length === 0);
      }),
      { numRuns: 1000 },
    );
  });
});

describe("isInSubtree（読み取り範囲: 自分の部分木のみ）", () => {
  const nodes = [
    { id: "root", role: "integrator" as const, parentId: null },
    { id: "m1", role: "integrator" as const, parentId: "root" },
    { id: "a", role: "implement" as const, parentId: "m1" },
    { id: "m2", role: "integrator" as const, parentId: "root" },
    { id: "b", role: "implement" as const, parentId: "m2" },
  ];
  it("自分と子孫は真、兄弟の部分木・祖先・未知のノードは偽", () => {
    expect(isInSubtree(nodes, "m1", "m1")).toBe(true);
    expect(isInSubtree(nodes, "m1", "a")).toBe(true);
    expect(isInSubtree(nodes, "root", "b")).toBe(true);
    expect(isInSubtree(nodes, "m1", "b")).toBe(false);
    expect(isInSubtree(nodes, "m1", "root")).toBe(false);
    expect(isInSubtree(nodes, "m1", "zzz")).toBe(false);
    expect(isInSubtree(nodes, "zzz", "a")).toBe(false);
    expect(isInSubtree(nodes, "", "")).toBe(false);
  });
  it("壊れた入力でも例外を出さず偽", () => {
    for (const bad of [null, undefined, 5, {}]) {
      expect(isInSubtree(bad as never, "m1", "a")).toBe(false);
      expect(isInSubtree(nodes, bad as never, "a")).toBe(false);
      expect(isInSubtree(nodes, "m1", bad as never)).toBe(false);
    }
  });
});

describe("isStrictDescendant・isDirectChild（部分木の規則）", () => {
  const nodes = [
    { id: "root", role: "integrator" as const, parentId: null },
    { id: "m1", role: "integrator" as const, parentId: "root" },
    { id: "a", role: "implement" as const, parentId: "m1" },
    { id: "m2", role: "integrator" as const, parentId: "root" },
  ];
  it("isStrictDescendant: 自分自身を含まない子孫だけ真", () => {
    expect(isStrictDescendant(nodes, "root", "a")).toBe(true);
    expect(isStrictDescendant(nodes, "root", "m1")).toBe(true);
    expect(isStrictDescendant(nodes, "m1", "a")).toBe(true);
    expect(isStrictDescendant(nodes, "m1", "m1")).toBe(false);
    expect(isStrictDescendant(nodes, "m1", "root")).toBe(false);
    expect(isStrictDescendant(nodes, "m1", "m2")).toBe(false);
    expect(isStrictDescendant(nodes, "m1", "zzz")).toBe(false);
    expect(isStrictDescendant(nodes, "zzz", "a")).toBe(false);
  });
  it("isDirectChild: 直接の子だけ真", () => {
    expect(isDirectChild(nodes, "root", "m1")).toBe(true);
    expect(isDirectChild(nodes, "m1", "a")).toBe(true);
    expect(isDirectChild(nodes, "root", "a")).toBe(false); // 孫
    expect(isDirectChild(nodes, "m1", "m1")).toBe(false);
    expect(isDirectChild(nodes, "m1", "zzz")).toBe(false);
    expect(isDirectChild(nodes, "zzz", "a")).toBe(false);
  });
  it("壊れた入力でも例外を出さず偽", () => {
    for (const bad of [null, undefined, 5, {}]) {
      expect(isStrictDescendant(bad as never, "m1", "a")).toBe(false);
      expect(isStrictDescendant(nodes, bad as never, "a")).toBe(false);
      expect(isDirectChild(bad as never, "m1", "a")).toBe(false);
      expect(isDirectChild(nodes, "m1", bad as never)).toBe(false);
    }
  });
});
