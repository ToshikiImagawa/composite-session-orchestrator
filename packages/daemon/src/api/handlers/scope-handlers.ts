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
import {
  alreadyApplied,
  appendAtomically,
  deriveId,
  fail,
  type LogPort,
  summarize,
} from "./context.js";

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

const LIVE: ReadonlySet<NodeState> = new Set(["running", "waiting"]);

// biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字を拒否するための検査
const CONTROL = /[\u0000-\u001f\u007f]/u;

/** 拡張の対象として使えない値の理由。使えれば `undefined`。 */
function targetProblem(target: { kind: string; value: string }): string | undefined {
  const v = target.value;
  if (v.trim() === "" || v !== v.trim()) return "前後の空白・空の値は使えない";
  if (CONTROL.test(v)) return "制御文字（改行を含む）は使えない";
  if (target.kind === "write") {
    if (v.startsWith("/")) return "絶対パスは使えない";
    const segs = v.split("/");
    if (segs.some((seg) => seg === "..")) return ".. は使えない";
    if (/[*?[\]{}]/u.test(v)) return "glob 文字（* ? [ ] { }）は使えない";
    if (segs.some((seg) => seg.toLowerCase() === ".git")) return ".git（入れ子を含む）は使えない";
    return undefined;
  }
  if (/[&;|`<>]|\$\(/u.test(v)) return "シェルの連結子・置換（& ; | ` < > $(）は使えない";
  return undefined;
}

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
      const problem = targetProblem(target);
      if (problem !== undefined) {
        return fail(
          "invalidTarget",
          `拡張の対象が使えない: ${problem}（書き込み先は、作業ツリーの内側の相対パス。コマンドは、単純な 1 つのコマンド）`,
          "対象を直して要求し直す",
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
            summary: summarize(`範囲の拡張要求（${target.kind}）: ${target.value}`),
            ref: extensionId,
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
      const stateOfNode = (): NodeState | undefined => stateOf(log.state(), ext.nodeId);
      // 承認済みへの再承認: 記録はせず、アダプタの更新だけをやり直す（requestId が違っても。冪等）。
      if (decision === "approve" && ext.status === "approved") {
        const failed = applyToAdapter(ext, extensionId);
        if (failed) return failed;
        return { ok: true, value: { state: stateOfNode() as NodeState } };
      }
      if (decision === "approve" && ext.status === "open") {
        // 検査は、記録する直前に取り直す（検査の途中の待ちの間に、範囲が変わっていないか）。
        for (let attempt = 0; ; attempt++) {
          const basis = JSON.stringify(effectiveScope(log.state(), ext.nodeId));
          const problem = await checkApprove(ext);
          if (problem) return problem;
          if (JSON.stringify(effectiveScope(log.state(), ext.nodeId)) === basis) break;
          if (attempt >= 1) {
            return fail("busy", "検査の間に範囲が変わった", "もう一度判定する");
          }
        }
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
        const failed = applyToAdapter(ext, extensionId);
        if (failed) return failed;
      }
      notifyChild(ext, decision, caller, req.requestId);
      return { ok: true, value: { state: stateOfNode() as NodeState } };
    },
  };

  /** 承認を、動作中の子のアダプタへ反映する（動作中でなければ、次回の起動で有効な範囲が使われるので、何もしない）。 */
  function applyToAdapter(
    ext: ExtensionRecord,
    extensionId: string,
  ): { ok: false; error: Failure } | undefined {
    const after = log.state();
    if (!LIVE.has(stateOf(after, ext.nodeId) ?? "pending")) return undefined;
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
    if (failedWith === undefined) return undefined;
    note(ext.nodeId, `範囲を更新できない: ${failedWith}`);
    const listed = appendAtomically(
      log,
      deps.clock,
      `update-failed-${extensionId}`,
      { system: true },
      [
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", "system", extensionId, "update-failed"),
            kind: "failure",
            nodeId: ext.nodeId,
            summary: summarize(
              `範囲の拡張 ${extensionId} を承認したが、アダプタの範囲を更新できなかった`,
            ),
          },
        },
      ],
    );
    if (!listed.ok)
      note(ext.nodeId, `受信箱に載せられない: ${listed.error.code}: ${listed.error.cause}`);
    return fail(
      "scopeUpdateFailed",
      "承認は記録したが、アダプタの範囲を更新できなかった",
      "同じ判定をもう一度送ると、更新をやり直す",
    );
  }

  /** 判定の結果を、動作中の子に追加指示として記録して届ける（失敗は判定を妨げない）。 */
  function notifyChild(
    ext: ExtensionRecord,
    decision: "approve" | "reject" | "split",
    caller: string,
    requestId: string,
  ): void {
    if (!LIVE.has(stateOf(log.state(), ext.nodeId) ?? "pending")) return;
    const what = `${ext.target.kind === "write" ? "書き込み先" : "コマンド"} ${ext.target.value}`;
    const text =
      decision === "approve"
        ? `範囲の拡張の要求（${what}）は承認された。使ってよい`
        : decision === "reject"
          ? `範囲の拡張の要求（${what}）は却下された。範囲の内側で進める`
          : `範囲の拡張の要求（${what}）は、作業を切り出して別に進めることになった。範囲の内側で進める`;
    const notifyId = `${requestId}/notify`;
    const before = alreadyApplied(log.state(), { nodeId: caller }, notifyId);
    const r = appendAtomically(log, deps.clock, notifyId, { nodeId: caller }, [
      { type: "node.instructed", payload: { nodeId: ext.nodeId, text } },
    ]);
    if (!r.ok) {
      note(ext.nodeId, `判定の通知を記録できない: ${r.error.code}: ${r.error.cause}`);
      return;
    }
    if (before) return;
    const adapter = deps.adapterFor(ext.nodeId);
    if (adapter === undefined) return;
    void adapter.send(ext.nodeId, text).then(
      (sent) => {
        if (!sent.ok) note(ext.nodeId, `判定の通知を届けられない: ${sent.error.code}`);
      },
      (e: unknown) => note(ext.nodeId, `判定の通知を届けられない: ${String(e)}`),
    );
  }
}
