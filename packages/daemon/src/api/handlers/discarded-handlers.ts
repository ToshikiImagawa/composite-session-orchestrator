/**
 * 保管している、破棄した成果の操作（T13f-r）: 一覧（`node.discardedList`）・取り出し（`node.discardedRestore`）・消去（`node.discardedDrop`）。
 * 人間だけ（認可でも拒否するが、ハンドラでも `human` を確かめる）。`docs/discarded-work.md`
 *
 * - 保管は、git の `refs/cso/discarded/<key>`。`<key>` は、ノード ID から導く名前（`discardedKeyOf`）。`target` は、ノード ID か `<key>`。
 * - コミットの件名は、コミットメッセージ由来の**信頼できない入力**。他の信頼できない文字列と同じサニタイズをかけて返す。
 * - 取り出しは、作成だけ（既存のブランチは上書きしない）。保管は残る。
 */

import {
  type Failure,
  LIMITS,
  type OperationMap,
  type OrchState,
  type Result,
  sanitizeText,
} from "@cso/core";
import type { GitPorts } from "../../git-ports.js";
import type { HandlerRequest } from "../server.js";
import { fail } from "./context.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

export type DiscardedPorts = Pick<
  GitPorts,
  "discardedList" | "discardedKeyOf" | "discardedRestore" | "discardedDrop"
>;

export interface DiscardedHandlerDeps {
  readonly state: () => OrchState;
  readonly ports: DiscardedPorts;
  /** 監査の記録。例外を外へ出さない扱いで呼ぶ。 */
  readonly audit?: (event: string, data: Record<string, unknown>) => void;
}

const KEY_SUFFIX = /-[0-9a-f]{12}$/;

export function createDiscardedHandlers(deps: DiscardedHandlerDeps) {
  const { ports } = deps;
  const humanOnly = (role: string): Result<never, Failure> | undefined =>
    role === "human"
      ? undefined
      : fail(
          "forbidden",
          "保管した成果の操作は、人間のコマンドだけが実行できる",
          "人間用のコマンド（cso discarded）を使う",
        );
  const audit = (event: string, data: Record<string, unknown>): void => {
    try {
      deps.audit?.(event, data);
    } catch {
      // 記録先の失敗は、処理を止めない
    }
  };
  /** `target`（ノード ID か `<key>`）を、保管の鍵にする。存在するノードの ID なら、そのノードの鍵。 */
  const keyOf = (target: string): string =>
    deps.state().nodes.some((n) => n.id === target) ? ports.discardedKeyOf(target) : target;

  return {
    "node.discardedList": async (
      req: HandlerRequest<"node.discardedList">,
    ): Promise<R<"node.discardedList">> => {
      const denied = humanOnly(req.role);
      if (denied) return denied;
      const listed = await ports.discardedList();
      if (!listed.ok) return listed;
      const byBase = new Map<string, string>();
      for (const n of deps.state().nodes) byBase.set(ports.discardedKeyOf(n.id), n.id);
      return {
        ok: true,
        value: {
          max: listed.value.max,
          items: listed.value.items.map((i) => {
            const nodeId = byBase.get(i.key) ?? byBase.get(i.key.replace(KEY_SUFFIX, ""));
            return {
              key: i.key,
              tip: i.tip,
              orphan: nodeId === undefined,
              ...(nodeId === undefined ? {} : { nodeId }),
              ...(i.committedAt === undefined ? {} : { committedAt: i.committedAt }),
              ...(i.subject === undefined
                ? {}
                : {
                    untrustedSubject: sanitizeText(
                      i.subject.replace(/\s+/g, " ").trim(),
                      LIMITS.lossSubjectLength,
                    ),
                  }),
            };
          }),
        },
      };
    },

    "node.discardedRestore": async (
      req: HandlerRequest<"node.discardedRestore">,
    ): Promise<R<"node.discardedRestore">> => {
      const denied = humanOnly(req.role);
      if (denied) return denied;
      const r = await ports.discardedRestore({
        key: keyOf(req.params.target),
        ...(req.params.branch === undefined ? {} : { branch: req.params.branch }),
      });
      if (r.ok) audit("discardedRestored", { key: keyOf(req.params.target), tip: r.value.tip });
      return r;
    },

    "node.discardedDrop": async (
      req: HandlerRequest<"node.discardedDrop">,
    ): Promise<R<"node.discardedDrop">> => {
      const denied = humanOnly(req.role);
      if (denied) return denied;
      const key = keyOf(req.params.target);
      const r = await ports.discardedDrop(key);
      if (!r.ok) return r;
      audit("discardedDropped", { key, tip: r.value.tip });
      return { ok: true, value: { dropped: true, key: r.value.key, tip: r.value.tip } };
    },
  };
}
