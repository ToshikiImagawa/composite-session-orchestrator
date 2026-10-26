/**
 * 回収可能判定（条件 1〜6、純粋関数）。
 * PRD: FR_026, FR_027, FR_028, NFR_007 / spec 5.8, design 6.2
 *
 * 時刻・識別子・プロセス一覧・作業ツリーの事実（統合済みか、きれいか）は引数で受ける。
 * 入力が欠ける・不正なときは安全側（回収不可）に倒す（フェイルクローズ）:
 * 事実は `=== true` のときだけ満たしたとみなし、`hasOpenFiles` は `=== false` のときだけ開いていないとみなす。
 * 入力の形が壊れている場合は例外を出さず `Failure`（`invalidInput`）を返す。
 * T07 の `OrchState` からの変換は daemon の責務。
 *
 * 規則:
 * - 判定の対象にできる状態は、`verified`、`stopped`、`reclaimable`。回収の実行直前の再判定のため
 *   `reclaimable` も対象とする（`archived` と、`done`・`stopping`・`stopIncomplete` などは `stateNotEligible`）。
 * - 成果の統合済み（条件 1）と未保存の変更なし（条件 2）は、事実 `merged`・`clean` で判定する。
 *   ただし、破棄の判断を経た停止（`stopped` で `discarded`）は、成果を捨てることを含めて判断済みなので、
 *   条件 1 と条件 2 を免除する（人間への未保存の変更の提示は、判断の画面の責務。spec 5.8）。
 *   `reclaimable` は、`merged` でなければ破棄の経路とみなし、`discarded` を要する。
 * - 条件 3 の「未完了」は、依存元が `COMPLETED_STATES`（`verified`・`reclaimable`・`archived`）以外であること。
 *   入力の `nodes` に含まれない木の外からの依存は、daemon が実行時に再判定して拾う。
 * - 条件 5: 統合ノードは、配下がすべて `reclaimable` または `archived` であること。
 * - 条件 6: プロセスの cwd が作業ツリー配下、または作業ツリー配下のファイルを開いている（または不明）なら
 *   動作中とする。cwd は `scope.ts` と同じ規則（大文字小文字・Unicode 正規形の畳み込み、ディレクトリ境界）で比べる。
 *
 * 前提（daemon のアダプタの責務）:
 * - `cwd` と作業ツリーのパスは、シンボリックリンクを解決した実パス（realpath）にして渡す。ここでは解決しない。
 * - `discarded` の情報源は、daemon が一つのイベントから導く（二重の情報源にしない）。
 * - 作業ツリーのパスは daemon の作業ツリー置き場の配下であること。`worktreeRoot` を渡すと、配下でないパスを
 *   `factsMissing` として拒否する。
 */

import { type Failure, failure, ok, type Result } from "./contract.js";
import type { NodeState } from "./index.js";
import { type ProcessLabel, processCommandName } from "./process-name.js";
import { isPathUnder, normalizePath } from "./scope.js";
import { COMPLETED_STATES } from "./transition.js";
import { descendantsOf, type TreeNode } from "./tree.js";

export interface ProcessInfo {
  readonly pid: number;
  readonly cwd: string;
  /** 作業ツリー配下のファイルを開いているか。`"unknown"`（調べられなかった）は動作中として扱う。 */
  readonly hasOpenFiles: boolean | "unknown";
  /** コマンドの名前（lsof の `c`）。表示だけに使う。古い記録・取れないときは無い。 */
  readonly command?: string;
}

export interface ReclaimNodeFacts {
  /** 成果が親ブランチに統合済みか（条件 1）。 */
  readonly merged: boolean;
  /** 作業ツリーに未保存の変更がないか（条件 2）。 */
  readonly clean: boolean;
  /** 破棄してよいという判断を経たか（停止したノードの回収）。 */
  readonly discarded: boolean;
  /** 作業ツリーの絶対パス（realpath）。 */
  readonly worktreePath: string;
}

export interface ReclaimNode extends TreeNode {
  readonly dependsOn: readonly string[];
  readonly state: NodeState;
}

