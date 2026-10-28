/**
 * daemon の再起動のあとに、Desktop の子（daemon の外で動く子）を人に確かめてもらう、根の受信箱の依頼（T21・C2-4）。
 *
 * - 依頼は、起動時の照合（`reconcile.ts`）が、未解決のものを常に 1 件だけ置く: 未解決の古い依頼（前の版の文面を含む）は、
 *   解決済みにしてから、今の対象の子で新しい依頼を出す（置き換え）。対象の子がいなければ、出さない。
 * - 記録で動作中・判断待ち・停止中・停止未完了の子が 1 つもなくなったら、未解決の依頼を、system が解決済みにする
 *   （停止の宣言・完了などで状態が変わったとき。対象の ID は持たず、今の木全体で判断する）。
 * - 記録の形は変えない（`inbox.added`・`inbox.resolved` だけ）。
 *
 * 包む経路（追記が成功したあとに、解決を判断する。`withExternalCheckResolution`）:
 * - 操作のハンドラ（停止の宣言・完了の報告・受理・停止など、ノードの状態を変える操作は、すべてここを通る）。
 * - Desktop のアダプタの記録口（停止の代行依頼の `stopTimeout` など）。
 * 包まない経路: 配下の要約（digest）・窓口の警告（api-alert）・自動の最終削除（auto-purge）・起こす指示（wake）・回答の配送の
 * やり直し。これらは受信箱の項目と指示を書くだけで、子の状態を「動いているかもしれない」から外さないので、解決の判断が要らない
 * （起動時の照合でも、同じ判断をする）。
 *
 * 停止の追記のあとは、子は停止中（stopping）のままなので、解決は起きない（記録が増えない）。`pause-handlers.ts`・
 * `spawn-handlers.ts` は、停止の要求を追記したあとの `log.state().lastSeq` を、停止の要求の seq として使っているので、
 * この前提が崩れたら（停止の追記のあとに、解決の追記が起きうるようになったら）、追記の結果の seq を使う形に直すこと
 * （tasks.md の T21-ec2）。
 */

import type { Actor, EventBody, OrchState } from "@cso/core";
import type { LogPort } from "./api/handlers/context.js";

/**
 * 依頼の文面（固定。依頼の判定にも使う）。詳しい手順は `docs/desktop-runtime.md` の「根の受信箱の 1 件で、人に確かめてもらうこと」。
 */
export const EXTERNAL_CHECK_SUMMARY =
  "daemon 再起動後: 子は止まったと決めつけず、Desktop で子ごとに確かめ、アーカイブし、止まりを確かめて宣言（desktop-runtime.md）";

/**
 * 前の版の文面（記録に残っている未解決の依頼も、同じ依頼として扱う。置き換え・解決の対象にする）。
 * 固定文を変えるときは、その時点の文面をここに足す。
 */
const LEGACY_EXTERNAL_CHECK_SUMMARIES: readonly string[] = [
  "daemon の再起動のあと、Desktop の子の状態は daemon から確かめられない。Desktop で確かめ、止まっていれば停止して止めたと宣言する（仮置き）",
];

export const isExternalCheck = (summary: string | undefined): boolean =>
  summary !== undefined &&
  [EXTERNAL_CHECK_SUMMARY, ...LEGACY_EXTERNAL_CHECK_SUMMARIES].some((s) => summary.startsWith(s));

/** 確かめてもらう対象の状態（記録で、まだ動いているかもしれない子）。 */
export const EXTERNAL_LIVE_STATES: ReadonlySet<string> = new Set([
  "running",
  "waiting",
  "stopping",
  "stopIncomplete",
]);

const SYSTEM: Actor = { system: true };

/** 未解決の依頼の ID。 */
export const openExternalChecks = (state: OrchState): string[] =>
  state.inbox
    .filter((i) => i.resolved === undefined && isExternalCheck(i.summary))
    .map((i) => i.id);

/** 記録で、まだ動いているかもしれない Desktop の子（根を除く。`isExternal` が真のもの）がいるか。 */
export const hasLiveChild = (
  state: OrchState,
  isExternal: (nodeId: string) => boolean = () => true,
): boolean =>
  state.nodes.some(
    (n) => n.parentId !== null && EXTERNAL_LIVE_STATES.has(n.state) && isExternal(n.id),
  );

/** 依頼を解決済みにする記録（system）。 */
export const resolveExternalCheckBodies = (ids: readonly string[]): EventBody[] =>
  ids.map((itemId): EventBody => ({ type: "inbox.resolved", payload: { itemId } }));

/**
 * 動いているかもしれない子が 1 つもなければ、未解決の依頼を解決済みにする。1 件ずつ、項目の ID から決まる要求 ID で書く
 * （同じ項目の再実行は重複しない）。
 */
export function resolveStaleExternalChecks(
  log: Pick<LogPort, "state" | "append">,
  isExternal: (nodeId: string) => boolean = () => true,
  onFailure?: (cause: string) => void,
): void {
  const state = log.state();
  const open = openExternalChecks(state);
  if (open.length === 0 || hasLiveChild(state, isExternal)) return;
  for (const itemId of open) {
    const r = log.append({
      requestId: `external-check-resolved-${itemId}`,
      actor: SYSTEM,
      body: { type: "inbox.resolved", payload: { itemId } },
    });
    if (!r.ok) onFailure?.(`依頼を解決済みにできない: ${r.error.cause}`);
  }
}

/** 任意の口を、元のログに結び付けて渡す（`this` を失わない）。 */
function optional(log: LogPort): Partial<LogPort> {
  const out: {
    actorsAfter?: NonNullable<LogPort["actorsAfter"]>;
    purgeTree?: NonNullable<LogPort["purgeTree"]>;
    checkPurge?: NonNullable<LogPort["checkPurge"]>;
    firstEventOf?: NonNullable<LogPort["firstEventOf"]>;
  } = {};
  if (log.actorsAfter !== undefined) out.actorsAfter = log.actorsAfter.bind(log);
  if (log.purgeTree !== undefined) out.purgeTree = log.purgeTree.bind(log);
  if (log.checkPurge !== undefined) out.checkPurge = log.checkPurge.bind(log);
  if (log.firstEventOf !== undefined) out.firstEventOf = log.firstEventOf.bind(log);
  return out;
}

/**
 * 追記が成功したあとに、`resolveStaleExternalChecks` を呼ぶログ（操作のハンドラに渡す。Desktop の子のときだけ使う）。
 * 解決の追記は、元のログに書く（この包みを通らないので、繰り返さない）。
 */
export function withExternalCheckResolution(
  log: LogPort,
  isExternal: (nodeId: string) => boolean,
  onFailure?: (cause: string) => void,
): LogPort {
  const after = (): void => {
    try {
      resolveStaleExternalChecks(log, isExternal, onFailure);
    } catch (e) {
      onFailure?.(`依頼を解決済みにできない: ${String(e)}`);
    }
  };
  return {
    state: () => log.state(),
    append: (request) => {
      const r = log.append(request);
      if (r.ok) after();
      return r;
    },
    appendAll: (requests) => {
      const r = log.appendAll(requests);
      if (r.ok) after();
      return r;
    },
    ...optional(log),
  };
}
