/**
 * イベントログ（追記と復元）。NFR_002, NFR_003, NFR_011 / design 5 章
 *
 * 状態の導出は core の `applyEvent`・`foldEvents` だけを使う（このファイルは導出を持たない）。
 * - 追記は 1 トランザクションで、seq 採番・追記前の検査（`applyEvent`）・保存を行う。
 *   検査で失敗したイベントは保存せず、seq も消費しない。ストアの失敗でも状態は変わらない。
 * - 同じ `requestId` の再試行は、行を増やさず最初のイベントを返す（冪等）。
 * - 復元は、スナップショット（キャッシュ）から再開する。壊れていれば捨ててログ全体から再構築する。
 * - 壊れた行は例外でなく失敗（`corruptRow`）として返す。
 */

import {
  type Actor,
  applyEvent,
  type EventBody,
  type Failure,
  failure,
  foldEvents,
  initialState,
  type OrchEvent,
  type OrchState,
  ok,
  type Result,
} from "@cso/core";
import type { EventStore, StoredEvent } from "./event-store.js";

export interface AppendRequest {
  readonly requestId: string;
  readonly actor: Actor;
  readonly body: EventBody;
}

export interface AppendOutcome {
  readonly event: OrchEvent;
  /** `false` のときは、同じ `requestId` で同一内容の重複で、最初のイベントを返している。 */
  readonly applied: boolean;
  readonly state: OrchState;
}

export interface EventLogOptions {
  /** 時刻（ISO 8601 UTC）。daemon が付与する。 */
  readonly clock: () => string;
  /** このイベント数ごとにスナップショットを保存する。0 以下で保存しない。既定 1000。 */
  readonly snapshotEvery?: number;
}

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const isArr = (x: unknown): x is unknown[] => Array.isArray(x);

const corrupt = (seq: number, what: string): Failure =>
  failure(
    "corruptRow",
    `seq ${seq} の行が壊れている: ${what}`,
    "ログの行を確認する",
    "バックアップから復元する",
  );

/** 保存された行をイベントに戻す。形の検査は最小限にし、中身の検証は core の畳み込みが行う。 */
function parseRow(r: StoredEvent): Result<OrchEvent, Failure> {
  const seq = isRec(r) && Number.isInteger(r.seq) ? r.seq : 0;
  if (!isRec(r) || !Number.isInteger(r.seq))
    return { ok: false, error: corrupt(seq, "seq が整数でない") };
  if (typeof r.requestId !== "string" || typeof r.at !== "string" || typeof r.type !== "string") {
    return { ok: false, error: corrupt(seq, "requestId・at・type が文字列でない") };
  }
  if (r.type === "") return { ok: false, error: corrupt(seq, "type が空") };
  let actor: unknown;
  let payload: unknown;
  try {
    actor = JSON.parse(r.actor);
    payload = JSON.parse(r.payload);
  } catch {
    return { ok: false, error: corrupt(seq, "actor または payload が JSON でない") };
  }
  if (!isRec(actor) || !isRec(payload)) {
    return { ok: false, error: corrupt(seq, "actor または payload がオブジェクトでない") };
  }
  return ok({
    seq,
    at: r.at,
    requestId: r.requestId,
    actor,
    type: r.type,
    payload,
  } as unknown as OrchEvent);
}

const toRow = (e: OrchEvent): StoredEvent => ({
  seq: e.seq,
  at: e.at,
  requestId: e.requestId,
  actor: JSON.stringify(e.actor),
  type: e.type,
  payload: JSON.stringify(e.payload),
});

/** スナップショットの状態を検査する（キャッシュなので、少しでも怪しければ捨てる）。 */
function parseSnapshotState(json: string, lastSeq: number): OrchState | undefined {
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (!isRec(v) || v.lastSeq !== lastSeq || !isRec(v.requests)) return undefined;
  const { nodes, inbox, decisions, violations } = v;
  if (!isArr(nodes) || !isArr(inbox) || !isArr(decisions) || !isArr(violations)) return undefined;
  const nodeOk = (n: unknown): boolean =>
    isRec(n) &&
    typeof n.id === "string" &&
    typeof n.role === "string" &&
    typeof n.state === "string" &&
    (n.parentId === null || typeof n.parentId === "string") &&
    isArr(n.dependsOn);
  if (!nodes.every(nodeOk)) return undefined;
  if (!inbox.every((i) => isRec(i) && typeof i.id === "string" && typeof i.nodeId === "string"))
    return undefined;
  if (!decisions.every((d) => isRec(d) && typeof d.decisionId === "string" && isArr(d.rejected)))
    return undefined;
  if (!violations.every((x) => isRec(x) && typeof x.nodeId === "string")) return undefined;
  return v as unknown as OrchState;
}

