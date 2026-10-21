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
  applyEvent,
  type EventBody,
  type Failure,
  failure,
  LIMITS,
  type OrchEvent,
  type OrchState,
  type Result,
  sanitizeText,
} from "@cso/core";
import type { AppendOutcome, AppendRequest } from "../../eventlog.js";

/** イベントログの、ハンドラが使う部分（`EventLog` がそのまま満たす）。 */
export interface LogPort {
  state(): OrchState;
  append(request: AppendRequest): Result<AppendOutcome, Failure>;
}

/** 呼び出し元・要求 ID・用途から、決定的で `isSafeId` を満たす ID を導く。 */
export function deriveId(prefix: string, caller: string, requestId: string, tag: string): string {
  const h = createHash("sha256").update(`${caller}\0${requestId}\0${tag}`, "utf8").digest("hex");
  return `${prefix}-${h.slice(0, 32)}`;
}

/** 受信箱の要約: 空白を詰めて 1 行にし、上限に収める。 */
export const summarize = (text: string): string =>
  sanitizeText(text.replace(/\s+/g, " ").trim(), LIMITS.summary);

export interface Appended {
  readonly state: OrchState;
}

/**
 * `bodies` を、派生した requestId で順に追記する。追記の前に、全体を適用できるか検査し、失敗なら何も書かない。
 * 追記の途中でストアが失敗したら、同じ requestId での再試行を促す失敗を返す。
 */
export function appendAtomically(
  log: LogPort,
  clock: () => string,
  requestId: string,
  actor: Actor,
  bodies: readonly EventBody[],
): Result<Appended, Failure> {
  let probe = log.state();
  const at = clock();
  for (const [i, body] of bodies.entries()) {
    const event = {
      seq: probe.lastSeq + 1,
      at,
      requestId: `${requestId}:${i}`,
      actor,
      ...body,
    } as OrchEvent;
    const r = applyEvent(probe, event);
    if (!r.ok) return { ok: false, error: toFailure(r.error) };
    probe = r.value.state;
  }
  for (const [i, body] of bodies.entries()) {
    const r = log.append({ requestId: `${requestId}:${i}`, actor, body });
    if (!r.ok) {
      const cause = `${r.error.cause}（${i + 1}/${bodies.length} 件目で失敗）`;
      return {
        ok: false,
        error: failure(
          r.error.code,
          cause,
          "同じ requestId でもう一度試す",
          ...r.error.nextActions,
        ),
      };
    }
  }
  return { ok: true, value: { state: log.state() } };
}

/** core の失敗（`seq` つき）を、窓口の失敗にそろえる。 */
function toFailure(e: Failure): Failure {
  return failure(e.code, e.cause, ...e.nextActions);
}

/** 要求の最初のイベントが追記済みか（再試行の判定）。 */
export const alreadyApplied = (state: OrchState, requestId: string): boolean =>
  Object.hasOwn(state.requests, `${requestId}:0`);

export const fail = (
  code: string,
  cause: string,
  ...next: [string, ...string[]]
): { ok: false; error: Failure } => ({ ok: false, error: failure(code, cause, ...next) });
