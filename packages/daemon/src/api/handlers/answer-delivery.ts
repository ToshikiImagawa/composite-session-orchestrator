/**
 * 判断の回答を、判断を出したノードへ届ける（T10b-r）。`decision.answer` が成功したあと、回答を「人間からの回答」と分かる
 * 追加指示にして、`node.send` と同じ配送（`InstructionDelivery`）で子へ渡す。
 *
 * - 記録: `node.instructed`（行為者は system。requestId は判断の ID から決める）→ 配送に成功したら `node.instructionDelivered`。
 *   同じ回答の再送・別の requestId の同じ回答でも、指示は 1 つ（記録済みで配送済みなら何もしない。未配送なら配送だけをやり直す）。
 * - 届けるのは、動作中・待機中（running・waiting）で、届ける手段（アダプタ）がある判断者だけ。停止済み（stopped）の子の再開は
 *   `pause-handlers` が行う。手段がない判断者（daemon の外で動く統合ノードなど）には何もしない。終わった子（done など）には届けず、
 *   受信箱に info を出す。
 * - 配送の失敗は、黙って捨てない。受信箱に failure（「回答は記録済みで、子には届いていない」）を出し（項目は 1 つ）、失敗を返す
 *   （呼び出し側が `resumePending` にする。同じ回答の再送でやり直せる）。
 * - 本文は、質問・回答とも信頼できない入力として `sanitizeText` を通し、全体を `LIMITS.reportText` に収める。
 * - 回復: daemon が「記録」と「配送」の間で落ちたときは、起動時に `recoverAnswerDeliveries` が、未配送の回答を見つけて配送し直す。
 */

import {
  type DecisionRecord,
  type EventBody,
  type Failure,
  LIMITS,
  type NodeState,
  type OrchState,
  type Result,
  sanitizeText,
  stateOf,
} from "@cso/core";
import {
  alreadyApplied,
  appendAtomically,
  deriveId,
  fail,
  type LogPort,
  summarize,
} from "./context.js";
import { type InstructionDelivery, isDelivered } from "./instruction-delivery.js";

const SYS = { system: true } as const;
const LIVE: ReadonlySet<NodeState> = new Set(["running", "waiting"]);
/** 状態の遷移の途中・停止済みは、ここでは扱わない（停止済みの子は、`pause-handlers` が再開する）。 */
const NOT_HERE: ReadonlySet<NodeState> = new Set(["stopped", "stopping", "stopIncomplete"]);

/** 回答の指示の requestId（判断ごとに 1 つ）。 */
export const answerRequestId = (decisionId: string): string => `answer-${decisionId}`;

/** 回答を、子への追加指示の本文にする。 */
export function answerText(d: DecisionRecord, answer: string): string {
  const question = sanitizeText(d.question ?? "", 4 * 1024);
  const chosen = d.options?.includes(answer) === true;
  const body = sanitizeText(answer, 48 * 1024);
  const text = [
    `【人間からの回答】判断 ${d.decisionId}`,
    ...(question === "" ? [] : [`質問: ${question}`]),
    chosen ? `選んだ選択肢: ${body}` : `回答（自由記述）: ${body}`,
    "この回答をふまえて、作業を続けてください。",
  ].join("\n");
  return sanitizeText(text, LIMITS.reportText);
}

export interface AnswerDeliveryDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  readonly deliver: InstructionDelivery["deliver"];
  readonly canDeliver: InstructionDelivery["available"];
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

export type AnswerDeliveryOutcome =
  | { readonly kind: "delivered" | "skipped" }
  | { readonly kind: "failed"; readonly message: string };

const note = (deps: AnswerDeliveryDeps, nodeId: string, cause: string): void => {
  try {
    deps.onFailure?.(nodeId, cause);
  } catch {
    // 記録先の失敗は、処理を止めない
  }
};

/** 受信箱の項目。failure は、根拠の報告（`report.added`。kind: failure）を指す。info は参照なし。 */
const inboxBodies = (
  decisionId: string,
  nodeId: string,
  kind: "info" | "failure",
  text: string,
): EventBody[] => {
  const key = answerRequestId(decisionId);
  const reportId = deriveId("report", "system", key, kind);
  return [
    ...(kind === "failure"
      ? ([
          {
            type: "report.added",
            payload: {
              reportId,
              nodeId,
              kind: "failure",
              text: sanitizeText(text, LIMITS.reportText),
            },
          },
        ] as const)
      : []),
    {
      type: "inbox.added",
      payload: {
        id: deriveId("inbox", "system", key, kind),
        kind,
        nodeId,
        summary: summarize(text),
        ...(kind === "failure" ? { ref: reportId } : {}),
      },
    },
  ];
};

const appendInbox = (
  deps: AnswerDeliveryDeps,
  decisionId: string,
  nodeId: string,
  kind: "info" | "failure",
  text: string,
): void => {
  const r = appendAtomically(
    deps.log,
    deps.clock,
    `${answerRequestId(decisionId)}-${kind}`,
    SYS,
    inboxBodies(decisionId, nodeId, kind, text),
  );
  if (!r.ok) note(deps, nodeId, `受信箱に載せられない: ${r.error.code}: ${r.error.cause}`);
};

