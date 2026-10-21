/**
 * SQLite による EventStore（better-sqlite3）。ドライバーはこのファイルに閉じ込め、EventStore の契約だけを公開する
 * （node:sqlite などへ差し替え可能）。
 *
 * - **追記のみ**（NFR_011）: イベントの UPDATE・DELETE と、既存の `seq`・`request_id` を置き換える INSERT（REPLACE）は
 *   トリガーで拒否する。INSERT は `OR ABORT` で固定する。最終削除（FR_031）は別の経路で設計する。
 *   `seq` は主キー、`request_id` は一意（NFR_003）。
 * - **単一プロセス**: `locking_mode = EXCLUSIVE` で、開いた時点で書き込みのロックを取り、二重に開くと `storeLocked` で失敗する。
 * - **耐久性**: WAL と `synchronous = FULL`。WAL にできなければ失敗する（`:memory:` は不可）。
 * - **他のデータベースの巻き込み防止**: `application_id` に固有値を書き、`user_version` でスキーマの版を持つ。
 *   固有値でない既存のデータベース、版が 0 なのにテーブルがあるもの（`schemaMismatch`）、より新しい版（`schemaTooNew`）は開かない。
 * - 開くときの失敗は例外でなく失敗として返し、失敗したらデータベースを閉じる（ロックを残さない）。
 */

import { type Failure, failure, ok, type Result } from "@cso/core";
import Database from "better-sqlite3";
import {
  type EventStore,
  type StoredEvent,
  type StoredSnapshot,
  StoreIntegrityError,
} from "./event-store.js";

export const SCHEMA_VERSION = 1;
/** `application_id` の固有値（ASCII の "CSO1"）。 */
export const APPLICATION_ID = 0x43534f31;

const TRIGGER_NAMES = ["events_no_delete", "events_no_replace", "events_no_update"] as const;
const DELETE_TRIGGER = `CREATE TRIGGER IF NOT EXISTS events_no_delete BEFORE DELETE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  seq        INTEGER PRIMARY KEY,
  at         TEXT NOT NULL,
  request_id TEXT NOT NULL UNIQUE,
  actor      TEXT NOT NULL,
  type       TEXT NOT NULL,
  payload    TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS snapshot (
  id            INTEGER PRIMARY KEY CHECK (id = 1),
  last_seq      INTEGER NOT NULL,
  state         TEXT NOT NULL,
  state_version INTEGER NOT NULL,
  last_hash     TEXT NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS events_no_update BEFORE UPDATE ON events
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
${DELETE_TRIGGER}
CREATE TRIGGER IF NOT EXISTS events_no_replace BEFORE INSERT ON events
WHEN EXISTS (SELECT 1 FROM events WHERE seq = NEW.seq OR request_id = NEW.request_id)
BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
`;

interface EventRow {
  seq: number;
  at: string;
  request_id: string;
  actor: string;
  type: string;
  payload: string;
}

const toStored = (r: EventRow): StoredEvent => ({
  seq: r.seq,
  at: r.at,
  requestId: r.request_id,
  actor: r.actor,
  type: r.type,
  payload: r.payload,
});

const fail = (
  code: string,
  cause: string,
  ...next: [string, ...string[]]
): Result<never, Failure> => ({
  ok: false,
  error: failure(code, cause, ...next),
});

const isLocked = (e: unknown): boolean =>
  typeof e === "object" &&
  e !== null &&
  ((e as { code?: unknown }).code === "SQLITE_BUSY" ||
    /database is locked/i.test(String((e as { message?: unknown }).message)));

/** 初期化（または既存のデータベースの検査）。失敗は理由つきの結果で返し、例外は呼び出し側が受ける。 */
function initialize(db: Database.Database, path: string): Result<never, Failure> | undefined {
  db.exec("BEGIN IMMEDIATE"); // 書き込みのロックを取る（排他）
  try {
    const appId = db.pragma("application_id", { simple: true }) as number;
    const version = db.pragma("user_version", { simple: true }) as number;
    const objects = (
      db
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .get() as { n: number }
    ).n;
    if (version > SCHEMA_VERSION) {
      db.exec("ROLLBACK");
      return fail(
        "schemaTooNew",
        `ログのスキーマ（${version}）がこの版（${SCHEMA_VERSION}）より新しい`,
        "新しい版の daemon で開く",
        "別のファイルを指定する",
      );
    }
    const foreign =
      (appId !== 0 && appId !== APPLICATION_ID) || (objects > 0 && (appId === 0 || version === 0));
    if (foreign) {
      db.exec("ROLLBACK");
      return fail(
        "schemaMismatch",
        `このアプリのイベントログではない既存のデータベース（${path}）`,
        "別のファイルを指定する",
        "ファイルの中身を確認する",
      );
    }
    db.exec(SCHEMA);
    db.pragma(`application_id = ${APPLICATION_ID}`);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
    db.exec("COMMIT");
    return undefined;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ロールバックできなくても、元の例外を返す。
    }
    throw e;
  }
}

