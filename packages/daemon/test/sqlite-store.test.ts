import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventBody, stateOf } from "@cso/core";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { type EventStore, StoreIntegrityError } from "../src/event-store.js";
import { EventLog } from "../src/eventlog.js";
import { APPLICATION_ID, openSqliteStore } from "../src/sqlite-store.js";
import { describeEventStore, row, snap } from "./event-store.contract.js";

const openOrThrow = (path: string): EventStore => {
  const r = openSqliteStore(path);
  if (!r.ok) throw new Error(`open failed: ${r.error.code} ${r.error.cause}`);
  return r.value;
};

/** 一時ディレクトリと、開いたストアの管理。`reopen` は以前のストアを閉じてから開く（再起動の模擬）。 */
const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), "cso-eventlog-"));
  const opened: EventStore[] = [];
  const path = join(dir, "events.db");
  return {
    dir,
    path,
    open(): EventStore {
      for (const s of opened.splice(0)) s.close();
      const s = openOrThrow(path);
      opened.push(s);
      return s;
    },
    closeAll(): void {
      for (const s of opened.splice(0)) s.close();
    },
    cleanup(): void {
      for (const s of opened) s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

const code = (path: string): string | null => {
  const r = openSqliteStore(path);
  if (r.ok) {
    r.value.close();
    return null;
  }
  return r.error.code;
};

describeEventStore("SQLite 実装（better-sqlite3）", () => {
  const t = tmp();
  return { store: t.open(), reopen: () => t.open(), cleanup: t.cleanup };
});

describe("SQLite 実装に固有の性質", () => {
  it("スキーマのバージョンとアプリケーション識別子を持ち、WAL で動作する", () => {
    const t = tmp();
    try {
      t.open();
      t.closeAll();
      const raw = new Database(t.path, { readonly: true });
      expect(raw.pragma("user_version", { simple: true })).toBe(1);
      expect(raw.pragma("application_id", { simple: true })).toBe(APPLICATION_ID);
      expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
      raw.close();
    } finally {
      t.cleanup();
    }
  });

  it("イベントの行は追記のみ（UPDATE・DELETE・REPLACE は拒否され、行は変わらない）", () => {
    const t = tmp();
    try {
      const s = t.open();
      s.append(row(1));
      t.closeAll();
      const raw = new Database(t.path);
      expect(() => raw.prepare("UPDATE events SET type = 'x' WHERE seq = 1").run()).toThrow(
        /append-only/,
      );
      expect(() => raw.prepare("DELETE FROM events WHERE seq = 1").run()).toThrow(/append-only/);
      expect(() =>
        raw
          .prepare(
            "INSERT OR REPLACE INTO events (seq, at, request_id, actor, type, payload) VALUES (1, 'a', 'other', '{}', 'x', '{}')",
          )
          .run(),
      ).toThrow(/append-only/);
      expect(() =>
        raw
          .prepare(
            "INSERT OR REPLACE INTO events (seq, at, request_id, actor, type, payload) VALUES (2, 'a', 'req-1', '{}', 'x', '{}')",
          )
          .run(),
      ).toThrow(/append-only/);
      raw.close();
      expect(t.open().readAll()).toEqual([row(1)]);
    } finally {
      t.cleanup();
    }
  });

  it("purgeRows の後も、追記のみのトリガーは戻っている（UPDATE・DELETE・REPLACE は拒否される）", () => {
    const t = tmp();
    try {
      const s = t.open();
      for (const n of [1, 2, 3]) s.append(row(n));
      s.purgeRows([2], row(4, { type: "node.purged" }));
      t.closeAll();
      const raw = new Database(t.path);
      const triggers = raw
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(triggers).toEqual(["events_no_delete", "events_no_replace", "events_no_update"]);
      expect(() => raw.prepare("DELETE FROM events WHERE seq = 1").run()).toThrow(/append-only/);
      expect(() => raw.prepare("UPDATE events SET type = 'x' WHERE seq = 1").run()).toThrow(
        /append-only/,
      );
      raw.close();
      expect(
        t
          .open()
          .readAll()
          .map((r) => r.seq),
      ).toEqual([1, 3, 4]);
    } finally {
      t.cleanup();
    }
  });

  it("purgeRows が途中で失敗しても、トリガーは外れたまま残らない（ロールバックされる）", () => {
    const t = tmp();
    try {
      const s = t.open();
      for (const n of [1, 2]) s.append(row(n));
      expect(() => s.purgeRows([1, 99], row(3))).toThrow();
      t.closeAll();
      const raw = new Database(t.path);
      expect(() => raw.prepare("DELETE FROM events WHERE seq = 1").run()).toThrow(/append-only/);
      raw.close();
      expect(
        t
          .open()
          .readAll()
          .map((r) => r.seq),
      ).toEqual([1, 2]);
    } finally {
      t.cleanup();
    }
  });

  it("purgeRows の後、トリガーが戻っていることを確かめられなければ、StoreIntegrityError（fail closed）", () => {
    const t = tmp();
    try {
      const r = openSqliteStore(t.path, {
        beforeTriggerCheck: (db) => db.exec("DROP TRIGGER events_no_update"),
      });
      if (!r.ok) throw new Error(r.error.code);
      for (const n of [1, 2]) r.value.append(row(n));
      expect(() => r.value.purgeRows([1], row(3))).toThrow(StoreIntegrityError);
      r.value.close();
    } finally {
      t.cleanup();
    }
  });

  it("purgeRows の後、消した行の本文は、データベースにも WAL にも残らない（secure_delete と checkpoint）", () => {
    const t = tmp();
    try {
      const SECRET = "SECRET-OBJECTIVE-4f3a9c1e";
      const s = t.open();
      s.append(row(1, { payload: `{"nodeId":"n","note":"${SECRET}"}` }));
      s.append(row(2));
      s.saveSnapshot(snap(2, { state: `{"objective":"${SECRET}"}` }));
      s.purgeRows([1], row(3, { type: "node.purged" }));
      t.closeAll();
      for (const f of [t.path, `${t.path}-wal`]) {
        if (existsSync(f)) expect(readFileSync(f).includes(SECRET), f).toBe(false);
      }
      expect(
        t
          .open()
          .readAll()
          .map((r) => r.seq),
      ).toEqual([2, 3]);
    } finally {
      t.cleanup();
    }
  });

  it("secure_delete は、開くときに常に有効（削除した本文のページを 0 で上書きする）", () => {
    const t = tmp();
    try {
      let seen: unknown;
      const r = openSqliteStore(t.path, {
        beforeTriggerCheck: (db) => {
          seen = db.pragma("secure_delete", { simple: true });
        },
      });
      if (!r.ok) throw new Error(r.error.code);
      r.value.append(row(1));
      r.value.purgeRows([1], row(2));
      r.value.close();
      expect(seen).toBe(1);
    } finally {
      t.cleanup();
    }
  });

  it("purgeRows のコミットの後の例外（確認を含む）は、すべて StoreIntegrityError", () => {
    const t = tmp();
    try {
      const r = openSqliteStore(t.path, {
        beforeTriggerCheck: () => {
          throw new Error("確認中の例外");
        },
      });
      if (!r.ok) throw new Error(r.error.code);
      for (const n of [1, 2]) r.value.append(row(n));
      expect(() => r.value.purgeRows([1], row(3))).toThrow(StoreIntegrityError);
      r.value.close();
    } finally {
      t.cleanup();
    }
  });

  it("二重に開けない（daemon は単一プロセス）。先に閉じれば開ける", () => {
    const t = tmp();
    try {
      const first = openOrThrow(t.path);
      expect(code(t.path)).toBe("storeLocked");
      first.close();
      expect(code(t.path)).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it("2 つ目の EventLog は開けない（1 つ目が開いている間）", () => {
    const t = tmp();
    try {
      const clock = (): string => "2026-10-20T00:00:00Z";
      const first = openOrThrow(t.path);
      const log1 = EventLog.open(first, { clock });
      expect(log1.ok).toBe(true);
      const second = openSqliteStore(t.path);
      expect(second.ok ? null : second.error.code).toBe("storeLocked");
      first.close();
    } finally {
      t.cleanup();
    }
  });

  it("データベースでないファイルは、例外でなく失敗（storeError）として返す", () => {
    const t = tmp();
    try {
      writeFileSync(t.path, "これは SQLite のファイルではない".repeat(100));
      const r = openSqliteStore(t.path);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.code).toBe("storeError");
        expect(r.error.nextActions.length).toBeGreaterThan(0);
      }
    } finally {
      t.cleanup();
    }
  });

  it("より新しいスキーマのファイルは開かない（schemaTooNew）", () => {
    const t = tmp();
    try {
      const raw = new Database(t.path);
      raw.pragma(`application_id = ${APPLICATION_ID}`);
      raw.pragma("user_version = 99");
      raw.close();
      expect(code(t.path)).toBe("schemaTooNew");
    } finally {
      t.cleanup();
    }
  });

  it("このアプリのものでない既存のデータベースは開かない（schemaMismatch）", () => {
    const t = tmp();
    try {
      // 別のアプリのテーブルがあり、application_id が未設定
      const foreign = new Database(t.path);
      foreign.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
      foreign.close();
      expect(code(t.path)).toBe("schemaMismatch");
    } finally {
      t.cleanup();
    }
    const t2 = tmp();
    try {
      // application_id が別の値
      const other = new Database(t2.path);
      other.pragma("application_id = 12345");
      other.exec("CREATE TABLE events (seq INTEGER)");
      other.close();
      expect(code(t2.path)).toBe("schemaMismatch");
    } finally {
      t2.cleanup();
    }
    const t3 = tmp();
    try {
      // user_version が 0（未初期化）なのに、既存のテーブルがある
      const half = new Database(t3.path);
      half.pragma(`application_id = ${APPLICATION_ID}`);
      half.exec("CREATE TABLE events (seq INTEGER)");
      half.close();
      expect(code(t3.path)).toBe("schemaMismatch");
    } finally {
      t3.cleanup();
    }
  });

  it("空のファイル・新しいパスは初期化して開ける", () => {
    const t = tmp();
    try {
      writeFileSync(t.path, "");
      expect(code(t.path)).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it("列が違う既存の events テーブル（prepare が例外になる）でも、例外でなく storeError を返し、ロックを残さない", () => {
    const t = tmp();
    try {
      const raw = new Database(t.path);
      raw.pragma(`application_id = ${APPLICATION_ID}`);
      raw.pragma("user_version = 1");
      raw.exec("CREATE TABLE events (seq INTEGER PRIMARY KEY, other TEXT)");
      raw.close();
      expect(code(t.path)).toBe("storeError");
      // DB を閉じてロックを残していないので、別の接続で書ける
      const again = new Database(t.path);
      expect(() => again.exec("CREATE TABLE probe (x INTEGER)")).not.toThrow();
      again.close();
    } finally {
      t.cleanup();
    }
  });

  it("WAL にできない（:memory:）なら失敗（storeError）", () => {
    expect(code(":memory:")).toBe("storeError");
  });

  it("存在しないディレクトリは失敗として返す", () => {
    const t = tmp();
    try {
      expect(code(join(t.dir, "no", "such", "events.db"))).toBe("storeError");
      mkdirSync(join(t.dir, "no", "such"), { recursive: true });
      expect(code(join(t.dir, "no", "such", "events.db"))).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it("スナップショットは状態のバージョンと末尾のイベントのハッシュを持って往復する", () => {
    const t = tmp();
    try {
      const s = t.open();
      s.saveSnapshot(snap(5, { stateVersion: 3, lastEventHash: "deadbeef" }));
      expect(t.open().loadSnapshot()).toEqual(
        snap(5, { stateVersion: 3, lastEventHash: "deadbeef" }),
      );
    } finally {
      t.cleanup();
    }
  });

  it("EventLog を載せて、再起動（開き直し）しても状態と採番が続く。再送は行を増やさない", () => {
    const t = tmp();
    try {
      const clock = (): string => "2026-10-20T00:00:00Z";
      const bodies: [string, EventBody][] = [
        [
          "r1",
          {
            type: "node.created",
            payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
          },
        ],
        [
          "r2",
          { type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } },
        ],
        [
          "r3",
          {
            type: "node.created",
            payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
          },
        ],
      ];
      const store1 = t.open();
      const log1 = EventLog.open(store1, { clock, snapshotEvery: 2 });
      if (!log1.ok) throw new Error("open");
      for (const [id, body] of bodies) {
        expect(log1.value.append({ requestId: id, actor: { system: true }, body }).ok).toBe(true);
      }
      const again = log1.value.append({
        requestId: "r3",
        actor: { system: true },
        body: bodies[2]?.[1] as EventBody,
      });
      expect(again.ok && again.value.applied).toBe(false);

      const store2 = t.open();
      const log2 = EventLog.open(store2, { clock, snapshotEvery: 2 });
      if (!log2.ok) throw new Error("reopen");
      expect(stateOf(log2.value.state(), "root")).toBe("running");
      expect(stateOf(log2.value.state(), "a")).toBe("pending");
      const next = log2.value.append({
        requestId: "r4",
        actor: { system: true },
        body: { type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } },
      });
      expect(next.ok && next.value.event.seq).toBe(4);
      expect(store2.readAll()).toHaveLength(4);
    } finally {
      t.cleanup();
    }
  });
});
