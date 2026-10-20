import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventBody, stateOf } from "@cso/core";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { EventStore } from "../src/event-store.js";
import { EventLog } from "../src/eventlog.js";
import { openSqliteStore } from "../src/sqlite-store.js";
import { describeEventStore, row } from "./event-store.contract.js";

const openOrThrow = (path: string): EventStore => {
  const r = openSqliteStore(path);
  if (!r.ok) throw new Error(`open failed: ${r.error.code} ${r.error.cause}`);
  return r.value;
};

const tmp = (): { dir: string; path: string; opened: EventStore[]; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "cso-eventlog-"));
  const opened: EventStore[] = [];
  return {
    dir,
    path: join(dir, "events.db"),
    opened,
    cleanup: () => {
      for (const s of opened) s.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

describeEventStore("SQLite 実装（better-sqlite3）", () => {
  const t = tmp();
  const open = (): EventStore => {
    const s = openOrThrow(t.path);
    t.opened.push(s);
    return s;
  };
  return { store: open(), reopen: open, cleanup: t.cleanup };
});

describe("SQLite 実装に固有の性質", () => {
  it("スキーマのバージョンを持ち、WAL で動作する", () => {
    const t = tmp();
    try {
      t.opened.push(openOrThrow(t.path));
      const raw = new Database(t.path, { readonly: true });
      expect(raw.pragma("user_version", { simple: true })).toBe(1);
      expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
      raw.close();
    } finally {
      t.cleanup();
    }
  });

  it("イベントの行は追記のみ（UPDATE は拒否される）", () => {
    const t = tmp();
    try {
      const s = openOrThrow(t.path);
      t.opened.push(s);
      s.append(row(1));
      const raw = new Database(t.path);
      expect(() => raw.prepare("UPDATE events SET type = 'x' WHERE seq = 1").run()).toThrow(
        /append-only/,
      );
      raw.close();
      expect(s.readAll()[0]?.type).toBe("scope.violation");
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
      raw.pragma("user_version = 99");
      raw.close();
      const r = openSqliteStore(t.path);
      expect(r.ok ? null : r.error.code).toBe("schemaTooNew");
    } finally {
      t.cleanup();
    }
  });

  it("存在しないディレクトリは失敗として返す", () => {
    const t = tmp();
    try {
      const r = openSqliteStore(join(t.dir, "no", "such", "events.db"));
      expect(r.ok ? null : r.error.code).toBe("storeError");
      mkdirSync(join(t.dir, "no", "such"), { recursive: true });
      expect(openSqliteStore(join(t.dir, "no", "such", "events.db")).ok).toBe(true);
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
      const store1 = openOrThrow(t.path);
      t.opened.push(store1);
      const log1 = EventLog.open(store1, { clock, snapshotEvery: 2 });
      if (!log1.ok) throw new Error("open");
      for (const [id, body] of bodies)
        expect(log1.value.append({ requestId: id, actor: { system: true }, body }).ok).toBe(true);
      const again = log1.value.append({
        requestId: "r3",
        actor: { system: true },
        body: bodies[2]?.[1] as EventBody,
      });
      expect(again.ok && again.value.applied).toBe(false);
      store1.close();

      const store2 = openOrThrow(t.path);
      t.opened.push(store2);
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
