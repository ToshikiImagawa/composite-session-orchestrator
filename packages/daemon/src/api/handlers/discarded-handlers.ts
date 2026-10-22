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
import { ownedBy, ownerBaseOf } from "../../discarded-keys.js";
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
  /** 保管の鍵 → その保管を持つノード（まだ存在するノードだけ）。持ち主の判定は、`ownerBaseOf`（鍵の形の判定）だけを使う。 */
  const nodeOfKey = (key: string): string | undefined => {
    const owner = ownerBaseOf(key);
    if (owner === undefined) return undefined;
    return deps.state().nodes.find((n) => ports.discardedKeyOf(n.id) === owner)?.id;
  };
  /**
   * `target`（保管の鍵か、ノード ID）を、保管 1 件に決める。鍵が一覧にあれば、それ。なければ、存在するノードの ID として、そのノードの保管を探す。
   * 複数あれば `multipleKept`（鍵を指定させる）、なければ `notFound`。
   */
  const resolve = async (
    target: string,
  ): Promise<Result<{ key: string; tip: string }, Failure>> => {
    const listed = await ports.discardedList();
    if (!listed.ok) return listed;
    const exact = listed.value.items.find((i) => i.key === target);
    if (exact !== undefined) return { ok: true, value: { key: exact.key, tip: exact.tip } };
    if (!deps.state().nodes.some((n) => n.id === target)) {
      return fail("notFound", "その保管はない", "cso discarded list で名前を確かめる");
    }
    const mine = new Set([ports.discardedKeyOf(target)]);
    const owned = listed.value.items.filter((i) => ownedBy(i.key, mine));
    if (owned.length === 0) {
      return fail("notFound", "そのノードの保管はない", "cso discarded list で名前を確かめる");
    }
    if (owned.length > 1) {
      return fail(
        "multipleKept",
        `ノード ${target} の保管が複数ある（${owned.map((i) => i.key).join("、")}）`,
        "cso discarded list で確かめて、鍵（key）を指定する",
      );
    }
    const only = owned[0] as { key: string; tip: string };
    return { ok: true, value: { key: only.key, tip: only.tip } };
  };

  return {
    "node.discardedList": async (
      req: HandlerRequest<"node.discardedList">,
    ): Promise<R<"node.discardedList">> => {
      const denied = humanOnly(req.role);
      if (denied) return denied;
      const listed = await ports.discardedList();
      if (!listed.ok) return listed;
      return {
        ok: true,
        value: {
          max: listed.value.max,
          items: listed.value.items.map((i) => {
            const nodeId = nodeOfKey(i.key);
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
      const one = await resolve(req.params.target);
      if (!one.ok) return one;
      const r = await ports.discardedRestore({
        key: one.value.key,
        ...(req.params.branch === undefined ? {} : { branch: req.params.branch }),
      });
      if (r.ok) audit("discardedRestored", { key: one.value.key, tip: r.value.tip });
      return r;
    },

    "node.discardedDrop": async (
      req: HandlerRequest<"node.discardedDrop">,
    ): Promise<R<"node.discardedDrop">> => {
      const denied = humanOnly(req.role);
      if (denied) return denied;
      const one = await resolve(req.params.target);
      if (!one.ok) return one;
      const r = await ports.discardedDrop(one.value.key, req.params.expectTip);
      if (!r.ok) return r;
      audit("discardedDropped", { key: one.value.key, tip: r.value.tip });
      return { ok: true, value: { dropped: true, key: r.value.key, tip: r.value.tip } };
    },
  };
}
