import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  addChild,
  ancestors,
  childrenOf,
  countByState,
  depthOf,
  descendantsOf,
  NODE_STATES,
  type NodeRole,
  type NodeState,
  reclaimInvariantViolations,
  type TreeNode,
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

  it("同じ入力なら同じ出力（決定的）", () => {
    fc.assert(
      fc.property(treeArb, (tree) => {
        expect(descendantsOf(tree, "n0")).toEqual(descendantsOf([...tree], "n0"));
      }),
    );
  });
});
