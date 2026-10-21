import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventBody, failure, type NodeEvent } from "@cso/core";
import { describe, expect, it } from "vitest";
import { createPurger, type PurgeHandlerDeps } from "../src/api/handlers/purge-handlers.js";
import { createAutoPurger } from "../src/auto-purge.js";
import { EventLog } from "../src/eventlog.js";
import { createMemoryStore } from "../src/memory-store.js";
import type { Timers } from "../src/sdk/runtime.js";
import { openSqliteStore } from "../src/sqlite-store.js";

const SYS = { system: true } as const;
const DAY = 86_400_000;
const T0 = Date.parse("2026-01-01T00:00:00Z");

/** 手動で進めるタイマー。 */
const manualTimers = () => {
  let nowMs = T0;
  const waiting: { at: number; resolve: () => void; cancelled: boolean }[] = [];
  const timers: Timers = {
    now: () => nowMs,
    sleep: () => Promise.resolve(),
    after: (ms) => {
      const w = { at: nowMs + ms, resolve: () => {}, cancelled: false };
      const promise = new Promise<void>((res) => {
        w.resolve = res;
      });
      waiting.push(w);
      return {
        promise,
        cancel: () => {
          w.cancelled = true;
        },
      };
    },
  };
  return {
    timers,
    pending: () => waiting.filter((w) => !w.cancelled && w.at >= nowMs).length,
    /** 時刻を進め、期限が来たタイマーを発火する（その後の処理を待つ）。 */
    advance: async (ms: number) => {
      nowMs += ms;
      for (const w of [...waiting]) {
        if (!w.cancelled && w.at <= nowMs) {
          w.cancelled = true;
          w.resolve();
        }
      }
      await new Promise((r) => setImmediate(r));
    },
  };
};

const SECRET = "SECRET-TEXT-7d2e41aa";

