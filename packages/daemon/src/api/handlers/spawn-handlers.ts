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
  COMPLETED_STATES,
  type EventBody,
  effectiveScope,
  type Failure,
  failure,
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
import type { CredentialStore } from "../credentials.js";
import type { HandlerRequest } from "../server.js";
import { alreadyApplied, appendAtomically, deriveId, fail, type LogPort } from "./context.js";

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
  /** 応答に出さない原因（後始末の失敗・アダプタの詳細など）の記録先。 */
  readonly onFailure?: (nodeId: string, cause: string) => void;
}

interface BriefParams {
  readonly objective: string;
  readonly acceptanceCriteria: readonly string[];
  readonly scope: Scope;
  readonly dependsOn?: readonly string[];
}

const LIVE = new Set(["running", "waiting"]);
/** 後始末済み・終わった子。同じ requestId の再試行で、成功として返してはならない。 */
const DEAD = new Set(["stopping", "stopIncomplete", "stopped", "reclaimable", "archived"]);

const instructionOf = (b: BriefParams): string =>
  [
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

export function createSpawnHandlers(deps: SpawnHandlerDeps) {
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

  /**
   * 同じ呼び出し元・同じ requestId の処理を、同時に 1 つだけ走らせる（同じ Promise を共有する）。内容が違えば
   * `requestIdConflict`。終わったら外す（以降の再試行は、記録を見て判定する）。
   */
  const inflight = new Map<
    string,
    { fingerprint: string; promise: Promise<Result<unknown, Failure>> }
  >();
  function exclusive<T>(
    key: string,
    fingerprint: string,
    run: () => Promise<Result<T, Failure>>,
  ): Promise<Result<T, Failure>> {
    const running = inflight.get(key);
    if (running !== undefined) {
      if (running.fingerprint !== fingerprint) {
        return Promise.resolve(
          fail(
            "requestIdConflict",
            "同じ requestId で、処理中の要求と内容が違う",
            "別の requestId で要求する",
          ),
        );
      }
      return running.promise as Promise<Result<T, Failure>>;
    }
    const promise = run().finally(() => inflight.delete(key));
    inflight.set(key, { fingerprint, promise });
    return promise;
  }

  /** 失敗の後始末。冪等で、例外を外へ出さない。 */
  async function cleanup(
    nodeId: string,
    requestId: string,
    caller: string,
    worktreePath: string | undefined,
  ): Promise<void> {
    try {
      credentials.revokeNode(nodeId);
    } catch (e) {
      note(nodeId, `トークンを失効できない: ${String(e)}`);
    }
    if (worktreePath !== undefined) {
      try {
        const r = await ports.removeWorktree(nodeId, { expectedPath: worktreePath });
        if (!r.ok) note(nodeId, `作業ツリーを消せない: ${r.error.code}: ${r.error.cause}`);
      } catch (e) {
        note(nodeId, `作業ツリーを消せない: ${String(e)}`);
      }
    }
    const state = nodeOf(log.state(), nodeId)?.state;
    if (state === undefined || state === "stopped") return;
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
    const r = appendAtomically(log, deps.clock, `${requestId}/cleanup`, { nodeId: caller }, bodies);
    if (!r.ok) note(nodeId, `停止を記録できない: ${r.error.code}: ${r.error.cause}`);
  }

  /** 起動の手順（トークン発行 → adapter.start → start の記録）。失敗したら後始末して、定型の失敗を返す。 */
  async function startNode(
    ctx: { requestId: string; caller: string; nodeId: string; worktreePath: string },
    adapter: RuntimeAdapter,
    brief: BriefParams,
    role: NodeRecord["role"],
  ): Promise<Result<{ nodeId: string }, Failure>> {
    const { requestId, caller, nodeId, worktreePath } = ctx;
    const abort = async (code: string, what: string, cause: string) => {
      note(nodeId, cause);
      await cleanup(nodeId, requestId, caller, worktreePath);
      return fail(code, `${what}。後始末した`, "しばらくして、別の requestId でもう一度試す");
    };
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
        worktreePath,
        scope: brief.scope,
        instruction: instructionOf(brief),
        mcp: { url: ports.mcpUrl, token },
      });
      if (!started.ok) {
        return abort(
          "startFailed",
          "子を起動できなかった",
          `起動に失敗: ${started.error.code}: ${started.error.cause}`,
        );
      }
    } catch (e) {
      return abort("startFailed", "子を起動できなかった", `起動が例外: ${String(e)}`);
    }
    // 起動に成功してから start を記録する（記録だけが残る経路をなくす）。記録に失敗したら、起動した子を止めて後始末する。
    const recorded = appendAtomically(log, deps.clock, `${requestId}/start`, { nodeId: caller }, [
      { type: "node.stateChanged", payload: { nodeId, event: { type: "start" } } },
    ]);
    if (!recorded.ok) {
      try {
        await adapter.stop(nodeId, { mode: "immediate", stopSeq: log.state().lastSeq });
      } catch (e) {
        note(nodeId, `起動した子を止められない: ${String(e)}`);
      }
      return abort(
        "startFailed",
        "子を起動できなかった",
        `起動を記録できない: ${recorded.error.code}: ${recorded.error.cause}`,
      );
    }
    return { ok: true, value: { nodeId } };
  }

  const dependsDone = (state: OrchState, dependsOn: readonly string[]): boolean =>
    dependsOn.every((d) => COMPLETED_STATES.has(stateOf(state, d) ?? "pending"));

  /** spawn・split の共通の本体。 */
  async function create(
    req: { requestId: string; caller: string },
    input: { parentId: string; role: NodeRecord["role"]; brief: BriefParams; tag: string },
  ): Promise<Result<{ nodeId: string }, Failure>> {
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
        return startNode(
          { requestId, caller, nodeId, worktreePath: provisioned.value.worktreePath },
          adapter,
          brief,
          role,
        );
      }
      return { ok: true, value: { nodeId } };
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
    if (
      typeof worktreePath !== "string" ||
      !worktreePath.startsWith("/") ||
      worktreePath.includes("\0") ||
      !isPathUnder(normalizePath("/", worktreePath), normalizePath("/", ports.worktreeRoot)) ||
      normalizePath("/", worktreePath) === normalizePath("/", ports.worktreeRoot)
    ) {
      note(nodeId, `作業ツリーのパスが置き場の外: ${String(worktreePath)}`);
      return fail("provisionFailed", "作業ツリーを作れなかった", "しばらくして、もう一度試す");
    }
    const abort = async (f: { ok: false; error: Failure }) => {
      await cleanup(nodeId, requestId, caller, worktreePath);
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
    if (!dependsDone(state, dependsOn)) return { ok: true, value: { nodeId } };
    return startNode({ requestId, caller, nodeId, worktreePath }, adapter, brief, role);
  }

  const fingerprintOf = (v: unknown): string => JSON.stringify(v);

  return {
    "node.spawn": (req: HandlerRequest<"node.spawn">): Promise<R<"node.spawn">> => {
      const { parentId, role, ...brief } = req.params;
      const caller = req.caller?.nodeId ?? "";
      return exclusive(`${caller}\0${req.requestId}`, fingerprintOf(req.params), () =>
        create({ requestId: req.requestId, caller }, { parentId, role, brief, tag: "spawn" }),
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
}
