/**
 * イベントログだけで完結する操作の実体（アダプタを使わない）: 一覧表・受信箱の取得、子の報告、判断要求と回答、
 * 完了の判定。権限と部分木の判定は、認可（`authorize`）で済んでいる前提で、ここでは状態の整合を確かめる。
 * PRD: FR_011, FR_012, FR_018, FR_019, FR_020, FR_022, FR_024
 *
 * - 受信箱・一覧は、呼び出した統合ノードの部分木に絞る（`visibleState`）。
 * - 複数イベントの操作は、事前に全体を検査してから追記する（`appendAtomically`）。再試行は冪等。
 * - 子の報告は、動作中（running・waiting・stopping）のノードだけ。
 * - `decision.present` の `pauseNodeIds`（子の一時停止）は、`allowPause` のときだけ受け付ける（止める・再開するのは `pause-handlers`）。
 */

import {
  type EventBody,
  type Failure,
  type NodeState,
  type OperationMap,
  type OrchState,
  type Result,
  stateOf,
  unresolvedInbox,
  visibleState,
} from "@cso/core";
import type { HandlerRequest } from "../server.js";
import {
  alreadyApplied,
  appendAtomically,
  deriveId,
  fail,
  type LogPort,
  summarize,
} from "./context.js";
import { createExclusive } from "./inflight.js";
import { type InstructionDelivery, isDelivered } from "./instruction-delivery.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

export interface StateHandlerDeps {
  readonly log: LogPort;
  /** イベントの時刻（ISO 8601 UTC）。事前検査にも使う。 */
  readonly clock: () => string;
  /**
   * `decision.present` の `pauseNodeIds`（子の一時停止）を受け付ける。止める操作と、回答での再開は、`pause-handlers`
   * が包んで行う。包まないときは false のまま（記録だけして止めない・再開しない、を避けるため notSupported）。
   */
  readonly allowPause?: boolean;
  /** 差し戻しの理由（追加指示）を子へ届ける。省略すると、記録だけを行う。 */
  readonly deliver?: InstructionDelivery["deliver"];
  /** 届ける手段（アダプタ）があるか。`deliver` を渡すときは、差し戻しを記録する前に確かめる。 */
  readonly canDeliver?: InstructionDelivery["available"];
}

const ACTIVE: ReadonlySet<NodeState> = new Set(["running", "waiting", "stopping"]);

const callerOf = (req: HandlerRequest): string => req.caller?.nodeId ?? "";

