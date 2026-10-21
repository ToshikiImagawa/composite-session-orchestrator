/**
 * 範囲の拡張の操作の実体: 要求（`scope.extend`。子）と判定（`scope.decide`。統合ノード）。
 * PRD: FR_015 / spec 5.5
 *
 * - `scope.extend`: 要求（`scope.extensionRequested`）と、親の受信箱の項目（`violation`。次の操作は `scope_decide`。拡張要求の ID は要約に入れる）を 1 トランザクションで
 *   記録する。対象の書き込み先は、作業ツリーの内側の相対パスに限る（絶対パス・`..`・`/` は、何も記録せずに拒否）。未判定の
 *   上限（10 件。`tooManyOpenExtensions`）と、要求できる状態（running・waiting）は core が判定する。
 * - `scope.decide`: 判定（`scope.extensionDecided`）を記録する。承認（approve）は、記録の前に、拡張後の範囲が作業ツリーの
 *   規則を満たす（`validateScope`）こと、親の範囲に収まる（`isScopeSubset`。ブリーフのない親は `rootScope`）ことを確かめ、
 *   許可した対象（要求と同じもの）を記録してから、有効な範囲（`effectiveScope`）でアダプタを更新する（`updateScope`）。
 *   更新に失敗したら、判定は記録済みのまま、受信箱に `failure` を出して失敗を返す（同じ要求の再送で、更新をやり直す）。
 *   却下・切り出し（reject・split）は記録だけ。判定の対象のノードの祖先（自分を含まない）だけが判定できる。
 */

import {
  type EventBody,
  type ExtensionRecord,
  effectiveScope,
  type Failure,
  isScopeSubset,
  isStrictDescendant,
  type NodeState,
  type OperationMap,
  type Result,
  type Scope,
  stateOf,
  validateScope,
} from "@cso/core";
import type { RuntimeAdapter } from "../../sdk/runtime.js";
import type { HandlerRequest } from "../server.js";
import { appendAtomically, deriveId, fail, type LogPort, summarize } from "./context.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

export interface ScopeHandlerDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  readonly adapterFor: (nodeId: string) => RuntimeAdapter | undefined;
  /** ノードの作業ツリー（実パス）。アダプタ側を正とする。取得できなければ `undefined`（承認しない＝安全側）。 */
  readonly cwdOf: (nodeId: string) => Promise<string | undefined>;
  /** ブリーフのない親（根など）の有効な範囲（`SpawnHandlerDeps.rootScope` と同じ）。 */
  readonly rootScope?: Scope;
  /** 応答に出さない原因の記録先。 */
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

/** 書き込み先として使えない値: 絶対パス・`..` を含む・`/` だけ。 */
const badWritable = (v: string): boolean =>
  v.startsWith("/") || v.split("/").some((seg) => seg === "..") || v.trim() === "";

