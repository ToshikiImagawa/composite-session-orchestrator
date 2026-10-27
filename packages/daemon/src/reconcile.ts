/**
 * 起動時の整合。daemon が再起動すると、アダプタが管理していた子のセッションは失われる。記録では動作中（running・waiting）や
 * 停止の途中（stopping・stopIncomplete）のままのノードを、作業ツリーのプロセスの有無（`probe`）に合わせる。
 * PRD: FR_010, NFR_003 / design 9.2
 *
 * - アダプタが管理している子（`has`）、根（ブリーフのない人間のセッション）、動作中でない状態（pending・done など）は対象外。
 * - プロセスがない: running・waiting は、予期しない終了（`node.exited`）として記録して停止済みにし、受信箱に失敗を出す。
 *   stopping・stopIncomplete は、停止を確認して stopped にする。
 * - プロセスが残っている、または調べられない（`probe` が `null`・作業ツリーが分からない）: 安全側に、running・waiting は
 *   停止の要求（即時）→ `stopTimeout` で停止未完了にし、stopping は `stopTimeout` で停止未完了にする。受信箱に残っている pid を出す。
 *   stopIncomplete は、そのまま。残っているプロセスは、アダプタが持っていないので `node.stop` では止められない（人間が止めてから、
 *   再起動すると、停止を確認して stopped にする）。
 * - 判断を待っていた子（未回答の判断要求を持つ waiting）は、プロセスが失われていたら、停止済みにして、どの判断を待っていたかを
 *   記録に残す（停止の要求の requestId を判断から決める）。回答（`decision.answer`）の側が、これを見て再開する（人間が止めた子は除く）。
 * - プロセスの調査は、置き場全体に 1 回だけ行って共有する（`worktreeRoot` を渡すとき）。
 * - 「プロセスがない」は、停止の証明ではない（調べられた範囲に、見つからなかっただけ）。作業ツリーの外へ出たプロセスは、見つけられない。
 * - 同じ状態での再実行は、何も変えない（冪等）。記録は、システムの記録として、この起動の時点の `seq` から導く requestId で追記する。
 */

import {
  type EventBody,
  findRunningProcesses,
  formatProcesses,
  type OrchState,
  type ProcessInfo,
  stateOf,
} from "@cso/core";
import {
  appendAtomically,
  deriveId,
  type LogPort,
  summarize,
  waitRequestKey,
} from "./api/handlers/context.js";
import type { ProcessProbe } from "./sdk/lsof-probe.js";

export interface ReconcileDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  /** ノードの作業ツリー（実パス）。分からなければ `undefined`（安全側）。 */
  readonly cwdOf: (nodeId: string) => Promise<string | undefined>;
  readonly probe: ProcessProbe;
  /**
   * 作業ツリーの置き場。渡すと、プロセスの調査を置き場全体に 1 回だけ行い、全ノードで共有する（各ノードの作業ツリーの
   * 配下のプロセスだけを数える）。省略すると、ノードごとに調べる。
   */
  readonly worktreeRoot?: string;
  /** アダプタが、そのノードの子を管理しているか。 */
  readonly has?: (nodeId: string) => boolean;
  /**
   * daemon の外で動く子（Desktop の子。T21）か。真のノードは、プロセスで照合せず（作業ツリーのプロセスでは確かめられない）、
   * 状態を変えずに、根の受信箱に、人に確かめてもらう項目（stopIncomplete の帯）を、まとめて 1 件出す（未解決の同じ依頼があれば、出さない）。
   */
  readonly external?: (nodeId: string) => boolean;
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

export interface ReconcileOutcome {
  readonly nodeId: string;
  readonly from: string;
  readonly to: string;
}

const TARGETS = new Set(["running", "waiting", "stopping", "stopIncomplete"]);

/**
 * daemon の外で動く子（Desktop）を、再起動のあとに人に確かめてもらう依頼の文面（固定。重複の判定にも使う）。
 * 詳しい手順は `docs/desktop-runtime.md` の「根の受信箱の 1 件で、人に確かめてもらうこと」。
 */
export const EXTERNAL_CHECK_SUMMARY =
  "再起動後: Desktop の子は止まったと決めつけない。画面で子ごとに確かめ、アーカイブで止め、止まったと確かめて宣言（desktop-runtime.md）";

