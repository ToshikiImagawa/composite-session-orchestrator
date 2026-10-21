/**
 * 回収の操作の実体: 事前確認（`node.reclaimPreview`）と実行（`node.reclaim`）。権限と部分木の判定は、認可（`authorize`）で
 * 済んでいる前提（ハンドラでも、対象が呼び出し元の自分を含まない子孫であることを確かめる）。
 * PRD: FR_026, FR_027, FR_028 / spec 5.8
 *
 * - 判定は core の `assessReclaim`（条件 1〜6）。事実（統合済みか・きれいか・作業ツリーのパス）とプロセスの調査、作業ツリーの
 *   削除は、注入した `ReclaimPorts` が担う（git・lsof の実体は daemon の組み立てで渡す）。
 * - 対象の配下（統合ノードのとき）は、配下から先（後順）に判定・回収する。判定は、実行の前に全体を検査し、1 つでも回収できなければ
 *   何もしない。実行時にも、事前確認とは独立に再判定する（その間に状況が変わりうる）。
 * - 実行は、ノードごとに「回収可能にする → 作業ツリーを消す → アーカイブする」の順。削除に失敗したら、そこで止めて失敗を返す
 *   （記録は回収可能のまま。作業ツリーが残るのに、アーカイブしない）。再試行は、アーカイブ済みを飛ばして続きから完了する（冪等）。
 * - 破棄の判断（停止したノードの回収）は、`node.discardDecided`（`node.reclaimInstruct`。人間）の記録から導く（`discardedNodeIds`）。
 *   判断がない停止したノードは、
 *   `discardRequired`（人間の判断が要る）として拒否する。
 */

import {
  assessReclaim,
  type Blocker,
  discardedNodeIds,
  type Failure,
  failure,
  isStrictDescendant,
  type NodeRecord,
  type OperationMap,
  type OrchState,
  type ProcessInfo,
  type ReclaimAssessment,
  type ReclaimNode,
  type ReclaimNodeFacts,
  type Result,
  type UnmetReason,
} from "@cso/core";
import type { ProcessProbe } from "../../sdk/lsof-probe.js";
import type { HandlerRequest } from "../server.js";
import { appendAtomically, fail, type LogPort } from "./context.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

/** 作業ツリーの事実（`discarded` は、`node.discardDecided` の記録から導く）。 */
export type WorktreeFacts = Omit<ReclaimNodeFacts, "discarded"> & {
  /** ブランチの先端（最終コミットの SHA）。取れなければ省略する（回収は止めない）。 */
  readonly headCommit?: string;
};

/**
 * 回収の実体（git・lsof）への口。実装（T10b）が守る契約:
 * - `removeWorktree` は、既定では `git worktree remove` を `--force` なしで行い、ブランチは `git branch -d`（統合済みだけ）で消す
 *   （`-D` は使わない）。未保存の変更・未統合の成果があれば、強制せずに失敗を返す（失うものがある場合は拒否する）。
 *   `force: true` のときだけ、`--force` と `-D` で消す（成果を捨てる）。`force` を渡してよいのは、記録上、人間が破棄を判断した
 *   停止ノードだけで、その判断はハンドラが行う（ポートは、渡された `force` を実行するだけ）。`expectedPath` の照合と、登録されていない
 *   場所を消さないことは、`force` でも変わらない。
 * - `removeWorktree` は `expectedPath`（判定に使った作業ツリーの実パス）と、実際に削除するパスが同じかを照合し、
 *   違えば何も消さずに失敗する（判定と削除の対象のずれを防ぐ）。
 * - すべての口は、取得に失敗したら例外か `undefined`・`null`・`Failure` で返してよい（ハンドラが安全側＝回収不可に倒す）。
 */
export interface ReclaimPorts {
  /** ノードの作業ツリーの事実。調べられない・作業ツリーがなければ `undefined`（回収不可）。 */
  factsFor(nodeId: string): Promise<WorktreeFacts | undefined>;
  /** 作業ツリー配下のプロセスの調査。取得できなければ `null`（回収不可）。 */
  readonly probe: ProcessProbe;
  /** 作業ツリーを消す。失敗は `Failure` で返す（例外は、ハンドラが `Failure` に変える）。 */
  removeWorktree(
    nodeId: string,
    opts: { expectedPath: string; force?: boolean; onTip?: (tip: string) => void },
  ): Promise<Result<undefined, Failure>>;
  /** daemon の作業ツリー置き場（作業ツリーのパスがこの配下であることを検査する）。 */
  readonly worktreeRoot: string;
  /** 強制で消す直前の、ブランチの先端（捨てる成果の最後のコミット）の記録先。 */
  readonly onForced?: (nodeId: string, tip: string) => void;
}

export interface ReclaimHandlerDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  readonly ports: ReclaimPorts;
  /** 応答に出さない生の原因（ポートの失敗・例外）の記録先。 */
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

