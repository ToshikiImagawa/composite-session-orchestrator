/**
 * 追加指示の配送（アダプタへ渡し、成功したら `node.instructionDelivered` を記録する）。`node.send` と、差し戻しの
 * feedback（`node.review`）が使う。配送の記録は指示ごとに 1 回（`deliveredSeq`）。
 *
 * - 配送の失敗は、そのまま返す（記録済みの指示は残り、同じ要求の再送で、未配送のときだけ送り直す）。
 * - 送ったあとの配送の記録に失敗したら、送信は成功として返す（記録されないので、再送で重複して届きうる＝少なくとも 1 回）。
 *   失敗は `onFailure` に残す。
 */

import { type Failure, failure, type OrchState, type Result } from "@cso/core";
import type { RuntimeAdapter } from "../../sdk/runtime.js";
import { appendAtomically, type LogPort } from "./context.js";

export interface InstructionDelivery {
  /** 子へ届ける手段（アダプタ）があるか。ない子には、記録する前に失敗させる。 */
  available(nodeId: string): boolean;
  /** 指示（`node.instructed` の `seq`）を子へ届け、成功したら配送を記録する。 */
  deliver(nodeId: string, text: string, instructedSeq: number): Promise<Result<undefined, Failure>>;
}

export interface InstructionDeliveryDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  readonly adapterFor: (nodeId: string) => RuntimeAdapter | undefined;
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

/** 指示が配送済みか（記録がなければ、未配送として扱う）。 */
export const isDelivered = (state: OrchState, instructedSeq: number): boolean =>
  state.instructions.find((i) => i.seq === instructedSeq)?.deliveredSeq !== undefined;

export function createInstructionDelivery(deps: InstructionDeliveryDeps): InstructionDelivery {
  return {
    available: (nodeId) => deps.adapterFor(nodeId) !== undefined,
    async deliver(nodeId, text, instructedSeq) {
      const adapter = deps.adapterFor(nodeId);
      if (adapter === undefined) {
        return {
          ok: false,
          error: failure(
            "noRuntime",
            `ノード ${nodeId} のランタイム（アダプタ）が見つからない`,
            "ノードの状態を確認する",
          ),
        };
      }
      const sent = await adapter.send(nodeId, text);
      if (!sent.ok) return sent;
      const recorded = appendAtomically(
        deps.log,
        deps.clock,
        `instruction-delivered-${instructedSeq}`,
        { system: true },
        [{ type: "node.instructionDelivered", payload: { instructedSeq } }],
      );
      if (!recorded.ok) {
        try {
          deps.onFailure?.(
            nodeId,
            `配送を記録できない: ${recorded.error.code}: ${recorded.error.cause}`,
          );
        } catch {
          // 記録先の失敗は、処理を止めない
        }
      }
      return { ok: true, value: undefined };
    },
  };
}
