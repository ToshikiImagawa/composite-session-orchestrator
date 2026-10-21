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
 * - 破棄の判断（停止したノードの回収）は、記録する経路がまだない。`discarded` は常に false で判定し、停止したノードは
 *   `discardRequired`（人間の判断が要る）として拒否する。
 */

import {
  assessReclaim,
  type Blocker,
  type Failure,
  failure,
  isStrictDescendant,
  type NodeRecord,
  type OrchState,
  type ProcessInfo,
  type ReclaimNode,
  type ReclaimNodeFacts,
  type Result,
  type UnmetReason,
} from "@cso/core";
import type { ProcessProbe } from "../../sdk/lsof-probe.js";
import type { HandlerRequest } from "../server.js";
import { appendAtomically, fail, type LogPort } from "./context.js";

/** 作業ツリーの事実（`discarded` は daemon が決める）。 */
export type WorktreeFacts = Omit<ReclaimNodeFacts, "discarded">;

export interface ReclaimPorts {
  /** ノードの作業ツリーの事実。調べられない・作業ツリーがなければ `undefined`（回収不可）。 */
  factsFor(nodeId: string): Promise<WorktreeFacts | undefined>;
  /** 作業ツリー配下のプロセスの調査。取得できなければ `null`（回収不可）。 */
  readonly probe: ProcessProbe;
  /** 作業ツリーを消す。失敗は `Failure` で返す（例外にしない）。 */
  removeWorktree(nodeId: string): Promise<Result<undefined, Failure>>;
  /** daemon の作業ツリー置き場（渡すと、配下でないパスを拒否する）。 */
  readonly worktreeRoot?: string;
}

export interface ReclaimHandlerDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  readonly ports: ReclaimPorts;
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

  /**
   * 対象と配下を、配下から順に判定する。先に判定した回収可能なノードは、後のノード（親）の判定では回収可能とみなす。
   * アーカイブ済みは判定せず、回収済みとして数える。
   */
  async function assess(
    state: OrchState,
    targetId: string,
  ): Promise<{ plan: NodeRecord[]; unmet: Unmet[] }> {
    const plan = postOrder(state.nodes, targetId);
    const virtual = new Map<string, ReclaimNode>(state.nodes.map((n) => [n.id, n]));
    const open = openDecisionNodes(state);
    const unmet: Unmet[] = [];
    for (const n of plan) {
      if (n.state === "archived") continue;
      const found = await ports.factsFor(n.id);
      const facts = found === undefined ? {} : { [n.id]: { ...found, discarded: false } };
      let processes: readonly ProcessInfo[] | null = null;
      if (found !== undefined) {
        try {
          processes = await ports.probe(found.worktreePath);
        } catch {
          processes = null;
        }
      }
      const r = assessReclaim(
        {
          nodes: [...virtual.values()],
          facts,
          openDecisionNodeIds: open,
          processes,
          ...(ports.worktreeRoot === undefined ? {} : { worktreeRoot: ports.worktreeRoot }),
        },
        n.id,
      );
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

  return {
    "node.reclaimPreview": async (
      req: HandlerRequest<"node.reclaimPreview">,
    ): Promise<Result<{ reclaimable: boolean }, Failure>> => {
      const { nodeId } = req.params;
      const outside = outsideSubtree(req.caller?.nodeId ?? "", nodeId);
      if (outside) return outside;
      const { unmet } = await assess(log.state(), nodeId);
      if (unmet.length > 0) return notReclaimable(unmet);
      return { ok: true, value: { reclaimable: true } };
    },

    "node.reclaim": async (
      req: HandlerRequest<"node.reclaim">,
    ): Promise<Result<{ reclaimed: readonly string[] }, Failure>> => {
      const { nodeId } = req.params;
      const caller = req.caller?.nodeId ?? "";
      const outside = outsideSubtree(caller, nodeId);
      if (outside) return outside;
      const { plan, unmet } = await assess(log.state(), nodeId);
      if (unmet.length > 0) return notReclaimable(unmet);

      const actor = { nodeId: caller };
      const reclaimed: string[] = [];
      for (const n of plan) {
        const current = log.state().nodes.find((x) => x.id === n.id);
        if (current?.state !== "archived") {
          if (current?.state !== "reclaimable") {
            const marked = appendAtomically(
              log,
              deps.clock,
              `${req.requestId}/${n.id}/mark`,
              actor,
              [
                {
                  type: "node.stateChanged",
                  payload: { nodeId: n.id, event: { type: "markReclaimable", discarded: false } },
                },
              ],
            );
            if (!marked.ok) return { ok: false, error: marked.error };
          }
          const removed = await ports.removeWorktree(n.id);
          if (!removed.ok) {
            return {
              ok: false,
              error: failure(
                removed.error.code,
                `ノード ${n.id} の作業ツリーを消せなかった（回収済み: ${reclaimed.join("、") || "なし"}）: ${removed.error.cause}`,
                ...(removed.error.nextActions.length > 0
                  ? removed.error.nextActions
                  : (["原因を取り除いて、もう一度回収する"] as [string, ...string[]])),
              ),
            };
          }
          const archived = appendAtomically(
            log,
            deps.clock,
            `${req.requestId}/${n.id}/archive`,
            actor,
            [{ type: "node.stateChanged", payload: { nodeId: n.id, event: { type: "archive" } } }],
          );
          if (!archived.ok) return { ok: false, error: archived.error };
        }
        reclaimed.push(n.id);
      }
      return { ok: true, value: { reclaimed } };
    },
  };
}