const REASON_TEXT: Record<UnmetReason, string> = {
  stateNotEligible: "回収できる状態でない",
  discardRequired: "停止したノードで、成果を破棄する判断がない",
  factsMissing: "作業ツリーの情報を確認できない（作業ツリーがない・場所が不正）",
  notMerged: "成果がまだ親のブランチに統合されていない",
  dirty: "作業ツリーに未保存の変更がある",
  dependentsIncomplete: "このノードに依存する別のノードが、まだ完了していない",
  openDecision: "未回答の判断がある",
  descendantsNotReclaimable: "配下に、まだ回収できていないノードがある",
  processesRunning: "作業ツリーでプロセスが動いている",
  processesUnknown: "作業ツリーのプロセスを調べられない",
};

const blockerText = (b: Blocker): string =>
  b.kind === "process" ? `pid ${b.pid}` : `ノード ${b.nodeId}`;

interface Unmet {
  readonly nodeId: string;
  readonly unmet: readonly UnmetReason[];
  readonly blockers: readonly Blocker[];
}

/** 対象と配下を、配下から先（後順。兄弟は作成順）に並べる。 */
function postOrder(nodes: readonly NodeRecord[], targetId: string): NodeRecord[] {
  const out: NodeRecord[] = [];
  const seen = new Set<string>();
  const walk = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    for (const n of nodes) if (n.parentId === id) walk(n.id);
    const self = nodes.find((n) => n.id === id);
    if (self !== undefined) out.push(self);
  };
  walk(targetId);
  return out;
}

const describeUnmet = (list: readonly Unmet[]): string =>
  list
    .map((u) => {
      const reasons = u.unmet.map((r) => REASON_TEXT[r]).join("、");
      const who = u.blockers
        .filter((b) => !(b.kind === "node" && b.nodeId === u.nodeId))
        .map(blockerText)
        .join("、");
      return `ノード ${u.nodeId}: ${reasons}${who === "" ? "" : `（${who}）`}`;
    })
    .join("／");

