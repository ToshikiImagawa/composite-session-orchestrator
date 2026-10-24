/**
 * フックの受け口（`POST /v1/hook`）の session_id の結び付けを外す操作（`node.hookUnbind`。T22-hu）。
 * PRD: FR_014, IR_002 / `docs/plugin.md` の「フック」
 *
 * - 人間と、祖先の統合ノード（自分を含まない子孫が対象）だけ。子のトークンは、操作の表（ROLE_OPERATIONS）にないので、窓口で 403。
 *   本人が外せると、盗まれたトークンで外して、別のセッションで結び直せてしまう。
 * - 記録（`node.hookUnbound`。外した者は actor）に成功してから外す（記録できなければ、外さない）。記録と外す処理は同期の処理の
 *   中で続けて行うので、その間に別のセッションが結ぶことはない。session_id は記録に書かない。
 * - 同じ requestId の再送は、もう一度は外さない（再送のあいだに結んだ、新しいセッションを外さないため）。結果は `unbound: false`。
 */

import { type Failure, isStrictDescendant, type OperationMap, type Result } from "@cso/core";
import type { SessionBinder } from "../hook.js";
import type { HandlerRequest } from "../server.js";
import { alreadyApplied, derivedRequestId, fail, type LogPort } from "./context.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

export interface HookHandlerDeps {
  readonly log: LogPort;
  readonly sessions: SessionBinder;
}

export function createHookHandlers(deps: HookHandlerDeps) {
  const { log, sessions } = deps;
  return {
    "node.hookUnbind": (req: HandlerRequest<"node.hookUnbind">): R<"node.hookUnbind"> => {
      const { nodeId } = req.params;
      const human = req.role === "human";
      const caller = req.caller?.nodeId ?? "";
      const state = log.state();
      if (!human && !isStrictDescendant(state.nodes, caller, nodeId)) {
        return fail(
          "forbidden",
          "対象のノードが、自分の部分木の規則（自分を含まない子孫）を満たさない",
          "親（統合ノード）か人間に依頼する",
        );
      }
      if (!state.nodes.some((n) => n.id === nodeId)) {
        return fail("notFound", "ノードが見つからない", "ID を確認する");
      }
      const actor = human ? ({ human: true } as const) : { nodeId: caller };
      if (alreadyApplied(state, actor, req.requestId))
        return { ok: true, value: { unbound: false } };
      const hadBinding = sessions.has(nodeId);
      const r = log.append({
        requestId: derivedRequestId(actor, req.requestId, 0),
        actor,
        body: { type: "node.hookUnbound", payload: { nodeId, hadBinding } },
      });
      if (!r.ok) return fail(r.error.code, r.error.cause, ...r.error.nextActions);
      return { ok: true, value: { unbound: sessions.unbind(nodeId) } };
    },
  };
}
