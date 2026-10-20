/**
 * 回収可能判定（条件 1〜6、純粋関数）。
 * PRD: FR_026, FR_027, FR_028, NFR_007 / spec 5.8, design 6.2
 *
 * 時刻・識別子・プロセス一覧・作業ツリーの事実（統合済みか、きれいか）は引数で受ける。
 * 入力が欠ける・不正なときは安全側（回収不可）に倒す。T07 の `OrchState` からの変換は daemon の責務。
 *
 * 規則:
 * - 回収可能にできるのは `verified` と、破棄の判断を経た `stopped` だけ。それ以外（`done`、`stopping`、
 *   `stopIncomplete` など）は `stateNotEligible`。
 * - 停止したノードは条件 1（統合済み）を満たさないため、破棄の判断（`discarded`）を条件 1 の代わりとする。
 *   条件 2 以降は免除しない。
 * - 条件 3 の「未完了」は、依存元が `verified`・`reclaimable`・`archived` のいずれでもないこと。
 * - 条件 5: 統合ノードは、配下がすべて `reclaimable` または `archived` であること。
 * - 条件 6: プロセスの cwd が作業ツリー配下、または作業ツリー配下のファイルを開いていれば動作中とする。
 *   cwd は `scope.ts` と同じ規則（大文字小文字・Unicode 正規形の畳み込み、ディレクトリ境界）で比べる。
 */

import { type Failure, failure, ok, type Result } from "./contract.js";
import type { NodeState } from "./index.js";
import { isPathUnder, normalizePath } from "./scope.js";
import { descendantsOf, type TreeNode } from "./tree.js";

export interface ProcessInfo {
  readonly pid: number;
  readonly cwd: string;
  /** 作業ツリー配下のファイルを開いているか。 */
  readonly hasOpenFiles: boolean;
}

export interface ReclaimNodeFacts {
  /** 成果が親ブランチに統合済みか（条件 1）。 */
  readonly merged: boolean;
  /** 作業ツリーに未保存の変更がないか（条件 2）。 */
  readonly clean: boolean;
  /** 破棄してよいという判断を経たか（停止したノードの回収）。 */
  readonly discarded: boolean;
  /** 作業ツリーの絶対パス。 */
  readonly worktreePath: string;
}

export interface ReclaimNode extends TreeNode {
  readonly dependsOn: readonly string[];
  readonly state: NodeState;
}

export interface ReclaimInput {
  readonly nodes: readonly ReclaimNode[];
  readonly facts: Readonly<Record<string, ReclaimNodeFacts | undefined>>;
  /** 未回答の判断があるノードの ID（条件 4）。 */
  readonly openDecisionNodeIds: readonly string[];
  /** プロセスの一覧。取得できなかったときは `null`（安全側で回収不可）。 */
  readonly processes: readonly ProcessInfo[] | null;
}

export const UNMET_REASONS = [
  "stateNotEligible",
  "discardRequired",
  "factsMissing",
  "notMerged", // 条件 1
  "dirty", // 条件 2
  "dependentsIncomplete", // 条件 3
  "openDecision", // 条件 4
  "descendantsNotReclaimable", // 条件 5
  "processesRunning", // 条件 6
  "processesUnknown", // 条件 6
] as const;
export type UnmetReason = (typeof UNMET_REASONS)[number];

/** 満たしていない条件の原因（ノードまたはプロセス）。 */
export type Blocker =
  | { readonly reason: UnmetReason; readonly nodeId: string }
  | { readonly reason: UnmetReason; readonly pid: number };

export interface ReclaimAssessment {
  readonly nodeId: string;
  readonly reclaimable: boolean;
  /** 満たしていない条件。空なら回収可能。 */
  readonly unmet: readonly UnmetReason[];
  /** 原因のノード・プロセス（統合ノードでは原因の配下ノードを名指しする）。 */
  readonly blockers: readonly Blocker[];
}