export function createReclaimHandlers(deps: ReclaimHandlerDeps) {
  const { log, ports } = deps;
  let reclaiming = false;

  const outsideSubtree = (caller: string, nodeId: string) =>
    isStrictDescendant(log.state().nodes, caller, nodeId)
      ? undefined
      : fail(
          "forbidden",
          "対象のノードが、自分の部分木の規則（自分を含まない子孫）を満たさない",
          "親（統合ノード）に依頼する",
        );

  const openDecisionNodes = (state: OrchState): string[] =>
    state.decisions.filter((d) => d.status === "open").map((d) => d.nodeId);

  const safely = async <T>(nodeId: string, f: () => Promise<T>, fallback: T): Promise<T> => {
    try {
      return await f();
    } catch (e) {
      deps.onFailure?.(nodeId, String(e));
      return fallback;
    }
  };

  /** 1 ノードの判定。事実とプロセスは、注入されたもの（なければ取り直す）。取得の失敗は回収不可（安全側）。 */
  async function assessNode(
    nodes: readonly ReclaimNode[],
    open: readonly string[],
    nodeId: string,
    discarded: ReadonlySet<string>,
    shared?: { processes: readonly ProcessInfo[] | null },
  ): Promise<{ result: Result<ReclaimAssessment, Failure>; facts?: WorktreeFacts }> {
    const found = await safely(nodeId, () => ports.factsFor(nodeId), undefined);
    let processes: readonly ProcessInfo[] | null = null;
    if (found !== undefined) {
      processes =
        shared !== undefined
          ? shared.processes
          : await safely(nodeId, () => ports.probe(found.worktreePath), null);
    }
    const result = assessReclaim(
      {
        nodes,
        facts:
          found === undefined ? {} : { [nodeId]: { ...found, discarded: discarded.has(nodeId) } },
        openDecisionNodeIds: open,
        processes,
        worktreeRoot: ports.worktreeRoot,
      },
      nodeId,
    );
    return found === undefined ? { result } : { result, facts: found };
  }

  /**
   * 対象と配下を、配下から順に判定する。先に判定した回収可能なノードは、後のノード（親）の判定では回収可能とみなす。
   * アーカイブ済みは判定せず、回収済みとして数える。プロセスの調査は、置き場全体で 1 回だけ行い、全ノードで共有する。
   */
  async function assess(
    state: OrchState,
    targetId: string,
  ): Promise<{ plan: NodeRecord[]; unmet: Unmet[] }> {
    const plan = postOrder(state.nodes, targetId);
    const virtual = new Map<string, ReclaimNode>(state.nodes.map((n) => [n.id, n]));
    const open = openDecisionNodes(state);
    const discarded = new Set(discardedNodeIds(state));
    const unmet: Unmet[] = [];
    const shared = {
      processes: plan.every((n) => n.state === "archived")
        ? []
        : await safely("", () => ports.probe(ports.worktreeRoot), null),
    };
    for (const n of plan) {
      if (n.state === "archived") continue;
      const { result: r } = await assessNode([...virtual.values()], open, n.id, discarded, shared);
      if (!r.ok) {
        unmet.push({ nodeId: n.id, unmet: ["stateNotEligible"], blockers: [] });
        continue;
      }
      if (r.value.reclaimable) {
        virtual.set(n.id, { ...n, state: "reclaimable" });
      } else if (!r.value.unmet.every((u) => u === "descendantsNotReclaimable")) {
        // 配下だけが原因のノードは、原因の配下が自分で名指しされるので、重ねて挙げない。
        unmet.push({ nodeId: n.id, unmet: r.value.unmet, blockers: r.value.blockers });
      }
    }
    return { plan, unmet };
  }

  const notReclaimable = (list: readonly Unmet[]) => {
    const needsHuman = list.some((u) => u.unmet.includes("discardRequired"));
    return fail(
      "notReclaimable",
      `回収できない: ${describeUnmet(list)}`,
      ...((needsHuman
        ? ["成果を破棄してよいか、人間に確認する", "条件を満たしてから、もう一度確認する"]
        : ["条件を満たしてから、もう一度確認する"]) as [string, ...string[]]),
    );
  };

  const unsupported =
    (what: string, ...next: [string, ...string[]]) =>
    () =>
      fail("notSupported", what, ...next);

  return {
    // 人間の破棄の判断の記録（core の `node.discardDecided`。T13e）ができるまで、受け付けない。
    // 破棄の判断（人間）。停止したノードの成果を捨ててよいという判断を記録する。回収は、別に実行する。
    "node.reclaimInstruct": (
      req: HandlerRequest<"node.reclaimInstruct">,
    ): Result<{ accepted: true }, Failure> => {
      const { nodeId } = req.params;
      const node = log.state().nodes.find((n) => n.id === nodeId);
      if (node === undefined) return fail("notFound", "ノードが見つからない", "ID を確認する");
      if (node.discarded !== undefined) return { ok: true, value: { accepted: true } }; // 記録済み（冪等）
      if (node.state !== "stopped") {
        return fail(
          "notStopped",
          `ノード ${nodeId} は ${node.state} で、破棄を判断できない（停止済み〔stopped〕のノードだけ）`,
          "先に node.stop で止めて、停止を確認してから判断する",
          "統合済みで検証済みのノードは、破棄でなく、通常の回収（node.reclaim）を使う",
        );
      }
      const r = appendAtomically(log, deps.clock, req.requestId, { human: true }, [
        { type: "node.discardDecided", payload: { nodeId } },
      ]);
      return r.ok ? { ok: true, value: { accepted: true } } : r;
    },
    // 最終削除は、アーカイブ日（`archivedAt`）とログの最終削除の経路の設計後に実装する。
    "node.purgePreview": unsupported(
      "最終削除は、アーカイブ日の記録とログの削除経路の設計が済むまで、まだ使えない",
      "アーカイブしたまま保持する",
    ),
    "node.purge": unsupported(
      "最終削除は、アーカイブ日の記録とログの削除経路の設計が済むまで、まだ使えない",
      "アーカイブしたまま保持する",
    ),
    "node.reclaimPreview": async (
      req: HandlerRequest<"node.reclaimPreview">,
    ): Promise<R<"node.reclaimPreview">> => {
      const { nodeId } = req.params;
      const outside = outsideSubtree(req.caller?.nodeId ?? "", nodeId);
      if (outside) return outside;
      const { unmet } = await assess(log.state(), nodeId);
      // 満たしていない条件の和と、原因（対象の配下のノードは、そのノードの条件も原因として挙げる）。
      const reasons = [...new Set(unmet.flatMap((u) => u.unmet))];
      if (
        unmet.some((u) => u.nodeId !== nodeId) &&
        !reasons.includes("descendantsNotReclaimable")
      ) {
        reasons.push("descendantsNotReclaimable"); // 配下に回収できないノードがある（対象の条件 5）
      }
      const blockers = unmet.flatMap((u) => [
        ...u.blockers,
        ...(u.nodeId === nodeId
          ? []
          : u.unmet.map((reason) => ({ kind: "node" as const, reason, nodeId: u.nodeId }))),
      ]);
      return { ok: true, value: { reclaimable: unmet.length === 0, unmet: reasons, blockers } };
    },

    "node.reclaim": async (
      req: HandlerRequest<"node.reclaim">,
    ): Promise<Result<{ reclaimed: readonly string[] }, Failure>> => {
      const { nodeId } = req.params;
      const caller = req.caller?.nodeId ?? "";
      const outside = outsideSubtree(caller, nodeId);
      if (outside) return outside;
      // 回収は daemon 全体で直列にする（判定と削除の間に、別の回収が割り込まないように）。
      if (reclaiming) {
        return fail("busy", "別の回収を実行中", "少し待って、もう一度回収する");
      }
      reclaiming = true;
      try {
        return await execute(req.requestId, caller, nodeId);
      } finally {
        reclaiming = false;
      }
    },
  };

  async function execute(
    requestId: string,
    caller: string,
    nodeId: string,
  ): Promise<Result<{ reclaimed: readonly string[] }, Failure>> {
    const { plan, unmet } = await assess(log.state(), nodeId);
    if (unmet.length > 0) return notReclaimable(unmet);

    const actor = { nodeId: caller };
    const reclaimed: string[] = [];
    const done = () => (reclaimed.length === 0 ? "なし" : reclaimed.join("、"));
    for (const n of plan) {
      const current = log.state().nodes.find((x) => x.id === n.id);
      if (current?.state !== "archived") {
        // 各ノードの記録の直前に、そのノードだけ、事実とプロセスを取り直して判定する（判定から時間が経っている）。
        const state = log.state();
        const again = await assessNode(
          state.nodes,
          openDecisionNodes(state),
          n.id,
          new Set(discardedNodeIds(state)),
        );
        if (!again.result.ok || !again.result.value.reclaimable || again.facts === undefined) {
          const list: Unmet[] = again.result.ok
            ? [
                {
                  nodeId: n.id,
                  unmet: again.result.value.unmet,
                  blockers: again.result.value.blockers,
                },
              ]
            : [{ nodeId: n.id, unmet: ["stateNotEligible"], blockers: [] }];
          const f = notReclaimable(list);
          return {
            ok: false,
            error: failure(
              f.error.code,
              `${f.error.cause}（回収済み: ${done()}）`,
              ...(f.error.nextActions as [string, ...string[]]),
            ),
          };
        }
        if (current?.state !== "reclaimable") {
          const marked = appendAtomically(log, deps.clock, `${requestId}/${n.id}/mark`, actor, [
            {
              type: "node.stateChanged",
              payload: {
                nodeId: n.id,
                event: {
                  type: "markReclaimable",
                  discarded: discardedNodeIds(log.state()).includes(n.id),
                },
              },
            },
          ]);
          if (!marked.ok) return { ok: false, error: marked.error };
        }
        // 作業ツリーを消す前に、最終コミットを記録する（墓標の `lastCommit` の情報源。FR_031）。記録できなくても、回収は進める。
        const head = again.facts.headCommit;
        if (head === undefined) {
          deps.onFailure?.(n.id, "最終コミットを取得できなかった（記録せずに回収を進める）");
        } else if (current?.lastCommit !== head) {
          const rec = appendAtomically(log, deps.clock, `${requestId}/${n.id}/lastCommit`, actor, [
            { type: "node.lastCommit", payload: { nodeId: n.id, commit: head } },
          ]);
          if (!rec.ok) {
            deps.onFailure?.(
              n.id,
              `最終コミットを記録できなかった（回収を進める）: ${rec.error.code}: ${rec.error.cause}`,
            );
          }
        }
        let removed: Result<undefined, Failure>;
        try {
          // 強制（作業ツリーの `--force`・ブランチの `-D`）は、記録上、人間が破棄を判断した（`discarded`）、停止した
          // （stopped・そこから回収可能にした）ノードだけ（仕様 5.8）。判断は、ここで行う。ポートは渡された `force` を実行するだけ。
          const record = log.state().nodes.find((x) => x.id === n.id);
          const force =
            record?.discarded !== undefined &&
            (record.state === "stopped" || record.state === "reclaimable");
          removed = await ports.removeWorktree(n.id, {
            expectedPath: again.facts.worktreePath,
            ...(force ? { force: true, onTip: (tip: string) => ports.onForced?.(n.id, tip) } : {}),
          });
        } catch (e) {
          removed = { ok: false, error: failure("removeFailed", String(e), "原因を取り除く") };
        }
        if (!removed.ok) {
          deps.onFailure?.(n.id, `${removed.error.code}: ${removed.error.cause}`);
          return fail(
            "removeFailed",
            `ノード ${n.id} の作業ツリーを消せなかった（回収済み: ${done()}）。記録は回収可能のまま`,
            "作業ツリーの状態を確認して、もう一度回収する",
          );
        }
        const archived = appendAtomically(log, deps.clock, `${requestId}/${n.id}/archive`, actor, [
          { type: "node.stateChanged", payload: { nodeId: n.id, event: { type: "archive" } } },
        ]);
        if (!archived.ok) return { ok: false, error: archived.error };
      }
      reclaimed.push(n.id);
    }
    return { ok: true, value: { reclaimed } };
  }
}