export function createScopeHandlers(deps: ScopeHandlerDeps) {
  const { log } = deps;
  const note = (nodeId: string, cause: string): void => {
    try {
      deps.onFailure?.(nodeId, cause);
    } catch {
      // 記録先の失敗は、処理を止めない
    }
  };

  /** 承認の前の検査。問題があれば失敗を返す。 */
  async function checkApprove(
    ext: ExtensionRecord,
  ): Promise<{ ok: false; error: Failure } | undefined> {
    const state = log.state();
    const node = state.nodes.find((n) => n.id === ext.nodeId);
    if (node === undefined || node.parentId === null) {
      return fail("notFound", "対象のノードまたはその親が見つからない", "ID を確認する");
    }
    const current = effectiveScope(state, ext.nodeId);
    if (current === undefined) {
      return fail(
        "scopeUnknown",
        `ノード ${ext.nodeId} にブリーフ（範囲）がない`,
        "範囲を確認する",
      );
    }
    const grown: Scope =
      ext.target.kind === "write"
        ? {
            ...current,
            writableLocations: [...new Set([...current.writableLocations, ext.target.value])],
          }
        : {
            ...current,
            allowedCommands: [...new Set([...current.allowedCommands, ext.target.value])],
          };
    const [cwd, parentCwd] = await Promise.all([
      deps.cwdOf(ext.nodeId).catch(() => undefined),
      deps.cwdOf(node.parentId).catch(() => undefined),
    ]);
    if (cwd === undefined || parentCwd === undefined) {
      return fail("worktreeUnknown", "作業ツリーを確認できない", "ノードの状態を確認する");
    }
    const issues = validateScope(grown, cwd);
    if (issues.length > 0) {
      return fail(
        "scopeInvalid",
        `拡張後の範囲が作業ツリーの規則を満たさない: ${issues.map((i) => `${i.field}（${i.problem}）`).join("、")}`,
        "対象を、作業ツリーの内側の相対パスにして要求し直させる",
      );
    }
    const parentScope = effectiveScope(state, node.parentId) ?? deps.rootScope;
    if (parentScope === undefined) {
      return fail(
        "rootScopeUnconfigured",
        "親にブリーフがなく、根の範囲の設定（許可リスト）もない",
        "daemon の設定に、根の範囲を書く",
      );
    }
    if (!isScopeSubset(grown, parentScope, { child: parentCwd, parent: parentCwd })) {
      return fail(
        "scopeNotSubset",
        "拡張後の範囲が、親の範囲に収まらない",
        "却下する",
        "親の範囲を広げてから、もう一度判定する",
      );
    }
    return undefined;
  }

  return {
    "scope.extend": (req: HandlerRequest<"scope.extend">): R<"scope.extend"> => {
      const caller = req.caller?.nodeId ?? "";
      const { target, reason } = req.params;
      if (target.kind === "write" && badWritable(target.value)) {
        return fail(
          "invalidTarget",
          "書き込み先は、作業ツリーの内側の相対パスで指定する（絶対パス・.. ・/ は使えない）",
          "相対パスで要求し直す",
        );
      }
      const extensionId = deriveId("ext", caller, req.requestId, "extension");
      const bodies: EventBody[] = [
        {
          type: "scope.extensionRequested",
          payload: { extensionId, nodeId: caller, target, reason },
        },
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", caller, req.requestId, "inbox"),
            kind: "violation",
            nodeId: caller,
            // 受信箱の `ref` は拡張要求を指せない（core の参照先は判断要求・報告だけ）ので、ID は要約に入れる。
            summary: summarize(`範囲の拡張要求 ${extensionId}（${target.kind}）: ${target.value}`),
          },
        },
      ];
      const r = appendAtomically(log, deps.clock, req.requestId, { nodeId: caller }, bodies);
      return r.ok ? { ok: true, value: { extensionId } } : r;
    },

    "scope.decide": async (req: HandlerRequest<"scope.decide">): Promise<R<"scope.decide">> => {
      const caller = req.caller?.nodeId ?? "";
      const { extensionId, decision } = req.params;
      const state = log.state();
      const ext = state.extensions.find((x) => x.extensionId === extensionId);
      if (ext === undefined) {
        return fail("notFound", "拡張要求が見つからない", "拡張要求の ID を確認する");
      }
      if (!isStrictDescendant(state.nodes, caller, ext.nodeId)) {
        return fail(
          "forbidden",
          "判定できるのは、対象のノードの祖先（統合ノード）だけ",
          "親の統合ノードに依頼する",
        );
      }
      if (decision === "approve" && ext.status === "open") {
        const problem = await checkApprove(ext);
        if (problem) return problem;
      }
      const bodies: EventBody[] = [
        {
          type: "scope.extensionDecided",
          payload: {
            extensionId,
            decision,
            ...(decision === "approve" ? { granted: ext.target } : {}),
          },
        },
      ];
      const decided = appendAtomically(log, deps.clock, req.requestId, { nodeId: caller }, bodies);
      if (!decided.ok) return decided;
      if (decision === "approve") {
        const after = log.state();
        const scope = effectiveScope(after, ext.nodeId);
        const adapter = deps.adapterFor(ext.nodeId);
        let failedWith: string | undefined;
        if (scope === undefined || adapter === undefined) {
          failedWith = "アダプタまたは範囲が見つからない";
        } else {
          try {
            const u = adapter.updateScope(ext.nodeId, scope);
            if (!u.ok) failedWith = `${u.error.code}: ${u.error.cause}`;
          } catch (e) {
            failedWith = String(e);
          }
        }
        if (failedWith !== undefined) {
          note(ext.nodeId, `範囲を更新できない: ${failedWith}`);
          appendAtomically(log, deps.clock, `${req.requestId}/update-failed`, { nodeId: caller }, [
            {
              type: "inbox.added",
              payload: {
                id: deriveId("inbox", caller, req.requestId, "update-failed"),
                kind: "failure",
                nodeId: ext.nodeId,
                summary: summarize(
                  `範囲の拡張 ${extensionId} を承認したが、アダプタの範囲を更新できなかった`,
                ),
              },
            },
          ]);
          return fail(
            "scopeUpdateFailed",
            "承認は記録したが、アダプタの範囲を更新できなかった",
            "同じ判定をもう一度送ると、更新をやり直す",
          );
        }
      }
      const st: NodeState | undefined = stateOf(log.state(), ext.nodeId);
      return { ok: true, value: { state: st as NodeState } };
    },
  };
}
