/**
 * 子の生成の操作の実体: `node.spawn`（子の生成と起動）と `node.split`（切り出し）。権限と部分木の判定は、認可
 * （`authorize`）で済んでいる前提（ハンドラでも、対象が呼び出し元の部分木に収まることを確かめる）。
 * PRD: FR_001, FR_005 / spec 5.2
 *
 * 順序（失敗したら、そこまでの副作用を片付ける）:
 * 1. 親（動作中の統合ノード）・依存先（呼び出し元の部分木のノード）・親の作業ツリー（`cwdOf`。取得できなければ失敗＝安全側）
 * 2. 作業ツリーを作る（`provisionWorktree`。同じ nodeId なら同じ結果を返す）
 * 3. 子の範囲を、子の作業ツリーで `validateScope`（必須）し、親の有効な範囲に収まるか `isScopeSubset` で検査する。
 *    相対パスは、親の作業ツリーを基準に、子も親も同じ基準で比べる（作業ツリーは別々なので、絶対パスは収まらない）。
 *    親にブリーフがなければ（根など）、daemon の設定の根の範囲（`rootScope`）と比べる。設定がなければ失敗させる（安全側）。
 * 4. ノードを記録する（`node.created`。依存が揃っていれば続けて `start`。1 トランザクション）。依存が揃っていなければ pending
 *    のまま返す（起動は、依存の完了時にスケジューラが行う）。
 * 5. トークンを発行して `adapter.start` に直接渡す（保存に成功してから有効になる）。
 * 失敗の後始末（冪等・例外を外へ出さない）: トークンの失効、作業ツリーの削除、記録済みのノードの停止（プロセスがないので、
 * 停止要求→停止の確認を記録する）。後始末自体の失敗は `onFailure` に渡す。
 * 同じ requestId の再試行は、記録済みなら何も重複させない（作業ツリー・トークン・起動をやり直さない）。
 * 起動の前に `start` を記録するので、再試行で二重に起動しない（記録のあとの異常終了で残る「動作中だがプロセスなし」は、
 * 再起動時の整合〔T10b〕で扱う）。
 */

import {
  type Actor,
  COMPLETED_STATES,
  type EventBody,
  effectiveScope,
  type Failure,
  isInSubtree,
  isPathUnder,
  isScopeSubset,
  type NodeRecord,
  normalizePath,
  type OperationMap,
  type OrchState,
  type Result,
  type Scope,
  stateOf,
  validateScope,
} from "@cso/core";
import type { RuntimeAdapter } from "../../sdk/runtime.js";
import { selfIntroLines } from "../../self-intro.js";
import type { CredentialStore } from "../credentials.js";
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

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

export interface SpawnPorts {
  /** ノードの作業ツリー（実パス）。アダプタ側を正とする。取得できなければ `undefined`（失敗させる）。 */
  cwdOf(nodeId: string): Promise<string | undefined>;
  /** 親のブランチから、子の作業ツリーとブランチを作る。同じ `nodeId` なら同じ結果を返す（冪等）。絶対パスで、`worktreeRoot` の配下。 */
  provisionWorktree(req: {
    parentId: string;
    nodeId: string;
  }): Promise<Result<{ worktreePath: string }, Failure>>;
  /** 作業ツリーを消す（強制しない。契約は `ReclaimPorts.removeWorktree` と同じ）。 */
  removeWorktree(
    nodeId: string,
    opts: { expectedPath: string },
  ): Promise<Result<undefined, Failure>>;
  /** daemon の作業ツリー置き場。`provisionWorktree` が返すパスは、この配下でなければならない。 */
  readonly worktreeRoot: string;
  /** 子に渡す MCP の接続先。 */
  readonly mcpUrl: string;
}

