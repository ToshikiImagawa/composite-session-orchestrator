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
 *   指示は、回答の requestId（`answer-<decisionId>`）の再追記（重複として最初のイベントを返す）から引く。**配送し直せるのは、
 *   子のセッション（アダプタの管理）が残っているときだけ**（daemon の再起動でプロセスは失われるため、そのときは受信箱に failure を出す）。
 * - 同じ判断の配送は、ログごと・判断 ID ごとに同時に 1 つだけ走らせる（同じ回答の同時の再送・回復との重なりで二重に届けない）。
 * - 再送で配送に成功したら、前に出した failure の項目を（system で）解決済みにする。
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

const ANSWER_FOOTER = "この回答をふまえて、作業を続けてください。";

/**
 * 回答を、子への追加指示の本文にする。全体の上限（`LIMITS.reportText`）は先頭を残して切り詰めるが、末尾の定型文は
 * 切り詰めの外に置く（落とさない）。
 */
export function answerText(d: DecisionRecord, answer: string): string {
  const question = sanitizeText(d.question ?? "", 4 * 1024);
  const chosen = d.options?.includes(answer) === true;
  const body = sanitizeText(answer, 48 * 1024);
  const head = [
    `【人間からの回答】判断 ${d.decisionId}`,
    ...(question === "" ? [] : [`質問: ${question}`]),
    chosen ? `選んだ選択肢: ${body}` : `回答（自由記述）: ${body}`,
  ].join("\n");
  const footer = `\n${ANSWER_FOOTER}`;
  return sanitizeText(head, LIMITS.reportText - Array.from(footer).length) + footer;
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
  tag: string,
): EventBody[] => {
  const key = answerRequestId(decisionId);
  const reportId = deriveId("report", "system", key, tag);
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
        id: inboxItemId(decisionId, tag),
        kind,
        nodeId,
        summary: summarize(text),
        ...(kind === "failure" ? { ref: reportId } : {}),
      },
    },
  ];
};

/** 受信箱の項目の ID（判断と用途の組ごとに 1 つ）。 */
const inboxItemId = (decisionId: string, tag: string): string =>
  deriveId("inbox", "system", answerRequestId(decisionId), tag);

/** 同じ用途の項目は、判断ごとに 1 度だけ載せる（記録済みなら何もしない）。 */
const addInboxOnce = (
  deps: AnswerDeliveryDeps,
  decisionId: string,
  nodeId: string,
  kind: "info" | "failure",
  text: string,
  tag: string,
): void => {
  const requestId = `${answerRequestId(decisionId)}-${tag}`;
  if (alreadyApplied(deps.log.state(), SYS, requestId)) return;
  const r = appendAtomically(
    deps.log,
    deps.clock,
    requestId,
    SYS,
    inboxBodies(decisionId, nodeId, kind, text, tag),
  );
  if (!r.ok) note(deps, nodeId, `受信箱に載せられない: ${r.error.code}: ${r.error.cause}`);
};

/** 配送に成功したら、前に出した failure の項目（あれば）を解決済みにする。 */
const resolveFailure = (deps: AnswerDeliveryDeps, decisionId: string, nodeId: string): void => {
  const itemId = inboxItemId(decisionId, "failure");
  if (!deps.log.state().inbox.some((i) => i.id === itemId && i.resolved === undefined)) return;
  const r = appendAtomically(
    deps.log,
    deps.clock,
    `${answerRequestId(decisionId)}-failure-resolved`,
    SYS,
    [{ type: "inbox.resolved", payload: { itemId } }],
  );
  if (!r.ok) note(deps, nodeId, `失敗の項目を解決できない: ${r.error.code}: ${r.error.cause}`);
};

/**
 * 回答の指示を記録（済みなら、その番号を引く）し、未配送なら配送する。記録済みの指示は、同じ requestId・同じ内容の
 * 再追記（重複として最初のイベントを返す）から引く。
 */
async function recordAndDeliver(
  deps: AnswerDeliveryDeps,
  d: DecisionRecord,
  answer: string,
): Promise<Result<"delivered" | "already", Failure>> {
  const text = answerText(d, answer);
  const entry = [{ type: "node.instructed", payload: { nodeId: d.nodeId, text } }] as const;
  const recorded = appendAtomically(
    deps.log,
    deps.clock,
    answerRequestId(d.decisionId),
    SYS,
    entry,
  );
  if (!recorded.ok) return recorded;
  const seq = recorded.value.events[0]?.seq;
  if (seq === undefined) {
    return fail("internal", "記録した指示の番号を取得できない", "もう一度試す");
  }
  if (isDelivered(deps.log.state(), seq)) return { ok: true, value: "already" };
  const sent = await deps.deliver(d.nodeId, text, seq);
  return sent.ok ? { ok: true, value: "delivered" } : sent;
}

