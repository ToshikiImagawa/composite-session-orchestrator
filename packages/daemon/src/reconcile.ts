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
 * - 同じ状態での再実行は、何も変えない（冪等）。記録は、システムの記録として、この起動の時点の `seq` から導く requestId で追記する。
 */

import { type EventBody, type OrchState, type ProcessInfo, stateOf } from "@cso/core";
import { appendAtomically, deriveId, type LogPort, summarize } from "./api/handlers/context.js";
import type { ProcessProbe } from "./sdk/lsof-probe.js";

export interface ReconcileDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  /** ノードの作業ツリー（実パス）。分からなければ `undefined`（安全側）。 */
  readonly cwdOf: (nodeId: string) => Promise<string | undefined>;
  readonly probe: ProcessProbe;
  /** アダプタが、そのノードの子を管理しているか。 */
  readonly has?: (nodeId: string) => boolean;
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

export interface ReconcileOutcome {
  readonly nodeId: string;
  readonly from: string;
  readonly to: string;
}

const TARGETS = new Set(["running", "waiting", "stopping", "stopIncomplete"]);

export async function reconcileOnStartup(deps: ReconcileDeps): Promise<ReconcileOutcome[]> {
  const { log } = deps;
  const start: OrchState = log.state();
  const run = start.lastSeq;
  const outcomes: ReconcileOutcome[] = [];
  const nodes = start.nodes.filter(
    (n) => n.parentId !== null && TARGETS.has(n.state) && deps.has?.(n.id) !== true,
  );
  for (const n of nodes) {
    let procs: readonly ProcessInfo[] | null = null;
    try {
      const cwd = await deps.cwdOf(n.id);
      procs = cwd === undefined ? null : await deps.probe(cwd);
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
    const pids = procs === null ? "不明（調べられない）" : procs.map((p) => p.pid).join(", ");
    if (n.state === "running" || n.state === "waiting") {
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
        bodies.push(
          exited(),
          stopImmediate,
          ev("stopTimeout"),
          inbox("stopIncomplete", `再起動後、停止を確認できない。残っているプロセス pid ${pids}`),
        );
      }
    } else if (n.state === "stopping") {
      bodies.push(
        gone ? ev("confirmStopped") : ev("stopTimeout"),
        gone
          ? inbox("info", "再起動後、停止を確認した")
          : inbox("stopIncomplete", `再起動後、停止を確認できない。残っているプロセス pid ${pids}`),
      );
    } else if (gone) {
      // stopIncomplete: 人間が残っていたプロセスを止めたあとの再起動で、停止を確認する。
      bodies.push(ev("confirmStopped"), inbox("info", "再起動後、停止を確認した"));
    } else {
      continue; // stopIncomplete のまま、プロセスが残っている
    }
    const r = appendAtomically(log, deps.clock, key, { system: true }, bodies);
    if (!r.ok) {
      deps.onFailure?.(n.id, `整合を記録できない: ${r.error.code}: ${r.error.cause}`);
      continue;
    }
    outcomes.push({ nodeId: n.id, from: n.state, to: stateOf(r.value.state, n.id) ?? "?" });
  }
  return outcomes;
}