export interface SpawnHandlerDeps {
  readonly log: LogPort;
  readonly clock: () => string;
  /** 新しい子のランタイム（アダプタ）。親のものを使う。 */
  readonly adapterFor: (nodeId: string) => RuntimeAdapter | undefined;
  readonly ports: SpawnPorts;
  readonly credentials: Pick<CredentialStore, "issueNodeToken" | "revokeNode">;
  /** `node.split` の keep が stop のときに、元のノードを止める（`node.stop` のハンドラ）。 */
  readonly stop: (req: HandlerRequest<"node.stop">) => R<"node.stop"> | Promise<R<"node.stop">>;
  /**
   * 根（ブリーフを持たない親）の有効な範囲。daemon の設定（プロジェクトの許可リスト）から導く。書き込み可能な場所は根の
   * 作業ツリーの下（相対パスは根の作業ツリー基準）、`allowedCommands` は設定のリスト。なければ、ブリーフを持たない親の
   * 下の `spawn` は失敗させる（根の子を経由した権限の昇格を防ぐ）。
   */
  readonly rootScope?: Scope;
  /** スケジューラが同時に起動する数の上限（親ごと・全体）。既定は `DEFAULT_START_LIMITS`。 */
  readonly startLimits?: { readonly perParent?: number; readonly total?: number };
  /** 応答に出さない原因（後始末の失敗・アダプタの詳細など）の記録先。 */
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

interface BriefParams {
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly scope: Scope;
  readonly dependsOn?: readonly string[];
}

/** 生成の結果。依存先が未完了なら `pending`（待っている先行ノードを `waitingFor` に）、起動したら `running`。 */
interface Spawned {
  readonly nodeId: string;
  readonly status: "running" | "pending";
  readonly waitingFor?: string[];
}

/** スケジューラが同時に起動する数の既定の上限。 */
export const DEFAULT_START_LIMITS = { perParent: 4, total: 4 } as const;
const SYSTEM: Actor = { system: true };
const LIVE = new Set(["running", "waiting"]);
/** 後始末済み・終わった子。同じ requestId の再試行で、成功として返してはならない。 */
const DEAD = new Set(["stopping", "stopIncomplete", "stopped", "reclaimable", "archived"]);

/** 起動の失敗のうち、利用者が直せるもの（原因と対処を、そのまま親に返す）。 */
const USER_FIXABLE: ReadonlySet<string> = new Set(["childAuthMissing"]);

const instructionOf = (b: BriefParams, self: string[]): string =>
  [
    ...self,
    `目的: ${b.objective}`,
    "受け入れ基準:",
    ...b.acceptanceCriteria.map((c) => `- ${c}`),
    "範囲:",
    `- 書き込み可能な場所: ${b.scope.writableLocations.join("、") || "なし"}`,
    `- 禁止する場所: ${b.scope.forbiddenLocations.join("、") || "なし"}`,
    `- 許可するコマンド: ${b.scope.allowedCommands.join("、") || "なし"}`,
    ...(b.dependsOn !== undefined && b.dependsOn.length > 0
      ? [`依存する先行ノード: ${b.dependsOn.join("、")}`]
      : []),
  ].join("\n");

/** 子の生成の操作に加えて、依存が揃った pending の子を起動するスケジューラ（`tick`）を返す。 */
export function createSpawner(deps: SpawnHandlerDeps) {
  const { log, ports, credentials } = deps;
  const note = (nodeId: string, cause: string): void => {
    try {
      deps.onFailure?.(nodeId, cause);
    } catch {
      // 記録先の失敗は、処理を止めない
    }
  };
  const nodeOf = (state: OrchState, id: string): NodeRecord | undefined =>
    state.nodes.find((n) => n.id === id);

  const exclusive = createExclusive();
  /** 同じノードの起動を、同時に 1 つだけにする（spawn の再試行・スケジューラ・別の tick が重なっても、二重に起動しない）。 */
  const startExclusive = createExclusive();
  const schedExclusive = createExclusive();

  /**
   * 失敗の後始末。冪等で、例外を外へ出さない。`safe` は、子のプロセスが残っていないと確かめられているか
   * （起動していないことが明らかか、停止を確認できたか）。そうでなければ、トークンの失効と停止の記録だけを行い、
   * 作業ツリーを消さず、アーカイブもしない（孤児プロセスと、生きている作業ツリーの削除を防ぐ）。
   */
  async function cleanup(
    nodeId: string,
    requestId: string,
    actor: Actor,
    worktreePath: string | undefined,
    safe = true,
  ): Promise<void> {
    try {
      credentials.revokeNode(nodeId);
    } catch (e) {
      note(nodeId, `トークンを失効できない: ${String(e)}`);
    }
    let removedOk = worktreePath === undefined;
    if (worktreePath !== undefined && safe) {
      try {
        const r = await ports.removeWorktree(nodeId, { expectedPath: worktreePath });
        if (r.ok) removedOk = true;
        else note(nodeId, `作業ツリーを消せない: ${r.error.code}: ${r.error.cause}`);
      } catch (e) {
        note(nodeId, `作業ツリーを消せない: ${String(e)}`);
      }
    }
    const state = nodeOf(log.state(), nodeId)?.state;
    if (state === undefined) return;
    if (state !== "stopped") {
      const bodies: EventBody[] =
        state === "running"
          ? [
              {
                type: "node.stateChanged",
                payload: { nodeId, event: { type: "stop", mode: "immediate" } },
              },
              { type: "node.stateChanged", payload: { nodeId, event: { type: "confirmStopped" } } },
            ]
          : [
              {
                type: "node.stateChanged",
                payload: { nodeId, event: { type: "stop", mode: "immediate" } },
              },
            ];
      const r = appendAtomically(log, deps.clock, `${requestId}/cleanup`, actor, bodies);
      if (!r.ok) {
        note(nodeId, `停止を記録できない: ${r.error.code}: ${r.error.cause}`);
        return;
      }
    }
    // 作業ツリーを消せたら、システムによる破棄の判断を記録して、アーカイブまで進める（成果のない失敗した生成）。
    // 消せなかったら、停止のまま残す（作業ツリーが残るので、人間が確認して回収する）。
    if (!removedOk || !safe) return;
    const archived = appendAtomically(
      log,
      deps.clock,
      `${requestId}/cleanup-archive`,
      { system: true },
      [
        { type: "node.discardDecided", payload: { nodeId } },
        {
          type: "node.stateChanged",
          payload: { nodeId, event: { type: "markReclaimable", discarded: true } },
        },
        { type: "node.stateChanged", payload: { nodeId, event: { type: "archive" } } },
      ],
    );
    if (!archived.ok)
      note(nodeId, `アーカイブできない: ${archived.error.code}: ${archived.error.cause}`);
  }

  /** 起動の手順（トークン発行 → adapter.start → start の記録）。失敗したら後始末して、定型の失敗を返す。 */
  async function startNode(
    ctx: { requestId: string; actor: Actor; nodeId: string; worktreePath: string },
    adapter: RuntimeAdapter,
    brief: BriefParams,
    role: NodeRecord["role"],
  ): Promise<Result<Spawned, Failure>> {
    const { requestId, actor, nodeId, worktreePath } = ctx;
    const abort = async (code: string, what: string, cause: string, safe = true) => {
      note(nodeId, cause);
      await cleanup(nodeId, requestId, actor, worktreePath, safe);
      return fail(
        code,
        safe ? `${what}。後始末した` : `${what}。子の停止を確認できないため、作業ツリーは残した`,
        "しばらくして、別の requestId でもう一度試す",
      );
    };
    /** 起動したかもしれない子を止め、停止を確認できたか。確認できなければ、プロセスが残っているとみなす。 */
    const stoppedForSure = async (): Promise<boolean> => {
      try {
        const r = await adapter.stop(nodeId, { mode: "immediate", stopSeq: log.state().lastSeq });
        return r.ok && r.value.state === "stopped";
      } catch (e) {
        note(nodeId, `起動したかもしれない子を止められない: ${String(e)}`);
        return false;
      }
    };
    // 起動の指示の先頭（自分の ID・role・親）。組み立てられなければ、何も起動せずに、後始末して失敗にする。
    const intro = selfIntroLines(nodeId, role, nodeOf(log.state(), nodeId)?.parentId ?? null);
    if (!intro.ok) {
      return abort(
        "internal",
        "子を起動できなかった",
        `指示を組み立てられない: ${intro.error.cause}`,
      );
    }
    let token: string;
    try {
      token = credentials.issueNodeToken(nodeId, role === "integrator" ? "integrator" : "child");
    } catch (e) {
      return abort(
        "tokenFailed",
        "子の認証情報を発行できなかった",
        `トークンを発行できない: ${String(e)}`,
      );
    }
    try {
      const started = await adapter.start({
        nodeId,
        role,
        worktreePath,
        scope: brief.scope,
        instruction: instructionOf(brief, intro.value),
        mcp: { url: ports.mcpUrl, token },
      });
      if (!started.ok) {
        const aborted = await abort(
          "startFailed",
          "子を起動できなかった",
          `起動に失敗: ${started.error.code}: ${started.error.cause}`,
        );
        // 利用者が直せる失敗（子の認証がない。T22-auth）は、原因と対処をそのまま親に返す（後始末は済んでいる）。
        return USER_FIXABLE.has(started.error.code) ? { ok: false, error: started.error } : aborted;
      }
    } catch (e) {
      // 例外は、起動したかどうかが分からない。停止を確認できたときだけ、作業ツリーを消す。
      const safe = await stoppedForSure();
      return abort("startFailed", "子を起動できなかった", `起動が例外: ${String(e)}`, safe);
    }
    // 起動に成功してから start を記録する（記録だけが残る経路をなくす）。記録に失敗したら、起動した子を止めて後始末する。
    const recorded = appendAtomically(log, deps.clock, `${requestId}/start`, actor, [
      { type: "node.stateChanged", payload: { nodeId, event: { type: "start" } } },
    ]);
    if (!recorded.ok) {
      const safe = await stoppedForSure();
      return abort(
        "startFailed",
        "子を起動できなかった",
        `起動を記録できない: ${recorded.error.code}: ${recorded.error.cause}`,
        safe,
      );
    }
    return { ok: true, value: { nodeId, status: "running" } };
  }

  /** 排他の中で、まだ pending か確かめてから起動する（先に起動した処理があれば、そのまま running として返す）。 */
  const startGuarded = (
    ctx: { requestId: string; actor: Actor; nodeId: string; worktreePath: string },
    adapter: RuntimeAdapter,
    brief: BriefParams,
    role: NodeRecord["role"],
  ): Promise<Result<Spawned, Failure>> =>
    startExclusive(ctx.nodeId, "start", async () => {
      if (nodeOf(log.state(), ctx.nodeId)?.state !== "pending")
        return { ok: true, value: { nodeId: ctx.nodeId, status: "running" } };
      return startNode(ctx, adapter, brief, role);
    });

  /** ポートが返した作業ツリーのパスを信用しない: 絶対パスで、置き場の配下であること。 */
  const worktreePathOk = (worktreePath: unknown): worktreePath is string =>
    typeof worktreePath === "string" &&
    worktreePath.startsWith("/") &&
    !worktreePath.includes("\0") &&
    isPathUnder(normalizePath("/", worktreePath), normalizePath("/", ports.worktreeRoot)) &&
    normalizePath("/", worktreePath) !== normalizePath("/", ports.worktreeRoot);

  const waitingOf = (state: OrchState, dependsOn: readonly string[]): string[] =>
    // 破棄された（失敗した生成の後始末で、アーカイブまで進んだ）依存先は、完了とみなさない（成果がないので、待ち続ける）。
    dependsOn.filter(
      (d) =>
        !COMPLETED_STATES.has(stateOf(state, d) ?? "pending") ||
        nodeOf(state, d)?.discarded !== undefined,
    );
  const dependsDone = (state: OrchState, dependsOn: readonly string[]): boolean =>
    waitingOf(state, dependsOn).length === 0;

  /** spawn・split の共通の本体。 */
  async function create(
    req: { requestId: string; caller: string },
    input: { parentId: string; role: NodeRecord["role"]; brief: BriefParams; tag: string },
  ): Promise<Result<Spawned, Failure>> {
    const { requestId, caller } = req;
    const { parentId, role, brief, tag } = input;
    const actor = { nodeId: caller };
    const nodeId = deriveId("node", caller, requestId, tag);
    const dependsOn = [...(brief.dependsOn ?? [])];
    const created: EventBody = {
      type: "node.created",
      payload: {
        nodeId,
        role,
        parentId,
        dependsOn,
        objective: brief.objective,
        acceptanceCriteria: [...brief.acceptanceCriteria],
        scope: brief.scope,
      },
    };

    const state = log.state();
    // 再試行: 記録済みなら、同じ内容か（違えば requestIdConflict）を確かめ、ノードの状態で結果を決める。
    if (alreadyApplied(state, actor, requestId)) {
      const dup = appendAtomically(log, deps.clock, requestId, actor, [created]);
      if (!dup.ok) return dup;
      const node = nodeOf(log.state(), nodeId);
      if (node === undefined || DEAD.has(node.state)) {
        return fail(
          "spawnFailedEarlier",
          "この requestId の生成は、先に失敗して後始末済み（または、すでに停止している）",
          "別の requestId で作り直す",
        );
      }
      if (node.state === "pending" && dependsDone(log.state(), dependsOn)) {
        // 記録済み・未起動（起動の前に異常終了した）。起動だけをやり直す。
        const adapter = deps.adapterFor(parentId);
        const provisioned = await ports
          .provisionWorktree({ parentId, nodeId })
          .catch(() => undefined);
        if (adapter === undefined || provisioned === undefined || !provisioned.ok) {
          return fail(
            "provisionFailed",
            "作業ツリーを確認できなかった",
            "しばらくして、もう一度試す",
          );
        }
        return startGuarded(
          { requestId, actor, nodeId, worktreePath: provisioned.value.worktreePath },
          adapter,
          brief,
          role,
        );
      }
      const waiting = waitingOf(log.state(), dependsOn);
      return {
        ok: true,
        value:
          node.state === "pending" && waiting.length > 0
            ? { nodeId, status: "pending", waitingFor: waiting }
            : { nodeId, status: "running" },
      };
    }

    const parent = nodeOf(state, parentId);
    if (parent === undefined) return fail("notFound", "親のノードが見つからない", "ID を確認する");
    if (!isInSubtree(state.nodes, caller, parentId)) {
      return fail("forbidden", "親が自分の部分木の外にある", "親（統合ノード）に依頼する");
    }
    if (parent.role !== "integrator" || !LIVE.has(parent.state)) {
      return fail(
        "notActive",
        `親 ${parentId} は動作中の統合ノードでない（${parent.role}・${parent.state}）`,
        "動作中の統合ノードを親にする",
      );
    }
    for (const d of dependsOn) {
      if (isDiscarded(state, d)) {
        return fail(
          "dependencyDiscarded",
          `依存先 ${d} は破棄されていて、完了しない（依存する子は、起動できない）`,
          "別の依存先を指定する",
        );
      }
      if (nodeOf(state, d) === undefined || !isInSubtree(state.nodes, caller, d)) {
        return fail(
          "notFound",
          `依存先 ${d} が、自分の部分木に見つからない`,
          "依存先の ID を確認する",
        );
      }
    }
    const adapter = deps.adapterFor(parentId);
    if (adapter === undefined) {
      return fail(
        "noRuntime",
        `親 ${parentId} のランタイム（アダプタ）が見つからない`,
        "ノードの状態を確認する",
      );
    }
    let parentCwd: string | undefined;
    try {
      parentCwd = await ports.cwdOf(parentId);
    } catch (e) {
      note(parentId, `親の作業ツリーを取得できない: ${String(e)}`);
    }
    if (parentCwd === undefined) {
      return fail(
        "worktreeUnknown",
        `親 ${parentId} の作業ツリーを確認できない`,
        "親の状態を確認する",
      );
    }

    // 親の範囲に収まるか（作業ツリーを作る前に検査する。相対パスは、親の作業ツリー基準で子も親も比べる）。
    const parentScope = effectiveScope(state, parentId) ?? deps.rootScope;
    if (parentScope === undefined) {
      return fail(
        "rootScopeUnconfigured",
        `親 ${parentId} にブリーフがなく、根の範囲の設定（許可リスト）もない。子の権限を決められない`,
        "daemon の設定に、根の範囲（許可する場所とコマンド）を書く",
      );
    }
    if (deps.rootScope === parentScope && validateScope(parentScope, parentCwd).length > 0) {
      return fail(
        "rootScopeInvalid",
        "daemon の設定の根の範囲が、根の作業ツリーの規則を満たさない",
        "設定の根の範囲を、根の作業ツリーの内側の場所に直す",
      );
    }
    if (!isScopeSubset(brief.scope, parentScope, { child: parentCwd, parent: parentCwd })) {
      return fail(
        "scopeNotSubset",
        "子の範囲が、親の範囲に収まらない（コマンド・書き込み可能な場所・禁止の場所）",
        "親の範囲の内側に絞って指定し直す",
      );
    }

    // 作業ツリーを作る（以降の失敗は、片付ける）。
    let provisioned: Result<{ worktreePath: string }, Failure>;
    try {
      provisioned = await ports.provisionWorktree({ parentId, nodeId });
    } catch (e) {
      note(nodeId, `作業ツリーを作れない: ${String(e)}`);
      return fail("provisionFailed", "作業ツリーを作れなかった", "しばらくして、もう一度試す");
    }
    if (!provisioned.ok) {
      note(nodeId, `作業ツリーを作れない: ${provisioned.error.code}: ${provisioned.error.cause}`);
      return fail("provisionFailed", "作業ツリーを作れなかった", "しばらくして、もう一度試す");
    }
    const worktreePath = provisioned.value.worktreePath;
    // ポートが返したパスを信用しない: 絶対パスで、置き場の配下であること（外のパスは、消しもしない）。
    if (!worktreePathOk(worktreePath)) {
      note(nodeId, `作業ツリーのパスが置き場の外: ${String(worktreePath)}`);
      return fail("provisionFailed", "作業ツリーを作れなかった", "しばらくして、もう一度試す");
    }
    const abort = async (f: { ok: false; error: Failure }) => {
      await cleanup(nodeId, requestId, actor, worktreePath);
      return f;
    };

    const issues = validateScope(brief.scope, worktreePath);
    if (issues.length > 0) {
      return abort(
        fail(
          "scopeInvalid",
          `範囲が作業ツリーの規則を満たさない: ${issues.map((i) => `${i.field}（${i.problem}）`).join("、")}`,
          "範囲を、作業ツリーの内側の相対パスで指定し直す",
        ),
      );
    }

    // 記録（pending）。起動は、依存が揃っていれば続けて行う。揃っていなければ pending のまま返す。
    const recorded = appendAtomically(log, deps.clock, requestId, actor, [created]);
    if (!recorded.ok) return abort({ ok: false, error: recorded.error });
    if (!dependsDone(state, dependsOn)) {
      return {
        ok: true,
        value: { nodeId, status: "pending", waitingFor: waitingOf(state, dependsOn) },
      };
    }
    return startGuarded({ requestId, actor, nodeId, worktreePath }, adapter, brief, role);
  }

  /** 破棄された（失敗した生成の後始末などで、アーカイブまで進んだ）ノードか。完了とはみなさない。 */
  const isDiscarded = (state: OrchState, id: string): boolean =>
    nodeOf(state, id)?.discarded !== undefined;

  /**
   * 待っている先から、永久に完了しない根本の依存先（破棄されたノード）を探す。pending の依存先は、その先も辿る
   * （連鎖: c が b を待ち、b が破棄された a を待つ）。見つからなければ undefined。
   */
  const deadDependency = (
    state: OrchState,
    dependsOn: readonly string[],
    seen = new Set<string>(),
  ): string | undefined => {
    for (const d of dependsOn) {
      if (seen.has(d)) continue;
      seen.add(d);
      if (isDiscarded(state, d)) return d;
      const dn = nodeOf(state, d);
      if (dn?.state === "pending") {
        const root = deadDependency(state, dn.dependsOn, seen);
        if (root !== undefined) return root;
      }
    }
    return undefined;
  };

  /** 親の受信箱に、失敗を 1 度だけ出す（`key` で決定的。再び呼んでも重複しない）。 */
  function reportOnce(nodeId: string, key: string, text: string): void {
    if (alreadyApplied(log.state(), SYSTEM, key)) return;
    const r = appendAtomically(log, deps.clock, key, SYSTEM, [
      {
        type: "inbox.added",
        payload: {
          id: deriveId("inbox", "system", key, "failure"),
          kind: "failure",
          nodeId,
          summary: summarize(text),
        },
      },
    ]);
    if (!r.ok) note(nodeId, `受信箱に記録できない: ${r.error.code}: ${r.error.cause}`);
  }

  const startLimits = {
    perParent: deps.startLimits?.perParent ?? DEFAULT_START_LIMITS.perParent,
    total: deps.startLimits?.total ?? DEFAULT_START_LIMITS.total,
  };
  const startingByParent = new Map<string, number>();
  const startingNodes = new Set<string>();
  const startSettled = new Set<Promise<unknown>>();

  /** 起動の入口の条件（状態だけで決まる部分）。満たせば、起動を試みる。 */
  const startable = (state: OrchState, node: NodeRecord): boolean => {
    if (node.state !== "pending" || node.parentId === null) return false;
    if (!dependsDone(state, node.dependsOn)) return false;
    const parent = nodeOf(state, node.parentId);
    return parent !== undefined && parent.role === "integrator" && LIVE.has(parent.state);
  };

  /** 起動できない事情を、pending のまま、最初の 1 度だけ受信箱に出す（以降の tick では、同じ事情を繰り返さない）。 */
  const unstartable = (nodeId: string, why: string): void => {
    note(nodeId, why);
    reportOnce(nodeId, `sched-${nodeId}/unstartable`, `依存が揃ったが、起動できない: ${why}`);
  };

  function startPending(nodeId: string): Promise<Result<undefined, Failure>> {
    return schedExclusive(nodeId, "sched", async () => {
      try {
        const state = log.state();
        const node = nodeOf(state, nodeId);
        if (node === undefined || !startable(state, node) || node.parentId === null)
          return { ok: true, value: undefined };
        const parentId = node.parentId;
        if (
          node.objective === undefined ||
          node.acceptanceCriteria === undefined ||
          node.scope === undefined
        ) {
          unstartable(nodeId, "ブリーフ（目的・受け入れ基準・範囲）が記録されていない");
          return { ok: true, value: undefined };
        }
        const adapter = deps.adapterFor(parentId);
        if (adapter === undefined) {
          unstartable(nodeId, `親 ${parentId} のランタイム（アダプタ）が見つからない`);
          return { ok: true, value: undefined };
        }
        const provisioned = await ports.provisionWorktree({ parentId, nodeId });
        if (!provisioned.ok || !worktreePathOk(provisioned.value.worktreePath)) {
          unstartable(nodeId, "作業ツリーを用意できない");
          return { ok: true, value: undefined };
        }
        const brief: BriefParams = {
          objective: node.objective,
          acceptanceCriteria: node.acceptanceCriteria,
          scope: node.scope,
          dependsOn: node.dependsOn,
        };
        const started = await startGuarded(
          {
            requestId: `sched-${nodeId}`,
            actor: SYSTEM,
            nodeId,
            worktreePath: provisioned.value.worktreePath,
          },
          adapter,
          brief,
          node.role,
        );
        if (!started.ok) {
          reportOnce(
            nodeId,
            `sched-${nodeId}/failed`,
            `依存が揃ったので起動しようとしたが、失敗した（${started.error.code}）: ${started.error.cause}。対処: ${started.error.nextActions[0]}`,
          );
        }
      } catch (e) {
        note(nodeId, `スケジューラが失敗: ${String(e)}`);
      }
      return { ok: true, value: undefined };
    });
  }

  /** 依存先が破棄されたまま完了しない pending の子について、親の受信箱に、1 度だけ失敗を出す。 */
  function reportBlocked(): void {
    const state = log.state();
    for (const n of state.nodes) {
      if (n.state !== "pending" || n.parentId === null) continue;
      const dead = deadDependency(state, n.dependsOn);
      if (dead === undefined) continue;
      reportOnce(
        n.id,
        `sched-${n.id}/blocked-${dead}`,
        `依存先 ${dead} が破棄されたため、このノードは起動できない。node.stop で取り消すか、別の依存先で作り直す`,
      );
    }
  }

  /**
   * 起動できる pending の子を起動する（依存の完了時・親の再開時・daemon の起動時に呼ぶ）。例外を外へ出さない。
   * 同時に起動する数は、親ごと・全体で上限（`startLimits`。既定 4）まで。上限を超える分は、空きができてから起動する。
   */
  async function tick(): Promise<void> {
    reportBlocked();
    const attempted = new Set<string>();
    for (;;) {
      const state = log.state();
      const ready = state.nodes.filter(
        (n) => !attempted.has(n.id) && !startingNodes.has(n.id) && startable(state, n),
      );
      if (ready.length === 0) return;
      const batch: NodeRecord[] = [];
      for (const n of ready) {
        const parentId = n.parentId as string;
        const perParent =
          (startingByParent.get(parentId) ?? 0) +
          batch.filter((b) => b.parentId === parentId).length;
        if (startingNodes.size + batch.length >= startLimits.total) break;
        if (perParent >= startLimits.perParent) continue;
        batch.push(n);
      }
      if (batch.length === 0) {
        // 空きがない: 起動中のどれかが終わるのを待って、やり直す（起動中がなければ、待つものはない）。
        if (startSettled.size === 0) return;
        await Promise.race([...startSettled]);
        continue;
      }
      const running: Promise<unknown>[] = [];
      for (const n of batch) {
        attempted.add(n.id);
        const parentId = n.parentId as string;
        startingNodes.add(n.id);
        startingByParent.set(parentId, (startingByParent.get(parentId) ?? 0) + 1);
        const p: Promise<unknown> = startPending(n.id).finally(() => {
          startingNodes.delete(n.id);
          startingByParent.set(parentId, (startingByParent.get(parentId) ?? 1) - 1);
          startSettled.delete(p);
        });
        startSettled.add(p);
        running.push(p);
      }
      await Promise.all(running);
    }
  }

  const fingerprintOf = (v: unknown): string => JSON.stringify(v);

  const handlers = {
    "node.spawn": (req: HandlerRequest<"node.spawn">): Promise<R<"node.spawn">> => {
      const { parentId, role, ...brief } = req.params;
      const caller = req.caller?.nodeId ?? "";
      return exclusive(
        `${caller}\0${req.requestId}`,
        fingerprintOf(req.params),
        async (): Promise<R<"node.spawn">> => {
          const created = await create(
            { requestId: req.requestId, caller },
            { parentId, role, brief, tag: "spawn" },
          );
          if (!created.ok) return created;
          // 結果: 依存先が未完了なら pending（待っている先行ノードを waitingFor に）、そうでなければ running。
          const state = log.state();
          const { nodeId } = created.value;
          const node = nodeOf(state, nodeId);
          if (node?.state !== "pending") return { ok: true, value: { nodeId, status: "running" } };
          const waitingFor = node.dependsOn.filter(
            (d) => !COMPLETED_STATES.has(stateOf(state, d) ?? "pending"),
          );
          return {
            ok: true,
            value: { nodeId, status: "pending", ...(waitingFor.length > 0 ? { waitingFor } : {}) },
          };
        },
      );
    },

    "node.split": (req: HandlerRequest<"node.split">): Promise<R<"node.split">> => {
      const { nodeId, keep, ...brief } = req.params;
      const caller = req.caller?.nodeId ?? "";
      return exclusive(`${caller}\0${req.requestId}`, fingerprintOf(req.params), async () => {
        const state = log.state();
        const original = nodeOf(state, nodeId);
        if (original === undefined)
          return fail("notFound", "ノードが見つからない", "ID を確認する");
        if (
          nodeId === caller ||
          !isInSubtree(state.nodes, caller, nodeId) ||
          original.parentId === null
        ) {
          return fail(
            "forbidden",
            "対象が、自分の部分木の規則（自分を含まない子孫）を満たさない",
            "親（統合ノード）に依頼する",
          );
        }
        // 再試行の判定は、元のノードの状態より前（途中で元が止まっていても、同じ結果を返す）。
        const retry = alreadyApplied(state, { nodeId: caller }, req.requestId);
        if (!retry && !LIVE.has(original.state)) {
          return fail(
            "notActive",
            `ノード ${nodeId} は ${original.state} で、切り出せない（running・waiting のとき）`,
            "状態を確認する",
          );
        }
        const made = await create(
          { requestId: req.requestId, caller },
          { parentId: original.parentId, role: original.role, brief, tag: "split" },
        );
        if (!made.ok) return made;
        const newNodeId = made.value.nodeId;
        if (keep === "stop") {
          // 新しい子を起動したあとで、元を止める。止められなかったら、新しい子の ID を添えて失敗を返す
          // （同じ requestId の再送で、切り出しはそのまま・止める操作だけをやり直す）。
          const stopped = await deps.stop({
            requestId: `${req.requestId}/split-stop`,
            operation: "node.stop",
            role: "integrator",
            caller: { nodeId: caller },
            params: { nodeId, mode: "graceful" },
          });
          if (!stopped.ok) {
            note(nodeId, `元のノードを止められない: ${stopped.error.code}: ${stopped.error.cause}`);
            return fail(
              "splitStopFailed",
              `切り出しは済んだ（新しいノード: ${newNodeId}）が、元のノード ${nodeId} を止められなかった`,
              "同じ要求をもう一度送ると、止める操作だけをやり直す",
              "node.stop で元のノードを止める",
            );
          }
        } else {
          // mainline: 元のノードは続ける。切り出した分を外して mainline に戻るよう、指示を記録して届ける。
          const text = `作業の一部を新しいノード ${newNodeId} に切り出した。あなたは、残りの作業（mainline）に戻って続けてほしい`;
          const mainlineId = `${req.requestId}/split-mainline`;
          const sentBefore = alreadyApplied(log.state(), { nodeId: caller }, mainlineId);
          const sent = appendAtomically(log, deps.clock, mainlineId, { nodeId: caller }, [
            { type: "node.instructed", payload: { nodeId, text } },
          ]);
          if (!sent.ok) {
            note(
              nodeId,
              `mainline への復帰の指示を記録できない: ${sent.error.code}: ${sent.error.cause}`,
            );
          } else if (!sentBefore) {
            try {
              const a = deps.adapterFor(nodeId);
              const r = a === undefined ? undefined : await a.send(nodeId, text);
              if (r === undefined || !r.ok) note(nodeId, "mainline への復帰の指示を届けられない");
            } catch (e) {
              note(nodeId, `mainline への復帰の指示を届けられない: ${String(e)}`);
            }
          }
        }
        return { ok: true, value: { newNodeId } };
      });
    },
  };
  return { handlers, startPending, tick };
}

export function createSpawnHandlers(deps: SpawnHandlerDeps) {
  return createSpawner(deps).handlers;
}
