/**
 * イベントログ（追記と復元）。NFR_002, NFR_003, NFR_011 / design 5 章
 *
 * 状態の導出は core の `applyEvent`・`foldEvents` だけを使う（このファイルは導出を持たない）。
 * - 追記は 1 トランザクションで、seq 採番・追記前の検査（`applyEvent`）・保存を行う。
 *   検査で失敗したイベントは保存せず、seq も消費しない。ストアの失敗でも状態は変わらない。
 * - 同じ `requestId` の再試行は、行を増やさず最初のイベントを返す（冪等）。
 * - 復元は、スナップショット（キャッシュ）から再開する。壊れていれば捨ててログ全体から再構築する。
 * - 壊れた行は例外でなく失敗（`corruptRow`）として返す。
 * - 時計が例外・不正な形式（ISO 8601 UTC でない）なら `invalidClock` で失敗する（何も書かない）。
 *
 * ライフサイクル: ストアを開いた側が閉じる責任を持つ（`EventLog` はストアを閉じない）。
 * スナップショットは、状態のスキーマの版と、末尾のイベントのハッシュが合うときだけ使う。`verifySnapshot` を指定すると、
 * さらにログ全体の畳み込みと突き合わせ、食い違えば捨てる（起動時の追加の検査。既定は無効）。
 */

import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  type Actor,
  applyEvent,
  type EventBody,
  type Failure,
  failure,
  foldEvents,
  initialState,
  isValidInboxTime,
  type OrchEvent,
  type OrchState,
  ok,
  purgeEventSeqs,
  type Result,
} from "@cso/core";
import { type EventStore, type StoredEvent, StoreIntegrityError } from "./event-store.js";

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
  /** 起動時に、スナップショットから復元した状態を、ログ全体の畳み込みと突き合わせる。既定は無効。 */
  readonly verifySnapshot?: boolean;
  /** `verifySnapshot` で、スナップショットがログ全体の畳み込みと食い違い、捨てたときの通知（運用の記録用）。 */
  readonly onSnapshotMismatch?: () => void;
  /**
   * 最終削除の後に、追記のみの保証を確かめられなかったとき（`StoreIntegrityError`）に呼ぶ。以降、このログは書き込みを拒否する
   * （`logBroken`）ので、呼び出し側は daemon を止める（fail closed）。
   */
  readonly onFatal?: (cause: string) => void;
}

/** 最終削除の要求。`marker` は、削除の後に残す標識のイベント（`node.purged`）。 */
export interface PurgeRequest {
  readonly requestId: string;
  readonly actor: Actor;
  /** 削除する木のノード（`planPurge` の結果）。 */
  readonly nodeIds: readonly string[];
  readonly marker: EventBody;
}

export interface PurgeOutcome {
  /** 標識のイベント。`applied: false` のときは、同じ `requestId` で先に記録された標識。 */
  readonly event: OrchEvent;
  readonly applied: boolean;
  /** 消した行数。 */
  readonly deleted: number;
}

/** スナップショットに保存する core の状態のスキーマの版。`OrchState` の形を変えたら上げる（2: 停止の試行・観測の記録を追加、3: 範囲外のツール拒否・予期しない終了・報告の記録と、判断要求の内容を追加、4: 範囲の拡張要求・追加指示の記録と、ノードのブリーフ・判断要求の止める子を追加、5: 破棄の判断・アーカイブ時刻・指示の配送の記録を追加、6: 受信箱の項目の解決済みの記録を追加、7: 最終削除の標識〔tombstones〕を追加）。 */
export const STATE_VERSION = 7;

