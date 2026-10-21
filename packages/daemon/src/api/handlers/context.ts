/**
 * 窓口のハンドラの共通部品。イベントログへの追記（複数イベントを、事前に全体を検査してから追記する）と、
 * 要求から決定的に導く ID、受信箱の要約。
 *
 * - 複数イベントの操作は、派生した requestId（`<要求>:<番号>`）で追記する。同じ requestId の再試行は、追記済みの
 *   イベントを重複させず、残りを完了させる（冪等。NFR_003）。
 * - 追記の前に、core の `applyEvent` で、全イベントを順に適用できるかを検査する。途中で失敗する操作は、何も書かない。
 * - ID は、呼び出し元・要求 ID・用途から決定的に導く（再試行で同じ ID になる）。`isSafeId` を満たす。
 */

import { createHash } from "node:crypto";
import {
  type Actor,
  type EventBody,
  type Failure,
  failure,
  LIMITS,
  type OrchEvent,
  type OrchState,
  type Result,
  sanitizeText,
} from "@cso/core";
import type { AppendOutcome, AppendRequest, PurgeOutcome, PurgeRequest } from "../../eventlog.js";

/** イベントログの、ハンドラが使う部分（`EventLog` がそのまま満たす）。 */
export interface LogPort {
  state(): OrchState;
  append(request: AppendRequest): Result<AppendOutcome, Failure>;
  /** 複数のイベントを、1 トランザクションで追記する（1 件でも失敗したら全件を書かない）。 */
  appendAll(requests: readonly AppendRequest[]): Result<AppendOutcome[], Failure>;
  /** 木の最終削除（`EventLog.purgeTree`）。ないログ（試験用の簡易なもの）では、最終削除の操作を有効にしない。 */
  purgeTree?(request: PurgeRequest): Result<PurgeOutcome, Failure>;
  /** 最終削除の事前確認（ドライラン）。何も書かない。 */
  checkPurge?(request: PurgeRequest): Result<{ deleteCount: number }, Failure>;
}

/** 呼び出し元・要求 ID・用途から、決定的で `isSafeId` を満たす ID を導く。 */
export function deriveId(prefix: string, caller: string, requestId: string, tag: string): string {
  const h = createHash("sha256").update(`${caller}\0${requestId}\0${tag}`, "utf8").digest("hex");
  return `${prefix}-${h.slice(0, 32)}`;
}

/** 受信箱の要約: 空白を詰めて 1 行にし、上限に収める。 */
export const summarize = (text: string): string =>
  sanitizeText(text.replace(/\s+/g, " ").trim(), LIMITS.summary);

/** 呼び出し元を表す鍵（ノード ID・人間・システム）。内部の requestId を呼び出し元ごとに分けるのに使う。 */
const callerKey = (actor: Actor): string =>
  "nodeId" in actor ? actor.nodeId : "human" in actor ? "human" : "system";

/**
 * 内部（イベントログ）の requestId: `rq-<32 桁>:<番号>`。呼び出し元と要求の ID からハッシュで導く（固定長）。
 * 呼び出し元ごとに分けるので、別の呼び出し元が同じ要求 ID を使っても衝突せず、他の呼び出し元の存在が失敗の
 * メッセージに出ない。長い要求 ID も、core の識別子の上限（128 文字）に収まる。同じ呼び出し元の再試行は同じ値。
 */
export function derivedRequestId(actor: Actor, requestId: string, index: number): string {
  return `${deriveId("rq", callerKey(actor), requestId, "")}:${index}`;
}

export interface Appended {
  readonly state: OrchState;
  /** 追記した（または、重複として最初のものを返した）イベント。`bodies` と同じ順。 */
  readonly events: readonly OrchEvent[];
  /** 全件が追記済みの重複（同じ呼び出し元・同じ requestId・同じ内容）。何も書いていない。 */
  readonly duplicate: boolean;
}

/**
 * `bodies` を、呼び出し元ごとに派生した requestId で、1 トランザクションで追記する（`EventLog.appendAll`）。
 * 全件を順に検査しながら書き、1 件でも失敗したら何も書かない。同じ呼び出し元・同じ requestId の再試行は、
 * 追記済みを重複させず、残りを完了させる（冪等）。
 */
export function appendAtomically(
  log: LogPort,
  _clock: () => string,
  requestId: string,
  actor: Actor,
  bodies: readonly EventBody[],
): Result<Appended, Failure> {
  const r = log.appendAll(
    bodies.map((body, i) => ({ requestId: derivedRequestId(actor, requestId, i), actor, body })),
  );
  if (!r.ok) return { ok: false, error: toFailure(r.error) };
  return {
    ok: true,
    value: {
      state: log.state(),
      events: r.value.map((o) => o.event),
      duplicate: r.value.every((o) => !o.applied),
    },
  };
}

/** core の失敗（`seq` つき）を、窓口の失敗にそろえる。 */
function toFailure(e: Failure): Failure {
  return failure(e.code, e.cause, ...e.nextActions);
}

/** 要求の最初のイベントが追記済みか（再試行の判定）。 */
export const alreadyApplied = (state: OrchState, actor: Actor, requestId: string): boolean =>
  Object.hasOwn(state.requests, derivedRequestId(actor, requestId, 0));

export const fail = (
  code: string,
  cause: string,
  ...next: [string, ...string[]]
): { ok: false; error: Failure } => ({ ok: false, error: failure(code, cause, ...next) });
