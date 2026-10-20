import { describe, expect, it } from "vitest";
import type { EventStore, StoredEvent, StoredSnapshot } from "../src/event-store.js";

export interface StoreHarness {
  readonly store: EventStore;
  /** 同じ保存先を開き直す（再起動の模擬）。以前に開いたストアは閉じる（daemon は単一プロセスで、排他のため）。 */
  reopen(): EventStore;
  cleanup(): void;
}

export const snap = (lastSeq: number, over: Partial<StoredSnapshot> = {}): StoredSnapshot => ({
  lastSeq,
  state: "{}",
  stateVersion: 1,
  lastEventHash: `hash-${lastSeq}`,
  ...over,
});

export const row = (seq: number, over: Partial<StoredEvent> = {}): StoredEvent => ({
  seq,
  at: "2026-10-20T00:00:00Z",
  requestId: `req-${seq}`,
  actor: '{"system":true}',
  type: "scope.violation",
  payload: '{"nodeId":"n","reason":"outsideWritable","subject":"s"}',
  ...over,
});

/**
 * EventStore の実装が満たす契約。メモリ実装と SQLite 実装の両方に同じ試験を課す。
 * 注意: メモリ実装は値の型を検査しない（SQLite は STRICT テーブルで検査する）。契約は、文字列・整数の正しい入力に対するもの。
 */
export function describeEventStore(name: string, make: () => StoreHarness): void {
  describe(`EventStore の契約: ${name}`, () => {
    const withStore = (fn: (h: StoreHarness) => void): void => {
      const h = make();
      try {
        fn(h);
      } finally {
        h.cleanup();
      }
    };

    it("空の保存先は空", () => {
      withStore(({ store }) => {
        expect(store.readAll()).toEqual([]);
        expect(store.readAfter(0)).toEqual([]);
        expect(store.lastSeq()).toBe(0);
        expect(store.findByRequestId("x")).toBeUndefined();
        expect(store.findBySeq(1)).toBeUndefined();
        expect(store.loadSnapshot()).toBeUndefined();
      });
    });

    it("追記した行を seq の昇順で読める（追記の順に依らない）", () => {
      withStore(({ store }) => {
        store.append(row(2));
        store.append(row(1));
        store.append(row(3));
        expect(store.readAll().map((r) => r.seq)).toEqual([1, 2, 3]);
        expect(store.lastSeq()).toBe(3);
        expect(store.readAfter(1).map((r) => r.seq)).toEqual([2, 3]);
        expect(store.readAfter(3)).toEqual([]);
      });
    });

    it("行の内容は欠けずに往復する", () => {
      withStore(({ store }) => {
        const r = row(1, { payload: '{"a":"日本語\\n\\"引用\\""}', actor: '{"nodeId":"n1"}' });
        store.append(r);
        expect(store.readAll()).toEqual([r]);
        expect(store.findByRequestId("req-1")).toEqual(r);
        expect(store.findBySeq(1)).toEqual(r);
        expect(store.findBySeq(2)).toBeUndefined();
      });
    });

    it("seq の重複・requestId の重複は例外（一意制約）で、行は増えない", () => {
      withStore(({ store }) => {
        store.append(row(1));
        expect(() => store.append(row(1, { requestId: "other" }))).toThrow();
        expect(() => store.append(row(2, { requestId: "req-1" }))).toThrow();
        expect(store.readAll().map((r) => r.seq)).toEqual([1]);
      });
    });

    it("transaction は値を返し、例外ならロールバックする", () => {
      withStore(({ store }) => {
        expect(store.transaction(() => 42)).toBe(42);
        store.append(row(1));
        expect(() =>
          store.transaction(() => {
            store.append(row(2));
            store.saveSnapshot(snap(2));
            throw new Error("boom");
          }),
        ).toThrow("boom");
        expect(store.readAll().map((r) => r.seq)).toEqual([1]);
        expect(store.lastSeq()).toBe(1);
        expect(store.loadSnapshot()).toBeUndefined();
        store.transaction(() => store.append(row(2)));
        expect(store.readAll().map((r) => r.seq)).toEqual([1, 2]);
      });
    });

    it("スナップショットは最新の 1 件だけを持つ", () => {
      withStore(({ store }) => {
        store.saveSnapshot(snap(3, { state: '{"a":1}' }));
        store.saveSnapshot(snap(6, { state: '{"a":2}', stateVersion: 2, lastEventHash: "abc" }));
        expect(store.loadSnapshot()).toEqual({
          lastSeq: 6,
          state: '{"a":2}',
          stateVersion: 2,
          lastEventHash: "abc",
        });
      });
    });

    it("開き直しても、行とスナップショットが残る（永続化）", () => {
      withStore((h) => {
        h.store.append(row(1));
        h.store.append(row(2));
        h.store.saveSnapshot(snap(2));
        const again = h.reopen();
        expect(again.readAll().map((r) => r.seq)).toEqual([1, 2]);
        expect(again.loadSnapshot()).toEqual(snap(2));
        expect(again.findByRequestId("req-2")?.seq).toBe(2);
      });
    });
  });
}