/** ファイルの SQLite を EventStore として開く。同じファイルを二重には開けない。 */
export function openSqliteStore(
  path: string,
  /** 試験用: 最終削除の後、トリガーの確認の直前に呼ぶ（確認の失敗を再現する）。 */
  testHooks?: { readonly beforeTriggerCheck?: (db: Database.Database) => void },
): Result<EventStore, Failure> {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { timeout: 0 });
    db.pragma("locking_mode = EXCLUSIVE");
    const mode = db.pragma("journal_mode = WAL", { simple: true });
    if (mode !== "wal") {
      db.close();
      return fail(
        "storeError",
        `WAL にできない（journal_mode: ${String(mode)}）。ファイルの場所とファイルシステムを確認する`,
        "通常のファイルのパスを指定する",
        "ネットワークファイルシステムを避ける",
      );
    }
    db.pragma("synchronous = FULL");
    const init = initialize(db, path);
    if (init !== undefined) {
      db.close();
      return init;
    }
    const conn = db;

    const selectAll = conn.prepare<[], EventRow>("SELECT * FROM events ORDER BY seq");
    const selectAfter = conn.prepare<[number], EventRow>(
      "SELECT * FROM events WHERE seq > ? ORDER BY seq",
    );
    const selectByRequest = conn.prepare<[string], EventRow>(
      "SELECT * FROM events WHERE request_id = ?",
    );
    const selectBySeq = conn.prepare<[number], EventRow>("SELECT * FROM events WHERE seq = ?");
    const selectMax = conn.prepare<[], { m: number | null }>("SELECT MAX(seq) AS m FROM events");
    const insert = conn.prepare(
      "INSERT OR ABORT INTO events (seq, at, request_id, actor, type, payload) VALUES (@seq, @at, @requestId, @actor, @type, @payload)",
    );
    const selectSnapshot = conn.prepare<
      [],
      { last_seq: number; state: string; state_version: number; last_hash: string }
    >("SELECT last_seq, state, state_version, last_hash FROM snapshot WHERE id = 1");
    const upsertSnapshot = conn.prepare(
      "INSERT INTO snapshot (id, last_seq, state, state_version, last_hash) VALUES (1, @lastSeq, @state, @stateVersion, @lastEventHash) ON CONFLICT(id) DO UPDATE SET last_seq = excluded.last_seq, state = excluded.state, state_version = excluded.state_version, last_hash = excluded.last_hash",
    );

    return ok({
      readAll: () => selectAll.all().map(toStored),
      readAfter: (seq) => selectAfter.all(seq).map(toStored),
      lastSeq: () => selectMax.get()?.m ?? 0,
      findByRequestId: (id) => {
        const r = selectByRequest.get(id);
        return r === undefined ? undefined : toStored(r);
      },
      findBySeq: (seq) => {
        const r = selectBySeq.get(seq);
        return r === undefined ? undefined : toStored(r);
      },
      append(row) {
        insert.run(row);
      },
      purgeRows(deleteSeqs, marker) {
        conn
          .transaction(() => {
            const max = selectMax.get()?.m ?? 0;
            if (marker.seq <= max)
              throw new Error(`purge: 標識の seq ${marker.seq} が最大 ${max} 以下`);
            for (const seq of deleteSeqs) {
              if (selectBySeq.get(seq) === undefined) throw new Error(`purge: seq ${seq} がない`);
            }
            // DDL もトランザクションに入る。途中で失敗すれば、トリガーも含めて全部ロールバックされる。
            conn.exec("DROP TRIGGER events_no_delete");
            const del = conn.prepare("DELETE FROM events WHERE seq = ?");
            for (const seq of deleteSeqs) del.run(seq);
            insert.run(marker); // events_no_replace は有効なまま（標識の重複は拒否される）
            conn.exec("DELETE FROM snapshot");
            conn.exec(DELETE_TRIGGER.replace("IF NOT EXISTS ", ""));
          })
          .immediate();
        testHooks?.beforeTriggerCheck?.(conn);
        const names = conn
          .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger'")
          .all()
          .map((r) => r.name);
        const missing = TRIGGER_NAMES.filter((t) => !names.includes(t));
        if (missing.length > 0) {
          throw new StoreIntegrityError(
            `最終削除の後に、追記のみのトリガーが戻っていない: ${missing.join(", ")}`,
          );
        }
      },
      transaction: <T>(fn: () => T): T => conn.transaction(fn)(),
      loadSnapshot(): StoredSnapshot | undefined {
        const r = selectSnapshot.get();
        return r === undefined
          ? undefined
          : {
              lastSeq: r.last_seq,
              state: r.state,
              stateVersion: r.state_version,
              lastEventHash: r.last_hash,
            };
      },
      saveSnapshot(s) {
        upsertSnapshot.run(s);
      },
      close() {
        if (conn.open) conn.close();
      },
    });
  } catch (e) {
    try {
      db?.close(); // ロックを残さない
    } catch {
      // 閉じられなくても、元の失敗を返す。
    }
    if (isLocked(e)) {
      return fail(
        "storeLocked",
        `イベントログ（${path}）は他のプロセス（または同じプロセスの別の接続）が開いている`,
        "daemon の二重起動でないか確認する",
        "先に開いている側を閉じる",
      );
    }
    return fail(
      "storeError",
      `SQLite を開けない（${path}）: ${String(e)}`,
      "ファイルのパスと権限を確認する",
      "壊れていれば、バックアップから復元する",
    );
  }
}
