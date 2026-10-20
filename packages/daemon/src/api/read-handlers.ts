/**
 * 読み取りだけの操作（`decision.get`・`report.get`）の実体。受信箱の項目の参照 ID（`ref`）から、判断要求の内容と
 * 報告の本文を返す。読める範囲（部分木）の判定は認可（`authorize`）で済んでいる前提。状態は変えない。
 */

import { failure, type OperationMap, type OrchState, type Result } from "@cso/core";
import type { HandlerRequest } from "./server.js";

type Failure = ReturnType<typeof failure>;
const notFound = (what: string): { ok: false; error: Failure } => ({
  ok: false,
  error: failure(
    "notFound",
    `${what}が見つからない`,
    "ID を確認する",
    "受信箱の参照 ID（ref）を確認する",
  ),
});

export function createReadHandlers(getState: () => OrchState) {
  return {
    "decision.get": (
      req: HandlerRequest<"decision.get">,
    ): Result<OperationMap["decision.get"]["result"], Failure> => {
      const d = getState().decisions.find((x) => x.decisionId === req.params.decisionId);
      if (d === undefined) return notFound("判断要求");
      return {
        ok: true,
        value: {
          decisionId: d.decisionId,
          nodeId: d.nodeId,
          status: d.status,
          ...(d.question === undefined ? {} : { question: d.question }),
          ...(d.options === undefined ? {} : { options: [...d.options] }),
          ...(d.answer === undefined ? {} : { answer: d.answer }),
        },
      };
    },
    "report.get": (
      req: HandlerRequest<"report.get">,
    ): Result<OperationMap["report.get"]["result"], Failure> => {
      const r = getState().reports.find((x) => x.reportId === req.params.reportId);
      if (r === undefined) return notFound("報告");
      return {
        ok: true,
        value: {
          reportId: r.reportId,
          nodeId: r.nodeId,
          kind: r.kind,
          text: r.text,
          ...(r.evidence === undefined ? {} : { evidence: r.evidence.map((e) => ({ ...e })) }),
        },
      };
    },
  } as const;
}
