import type { EventStore, StoredEvent, StoredSnapshot } from "./event-store.js";

interface Data {
  rows: StoredEvent[];
  snapshot: StoredSnapshot | undefined;
}

/**
 * メモリ上の EventStore（テスト用のフェイク）。`open()` で同じ保存先を開き直せる（再起動の模擬）。
 * SQLite 実装と同じ契約（一意制約、トランザクションのロールバック）を満たす。
 */
export function createMemoryStore(): { open(): EventStore } {
  const data: Data = { rows: [], snapshot: undefined };
  return {
    open(): EventStore {
      const sorted = (): StoredEvent[] => [...data.rows].sort((a, b) => a.seq - b.seq);
      return {
        readAll: sorted,
        readAfter: (seq) => sorted().filter((r) => r.seq > seq),
        lastSeq: () => data.rows.reduce((m, r) => Math.max(m, r.seq), 0),
        findBySeq: (seq) => data.rows.find((r) => r.seq === seq),
        findByRequestId: (id) => data.rows.find((r) => r.requestId === id),
        append(row) {
          if (data.rows.some((r) => r.seq === row.seq)) throw new Error(`UNIQUE: seq ${row.seq}`);
          if (data.rows.some((r) => r.requestId === row.requestId)) {
            throw new Error(`UNIQUE: requestId ${row.requestId}`);
          }
          data.rows.push({ ...row });
        },
        transaction(fn) {
          const before: Data = { rows: [...data.rows], snapshot: data.snapshot };
          try {
            return fn();
          } catch (e) {
            data.rows = before.rows;
            data.snapshot = before.snapshot;
            throw e;
          }
        },
        loadSnapshot: () => (data.snapshot === undefined ? undefined : { ...data.snapshot }),
        saveSnapshot(s) {
          data.snapshot = { ...s };
        },
        close() {},
      };
    },
  };
}
