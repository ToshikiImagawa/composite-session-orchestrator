/**
 * ノードの状態遷移（純粋関数）。
 * PRD: FR_008, FR_010, FR_018, FR_024 / spec 4.2, 5.2, 5.3, 5.7, 5.8
 *
 * 表にない（状態, イベント）の組はすべて拒否する。時刻・識別子・プロセスの確認は呼び出し側の責務で、
 * ここでは「確認できた」というイベントを受けて遷移だけを決める。
 */

import { type Failure, failure, ok, type Result } from "./contract.js";
import type { NodeState } from "./index.js";

/**
 * 「完了」とみなす状態（FR_008）。依存先がこれらのいずれかなら、依存元は起動できる（T07）。
 * 回収可能判定（T05）の条件 3 でも、依存元が完了しているかの判定に使う。
 */
export const COMPLETED_STATES: ReadonlySet<NodeState> = new Set([
  "verified",
  "reclaimable",
  "archived",
]);

export type StopMode = "graceful" | "immediate";

export type NodeEvent =
  | { readonly type: "start" } // 依存先が完了した（pending→running）
  | { readonly type: "requestDecision" } // 判断要求で一時停止（running→waiting）
  | { readonly type: "resume" } // 回答が届いた（waiting→running）
  | { readonly type: "reportDone" } // 完了報告（running→done）
  | { readonly type: "accept" } // 親が受理（done→verified）
  | { readonly type: "reject" } // 親が差し戻し（done→running）。統合ノードまたは人間の指示による
  | { readonly type: "stop"; readonly mode: StopMode; readonly graceMs?: number } // 停止要求。graceMs は猶予時間（記録用。遷移には影響しない）
  | { readonly type: "stopTimeout" } // 停止要求後、所定の時間を超えてもプロセスが残っている
  | { readonly type: "retryStop" } // 停止の再試行（stopIncomplete→stopping。即時停止の指示）
  | { readonly type: "confirmStopped" } // 作業ツリー配下にプロセスがないことを確認した
  | { readonly type: "restart"; readonly dependenciesDone: boolean } // 停止した子の再開。統合ノードまたは人間の指示による。stopped→pending、依存先が完了済みなら続けて start して running
  | { readonly type: "markReclaimable"; readonly discarded: boolean } // 回収可能と判定（判定自体は別関数）
  | { readonly type: "archive" }; // 回収を実行（reclaimable→archived）

/** 状態遷移に伴い、呼び出し側（daemon のアダプタ）が行う作用。 */
export type TransitionEffect = "gracefulStop" | "immediateStop" | "cancelStart";

export interface TransitionOutcome {
  readonly state: NodeState;
  /** 状態が変わったか。冪等な停止要求（進行中の停止の継続）では false。 */
  readonly changed: boolean;
  readonly effect?: TransitionEffect;
}

/** 失敗の分類（`Failure.code`）。 */
export type TransitionFailureCode = "invalidTransition" | "alreadyFinished" | "discardRequired";

export type TransitionResult = Result<TransitionOutcome, Failure>;

const moved = (state: NodeState, effect?: TransitionEffect): TransitionResult =>
  ok(effect === undefined ? { state, changed: true } : { state, changed: true, effect });

const unchanged = (state: NodeState, effect?: TransitionEffect): TransitionResult =>
  ok(effect === undefined ? { state, changed: false } : { state, changed: false, effect });

const fail = (
  code: TransitionFailureCode,
  cause: string,
  ...nextActions: readonly [string, ...string[]]
): TransitionResult => ({ ok: false, error: failure(code, cause, ...nextActions) });

/**
 * 停止要求。送り直しは冪等で、一度受け付けた停止要求は、再送しても成功（`changed: false`）を返す。
 * `alreadyFinished` は、停止の対象にならない状態（完了・検証済み・回収可能・アーカイブ）への要求だけに返す。
 */
function stop(state: NodeState, mode: StopMode): TransitionResult {
  switch (state) {
    case "running":
      return moved("stopping", mode === "graceful" ? "gracefulStop" : "immediateStop");
    case "waiting":
      // 動作中ではないため猶予なし。プロセスの不在を確認するまで stopped とは扱わない（spec 5.3）。
      return moved("stopping", "immediateStop");
    case "pending":
      return moved("stopped", "cancelStart"); // プロセス未生成
    case "stopping":
      // 進行中の停止を継続する。猶予中に即時の要求が来たら即時停止へ切り替える（再送しても同じ）。
      return unchanged(state, mode === "immediate" ? "immediateStop" : undefined);
    case "stopIncomplete":
    case "stopped":
      return unchanged(state);
    default:
      return fail(
        "alreadyFinished",
        `ノードは既に ${state} で、停止する対象がない`,
        "状態を確認する",
      );
  }
}

export function transition(state: NodeState, event: NodeEvent): TransitionResult {
  if (event.type === "stop") return stop(state, event.mode);

  switch (event.type) {
    case "start":
      return state === "pending" ? moved("running") : invalid(state, event);
    case "requestDecision":
      return state === "running" ? moved("waiting") : invalid(state, event);
    case "resume":
      return state === "waiting" ? moved("running") : invalid(state, event);
    case "reportDone":
      return state === "running" ? moved("done") : invalid(state, event);
    case "accept":
      return state === "done" ? moved("verified") : invalid(state, event);
    case "reject":
      return state === "done" ? moved("running") : invalid(state, event);
    case "stopTimeout":
      return state === "stopping" ? moved("stopIncomplete") : invalid(state, event);
    case "retryStop":
      return state === "stopIncomplete"
        ? moved("stopping", "immediateStop")
        : invalid(state, event);
    case "confirmStopped":
      return state === "stopping" || state === "stopIncomplete"
        ? moved("stopped")
        : invalid(state, event);
    case "restart":
      if (state !== "stopped") return invalid(state, event);
      return moved(event.dependenciesDone ? "running" : "pending");
    case "markReclaimable":
      if (state === "verified") return moved("reclaimable");
      if (state === "stopped") {
        return event.discarded
          ? moved("reclaimable")
          : fail(
              "discardRequired",
              "停止したノードは成果が統合されていないため、破棄の判断なしには回収できない",
              "破棄してよいかを人間に確認する",
              "再開する（restart）",
            );
      }
      return invalid(state, event);
    case "archive":
      return state === "reclaimable" ? moved("archived") : invalid(state, event);
  }
}

function invalid(state: NodeState, event: NodeEvent): TransitionResult {
  return fail(
    "invalidTransition",
    `状態 ${state} では ${event.type} を受け付けない`,
    "状態を確認する",
    "可能な操作を参照する",
  );
}