/** 回答の指示を記録（済みなら、その番号）し、未配送なら配送する。 */
async function recordAndDeliver(
  deps: AnswerDeliveryDeps,
  d: DecisionRecord,
  answer: string,
): Promise<Result<"delivered" | "already", Failure>> {
  const text = answerText(d, answer);
  const requestId = answerRequestId(d.decisionId);
  const entry = [{ type: "node.instructed", payload: { nodeId: d.nodeId, text } }] as const;
  const recorded = appendAtomically(deps.log, deps.clock, requestId, SYS, entry);
  if (!recorded.ok) return recorded;
  const seq = recorded.value.events[0]?.seq;
  if (seq === undefined) {
    return fail("internal", "記録した指示の番号を取得できない", "もう一度試す");
  }
  if (isDelivered(deps.log.state(), seq)) return { ok: true, value: "already" };
  const sent = await deps.deliver(d.nodeId, text, seq);
  return sent.ok ? { ok: true, value: "delivered" } : sent;
}

/** 回答を、判断を出したノードへ届ける。 */
export async function deliverAnswer(
  deps: AnswerDeliveryDeps,
  d: DecisionRecord,
  answer: string,
): Promise<AnswerDeliveryOutcome> {
  const state = stateOf(deps.log.state(), d.nodeId);
  if (state === undefined || NOT_HERE.has(state)) return { kind: "skipped" };
  if (!LIVE.has(state)) {
    if (!alreadyApplied(deps.log.state(), SYS, `${answerRequestId(d.decisionId)}-info`)) {
      appendInbox(
        deps,
        d.decisionId,
        d.nodeId,
        "info",
        `判断 ${d.decisionId} の回答は、${state} のノードには届けなかった（回答は記録済み）`,
      );
    }
    return { kind: "skipped" };
  }
  if (!deps.canDeliver(d.nodeId)) return { kind: "skipped" }; // 届ける手段がない判断者
  const r = await recordAndDeliver(deps, d, answer);
  if (r.ok) return { kind: "delivered" };
  note(deps, d.nodeId, `回答を届けられない: ${r.error.code}: ${r.error.cause}`);
  if (!alreadyApplied(deps.log.state(), SYS, `${answerRequestId(d.decisionId)}-failure`)) {
    appendInbox(
      deps,
      d.decisionId,
      d.nodeId,
      "failure",
      `判断 ${d.decisionId} の回答は記録済みだが、${d.nodeId} には届いていない（${r.error.code}）。同じ回答をもう一度送ると、届け直す`,
    );
  }
  return { kind: "failed", message: `${d.nodeId}（回答を届けられない: ${r.error.code}）` };
}

export interface RecoveredAnswer {
  readonly nodeId: string;
  readonly result: "delivered" | "unavailable" | "failed";
}

/**
 * 起動時の回復: 回答の指示（`node.instructed`）はあるが配送の記録がないものを、もう一度配送する。届ける手段がない
 * （子のセッションが失われた）ときは、受信箱に failure を 1 度だけ出す（子の再起動・追加の指示は、人間・統合ノードが行う）。
 */
export async function recoverAnswerDeliveries(
  deps: AnswerDeliveryDeps,
): Promise<RecoveredAnswer[]> {
  const out: RecoveredAnswer[] = [];
  const start: OrchState = deps.log.state();
  for (const d of start.decisions) {
    if (d.status !== "answered" || d.answer === undefined) continue;
    if (!alreadyApplied(start, SYS, answerRequestId(d.decisionId))) continue; // 回答の指示を記録していない
    const text = answerText(d, d.answer);
    const rec = start.instructions.find((i) => i.nodeId === d.nodeId && i.text === text);
    if (rec === undefined || isDelivered(start, rec.seq)) continue;
    const state = stateOf(start, d.nodeId);
    if (state === undefined || !LIVE.has(state) || !deps.canDeliver(d.nodeId)) {
      if (!alreadyApplied(start, SYS, `${answerRequestId(d.decisionId)}-failure`)) {
        appendInbox(
          deps,
          d.decisionId,
          d.nodeId,
          "failure",
          `判断 ${d.decisionId} の回答は記録済みだが、${d.nodeId} には届いていない（子のセッションが失われた）。子を再起動して、回答をもう一度指示する`,
        );
      }
      out.push({ nodeId: d.nodeId, result: "unavailable" });
      continue;
    }
    const sent = await deps.deliver(d.nodeId, text, rec.seq);
    if (!sent.ok)
      note(deps, d.nodeId, `回答を届けられない: ${sent.error.code}: ${sent.error.cause}`);
    out.push({ nodeId: d.nodeId, result: sent.ok ? "delivered" : "failed" });
  }
  return out;
}
