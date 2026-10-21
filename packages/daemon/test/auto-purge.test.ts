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
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
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
    nowMs?: () => number;
    retentionDays?: number;
    maxTreesPerRun?: number;
    defaultTombstone?: boolean;
    isStopped?: () => boolean;
    /** 省略すると、現在時刻の 1 秒前（時計が正常な場合）。 */
    lastEventAt?: () => string | undefined;
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
    nowMs: opts.nowMs ?? (() => T0 + opts.nowDays * DAY),
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
    lastEventAt: opts.lastEventAt ?? (() => new Date(T0 + opts.nowDays * DAY - 1000).toISOString()),
  });
  return { auto, mt, notes, audits, revoked };
};

const ids = (r: ReturnType<typeof rig>) =>
  r.log
    .state()
    .nodes.map((n) => n.id)
    .sort();

describe("自動の最終削除（T13f-a）", () => {
  it("保持期間を過ぎた最上位の木だけを消す。期間内の木は残す", async () => {
    const r = rig();
    r.tree("old", 1);
    r.tree("young", 50);
    const m = make(r, { nowDays: 100 }); // old: 99 日、young: 50 日
    const out = await m.auto.runOnce();
    expect(out.skipped).toBe(false);
    expect(out.purged.sort()).toEqual(["old", "oldc"]);
    expect(ids(r)).toEqual(["root", "young", "youngc"]);
    expect(r.log.state().tombstones).toHaveLength(1);
  });

  it("古い順に、maxTreesPerRun 本までだけ消す。残りは次の実行で消す", async () => {
    const r = rig();
    r.tree("a", 1);
    r.tree("b", 2);
    r.tree("c", 3);
    const m = make(r, { nowDays: 200, maxTreesPerRun: 2 });
    expect((await m.auto.runOnce()).purged.sort()).toEqual(["a", "ac", "b", "bc"]);
    expect(ids(r)).toEqual(["c", "cc", "root"]);
    expect((await m.auto.runOnce()).purged.sort()).toEqual(["c", "cc"]);
  });

  it("人間のコマンドと同じ経路を通る: 操作の主体は system、標識・監査（origin: auto）・トークンの失効が行われる", async () => {
    const r = rig();
    r.tree("t", 1);
    const m = make(r, { nowDays: 100 });
    await m.auto.runOnce();
    expect(m.audits.map((a) => a.event)).toEqual(["purgeStarting", "purged"]);
    expect(m.audits.every((a) => a.data.origin === "auto")).toBe(true);
    expect([...m.revoked].sort()).toEqual(["t", "tc"]);
    const marker = r.log.state().tombstones[0];
    expect(marker?.rootId).toBe("t");
  });

  it("墓標は、設定の既定（purgeTombstone）に従う", async () => {
    const a = rig();
    a.tree("t", 1);
    await make(a, { nowDays: 100, defaultTombstone: false }).auto.runOnce();
    expect(a.log.state().tombstones[0]?.tombstone).toBeUndefined();
    const b = rig();
    b.tree("t", 1);
    await make(b, { nowDays: 100, defaultTombstone: true }).auto.runOnce();
    expect(b.log.state().tombstones[0]?.tombstone?.title).toBeDefined();
  });

  it("最上位でない木・木にアーカイブでないノードがある木・別の木が依存している木は対象にしない（人間と同じ判定）", async () => {
    const r = rig();
    r.tree("done", 1);
    // 配下が動作中の木
    r.node("busy", "integrator", "root");
    r.ev("busy", { type: "start" });
    const m = make(r, { nowDays: 100 });
    const out = await m.auto.runOnce();
    expect(out.purged.sort()).toEqual(["done", "donec"]);
    expect(ids(r)).toContain("busy");
  });

  it("1 本が失敗しても止めず、記録に残して、次の木へ進む。同じ木は次の実行で再試行する", async () => {
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
    expect((await m.auto.runOnce()).purged.sort()).toEqual(["b", "bc"]);
    expect(m.notes.some((x) => x.event === "autoPurge.failed" && x.data.nodeId === "a")).toBe(true);
    fail = false;
    expect((await m.auto.runOnce()).purged.sort()).toEqual(["a", "ac"]);
  });

  it("同じ木を二度は消さない（requestId が決定的）。再実行しても、何も起きない", async () => {
    const r = rig();
    r.tree("t", 1);
    const m = make(r, { nowDays: 100 });
    expect((await m.auto.runOnce()).purged).toEqual(["tc", "t"]);
    const seq = r.log.state().lastSeq;
    expect((await m.auto.runOnce()).purged).toEqual([]);
    expect(r.log.state().lastSeq).toBe(seq);
  });

  it("実行中なら、次の実行は飛ばす（重ならない）", async () => {
    const r = rig();
    r.tree("t", 1);
    let inner: ReturnType<typeof createAutoPurger> | undefined;
    let reentered: { skipped: boolean } | undefined;
    const m = make(r, {
      nowDays: 100,
      purgeWrap: (f) => (args) => {
        void inner?.runOnce().then((v) => {
          reentered = v;
        });
        return f(args);
      },
    });
    inner = m.auto;
    await m.auto.runOnce();
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

  it("根のノード（parentId が null）は、アーカイブ済みで保持期間を過ぎていても、対象にしない（人間の node.purge だけ）", async () => {
    const r = rig();
    r.tree("t", 1);
    // 根もアーカイブ済みにする（配下がすべてアーカイブ済みなので、根の木全体が消せる状態）
    r.ev("root", { type: "reportDone" });
    r.ev("root", { type: "accept" });
    r.ev("root", { type: "markReclaimable", discarded: false });
    r.ev("root", { type: "archive" });
    const m = make(r, { nowDays: 100 });
    const out = await m.auto.runOnce();
    expect(out.purged).toEqual([]);
    expect(ids(r)).toContain("root");
    expect(ids(r)).toContain("t");
  });

  it("時計が、ログの最後の記録より前に戻っていたら、その回は止めて、理由を付けて記録する", async () => {
    const r = rig();
    r.tree("a", 1);
    const m = make(r, {
      nowDays: 100,
      lastEventAt: () => new Date(T0 + 100 * DAY + 60_000).toISOString(),
    });
    const out = await m.auto.runOnce();
    expect(out).toEqual({ skipped: true, purged: [] });
    expect(ids(r)).toContain("a");
    const note = m.notes.find((x) => x.event === "autoPurge.skipped");
    expect(String(note?.data.reason)).toContain("前に戻っている");
  });

  it("最後の記録から保持期間の半分以上進んでいたら、その回は止める。半分に満たなければ動く", async () => {
    const r = rig();
    r.tree("a", 1);
    const stop = make(r, {
      nowDays: 100,
      retentionDays: 90,
      lastEventAt: () => new Date(T0 + 55 * DAY).toISOString(), // 45 日（半分）
    });
    expect((await stop.auto.runOnce()).skipped).toBe(true);
    expect(String(stop.notes.at(-1)?.data.reason)).toContain("半分以上");
    expect(ids(r)).toContain("a");
    const ok = make(r, {
      nowDays: 100,
      retentionDays: 90,
      lastEventAt: () => new Date(T0 + 56 * DAY).toISOString(), // 44 日
    });
    expect((await ok.auto.runOnce()).purged).toEqual(["ac", "a"]);
  });

  it("ログが空（最後の記録がない）か、最後の時刻を読めないとき: 空は動き、読めなければ止める", async () => {
    const r = rig();
    r.tree("a", 1);
    expect(
      (await make(r, { nowDays: 100, lastEventAt: () => "不正" }).auto.runOnce()).skipped,
    ).toBe(true);
    expect(
      (await make(r, { nowDays: 100, lastEventAt: () => undefined }).auto.runOnce()).purged,
    ).toEqual(["ac", "a"]);
  });

  it("木を 1 本処理するごとに、イベントループに譲る（setImmediate）", async () => {
    const r = rig();
    r.tree("a", 1);
    r.tree("b", 2);
    r.tree("c", 3);
    const order: string[] = [];
    const m = make(r, {
      nowDays: 100,
      purgeWrap: (f) => (args) => {
        order.push(`purge:${args.nodeId}`);
        return f(args);
      },
    });
    const done = m.auto.runOnce().then(() => order.push("done"));
    setImmediate(() => order.push("tick"));
    await done;
    // 譲っているので、最初の木のあとに、ほかの setImmediate が割り込める
    expect(order.indexOf("tick")).toBeGreaterThan(order.indexOf("purge:a"));
    expect(order.indexOf("tick")).toBeLessThan(order.indexOf("done"));
  });

  it("同じ木・同じ原因の失敗の記録は、1 日に 1 回まで（1 日たてば、また記録する）", async () => {
    const r = rig();
    r.tree("a", 1);
    let t = T0 + 100 * DAY;
    const m = make(r, {
      nowDays: 100,
      nowMs: () => t,
      lastEventAt: () => undefined,
      purgeWrap: () => () => ({
        ok: false as const,
        error: failure("storeFailed", "x", "もう一度試す"),
      }),
    });
    await m.auto.runOnce();
    t += 60 * 60_000;
    await m.auto.runOnce();
    expect(m.notes.filter((x) => x.event === "autoPurge.failed")).toHaveLength(1);
    t += 24 * 60 * 60_000;
    await m.auto.runOnce();
    expect(m.notes.filter((x) => x.event === "autoPurge.failed")).toHaveLength(2);
  });

  it("実 SQLite: 自動の削除でも、消した本文はデータベースにも WAL にも残らない（secure_delete と checkpoint）。開き直しても同じ状態", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cso-auto-purge-"));
    try {
      const path = join(dir, "e.db");
      const s = openSqliteStore(path);
      if (!s.ok) throw new Error(s.error.code);
      const r = rig({ store: s.value });
      r.tree("t", 1, true);
      const m = make(r, { nowDays: 100 });
      expect((await m.auto.runOnce()).purged).toEqual(["tc", "t"]);
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