export interface ReclaimInput {
  readonly nodes: readonly ReclaimNode[];
  /** ノード ID → 事実。自前のプロパティだけを見る。 */
  readonly facts: Readonly<Record<string, ReclaimNodeFacts | undefined>>;
  /** 未回答の判断があるノードの ID（条件 4）。 */
  readonly openDecisionNodeIds: readonly string[];
  /** プロセスの一覧。取得できなかったときは `null`（安全側で回収不可）。 */
  readonly processes: readonly ProcessInfo[] | null;
  /** daemon の作業ツリー置き場。渡すと、作業ツリーのパスがこの配下であることを検査する。 */
  readonly worktreeRoot?: string;
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

/** 満たしていない条件の原因。`kind` でノードとプロセスを判別する。 */
export type Blocker =
  | { readonly kind: "node"; readonly reason: UnmetReason; readonly nodeId: string }
  | {
      readonly kind: "process";
      readonly reason: UnmetReason;
      readonly pid: number;
      /** 整えたコマンドの名前（任意）。 */
      readonly command?: string;
    };

export interface ReclaimAssessment {
  readonly nodeId: string;
  readonly reclaimable: boolean;
  /** 満たしていない条件。空なら回収可能。 */
  readonly unmet: readonly UnmetReason[];
  /** 原因のノード・プロセス（統合ノードでは原因の配下ノードを名指しする）。 */
  readonly blockers: readonly Blocker[];
}

const RECLAIMED: ReadonlySet<NodeState> = new Set(["reclaimable", "archived"]);
const ELIGIBLE: ReadonlySet<NodeState> = new Set(["verified", "stopped", "reclaimable"]);

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const hasNul = (s: string): boolean => s.includes("\0");
const validAbs = (p: unknown): p is string =>
  typeof p === "string" && p.startsWith("/") && !hasNul(p);
const validWorktree = (p: unknown): p is string => validAbs(p) && normalizePath("/", p) !== "/";

const bad = (cause: string): Result<never, Failure> => ({
  ok: false,
  error: failure("invalidInput", cause, "入力の形を確認する"),
});

const isNode = (x: unknown): x is ReclaimNode =>
  isRec(x) &&
  typeof x.id === "string" &&
  (x.parentId === null || typeof x.parentId === "string") &&
  typeof x.role === "string" &&
  typeof x.state === "string" &&
  Array.isArray(x.dependsOn) &&
  x.dependsOn.every((d) => typeof d === "string");

interface Facts {
  readonly merged: boolean;
  readonly clean: boolean;
  readonly discarded: boolean;
  readonly worktreePath: string;
}

/** 自前のプロパティだけを読み、`=== true` のときだけ満たしたとみなす。 */
function readFacts(facts: unknown, nodeId: string): Facts | undefined {
  if (!isRec(facts) || !Object.hasOwn(facts, nodeId)) return undefined;
  const f = facts[nodeId];
  if (!isRec(f)) return undefined;
  return {
    merged: f.merged === true,
    clean: f.clean === true,
    discarded: f.discarded === true,
    worktreePath: typeof f.worktreePath === "string" ? f.worktreePath : "",
  };
}

const sortPid = (a: Blocker, b: Blocker): number =>
  a.kind === "process" && b.kind === "process" ? a.pid - b.pid : 0;

/** 作業ツリー配下で動作中（または、動作中でないと確認できない）プロセス。 */
function runningProcesses(worktree: string, processes: readonly unknown[]): Blocker[] {
  const wt = normalizePath("/", worktree);
  const out: Blocker[] = [];
  for (const p of processes) {
    const pid = isRec(p) && Number.isInteger(p.pid) ? (p.pid as number) : -1;
    const notRunning =
      isRec(p) &&
      p.hasOpenFiles === false && // 開いていないと確認できたときだけ
      validAbs(p.cwd) && // cwd が不明なら動作中として扱う
      !isPathUnder(normalizePath("/", p.cwd), wt);
    if (notRunning) continue;
    const command = isRec(p) ? processCommandName(p.command) : undefined;
    out.push(
      command === undefined
        ? { kind: "process", reason: "processesRunning", pid }
        : { kind: "process", reason: "processesRunning", pid, command },
    );
  }
  return out.sort(sortPid);
}

/**
 * 作業ツリー配下で動作中（または、動作中でないと確認できない）プロセスの pid を昇順で返す。
 * 回収可能判定の条件 6 と同じ規則。停止後のプロセスの確認（daemon のアダプタ）でも使う。
 */
export function findRunningProcesses(
  worktreePath: string,
  processes: readonly ProcessInfo[],
): number[] {
  return runningProcesses(worktreePath, processes).map((b) => (b.kind === "process" ? b.pid : -1));
}

/** {@link findRunningProcesses} と同じ規則で、pid と整えたコマンドの名前（任意）を返す。表示に使う。 */
export function findRunningProcessLabels(
  worktreePath: string,
  processes: readonly ProcessInfo[],
): ProcessLabel[] {
  return runningProcesses(worktreePath, processes).map((b) =>
    b.kind === "process" && b.command !== undefined
      ? { pid: b.pid, command: b.command }
      : { pid: b.kind === "process" ? b.pid : -1 },
  );
}

/** ノードが回収可能かを、満たしていない条件と原因つきで判定する。回収の実行直前の再判定にも使う。 */
export function assessReclaim(
  input: ReclaimInput,
  nodeId: string,
): Result<ReclaimAssessment, Failure> {
  if (!isRec(input) || typeof nodeId !== "string") return bad("入力がオブジェクトでない");
  const { nodes, openDecisionNodeIds, processes } = input as unknown as Rec;
  if (!Array.isArray(nodes) || !nodes.every(isNode)) return bad("nodes の形が不正");
  if (
    !Array.isArray(openDecisionNodeIds) ||
    !openDecisionNodeIds.every((x) => typeof x === "string")
  ) {
    return bad("openDecisionNodeIds の形が不正");
  }

  const node = nodes.find((n) => n.id === nodeId);
  if (node === undefined) {
    return {
      ok: false,
      error: failure("unknownNode", `ノード ${nodeId} は存在しない`, "ノードの一覧を確認する"),
    };
  }
  const done = (
    unmet: UnmetReason[],
    blockers: Blocker[] = [],
  ): Result<ReclaimAssessment, Failure> =>
    ok({ nodeId, reclaimable: unmet.length === 0, unmet, blockers });
  if (!ELIGIBLE.has(node.state)) return done(["stateNotEligible"]);

  const unmet: UnmetReason[] = [];
  const blockers: Blocker[] = [];
  const facts = readFacts(input.facts, nodeId);
  const root = (input as unknown as Rec).worktreeRoot;
  const factsOk =
    facts !== undefined &&
    validWorktree(facts.worktreePath) &&
    (root === undefined ||
      (validAbs(root) &&
        isPathUnder(normalizePath("/", facts.worktreePath), normalizePath("/", root))));

  // 破棄の経路: 停止したノード、または統合済みでない（＝破棄で回収可能になった）回収可能ノード。
  const discardPath =
    node.state === "stopped" || (node.state === "reclaimable" && facts?.merged !== true);
  const discardedOk = discardPath && facts?.discarded === true;
  if (discardPath && !discardedOk) {
    unmet.push(node.state === "stopped" ? "discardRequired" : "notMerged");
  }

  if (facts === undefined || !factsOk) {
    unmet.push("factsMissing");
  } else if (!discardedOk) {
    if (!discardPath && !facts.merged) unmet.push("notMerged"); // 条件 1
    if (!facts.clean) unmet.push("dirty"); // 条件 2
  }

  const dependents = nodes.filter(
    (n) => n.dependsOn.includes(nodeId) && !COMPLETED_STATES.has(n.state),
  ); // 条件 3
  if (dependents.length > 0) {
    unmet.push("dependentsIncomplete");
    for (const d of dependents)
      blockers.push({ kind: "node", reason: "dependentsIncomplete", nodeId: d.id });
  }

  if (openDecisionNodeIds.includes(nodeId)) unmet.push("openDecision"); // 条件 4

  if (node.role === "integrator") {
    const stateById = new Map(nodes.map((n) => [n.id, n.state]));
    const causes = descendantsOf(nodes, nodeId).filter((n) => {
      const s = stateById.get(n.id);
      return s === undefined || !RECLAIMED.has(s);
    });
    if (causes.length > 0) {
      unmet.push("descendantsNotReclaimable"); // 条件 5
      for (const c of causes)
        blockers.push({ kind: "node", reason: "descendantsNotReclaimable", nodeId: c.id });
    }
  }

  if (facts !== undefined && factsOk) {
    if (!Array.isArray(processes)) {
      unmet.push("processesUnknown"); // 条件 6（一覧が取得できなかった）
    } else {
      const running = runningProcesses(facts.worktreePath, processes);
      if (running.length > 0) {
        unmet.push("processesRunning");
        blockers.push(...running);
      }
    }
  }

  return done(unmet, blockers);
}