const rig = (opts: { store?: ReturnType<ReturnType<typeof createMemoryStore>["open"]> } = {}) => {
  let nowMs = T0;
  const opened = EventLog.open(opts.store ?? createMemoryStore().open(), {
    clock: () => new Date(nowMs).toISOString(),
  });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  let n = 0;
  const add = (body: EventBody) => {
    const r = log.append({ requestId: `s-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  const node = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
    add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
  node("root", "integrator", null);
  ev("root", { type: "start" });
  /** 最上位の木 `<id>`（配下 `<id>c`）を、`nowMs` の時点でアーカイブする。 */
  const tree = (id: string, archiveDaysAfterStart: number, secret = false) => {
    node(id, "integrator", "root");
    ev(id, { type: "start" });
    node(`${id}c`, "implement", id);
    ev(`${id}c`, { type: "start" });
    if (secret) {
      add({
        type: "report.added",
        payload: { reportId: `r-${id}`, nodeId: `${id}c`, kind: "progress", text: SECRET },
      });
    }
    nowMs = T0 + archiveDaysAfterStart * DAY;
    for (const x of [`${id}c`, id]) {
      ev(x, { type: "reportDone" });
      ev(x, { type: "accept" });
      ev(x, { type: "markReclaimable", discarded: false });
      ev(x, { type: "archive" });
    }
  };
  return { log, tree, setNow: (ms: number) => (nowMs = ms), add, ev, node };
};

const make = (
  r: ReturnType<typeof rig>,
  opts: {
    nowDays: number;
    retentionDays?: number;
    maxTreesPerRun?: number;
    defaultTombstone?: boolean;
    isStopped?: () => boolean;
    purgeWrap?: (
      f: ReturnType<typeof createPurger>["purgeTreeOf"],
    ) => ReturnType<typeof createPurger>["purgeTreeOf"];
  },
) => {
  const mt = manualTimers();
  const notes: { event: string; data: Record<string, unknown> }[] = [];
  const audits: { event: string; data: Record<string, unknown> }[] = [];
  const revoked: string[] = [];
  const deps: PurgeHandlerDeps = {
    log: r.log,
    nowMs: () => T0 + opts.nowDays * DAY,
    retentionDays: opts.retentionDays ?? 90,
    defaultTombstone: opts.defaultTombstone ?? true,
    revokeNode: (id) => revoked.push(id),
    audit: (event, data) => audits.push({ event, data }),
  };
  const purger = createPurger(deps);
  const auto = createAutoPurger({
    state: () => r.log.state(),
    nowMs: deps.nowMs,
    retentionDays: deps.retentionDays,
    intervalMs: 60 * 60_000,
    maxTreesPerRun: opts.maxTreesPerRun ?? 5,
    purgeTreeOf: opts.purgeWrap ? opts.purgeWrap(purger.purgeTreeOf) : purger.purgeTreeOf,
    timers: mt.timers,
    note: (event, data) => notes.push({ event, data }),
    isStopped: opts.isStopped ?? (() => false),
  });
  return { auto, mt, notes, audits, revoked };
};

const ids = (r: ReturnType<typeof rig>) =>
  r.log
    .state()
    .nodes.map((n) => n.id)
    .sort();

describe("自動の最終削除（T13f-a）", () => {
  it("保持期間を過ぎた最上位の木だけを消す。期間内の木は残す", () => {
    const r = rig();
    r.tree("old", 1);
    r.tree("young", 50);
    const m = make(r, { nowDays: 100 }); // old: 99 日、young: 50 日
    const out = m.auto.runOnce();
    expect(out.skipped).toBe(false);
    expect(out.purged.sort()).toEqual(["old", "oldc"]);
    expect(ids(r)).toEqual(["root", "young", "youngc"]);
    expect(r.log.state().tombstones).toHaveLength(1);
  });

  it("古い順に、maxTreesPerRun 本までだけ消す。残りは次の実行で消す", () => {
    const r = rig();
    r.tree("a", 1);
    r.tree("b", 2);
    r.tree("c", 3);
    const m = make(r, { nowDays: 200, maxTreesPerRun: 2 });
    expect(m.auto.runOnce().purged.sort()).toEqual(["a", "ac", "b", "bc"]);
    expect(ids(r)).toEqual(["c", "cc", "root"]);
    expect(m.auto.runOnce().purged.sort()).toEqual(["c", "cc"]);
  });

  it("人間のコマンドと同じ経路を通る: 操作の主体は system、標識・監査（origin: auto）・トークンの失効が行われる", () => {
    const r = rig();
    r.tree("t", 1);
    const m = make(r, { nowDays: 100 });
    m.auto.runOnce();
    expect(m.audits.map((a) => a.event)).toEqual(["purgeStarting", "purged"]);
    expect(m.audits.every((a) => a.data.origin === "auto")).toBe(true);
    expect([...m.revoked].sort()).toEqual(["t", "tc"]);
    const marker = r.log.state().tombstones[0];
    expect(marker?.rootId).toBe("t");
  });

  it("墓標は、設定の既定（purgeTombstone）に従う", () => {
    const a = rig();
    a.tree("t", 1);
    make(a, { nowDays: 100, defaultTombstone: false }).auto.runOnce();
    expect(a.log.state().tombstones[0]?.tombstone).toBeUndefined();
    const b = rig();
    b.tree("t", 1);
    make(b, { nowDays: 100, defaultTombstone: true }).auto.runOnce();
    expect(b.log.state().tombstones[0]?.tombstone?.title).toBeDefined();
  });

  it("最上位でない木・木にアーカイブでないノードがある木・別の木が依存している木は対象にしない（人間と同じ判定）", () => {
    const r = rig();
    r.tree("done", 1);
    // 配下が動作中の木
    r.node("busy", "integrator", "root");
    r.ev("busy", { type: "start" });
    const m = make(r, { nowDays: 100 });
    const out = m.auto.runOnce();
    expect(out.purged.sort()).toEqual(["done", "donec"]);
    expect(ids(r)).toContain("busy");
  });

  it("1 本が失敗しても止めず、記録に残して、次の木へ進む。同じ木は次の実行で再試行する", () => {
    const r = rig();
    r.tree("a", 1);
    r.tree("b", 2);
    let fail = true;
    const m = make(r, {
      nowDays: 100,
      purgeWrap: (f) => (args) =>
        fail && args.nodeId === "a"
          ? { ok: false as const, error: failure("storeFailed", "x", "もう一度試す") }
          : f(args),
    });
    expect(m.auto.runOnce().purged.sort()).toEqual(["b", "bc"]);
    expect(m.notes.some((x) => x.event === "autoPurge.failed" && x.data.nodeId === "a")).toBe(true);
    fail = false;
    expect(m.auto.runOnce().purged.sort()).toEqual(["a", "ac"]);
  });

  it("同じ木を二度は消さない（requestId が決定的）。再実行しても、何も起きない", () => {
    const r = rig();
    r.tree("t", 1);
    const m = make(r, { nowDays: 100 });
    expect(m.auto.runOnce().purged).toEqual(["tc", "t"]);
    const seq = r.log.state().lastSeq;
    expect(m.auto.runOnce().purged).toEqual([]);
    expect(r.log.state().lastSeq).toBe(seq);
  });

  it("実行中なら、次の実行は飛ばす（重ならない）", () => {
    const r = rig();
    r.tree("t", 1);
    let inner: ReturnType<typeof createAutoPurger> | undefined;
    let reentered: { skipped: boolean } | undefined;
    const m = make(r, {
      nowDays: 100,
      purgeWrap: (f) => (args) => {
        reentered = inner?.runOnce();
        return f(args);
      },
    });
    inner = m.auto;
    m.auto.runOnce();
    expect(reentered?.skipped).toBe(true);
    expect(m.notes.some((x) => x.event === "autoPurge.skipped")).toBe(true);
    expect(ids(r)).toEqual(["root"]);
  });

  it("start の最初の実行は 1 周期後。stop で止まる。周期ごとに続く", async () => {
    const r = rig();
    r.tree("a", 1);
    const m = make(r, { nowDays: 100 });
    m.auto.start();
    expect(ids(r)).toContain("a"); // 起動直後は消さない
    await m.mt.advance(30 * 60_000);
    expect(ids(r)).toContain("a");
    await m.mt.advance(30 * 60_000); // 1 周期（60 分）
    expect(ids(r)).not.toContain("a");
    r.tree("b", 2); // 次の周期で消える
    await m.mt.advance(60 * 60_000);
    expect(ids(r)).not.toContain("b");
    m.auto.stop();
    r.tree("c", 3);
    await m.mt.advance(120 * 60_000);
    expect(ids(r)).toContain("c");
  });

  it("ログが壊れた後（isStopped）は、動かさない", async () => {
    const r = rig();
    r.tree("a", 1);
    let broken = false;
    const m = make(r, { nowDays: 100, isStopped: () => broken });
    m.auto.start();
    broken = true;
    await m.mt.advance(60 * 60_000);
    expect(ids(r)).toContain("a");
  });

  it("実 SQLite: 自動の削除でも、消した本文はデータベースにも WAL にも残らない（secure_delete と checkpoint）。開き直しても同じ状態", () => {
    const dir = mkdtempSync(join(tmpdir(), "cso-auto-purge-"));
    try {
      const path = join(dir, "e.db");
      const s = openSqliteStore(path);
      if (!s.ok) throw new Error(s.error.code);
      const r = rig({ store: s.value });
      r.tree("t", 1, true);
      const m = make(r, { nowDays: 100 });
      expect(m.auto.runOnce().purged).toEqual(["tc", "t"]);
      const state = r.log.state();
      s.value.close();
      for (const f of [path, `${path}-wal`]) {
        if (existsSync(f)) expect(readFileSync(f).includes(SECRET), f).toBe(false);
      }
      const again = openSqliteStore(path);
      if (!again.ok) throw new Error(again.error.code);
      const reopened = EventLog.open(again.value, {
        clock: () => "2026-06-01T00:00:00Z",
        verifySnapshot: true,
      });
      expect(reopened.ok && reopened.value.state()).toEqual(state);
      again.value.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
