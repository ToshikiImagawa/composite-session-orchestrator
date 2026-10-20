/**
 * SQLite による EventStore（better-sqlite3）。ドライバーはこのファイルに閉じ込め、EventStore の契約だけを公開する
 * （node:sqlite などへ差し替え可能）。
 *
 * - イベントは追記のみ（UPDATE はトリガーで拒否する。NFR_011）。`seq` は主キー、`request_id` は一意（NFR_003）。
 * - 耐久性のため WAL と `synchronous = FULL`。`busy_timeout` で一時的なロックを待つ。
 * - スキーマのバージョンは `user_version`。より新しいバージョンのファイルは開かない。
 * - 開くときの失敗（壊れたファイル、ディレクトリがない、新しすぎるスキーマ）は例外でなく失敗として返す。
 */

import { type Failure, failure, ok, type Result } from "@cso/core";
import Database from "better-sqlite3";
import type { EventStore, StoredEvent, StoredSnapshot } from "./event-store.js";

export const SCHEMA_VERSION = 1;

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
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  last_seq INTEGER NOT NULL,
  state    TEXT NOT NULL
) STRICT;
CREATE TRIGGER IF NOT EXISTS events_append_only
BEFORE UPDATE ON events
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

/** ファイル（または `:memory:`）の SQLite を EventStore として開く。 */
export function openSqliteStore(path: string): Result<EventStore, Failure> {
  let db: Database.Database | undefined;
  try {
    db = new Database(path);
    db.pragma("busy_timeout = 5000");
    const version = db.pragma("user_version", { simple: true }) as number;
    if (version > SCHEMA_VERSION) {
      db.close();
      return fail(
        "schemaTooNew",
        `ログのスキーマ（${version}）がこの版（${SCHEMA_VERSION}）より新しい`,
        "新しい版の daemon で開く",
        "別のファイルを指定する",
      );
    }
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.exec(SCHEMA);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
  } catch (e) {
    try {
      db?.close();
    } catch {
      // 開けなかったものを閉じられなくても、元の失敗を返す。
    }
    return fail(
      "storeError",
      `SQLite を開けない（${path}）: ${String(e)}`,
      "ファイルのパスと権限を確認する",
      "壊れていれば、バックアップから復元する",
    );
  }
  const conn = db;

  const selectAll = conn.prepare<[], EventRow>("SELECT * FROM events ORDER BY seq");
  const selectAfter = conn.prepare<[number], EventRow>(
    "SELECT * FROM events WHERE seq > ? ORDER BY seq",
  );
  const selectByRequest = conn.prepare<[string], EventRow>(
    "SELECT * FROM events WHERE request_id = ?",
  );
  const selectMax = conn.prepare<[], { m: number | null }>("SELECT MAX(seq) AS m FROM events");
  const insert = conn.prepare(
    "INSERT INTO events (seq, at, request_id, actor, type, payload) VALUES (@seq, @at, @requestId, @actor, @type, @payload)",
  );
  const selectSnapshot = conn.prepare<[], { last_seq: number; state: string }>(
    "SELECT last_seq, state FROM snapshot WHERE id = 1",
  );
  const upsertSnapshot = conn.prepare(
    "INSERT INTO snapshot (id, last_seq, state) VALUES (1, @lastSeq, @state) ON CONFLICT(id) DO UPDATE SET last_seq = excluded.last_seq, state = excluded.state",
  );

  return ok({
    readAll: () => selectAll.all().map(toStored),
    readAfter: (seq) => selectAfter.all(seq).map(toStored),
    lastSeq: () => selectMax.get()?.m ?? 0,
    findByRequestId: (id) => {
      const r = selectByRequest.get(id);
      return r === undefined ? undefined : toStored(r);
    },
    append(row) {
      insert.run(row);
    },
    transaction: <T>(fn: () => T): T => conn.transaction(fn)(),
    loadSnapshot(): StoredSnapshot | undefined {
      const r = selectSnapshot.get();
      return r === undefined ? undefined : { lastSeq: r.last_seq, state: r.state };
    },
    saveSnapshot(s) {
      upsertSnapshot.run(s);
    },
    close() {
      if (conn.open) conn.close();
    },
  });
}