export function createStateHandlers(deps: StateHandlerDeps) {
  const { log, clock } = deps;
  const exclusive = createExclusive();

  const notActive = (nodeId: string, state: NodeState | undefined) =>
    fail(
      "notActive",
      `ノード ${nodeId} は ${state ?? "不明"} で、報告できない（running・waiting・stopping のとき）`,
      "状態を確認する",
    );

  /** 報告の保存と、受信箱の項目。 */
  const reportOnly =
    (kind: "progress" | "outOfScope", inboxKind: "progress" | "info") =>
    (req: HandlerRequest<"report.progress" | "report.outOfScope">): R<"report.progress"> => {
      const caller = callerOf(req);
      const state = log.state();
      if (
        !alreadyApplied(state, { nodeId: caller }, req.requestId) &&
        !ACTIVE.has(stateOf(state, caller) as NodeState)
      ) {
        return notActive(caller, stateOf(state, caller));
      }
      const reportId = deriveId("report", caller, req.requestId, "report");
      const text = req.params.text;
      const bodies: EventBody[] = [
        { type: "report.added", payload: { reportId, nodeId: caller, kind, text } },
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", caller, req.requestId, "inbox"),
            kind: inboxKind,
            nodeId: caller,
            summary: summarize(text),
            ref: reportId,
          },
        },
      ];
      const r = appendAtomically(log, clock, req.requestId, { nodeId: caller }, bodies);
      return r.ok ? { ok: true, value: { accepted: true } } : r;
    };

  const reviewOnce = async (req: HandlerRequest<"node.review">): Promise<R<"node.review">> => {
    const caller = callerOf(req);
    const { nodeId, verdict } = req.params;
    // 認可（directChild）の二重の備え: 完了の判定は、そのノードの親だけ。
    if (log.state().nodes.find((n) => n.id === nodeId)?.parentId !== caller) {
      return fail(
        "forbidden",
        "完了の判定は、そのノードの親（統合ノード）だけができる",
        "親の統合ノードに依頼する",
      );
    }
    // 差し戻しの理由を届ける手段がなければ、記録する前に失敗させる（記録だけが残らないように）。
    if (
      req.params.verdict === "reject" &&
      deps.deliver !== undefined &&
      deps.canDeliver?.(nodeId) === false
    ) {
      return fail(
        "noRuntime",
        `ノード ${nodeId} のランタイム（アダプタ）が見つからず、差し戻しの理由を届けられない`,
        "ノードの状態を確認する",
      );
    }
    const bodies: EventBody[] = [
      {
        type: "node.stateChanged",
        payload: { nodeId, event: { type: verdict === "accept" ? "accept" : "reject" } },
      },
    ];
    // 受理の feedback は、報告（`review`）として記録する。差し戻しの理由は、再開した子への追加指示として記録する。
    if (req.params.verdict === "accept" && req.params.feedback !== undefined) {
      bodies.push({
        type: "report.added",
        payload: {
          reportId: deriveId("report", caller, req.requestId, "review"),
          nodeId,
          kind: "review",
          text: req.params.feedback,
        },
      });
    }
    if (req.params.verdict === "reject") {
      bodies.push({ type: "node.instructed", payload: { nodeId, text: req.params.feedback } });
    }
    const r = appendAtomically(log, clock, req.requestId, { nodeId: caller }, bodies);
    if (!r.ok) return r;
    // 差し戻しの理由を、再開した子へ届ける（未配送のときだけ。再送で、送り直せる）。
    if (req.params.verdict === "reject" && deps.deliver !== undefined) {
      const seq = r.value.events[1]?.seq;
      if (seq !== undefined && !isDelivered(r.value.state, seq)) {
        const sent = await deps.deliver(nodeId, req.params.feedback, seq);
        if (!sent.ok) return sent;
      }
    }
    return { ok: true, value: { state: stateOf(r.value.state, nodeId) as NodeState } };
  };

  return {
    "tree.list": (req: HandlerRequest<"tree.list">): R<"tree.list"> => {
      const v = visibleState(log.state(), callerOf(req));
      const rows = v.nodes.map((n) => [
        n.id,
        n.role,
        n.state,
        n.parentId ?? "-",
        n.dependsOn.length === 0 ? "-" : n.dependsOn.join(","),
      ]);
      const header = ["id", "role", "state", "parent", "dependsOn"];
      const widths = header.map((h, i) =>
        Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
      );
      const line = (cells: readonly string[]): string =>
        `| ${cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join(" | ")} |`;
      const sep = `|${widths.map((w) => "-".repeat(w + 2)).join("|")}|`;
      return { ok: true, value: { table: [line(header), sep, ...rows.map(line)].join("\n") } };
    },

    "inbox.fetch": (req: HandlerRequest<"inbox.fetch">): R<"inbox.fetch"> => {
      const since = req.params.sinceSeq ?? 0;
      // 解決済み（inbox.resolved）の項目は返さない（記録には残る）。
      const items = unresolvedInbox(visibleState(log.state(), callerOf(req)).inbox)
        .filter((i) => i.seq > since)
        .sort((a, b) => a.seq - b.seq);
      return { ok: true, value: { items } };
    },

    "report.progress": reportOnly("progress", "progress") as (
      req: HandlerRequest<"report.progress">,
    ) => R<"report.progress">,
    "report.outOfScope": reportOnly("outOfScope", "info") as (
      req: HandlerRequest<"report.outOfScope">,
    ) => R<"report.outOfScope">,

    "report.done": (req: HandlerRequest<"report.done">): R<"report.done"> => {
      const caller = callerOf(req);
      // 根拠は 1 件以上必須。ブリーフ（受け入れ基準）を持つノードは、すべての基準に根拠が要る。
      const criteria = log.state().nodes.find((n) => n.id === caller)?.acceptanceCriteria ?? [];
      const norm = (t: string): string => t.normalize("NFC").trim();
      const usable = req.params.evidence.filter((e) => norm(e.evidence) !== "");
      const covered = new Set(usable.map((e) => norm(e.criterion)));
      const missing: string[] = criteria.filter((c) => !covered.has(norm(c)));
      if (
        req.params.evidence.length === 0 ||
        usable.length !== req.params.evidence.length ||
        missing.length > 0
      ) {
        return fail(
          "evidenceRequired",
          missing.length > 0
            ? `完了報告には、すべての受け入れ基準の根拠が要る。根拠がない基準: ${missing.join("、")}`
            : "完了報告には、受け入れ基準ごとの根拠（テスト名・実行結果・コミットなど）が 1 件以上要る",
          "基準ごとに根拠（criterion に基準の文言そのまま）を添えて報告し直す",
        );
      }

      const reportId = deriveId("report", caller, req.requestId, "report");
      const evidence = req.params.evidence.map((e) => ({ ...e }));
      const bodies: EventBody[] = [
        {
          type: "report.added",
          payload: {
            reportId,
            nodeId: caller,
            kind: "done",
            text: `完了報告（根拠 ${evidence.length} 件）`,
            ...(evidence.length > 0 ? { evidence } : {}),
          },
        },
        { type: "node.stateChanged", payload: { nodeId: caller, event: { type: "reportDone" } } },
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", caller, req.requestId, "inbox"),
            kind: "done",
            nodeId: caller,
            summary: summarize(`完了報告（根拠 ${evidence.length} 件）`),
            ref: reportId,
          },
        },
      ];
      const r = appendAtomically(log, clock, req.requestId, { nodeId: caller }, bodies);
      return r.ok ? { ok: true, value: { accepted: true } } : r;
    },

    "report.decision": (req: HandlerRequest<"report.decision">): R<"report.decision"> => {
      const caller = callerOf(req);
      const decisionId = deriveId("decision", caller, req.requestId, "decision");
      const bodies: EventBody[] = [
        {
          type: "decision.requested",
          payload: {
            decisionId,
            nodeId: caller,
            question: req.params.question,
            options: [...req.params.options],
          },
        },
        {
          type: "node.stateChanged",
          payload: { nodeId: caller, event: { type: "requestDecision" } },
        },
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", caller, req.requestId, "inbox"),
            kind: "decision",
            nodeId: caller,
            summary: summarize(req.params.question),
            ref: decisionId,
          },
        },
      ];
      const r = appendAtomically(log, clock, req.requestId, { nodeId: caller }, bodies);
      return r.ok ? { ok: true, value: { decisionId } } : r;
    },

    "decision.present": (req: HandlerRequest<"decision.present">): R<"decision.present"> => {
      const pauseNodeIds = req.params.pauseNodeIds ?? [];
      if (pauseNodeIds.length > 0 && deps.allowPause !== true) {
        return fail(
          "notSupported",
          "pauseNodeIds（子の一時停止）は、再開の記録先がないため、まだ使えない",
          "pauseNodeIds を省略して判断要求だけを出す",
          "止めたい子は node.stop で止める",
        );
      }
      const caller = callerOf(req);
      const decisionId = deriveId("decision", caller, req.requestId, "decision");
      const bodies: EventBody[] = [
        {
          type: "decision.requested",
          payload: {
            decisionId,
            nodeId: caller,
            question: req.params.question,
            options: [...req.params.options],
            ...(pauseNodeIds.length > 0 ? { pauseNodeIds: [...pauseNodeIds] } : {}),
          },
        },
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", caller, req.requestId, "inbox"),
            kind: "decision",
            nodeId: caller,
            summary: summarize(req.params.question),
            ref: decisionId,
          },
        },
      ];
      const r = appendAtomically(log, clock, req.requestId, { nodeId: caller }, bodies);
      return r.ok ? { ok: true, value: { decisionId } } : r;
    },

    "decision.answer": (req: HandlerRequest<"decision.answer">): R<"decision.answer"> => {
      const state: OrchState = log.state();
      const p = req.params as { decisionId: string; choice?: string; text?: string };
      const d = state.decisions.find((x) => x.decisionId === p.decisionId);
      if (d === undefined) {
        return fail(
          "notFound",
          "判断要求が見つからない",
          "ID を確認する",
          "受信箱の参照 ID（ref）を確認する",
        );
      }
      const answer = p.choice ?? p.text ?? "";
      if (p.choice !== undefined && d.options !== undefined && !d.options.includes(p.choice)) {
        return fail(
          "choiceNotInOptions",
          `選択肢にない回答: ${p.choice}`,
          "選択肢から選ぶ",
          "自由入力（text）で答える",
        );
      }
      const retry = alreadyApplied(state, { human: true }, req.requestId);
      if (d.status === "answered" && !retry && d.answer === answer) {
        // 採用済みの回答と同じ内容の重複は、成功として返し、却下を記録しない。
        return { ok: true, value: { accepted: true } };
      }
      if (d.status === "answered" && !retry) {
        // 後から来た回答は採用しない。却下として記録し、採用された回答を伝える（FR_019）。
        appendAtomically(log, clock, req.requestId, { human: true }, [
          { type: "decision.answered", payload: { decisionId: d.decisionId, answer } },
        ]);
        return fail(
          "alreadyAnswered",
          `既に回答されている（採用された回答: ${d.answer ?? ""}）`,
          "採用された回答を確認する（decision.get）",
        );
      }
      if (retry && d.answer !== answer) {
        return fail(
          "alreadyAnswered",
          `既に別の回答が採用されている（採用された回答: ${d.answer ?? ""}）`,
          "採用された回答を確認する（decision.get）",
        );
      }
      const waiting = stateOf(state, d.nodeId) === "waiting";
      // 再試行でも同じ番号になるよう、任意の再開は最後に置く。
      const bodies: EventBody[] = [
        { type: "decision.answered", payload: { decisionId: d.decisionId, answer } },
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", "human", req.requestId, "inbox"),
            kind: "answer",
            nodeId: d.nodeId,
            summary: summarize(answer),
            ref: d.decisionId,
          },
        },
        ...(waiting
          ? ([
              {
                type: "node.stateChanged",
                payload: { nodeId: d.nodeId, event: { type: "resume" } },
              },
            ] as const)
          : []),
      ];
      const r = appendAtomically(log, clock, req.requestId, { human: true }, bodies);
      return r.ok ? { ok: true, value: { accepted: true } } : r;
    },

    // 同じ requestId の同時の判定は、1 つにまとめる（配送が 1 回だけになる）。
    "node.review": (req: HandlerRequest<"node.review">): Promise<R<"node.review">> =>
      exclusive(`${callerOf(req)}\0${req.requestId}`, JSON.stringify(req.params), () =>
        reviewOnce(req),
      ),
  };
}