/**
 * 前の版の文面（記録に残っている未解決の依頼も、同じ依頼として数える。重複して出さない）。
 * 固定文を変えるときは、その時点の文面をここに足す（記録に未解決の依頼が残るため）。
 */
const LEGACY_EXTERNAL_CHECK_SUMMARIES: readonly string[] = [
  "daemon の再起動のあと、Desktop の子の状態は daemon から確かめられない。Desktop で確かめ、止まっていれば停止して止めたと宣言する（仮置き）",
];
const isExternalCheck = (summary: string | undefined): boolean =>
  summary !== undefined &&
  [EXTERNAL_CHECK_SUMMARY, ...LEGACY_EXTERNAL_CHECK_SUMMARIES].some((s) => summary.startsWith(s));

export async function reconcileOnStartup(deps: ReconcileDeps): Promise<ReconcileOutcome[]> {
  const { log } = deps;
  const start: OrchState = log.state();
  const run = start.lastSeq;
  const outcomes: ReconcileOutcome[] = [];
  const candidates = start.nodes.filter(
    (n) => n.parentId !== null && TARGETS.has(n.state) && deps.has?.(n.id) !== true,
  );
  const nodes = candidates.filter((n) => deps.external?.(n.id) !== true);
  // daemon の外で動く子（Desktop）は、まとめて 1 件だけ、根の受信箱に出す（停止の代行依頼と同じ stopIncomplete の帯。見逃さない）。
  // 未解決の同じ依頼があれば、出さない（再起動を繰り返しても、増えない）。
  const external = candidates.filter((n) => deps.external?.(n.id) === true);
  const root = start.nodes.find((n) => n.parentId === null);
  const pending = start.inbox.some((i) => i.resolved === undefined && isExternalCheck(i.summary));
  if (external.length > 0 && root !== undefined && !pending) {
    const key = `reconcile-external-${run}`;
    const shown = external.slice(0, 5).map((n) => n.id);
    const more = external.length > shown.length ? ` ほか ${external.length - shown.length} 件` : "";
    const r = appendAtomically(log, deps.clock, key, { system: true }, [
      {
        type: "inbox.added",
        payload: {
          id: deriveId("inbox", "system", key, "external"),
          kind: "stopIncomplete",
          nodeId: root.id,
          summary: summarize(
            `${EXTERNAL_CHECK_SUMMARY}（${external.length} 件: ${shown.join("、")}${more}）`,
          ),
        },
      },
    ]);
    if (!r.ok) deps.onFailure?.(root.id, `確かめる依頼を記録できない: ${r.error.cause}`);
  }
  // 置き場全体を 1 回だけ調べて共有する（調べられなければ null。全ノードを安全側にする）。
  let shared: readonly ProcessInfo[] | null | undefined;
  if (deps.worktreeRoot !== undefined && nodes.length > 0) {
    try {
      shared = await deps.probe(deps.worktreeRoot);
    } catch (e) {
      deps.onFailure?.("", `プロセスを調べられない: ${String(e)}`);
      shared = null;
    }
  }
  for (const n of nodes) {
    let procs: readonly ProcessInfo[] | null = null;
    try {
      const cwd = await deps.cwdOf(n.id);
      if (cwd === undefined) procs = null;
      else if (deps.worktreeRoot !== undefined) {
        const pids =
          shared === null || shared === undefined ? undefined : findRunningProcesses(cwd, shared);
        procs =
          pids === undefined
            ? null
            : (shared as readonly ProcessInfo[]).filter((p) => pids.includes(p.pid));
      } else procs = await deps.probe(cwd);
    } catch (e) {
      deps.onFailure?.(n.id, `プロセスを調べられない: ${String(e)}`);
      procs = null;
    }
    const gone = procs !== null && procs.length === 0;
    const key = `reconcile-${n.id}-${run}`;
    const inbox = (
      kind: "info" | "failure" | "stopIncomplete",
      text: string,
      ref?: string,
    ): EventBody => ({
      type: "inbox.added",
      payload: {
        id: deriveId("inbox", "system", key, kind),
        kind,
        nodeId: n.id,
        summary: summarize(text),
        ...(ref === undefined ? {} : { ref }),
      },
    });
    const bodies: EventBody[] = [];
    let keyOverride: string | undefined;
    const exited = (): EventBody => ({
      type: "node.exited",
      payload: { nodeId: n.id, reason: "daemon の再起動で、子のセッションが失われた" },
    });
    const ev = (type: "confirmStopped" | "stopTimeout"): EventBody => ({
      type: "node.stateChanged",
      payload: { nodeId: n.id, event: { type } },
    });
    const stopImmediate: EventBody = {
      type: "node.stateChanged",
      payload: { nodeId: n.id, event: { type: "stop", mode: "immediate" } },
    };
    const pids = procs === null ? "pid 不明（調べられない）" : formatProcesses(procs);
    const openDecision =
      n.state === "waiting"
        ? start.decisions.find((d) => d.nodeId === n.id && d.status === "open")
        : undefined;
    if (openDecision !== undefined && gone) {
      // 判断を待っていた子: プロセスが失われた。どの判断を待っていたかを記録に残し、回答が来たら再開できるようにする
      // （停止の要求の requestId を、判断から決める。回答の側が、これを見て、人間が止めた子と区別する）。
      const waitKey = waitRequestKey(openDecision.decisionId);
      const reportId = deriveId("report", "system", waitKey, "report");
      bodies.push(
        stopImmediate,
        exited(),
        ev("confirmStopped"),
        {
          type: "report.added",
          payload: {
            reportId,
            nodeId: n.id,
            kind: "failure",
            text: `daemon の再起動で、子のセッションが失われた（判断 ${openDecision.decisionId} を待っていた。回答が来たら再開する）。`,
          },
        },
        inbox(
          "failure",
          `daemon の再起動で、判断 ${openDecision.decisionId} を待っていた子のセッションが失われた（回答で再開する）`,
          reportId,
        ),
      );
      keyOverride = waitKey;
    } else if (n.state === "running" || n.state === "waiting") {
      if (gone) {
        const reportId = deriveId("report", "system", key, "report");
        bodies.push(
          exited(),
          stopImmediate,
          ev("confirmStopped"),
          {
            type: "report.added",
            payload: {
              reportId,
              nodeId: n.id,
              kind: "failure",
              text: "daemon の再起動で、子のセッションが失われた（プロセスは残っていない）。",
            },
          },
          inbox("failure", "daemon の再起動で、子のセッションが失われた", reportId),
        );
      } else {
        // プロセスが残っている（または分からない）ときは、終了とは言えないので、node.exited は記録しない。
        // 失敗の報告と、受信箱の failure の項目は、アダプタの予期しない終了と同じく出す。
        const reportId = deriveId("report", "system", key, "report");
        bodies.push(
          stopImmediate,
          ev("stopTimeout"),
          {
            type: "report.added",
            payload: {
              reportId,
              nodeId: n.id,
              kind: "failure",
              text: "daemon の再起動で、子のセッションが失われた（プロセスが残っている、または調べられない）。",
            },
          },
          inbox("failure", "daemon の再起動で、子のセッションが失われた", reportId),
          inbox("stopIncomplete", `再起動後、停止を確認できない。残っているプロセス ${pids}`),
        );
      }
    } else if (n.state === "stopping") {
      bodies.push(
        gone ? ev("confirmStopped") : ev("stopTimeout"),
        gone
          ? inbox("info", "再起動後、停止を確認した")
          : inbox("stopIncomplete", `再起動後、停止を確認できない。残っているプロセス ${pids}`),
      );
    } else if (gone) {
      // stopIncomplete: 人間が残っていたプロセスを止めたあとの再起動で、停止を確認する。
      bodies.push(ev("confirmStopped"), inbox("info", "再起動後、停止を確認した"));
    } else {
      continue; // stopIncomplete のまま、プロセスが残っている
    }
    const r = appendAtomically(log, deps.clock, keyOverride ?? key, { system: true }, bodies);
    if (!r.ok) {
      deps.onFailure?.(n.id, `整合を記録できない: ${r.error.code}: ${r.error.cause}`);
      continue;
    }
    outcomes.push({ nodeId: n.id, from: n.state, to: stateOf(r.value.state, n.id) ?? "?" });
  }
  return outcomes;
}