function parseRows(rows: readonly StoredEvent[]): Result<OrchEvent[], Failure> {
  const out: OrchEvent[] = [];
  for (const r of rows) {
    const e = parseRow(r);
    if (!e.ok) return e;
    out.push(e.value);
  }
  return ok(out);
}

function restore(store: EventStore): Result<OrchState, Failure> {
  const snap = store.loadSnapshot();
  if (snap !== undefined && Number.isInteger(snap.lastSeq) && snap.lastSeq <= store.lastSeq()) {
    const base = parseSnapshotState(snap.state, snap.lastSeq);
    if (base !== undefined) {
      const rows = parseRows(store.readAfter(snap.lastSeq));
      if (rows.ok) {
        const folded = foldEvents(rows.value, base);
        if (folded.ok) return folded;
      }
      // スナップショットとの組み合わせで失敗したら、キャッシュを疑ってログ全体から再構築する。
    }
  }
  const all = parseRows(store.readAll());
  if (!all.ok) return all;
  return foldEvents(all.value, initialState());
}

export class EventLog {
  private constructor(
    private readonly store: EventStore,
    private readonly clock: () => string,
    private readonly snapshotEvery: number,
    private current: OrchState,
  ) {}

  /** ストアから状態を復元して開く。壊れた行・矛盾したログは、例外でなく失敗として返す。 */
  static open(store: EventStore, options: EventLogOptions): Result<EventLog, Failure> {
    let restored: Result<OrchState, Failure>;
    try {
      restored = restore(store);
    } catch (e) {
      return {
        ok: false,
        error: failure(
          "storeError",
          `ストアの読み出しに失敗: ${String(e)}`,
          "ストアの状態を確認する",
        ),
      };
    }
    if (!restored.ok) return restored;
    return ok(new EventLog(store, options.clock, options.snapshotEvery ?? 1000, restored.value));
  }

  state(): OrchState {
    return this.current;
  }

  /**
   * イベントを追記する。検査に失敗したら何も書かず、seq も消費しない。
   * 同じ `requestId` で同一内容の再試行は、行を増やさず最初のイベントを返す。
   */
  append(request: AppendRequest): Result<AppendOutcome, Failure> {
    if (
      !isRec(request) ||
      typeof request.requestId !== "string" ||
      !isRec(request.body) ||
      !isRec(request.actor)
    ) {
      return {
        ok: false,
        error: failure(
          "invalidRequest",
          "追記の要求の形が不正",
          "requestId・actor・body を確認する",
        ),
      };
    }
    let next: OrchState | undefined;
    try {
      const result = this.store.transaction((): Result<AppendOutcome, Failure> => {
        const event = {
          seq: this.current.lastSeq + 1,
          at: this.clock(),
          requestId: request.requestId,
          actor: request.actor,
          ...request.body,
        } as OrchEvent;
        const r = applyEvent(this.current, event);
        if (!r.ok) return r;
        if (!r.value.applied) {
          const stored = this.store.findByRequestId(request.requestId);
          const first = stored === undefined ? undefined : parseRow(stored);
          if (first === undefined || !first.ok) {
            return {
              ok: false,
              error: failure(
                "corruptRow",
                `requestId ${request.requestId} の最初の行を読み出せない`,
                "ログの行を確認する",
              ),
            };
          }
          return ok({ event: first.value, applied: false, state: this.current });
        }
        this.store.append(toRow(event));
        if (this.snapshotEvery > 0 && event.seq % this.snapshotEvery === 0) {
          this.store.saveSnapshot({ lastSeq: event.seq, state: JSON.stringify(r.value.state) });
        }
        next = r.value.state;
        return ok({ event, applied: true, state: r.value.state });
      });
      if (result.ok && next !== undefined) this.current = next; // コミット後に反映する
      return result;
    } catch (e) {
      return {
        ok: false,
        error: failure(
          "storeError",
          `ストアへの書き込みに失敗: ${String(e)}`,
          "ストアの状態を確認する",
          "同じ requestId で再試行する",
        ),
      };
    }
  }
}
