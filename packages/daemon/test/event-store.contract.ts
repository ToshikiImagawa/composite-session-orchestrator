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

    describe("purgeRows（最終削除専用の物理削除）", () => {
      it("指定した行を消し、標識の行を追記し、スナップショットを捨てる。消した seq は、再利用されない", () => {
        withStore((h) => {
          for (const n of [1, 2, 3, 4]) h.store.append(row(n));
          h.store.saveSnapshot(snap(4));
          h.store.purgeRows([2, 4], row(5, { type: "node.purged" }));
          expect(h.store.readAll().map((r) => r.seq)).toEqual([1, 3, 5]);
          expect(h.store.lastSeq()).toBe(5);
          expect(h.store.loadSnapshot()).toBeUndefined();
          expect(h.store.findByRequestId("req-2")).toBeUndefined();
          expect(h.store.findBySeq(4)).toBeUndefined();
          // 消した seq（4）の後ろは、標識の seq 5 から。末尾の行を消しても、seq は戻らない。
          expect(() => h.store.append(row(5))).toThrow();
          h.store.append(row(6));
          const again = h.reopen();
          expect(again.readAll().map((r) => r.seq)).toEqual([1, 3, 5, 6]);
        });
      });

      it("存在しない seq・標識の seq が最大以下・標識の requestId の重複は、何も変えずに失敗する", () => {
        withStore(({ store }) => {
          for (const n of [1, 2, 3]) store.append(row(n));
          store.saveSnapshot(snap(3));
          expect(() => store.purgeRows([2, 9], row(4))).toThrow();
          expect(() => store.purgeRows([2], row(3, { requestId: "other" }))).toThrow();
          expect(() => store.purgeRows([2], row(4, { requestId: "req-1" }))).toThrow();
          expect(store.readAll().map((r) => r.seq)).toEqual([1, 2, 3]);
          expect(store.loadSnapshot()).toEqual(snap(3));
        });
      });
    });
  });
}
