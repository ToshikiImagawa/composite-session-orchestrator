/**
 * イベントログの永続化の境界。ドライバー（SQLite など）をこのインターフェースの裏に隠し、
 * 差し替え可能にする（例: better-sqlite3 → node:sqlite）。状態の導出は持たない（core の foldEvents が唯一）。
 * 同期 API とする（daemon は単一プロセスで、追記は 1 トランザクションの seq 採番）。
 *
 * ライフサイクル: ストアを開いた側が閉じる責任を持つ（`EventLog` は閉じない）。実装は、同じ保存先を二重に開けない
 * ようにしてよい（SQLite 実装は排他ロックで拒否する）。
 */

/** 保存する 1 行。`actor`・`payload` は JSON 文字列のまま持ち、読み出しの検証は EventLog が行う。 */
export interface StoredEvent {
  readonly seq: number;
  readonly at: string;
  readonly requestId: string;
  readonly actor: string;
  readonly type: string;
  readonly payload: string;
}

/** 状態のスナップショット（写しではなくキャッシュ。壊れていれば捨てて、ログから再構築できる）。 */
export interface StoredSnapshot {
  readonly lastSeq: number;
  /** 状態の JSON 文字列。 */
  readonly state: string;
  /** core の状態のスキーマの版。異なる版のスナップショットは使わない。 */
  readonly stateVersion: number;
  /** `lastSeq` のイベントの行のハッシュ。ログと食い違うスナップショットを見つけるため。 */
  readonly lastEventHash: string;
}

/**
 * 最終削除の後に、追記のみの保証（トリガー）が戻っていることを確かめられなかった。ストアは信用できないので、
 * 呼び出し側は以降の書き込みを止める（fail closed）。通常の失敗（ロールバックされた）は、この型でない例外。
 */
export class StoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreIntegrityError";
  }
}

export interface EventStore {
  /** 保存済みの行を `seq` の昇順で返す。 */
  readAll(): StoredEvent[];
  /** `seq` が指定より大きい行を昇順で返す。 */
  readAfter(seq: number): StoredEvent[];
  /** 保存済みの最大の `seq`。空なら 0。 */
  lastSeq(): number;
  findByRequestId(requestId: string): StoredEvent | undefined;
  findBySeq(seq: number): StoredEvent | undefined;
  /** 行を追記する。`seq`・`requestId` の重複は例外（一意制約）。 */
  append(row: StoredEvent): void;
  /** `fn` を 1 つのトランザクションで実行する。例外ならロールバックして再送出する。 */
  transaction<T>(fn: () => T): T;
  /**
   * 最終削除専用の物理削除（追記のみの原則の、唯一の例外。追記・更新の経路には何も足さない）。1 つのトランザクションで、
   * `deleteSeqs` の行を消し、標識の行 `marker` を追記し、スナップショットを捨てる。`marker.seq` は現在の最大の `seq` より
   * 大きくなければならない（消した `seq` が再利用されない）。存在しない `seq`・標識の `seq`/`requestId` の不正は、何も変えずに
   * 例外。呼び出しは同期で、その間ほかの書き込みは入らない（ストアは単一の接続で排他的に開く）。完了後に追記のみの保証が
   * 戻っていなければ `StoreIntegrityError`。
   */
  purgeRows(deleteSeqs: readonly number[], marker: StoredEvent): void;
  loadSnapshot(): StoredSnapshot | undefined;
  /** 最新の 1 件だけを持つ（上書き）。 */
  saveSnapshot(snapshot: StoredSnapshot): void;
  close(): void;
}