/** イベントの行のハッシュ（SHA-256、16 進）。スナップショットがログと食い違っていないかを確かめる。 */
export function eventHash(row: StoredEvent): string {
  return createHash("sha256")
    .update(JSON.stringify([row.seq, row.at, row.requestId, row.actor, row.type, row.payload]))
    .digest("hex");
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

function foldAll(store: EventStore): Result<OrchState, Failure> {
  const all = parseRows(store.readAll());
  if (!all.ok) return all;
  return foldEvents(all.value, initialState());
}

/** スナップショットから復元する。使えない（版・ハッシュ・形が合わない、畳み込みに失敗する）ときは `undefined`。 */
function restoreFromSnapshot(store: EventStore): OrchState | undefined {
  const snap = store.loadSnapshot();
  if (snap === undefined || snap.stateVersion !== STATE_VERSION || !Number.isInteger(snap.lastSeq))
    return undefined;
  if (snap.lastSeq > store.lastSeq()) return undefined;
  const last = store.findBySeq(snap.lastSeq);
  if (last === undefined || eventHash(last) !== snap.lastEventHash) return undefined;
  const base = parseSnapshotState(snap.state, snap.lastSeq);
  if (base === undefined) return undefined;
  const rows = parseRows(store.readAfter(snap.lastSeq));
  if (!rows.ok) return undefined;
  const folded = foldEvents(rows.value, base);
  return folded.ok ? folded.value : undefined;
}

function restore(
  store: EventStore,
  verify: boolean,
  onMismatch?: () => void,
): Result<OrchState, Failure> {
  const fromSnapshot = restoreFromSnapshot(store);
  if (fromSnapshot !== undefined) {
    if (!verify) return ok(fromSnapshot);
    const full = foldAll(store);
    // 突き合わせで食い違えば、スナップショットを捨てて、ログ全体の結果を使う。
    if (full.ok && isDeepStrictEqual(full.value, fromSnapshot)) return ok(fromSnapshot);
    try {
      onMismatch?.();
    } catch {
      // 通知の失敗は、復元を止めない
    }
    return full;
  }
  return foldAll(store);
}

export class EventLog {
  private constructor(
    private readonly store: EventStore,
    private readonly clock: () => string,
    private readonly snapshotEvery: number,
    private current: OrchState,
    private readonly onFatal?: (cause: string) => void,
  ) {}

  /** 最終削除の後の保証が確かめられなかった。以降の書き込みを拒否する。 */
  private broken = false;

  private brokenFailure(): Failure {
    return failure(
      "logBroken",
      "最終削除の後に、イベントログの追記のみの保証を確かめられなかったため、書き込みを止めている",
      "daemon を止めて、イベントログのファイルを確認する",
    );
  }

  /** ストアから状態を復元して開く。壊れた行・矛盾したログは、例外でなく失敗として返す。 */
  static open(store: EventStore, options: EventLogOptions): Result<EventLog, Failure> {
    let restored: Result<OrchState, Failure>;
    try {
      restored = restore(store, options.verifySnapshot === true, options.onSnapshotMismatch);
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
    return ok(
      new EventLog(
        store,
        options.clock,
        options.snapshotEvery ?? 1000,
        restored.value,
        options.onFatal,
      ),
    );
  }

  state(): OrchState {
    return this.current;
  }

  /**
   * イベントを追記する。検査に失敗したら何も書かず、seq も消費しない。
   * 同じ `requestId` で同一内容の再試行は、行を増やさず最初のイベントを返す。
   */
  append(request: AppendRequest): Result<AppendOutcome, Failure> {
    if (this.broken) return { ok: false, error: this.brokenFailure() };
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
    // 標識（node.purged）を書けるのは、最終削除（purgeTree）だけ。追記の入口からは受け付けない。
    if (request.body.type === "node.purged") {
      return {
        ok: false,
        error: failure(
          "invalidRequest",
          "node.purged は、追記の入口からは書けない（最終削除だけが書く）",
          "最終削除の操作を使う",
        ),
      };
    }
    let at: string;
    try {
      at = this.clock();
    } catch (e) {
      return {
        ok: false,
        error: failure("invalidClock", `時計の取得に失敗: ${String(e)}`, "時計の設定を確認する"),
      };
    }
    if (typeof at !== "string" || !isValidInboxTime(at)) {
      return {
        ok: false,
        error: failure("invalidClock", "時計の値が ISO 8601（UTC）でない", "時計の設定を確認する"),
      };
    }
    let next: OrchState | undefined;
    try {
      const result = this.store.transaction((): Result<AppendOutcome, Failure> => {
        const event = {
          seq: this.current.lastSeq + 1,
          at,
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
        const row = toRow(event);
        this.store.append(row);
        if (this.snapshotEvery > 0 && event.seq % this.snapshotEvery === 0) {
          this.store.saveSnapshot({
            lastSeq: event.seq,
            state: JSON.stringify(r.value.state),
            stateVersion: STATE_VERSION,
            lastEventHash: eventHash(row),
          });
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

  /**
   * 複数のイベントを、1 トランザクションで追記する（`seq` は連番）。全件を順に検査しながら書き、1 件でも失敗したら
   * 全件をロールバックして、何も書かず、状態も `seq` も変えない。追記済みの要求（同じ `requestId`・同一内容）は
   * 重複として最初のイベントを返し（`applied: false`）、残りを追記する（再試行で完了する）。
   */
  appendAll(requests: readonly AppendRequest[]): Result<AppendOutcome[], Failure> {
    if (this.broken) return { ok: false, error: this.brokenFailure() };
    if (
      !Array.isArray(requests) ||
      requests.length === 0 ||
      !requests.every(
        (r) => isRec(r) && typeof r.requestId === "string" && isRec(r.body) && isRec(r.actor),
      )
    ) {
      return {
        ok: false,
        error: failure(
          "invalidRequest",
          "追記の要求の形が不正（1 件以上の { requestId, actor, body }）",
          "requestId・actor・body を確認する",
        ),
      };
    }
    let at: string;
    try {
      at = this.clock();
    } catch (e) {
      return {
        ok: false,
        error: failure("invalidClock", `時計の取得に失敗: ${String(e)}`, "時計の設定を確認する"),
      };
    }
    if (typeof at !== "string" || !isValidInboxTime(at)) {
      return {
        ok: false,
        error: failure("invalidClock", "時計の値が ISO 8601（UTC）でない", "時計の設定を確認する"),
      };
    }
    class Abort extends Error {
      constructor(readonly failure: Failure) {
        super(failure.code);
      }
    }
    let next: OrchState | undefined;
    try {
      const outcomes = this.store.transaction((): AppendOutcome[] => {
        let state = this.current;
        const out: AppendOutcome[] = [];
        for (const request of requests) {
          const event = {
            seq: state.lastSeq + 1,
            at,
            requestId: request.requestId,
            actor: request.actor,
            ...request.body,
          } as OrchEvent;
          const r = applyEvent(state, event);
          if (!r.ok) throw new Abort(r.error);
          if (!r.value.applied) {
            const stored = this.store.findByRequestId(request.requestId);
            const first = stored === undefined ? undefined : parseRow(stored);
            if (first === undefined || !first.ok) {
              throw new Abort(
                failure(
                  "corruptRow",
                  `requestId ${request.requestId} の最初の行を読み出せない`,
                  "ログの行を確認する",
                ),
              );
            }
            out.push({ event: first.value, applied: false, state });
            continue;
          }
          const row = toRow(event);
          this.store.append(row);
          if (this.snapshotEvery > 0 && event.seq % this.snapshotEvery === 0) {
            this.store.saveSnapshot({
              lastSeq: event.seq,
              state: JSON.stringify(r.value.state),
              stateVersion: STATE_VERSION,
              lastEventHash: eventHash(row),
            });
          }
          state = r.value.state;
          out.push({ event, applied: true, state });
        }
        next = state;
        return out;
      });
      if (next !== undefined) this.current = next; // コミット後に反映する
      return ok(outcomes);
    } catch (e) {
      if (e instanceof Abort) return { ok: false, error: e.failure };
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

  /**
   * 最終削除の準備（書き込まない）: 消す行の特定と、残りの行 + 標識の畳み込みの検証。畳み込めない・結果のノードが想定と
   * 合わないときは `purgeUnsafe`（原因のイベントの種類と `seq` を含める）。実行（`purgeTree`）と事前確認（`checkPurge`）が共有する。
   */
  private preparePurge(
    request: PurgeRequest,
  ): Result<{ event: OrchEvent; seqs: number[]; folded: { value: OrchState } }, Failure> {
    const unsafe = (cause: string): Result<never, Failure> => ({
      ok: false,
      error: failure(
        "purgeUnsafe",
        `最終削除を安全に行えない（${cause}）`,
        "削除する木・依存関係を確認する",
      ),
    });
    const at = this.clock();
    if (typeof at !== "string" || !isValidInboxTime(at)) {
      return {
        ok: false,
        error: failure("invalidClock", "時計の値が ISO 8601（UTC）でない", "時計の設定を確認する"),
      };
    }
    const set = new Set(request.nodeIds);
    const current = new Set(this.current.nodes.map((n) => n.id));
    for (const id of set) {
      if (!current.has(id)) return unsafe(`ノード ${id} が存在しない`);
    }
    const parsed = parseRows(this.store.readAll());
    if (!parsed.ok) return parsed;
    const seqs = purgeEventSeqs(parsed.value, set);
    const dropped = new Set(seqs);
    const event = {
      seq: Math.max(this.current.lastSeq, this.store.lastSeq()) + 1,
      at,
      requestId: request.requestId,
      actor: request.actor,
      ...request.marker,
    } as OrchEvent;
    const remaining = [...parsed.value.filter((e) => !dropped.has(e.seq)), event];
    const folded = foldEvents(remaining, initialState());
    if (!folded.ok) {
      const cause = remaining.find((e) => e.seq === folded.error.seq);
      return unsafe(
        `残りのログを畳み込めない。原因のイベント: ${cause?.type ?? "不明"}（seq ${folded.error.seq}）: ${folded.error.cause}`,
      );
    }
    const expected = [...current].filter((id) => !set.has(id)).sort();
    const actual = folded.value.nodes.map((n) => n.id).sort();
    if (!isDeepStrictEqual(expected, actual)) return unsafe("削除後のノードが、想定と合わない");
    return ok({ event, seqs, folded: { value: folded.value } });
  }

  /** 最終削除の事前確認（ドライラン）。何も書かない。実行（`purgeTree`）と同じ検証で、拒否の理由を返す。 */
  checkPurge(request: PurgeRequest): Result<{ deleteCount: number }, Failure> {
    if (this.broken) return { ok: false, error: this.brokenFailure() };
    try {
      const prepared = this.preparePurge(request);
      return prepared.ok ? ok({ deleteCount: prepared.value.seqs.length }) : prepared;
    } catch (e) {
      return {
        ok: false,
        error: failure(
          "storeError",
          `最終削除の確認に失敗: ${String(e)}`,
          "ストアの状態を確認する",
        ),
      };
    }
  }

  /**
   * 木の最終削除（FR_031）。木のノードを主語とするイベントの行を物理削除し、同じトランザクションで標識 `marker` を追記する
   * （最大の `seq` + 1。消した `seq` は再利用されない）。実行前に、残りの行 + 標識を畳み込み、成功すること、結果のノードが
   * 「現在のノードから木を除いたもの」と一致することを確かめる。合わなければ何も消さずに `purgeUnsafe` で拒否する。
   * 同じ `requestId` の再送は、何も消さずに最初の標識を返す。追記のみの保証を確かめられなければ `storeIntegrity` を返し、
   * `onFatal` を呼んで、以降の書き込みを拒否する。
   */
  purgeTree(request: PurgeRequest): Result<PurgeOutcome, Failure> {
    if (this.broken) return { ok: false, error: this.brokenFailure() };
    try {
      const stored = this.store.findByRequestId(request.requestId);
      if (stored !== undefined) {
        const first = parseRow(stored);
        if (!first.ok) return first;
        return ok({ event: first.value, applied: false, deleted: 0 });
      }
      const prepared = this.preparePurge(request);
      if (!prepared.ok) return prepared;
      const { event, seqs, folded } = prepared.value;
      try {
        this.store.purgeRows(seqs, toRow(event));
      } catch (e) {
        if (e instanceof StoreIntegrityError) {
          this.current = folded.value; // 削除はコミット済み（確認だけが失敗した）。状態はコミットした結果にそろえる
          this.broken = true;
          try {
            this.onFatal?.(e.message);
          } catch {
            // 通知の失敗は、書き込みの停止を妨げない
          }
          return {
            ok: false,
            error: failure(
              "storeIntegrity",
              e.message,
              "daemon を止めて、イベントログのファイルを確認する",
            ),
          };
        }
        return {
          ok: false,
          error: failure(
            "storeError",
            `最終削除に失敗した（何も変わっていない）: ${String(e)}`,
            "ストアの状態を確認する",
            "同じ requestId で再試行する",
          ),
        };
      }
      this.current = folded.value;
      return ok({ event, applied: true, deleted: seqs.length });
    } catch (e) {
      return {
        ok: false,
        error: failure("storeError", `最終削除に失敗: ${String(e)}`, "ストアの状態を確認する"),
      };
    }
  }
}
