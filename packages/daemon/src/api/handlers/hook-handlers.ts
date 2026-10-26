/**
 * フックの受け口（`POST /v1/hook`）の session_id の結び付けを外す操作（`node.hookUnbind`。T22-hu）。
 * PRD: FR_014, IR_002 / `docs/plugin.md` の「フック」
 *
 * - 人間と、祖先の統合ノード（自分を含まない子孫が対象）だけ。子のトークンは、操作の表（ROLE_OPERATIONS）にないので、窓口で 403。
 *   本人が外せると、盗まれたトークンで外して、別のセッションで結び直せてしまう。
 * - 記録（`node.hookUnbound`。外した者は actor）に成功してから外す（記録できなければ、外さない）。記録と外す処理は同期の処理の
 *   中で続けて行うので、その間に別のセッションが結ぶことはない。session_id は記録に書かない。
 * - 同じ requestId の再送は、もう一度は外さない（再送のあいだに結んだ、新しいセッションを外さないため）。結果は `{ unbound: false, duplicate: true }`。
 */

import {
  type Failure,
  isStrictDescendant,
  type OperationMap,
  type Result,
  stateOf,
} from "@cso/core";
import type { HookTokens, SessionBinder } from "../hook.js";
import type { HandlerRequest } from "../server.js";
import { alreadyApplied, derivedRequestId, fail, type LogPort } from "./context.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

export interface HookHandlerDeps {
  readonly log: LogPort;
  readonly sessions: SessionBinder;
  /** フック専用のトークン（T22-ht）。`childRuntime: "cli"` のときだけ渡す（省略すると `node.hookToken` は notCli）。 */
  readonly hookTokens?: HookTokens;
  /** daemon が管理している（起動した）子か。 */
  readonly managed?: (nodeId: string) => boolean;
  /** 窓口の URL（待ち受けの前は undefined）。 */
  readonly baseUrl?: () => string | undefined;
}

const LIVE = new Set(["running", "waiting"]);

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
        return { ok: true, value: { unbound: false, duplicate: true } };
      const hadBinding = sessions.has(nodeId);
      const r = log.append({
        requestId: derivedRequestId(actor, req.requestId, 0),
        actor,
        body: { type: "node.hookUnbound", payload: { nodeId, hadBinding } },
      });
      if (!r.ok) return fail(r.error.code, r.error.cause, ...r.error.nextActions);
      return { ok: true, value: { unbound: sessions.unbind(nodeId), duplicate: false } };
    },

    /**
     * 手動の CLI セッション用の、フック専用のトークン（T22-ht）。人間だけ（操作の表で、統合ノード・子は 403。ここでも確かめる）。
     * 記録（`node.hookTokenIssued`。トークンは書かない）に成功してから発行し、古いフック用トークンを無効にして、結び付けを外す。
     * 同じ requestId の再送は、新しいトークンを発行する（トークンを保存しないので、前の応答を返せない。記録は 1 回）。
     */
    "node.hookToken": (req: HandlerRequest<"node.hookToken">): R<"node.hookToken"> => {
      const { nodeId } = req.params;
      if (req.role !== "human") {
        return fail(
          "forbidden",
          "フック専用のトークンは、人間だけが発行できる",
          "人間のトークンで呼び出す",
        );
      }
      const tokens = deps.hookTokens;
      if (tokens === undefined) {
        return fail(
          "notCli",
          "この木の子は CLI の子ではない（設定 childRuntime が cli のときだけ）",
          "Desktop の子の紐付けは node.bindCode を使う",
        );
      }
      const state = log.state();
      const node = state.nodes.find((n) => n.id === nodeId);
      if (node === undefined) return fail("notFound", "ノードが見つからない", "ID を確認する");
      if (node.role === "integrator") {
        return fail(
          "integratorNotSupported",
          `ノード ${nodeId} は統合ノードで、フック専用のトークンは発行できない（子だけ）`,
          "作業の子のノード ID を指定する",
        );
      }
      const s = stateOf(state, nodeId);
      if (s === undefined || !LIVE.has(s)) {
        return fail(
          "notActive",
          `ノード ${nodeId} は ${String(s)} で、発行できない（running・waiting のとき）`,
          "ノードの状態を確認する",
        );
      }
      if (deps.managed !== undefined && !deps.managed(nodeId)) {
        return fail(
          "notManaged",
          `ノード ${nodeId} を、daemon が管理していない（daemon の再起動のあとなど。範囲と作業ツリーがない）`,
          "ノードの状態を確認する",
        );
      }
      const daemonUrl = deps.baseUrl?.();
      if (daemonUrl === undefined) {
        return fail("unavailable", "窓口がまだ待ち受けていない", "少し待って、もう一度呼び出す");
      }
      const actor = { human: true } as const;
      if (!alreadyApplied(state, actor, req.requestId)) {
        const r = log.append({
          requestId: derivedRequestId(actor, req.requestId, 0),
          actor,
          body: { type: "node.hookTokenIssued", payload: { nodeId } },
        });
        if (!r.ok) return fail(r.error.code, r.error.cause, ...r.error.nextActions);
      }
      // 古いトークンを無効にしてから（issue が置き換える）、同じ同期の処理の中で結び付けを外す
      const token = tokens.issue(nodeId);
      sessions.unbind(nodeId);
      return { ok: true, value: { token, nodeId, daemonUrl } };
    },
  };
}