const COMPLETED: ReadonlySet<NodeState> = new Set(["verified", "reclaimable", "archived"]);
const RECLAIMED: ReadonlySet<NodeState> = new Set(["reclaimable", "archived"]);

const hasNul = (s: string): boolean => s.includes("\0");
const validWorktree = (p: string): boolean =>
  p.startsWith("/") && !hasNul(p) && normalizePath("/", p) !== "/";

const blocked = (
  nodeId: string,
  unmet: readonly UnmetReason[],
  blockers: readonly Blocker[] = [],
): ReclaimAssessment => ({
  nodeId,
  reclaimable: unmet.length === 0,
  unmet,
  blockers,
});

function processBlockers(worktree: string, processes: readonly ProcessInfo[]): Blocker[] {
  const wt = normalizePath("/", worktree);
  return processes
    .filter((p) => {
      if (p.hasOpenFiles) return true;
      // cwd が絶対パスでなければ、どこで動いているか不明なので動作中として扱う。
      if (!p.cwd.startsWith("/") || hasNul(p.cwd)) return true;
      return isPathUnder(normalizePath("/", p.cwd), wt);
    })
    .map((p): Blocker => ({ reason: "processesRunning", pid: p.pid }))
    .sort((a, b) => ("pid" in a && "pid" in b ? a.pid - b.pid : 0));
}

/** ノードが回収可能かを、満たしていない条件と原因つきで判定する。 */
export function assessReclaim(
  input: ReclaimInput,
  nodeId: string,
): Result<ReclaimAssessment, Failure> {
  const node = input.nodes.find((n) => n.id === nodeId);
  if (node === undefined) {
    return {
      ok: false,
      error: failure("unknownNode", `ノード ${nodeId} は存在しない`, "ノードの一覧を確認する"),
    };
  }
  if (node.state !== "verified" && node.state !== "stopped")
    return ok(blocked(nodeId, ["stateNotEligible"]));

  const unmet: UnmetReason[] = [];
  const blockers: Blocker[] = [];
  const facts = input.facts[nodeId];
  const stopped = node.state === "stopped";

  if (stopped && facts?.discarded !== true) {
    unmet.push("discardRequired");
  }
  const factsOk = facts !== undefined && validWorktree(facts.worktreePath);

  if (factsOk) {
    if (!stopped && !facts.merged) unmet.push("notMerged"); // 条件 1（停止したノードは破棄判断で代える）
    if (!facts.clean) unmet.push("dirty"); // 条件 2
  }

  const dependents = input.nodes.filter(
    (n) => n.dependsOn.includes(nodeId) && !COMPLETED.has(n.state),
  ); // 条件 3
  if (dependents.length > 0) {
    unmet.push("dependentsIncomplete");
    for (const d of dependents) blockers.push({ reason: "dependentsIncomplete", nodeId: d.id });
  }

  if (input.openDecisionNodeIds.includes(nodeId)) unmet.push("openDecision"); // 条件 4

  if (node.role === "integrator") {
    const causes = descendantsOf(input.nodes, nodeId).filter(
      (n) => !RECLAIMED.has(nodeStateOf(input.nodes, n.id)),
    );
    if (causes.length > 0) {
      unmet.push("descendantsNotReclaimable"); // 条件 5
      for (const c of causes) blockers.push({ reason: "descendantsNotReclaimable", nodeId: c.id });
    }
  }

  if (factsOk) {
    if (input.processes === null) {
      unmet.push("processesUnknown"); // 条件 6
    } else {
      const running = processBlockers(facts.worktreePath, input.processes);
      if (running.length > 0) {
        unmet.push("processesRunning");
        blockers.push(...running);
      }
    }
  } else {
    unmet.push("factsMissing");
  }

  return ok(blocked(nodeId, unmet, blockers));
}

const nodeStateOf = (nodes: readonly ReclaimNode[], id: string): NodeState =>
  (nodes.find((n) => n.id === id) as ReclaimNode).state;