/** ログごと・判断 ID ごとに、配送を同時に 1 つだけ走らせる（同じ Promise を共有する）。 */
const inflightByLog = new WeakMap<object, Map<string, Promise<unknown>>>();
function once<T>(log: object, key: string, run: () => Promise<T>): Promise<T> {
  let map = inflightByLog.get(log);
  if (map === undefined) {
    map = new Map();
    inflightByLog.set(log, map);
  }
  const running = map.get(key);
  if (running !== undefined) return running as Promise<T>;
  const m = map;
  const promise = run().finally(() => m.delete(key));
  m.set(key, promise);
  return promise;
}

/** 回答を、判断を出したノードへ届ける。 */
export function deliverAnswer(
  deps: AnswerDeliveryDeps,
  d: DecisionRecord,
  answer: string,
): Promise<AnswerDeliveryOutcome> {
  return once(deps.log, d.decisionId, async (): Promise<AnswerDeliveryOutcome> => {
    const state = stateOf(deps.log.state(), d.nodeId);
    if (state === undefined || NOT_HERE.has(state)) return { kind: "skipped" };
    if (!LIVE.has(state)) {
      addInboxOnce(
        deps,
        d.decisionId,
        d.nodeId,
        "info",
        `判断 ${d.decisionId} の回答は、${state} のノードには届けなかった（回答は記録済み）`,
        "info",
      );
      return { kind: "skipped" };
    }
    if (!deps.canDeliver(d.nodeId)) return { kind: "skipped" }; // 届ける手段がない判断者
    const r = await recordAndDeliver(deps, d, answer);
    if (r.ok) {
      resolveFailure(deps, d.decisionId, d.nodeId);
      return { kind: "delivered" };
    }
    note(deps, d.nodeId, `回答を届けられない: ${r.error.code}: ${r.error.cause}`);
    addInboxOnce(
      deps,
      d.decisionId,
      d.nodeId,
      "failure",
      `判断 ${d.decisionId} の回答は記録済みだが、${d.nodeId} には届いていない（${r.error.code}）。同じ回答をもう一度送ると、届け直す`,
      "failure",
    );
    return { kind: "failed", message: `${d.nodeId}（回答を届けられない: ${r.error.code}）` };
  });
}

/** 停止の途中（stopping・stopIncomplete）の判断者には回答を届けられない。受信箱に info を 1 件出す。 */
export function noteStoppingAnswer(deps: AnswerDeliveryDeps, d: DecisionRecord): void {
  const state = stateOf(deps.log.state(), d.nodeId);
  if (state !== "stopping" && state !== "stopIncomplete") return;
  addInboxOnce(
    deps,
    d.decisionId,
    d.nodeId,
    "info",
    `判断 ${d.decisionId} の回答は、停止の途中（${state}）の ${d.nodeId} には届けなかった（回答は記録済み）`,
    "stopping",
  );
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
  for (const d of deps.log.state().decisions) {
    if (d.status !== "answered" || d.answer === undefined) continue;
    const answer = d.answer;
    if (!alreadyApplied(deps.log.state(), SYS, answerRequestId(d.decisionId))) continue; // 回答の指示を記録していない
    const r = await once(deps.log, d.decisionId, async (): Promise<RecoveredAnswer | undefined> => {
      const state = stateOf(deps.log.state(), d.nodeId);
      if (state === undefined || !LIVE.has(state) || !deps.canDeliver(d.nodeId)) {
        // 届けられない。すでに配送済みなら、何もしない。
        const check = appendAtomically(deps.log, deps.clock, answerRequestId(d.decisionId), SYS, [
          { type: "node.instructed", payload: { nodeId: d.nodeId, text: answerText(d, answer) } },
        ]);
        const seq = check.ok ? check.value.events[0]?.seq : undefined;
        if (seq !== undefined && isDelivered(deps.log.state(), seq)) return undefined;
        addInboxOnce(
          deps,
          d.decisionId,
          d.nodeId,
          "failure",
          `判断 ${d.decisionId} の回答は記録済みだが、${d.nodeId} には届いていない（子のセッションが失われた）。子を再起動して、回答をもう一度指示する`,
          "failure",
        );
        return { nodeId: d.nodeId, result: "unavailable" };
      }
      const sent = await recordAndDeliver(deps, d, answer);
      if (!sent.ok) {
        note(deps, d.nodeId, `回答を届けられない: ${sent.error.code}: ${sent.error.cause}`);
        return { nodeId: d.nodeId, result: "failed" };
      }
      if (sent.value === "already") return undefined;
      resolveFailure(deps, d.decisionId, d.nodeId);
      return { nodeId: d.nodeId, result: "delivered" };
    });
    if (r !== undefined) out.push(r);
  }
  return out;
}
