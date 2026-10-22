import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EventBody, failure, type NodeEvent, planPurge } from "@cso/core";
import { describe, expect, it } from "vitest";
import { deriveId } from "../src/api/handlers/context.js";
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
    noticeDays?: number;
    /** 起動の時点の、ログの最後の記録の時刻。 */
    startupLastEventAt?: string;
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
  let days = opts.nowDays;
  /** 壁時計だけが飛んだ分（単調時計は進まない）。 */
  let jumpMs = 0;
  r.setNow(T0 + days * DAY);
  const notes: { event: string; data: Record<string, unknown> }[] = [];
  const audits: { event: string; data: Record<string, unknown> }[] = [];
  const revoked: string[] = [];
  const deps: PurgeHandlerDeps = {
    log: r.log,
    nowMs: opts.nowMs ?? (() => T0 + days * DAY),
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
    noticeDays: opts.noticeDays ?? 7,
    record: (requestId, body) => r.log.append({ requestId, actor: SYS, body }),
    purgeTreeOf: opts.purgeWrap ? opts.purgeWrap(purger.purgeTreeOf) : purger.purgeTreeOf,
    timers: mt.timers,
    note: (event, data) => notes.push({ event, data }),
    isStopped: opts.isStopped ?? (() => false),
    monoMs: () => (opts.nowMs ?? (() => T0 + days * DAY))() - T0 - jumpMs,
    lastEventAtAtStartup: opts.startupLastEventAt,
    lastEventAt: opts.lastEventAt ?? (() => new Date(T0 + days * DAY - 1000).toISOString()),
  });
  const setDays = (d: number): void => {
    days = d;
    r.setNow(T0 + d * DAY);
  };
  /** 壁時計だけを `d` 日動かす（時計が飛んだ。単調時計は進まない）。 */
  const jumpClock = (d: number): void => {
    jumpMs += d * DAY;
    setDays(days + d);
  };
  /** 予告を出し（1 回目）、noticeDays 日すぎてから、削除する（2 回目）。2 回目の結果を返す。 */
  const settle = async () => {
    await auto.runOnce();
    setDays(days + (opts.noticeDays ?? 7) + 1);
    return auto.runOnce();
  };
  return { auto, mt, notes, audits, revoked, setDays, jumpClock, settle, days: () => days };
};

const ids = (r: ReturnType<typeof rig>) =>
  r.log
    .state()
    .nodes.map((n) => n.id)
    .sort();

const noticesOf = (r: ReturnType<typeof rig>) =>
  r.log.state().inbox.filter((i) => i.id.startsWith("apn-"));

describe("自動の最終削除（T13f-a・T13f-n）", () => {
  it("保持期間を過ぎた最上位の木だけを消す。期間内の木は残す（予告のあと）", async () => {
    const r = rig();
    r.tree("old", 1);
    r.tree("young", 50);
    const m = make(r, { nowDays: 100 }); // old: 99 日、young: 50 日
    const out = await m.settle();
    expect(out.skipped).toBe(false);
    expect(out.purged.sort()).toEqual(["old", "oldc"]);
    expect(ids(r)).toEqual(["root", "young", "youngc"]);
    expect(r.log.state().tombstones).toHaveLength(1);
  });

  it("予告より前（1 回目）は、消さずに、予告だけを出す。noticeDays 日たつまでは、消さない", async () => {
    const r = rig();
    r.tree("t", 1);
    const m = make(r, { nowDays: 100, noticeDays: 7 });
    expect((await m.auto.runOnce()).purged).toEqual([]);
    expect(ids(r)).toContain("t");
    expect(noticesOf(r)).toHaveLength(1);
    m.setDays(106); // 6 日後
    expect((await m.auto.runOnce()).purged).toEqual([]);
    expect(ids(r)).toContain("t");
    m.setDays(107); // 7 日後
    expect((await m.auto.runOnce()).purged).toEqual(["tc", "t"]);
  });

  it("予告は、木の根の親のノードの info の項目として 1 件だけ出る（再実行・別の実行器でも重複しない）。要約に、判断と未解決の項目の数", async () => {
    const r = rig();
    r.tree("t", 1);
    const m = make(r, { nowDays: 100 });
    await m.auto.runOnce();
    await m.auto.runOnce();
    await make(r, { nowDays: 100 }).auto.runOnce();
    const items = noticesOf(r);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "info", nodeId: "root" });
    expect(items[0]?.summary).toContain("木 t を");
    expect(items[0]?.summary).toContain("2026-");
    expect((items[0]?.summary ?? "").length).toBeLessThanOrEqual(200);
  });

  it("予告の要約に、木の中の未回答の判断・未解決の受信箱の項目の数を載せる", async () => {
    const r = rig();
    r.node("u", "integrator", "root");
    r.ev("u", { type: "start" });
    r.node("uc", "implement", "u");
    r.ev("uc", { type: "start" });
    r.add({
      type: "decision.requested",
      payload: { decisionId: "d1", nodeId: "uc", question: "q", options: ["a"] },
    } as never);
    r.add({ type: "inbox.added", payload: { id: "i1", kind: "info", nodeId: "uc", summary: "x" } });
    // 判断を回答済みにして、アーカイブする（判断は未回答のまま木をアーカイブできないため、回答してから別の判断を足す）
    r.add({ type: "decision.answered", payload: { decisionId: "d1", answer: "a" } } as never);
    for (const x of ["uc", "u"]) {
      r.ev(x, { type: "reportDone" });
      r.ev(x, { type: "accept" });
      r.ev(x, { type: "markReclaimable", discarded: false });
      r.ev(x, { type: "archive" });
    }
    const m = make(r, { nowDays: 100 });
    await m.auto.runOnce();
    const summary = noticesOf(r)[0]?.summary ?? "";
    expect(summary).toContain("未解決の項目 1");
  });

  it("人間が予告を解決済みにしても、削除の条件は変わらない（予告が出たことと、その at で判定する）", async () => {
    const r = rig();
    r.tree("t", 1);
    const m = make(r, { nowDays: 100 });
    await m.auto.runOnce();
    const id = noticesOf(r)[0]?.id ?? "";
    r.log.append({
      requestId: "human-resolve",
      actor: { human: true },
      body: { type: "inbox.resolved", payload: { itemId: id } },
    });
    m.setDays(106);
    expect((await m.auto.runOnce()).purged).toEqual([]); // 解決済みでも、早くは消えない
    m.setDays(108);
    expect((await m.auto.runOnce()).purged).toEqual(["tc", "t"]); // 解決済みでも、たてば消える
  });

  it("削除のあと、予告を system が解決済みにする", async () => {
    const r = rig();
    r.tree("t", 1);
    const m = make(r, { nowDays: 100 });
    await m.settle();
    const item = r.log.state().inbox.find((i) => i.id.startsWith("apn-"));
    expect(item?.resolved?.by).toEqual({ system: true });
  });

  it("削除の直前に、保持期間をもう一度判定する: 予告のあとで retentionDays を延ばしたら、予告済みでも消さない。予告は取り下げ、期間が過ぎたら出し直す", async () => {
    const r = rig();
    r.tree("t", 1); // アーカイブは 1 日目
    const first = make(r, { nowDays: 100, retentionDays: 90 });
    await first.auto.runOnce(); // 予告
    expect(noticesOf(r)).toHaveLength(1);
    // 保持期間を 200 日に延ばして再起動（別の実行器）。予告から 8 日たっても、消さない
    const second = make(r, { nowDays: 108, retentionDays: 200 });
    expect((await second.auto.runOnce()).purged).toEqual([]);
    expect(ids(r)).toContain("t");
    expect(noticesOf(r)[0]?.resolved?.by).toEqual({ system: true }); // 取り下げ
    expect(second.notes.some((x) => x.event === "autoPurge.noticeWithdrawn")).toBe(true);
    // 200 日を過ぎたら、予告を出し直し、さらに noticeDays 日たってから消す
    const third = make(r, { nowDays: 202, retentionDays: 200 });
    expect((await third.auto.runOnce()).purged).toEqual([]);
    expect(noticesOf(r)).toHaveLength(2);
    third.setDays(210);
    expect((await third.auto.runOnce()).purged).toEqual(["tc", "t"]);
  });

  it("予告のあとで木が対象から外れたら（外から依存された）、予告を system が解決済みにする", async () => {
    const r = rig();
    r.tree("t", 1);
    const m = make(r, { nowDays: 100 });
    await m.auto.runOnce();
    expect(noticesOf(r)[0]?.resolved).toBeUndefined();
    // 木の外のノードが、木のノードに依存する
    r.add({
      type: "node.created",
      payload: { nodeId: "w", role: "implement", parentId: "root", dependsOn: ["tc"] },
    });
    m.setDays(101);
    await m.auto.runOnce();
    expect(noticesOf(r)[0]?.resolved?.by).toEqual({ system: true });
    expect(ids(r)).toContain("t");
  });

  it("長く停止していて、保持期間をだいぶ過ぎてから起動した場合も、予告を今出し、noticeDays 日後に消す", async () => {
    const r = rig();
    r.tree("t", 1);
    const m = make(r, { nowDays: 400 }); // 399 日
    expect((await m.auto.runOnce()).purged).toEqual([]);
    expect(noticesOf(r)).toHaveLength(1);
    m.setDays(408);
    expect((await m.auto.runOnce()).purged).toEqual(["tc", "t"]);
  });

  it("予告は 1 回の実行で 20 件まで", async () => {
    const r = rig();
    for (let i = 0; i < 22; i++) r.tree(`t${i}`, 1);
    const m = make(r, { nowDays: 100 });
    await m.auto.runOnce();
    expect(noticesOf(r)).toHaveLength(20);
    await m.auto.runOnce();
    expect(noticesOf(r)).toHaveLength(22);
  });

  it("古い順に、maxTreesPerRun 本までだけ消す。残りは次の実行で消す", async () => {
    const r = rig();
    r.tree("a", 1);
    r.tree("b", 2);
    r.tree("c", 3);
    const m = make(r, { nowDays: 200, maxTreesPerRun: 2 });
    expect((await m.settle()).purged.sort()).toEqual(["a", "ac", "b", "bc"]);
    expect(ids(r)).toEqual(["c", "cc", "root"]);
    expect((await m.auto.runOnce()).purged.sort()).toEqual(["c", "cc"]);
  });

  it("人間のコマンドと同じ経路を通る: 操作の主体は system、標識・監査（origin: auto）・トークンの失効が行われる", async () => {
    const r = rig();
    r.tree("t", 1);
    const m = make(r, { nowDays: 100 });
    await m.settle();
    expect(m.audits.map((a) => a.event)).toEqual(["purgeStarting", "purged"]);
    expect(m.audits.every((a) => a.data.origin === "auto")).toBe(true);
    expect([...m.revoked].sort()).toEqual(["t", "tc"]);
    expect(r.log.state().tombstones[0]?.rootId).toBe("t");
  });

  it("墓標は、設定の既定（purgeTombstone）に従う", async () => {
    const a = rig();
    a.tree("t", 1);
    await make(a, { nowDays: 100, defaultTombstone: false }).settle();
    expect(a.log.state().tombstones[0]?.tombstone).toBeUndefined();
    const b = rig();
    b.tree("t", 1);
    await make(b, { nowDays: 100, defaultTombstone: true }).settle();
    expect(b.log.state().tombstones[0]?.tombstone?.title).toBeDefined();
  });

  it("最上位でない木・木にアーカイブでないノードがある木・別の木が依存している木は対象にしない（人間と同じ判定）。予告も出さない", async () => {
    const r = rig();
    r.tree("done", 1);
    r.node("busy", "integrator", "root");
    r.ev("busy", { type: "start" });
    const m = make(r, { nowDays: 100 });
    const out = await m.settle();
    expect(out.purged.sort()).toEqual(["done", "donec"]);
    expect(ids(r)).toContain("busy");
    expect(noticesOf(r).every((i) => i.summary?.includes("木 done"))).toBe(true);
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
    expect((await m.settle()).purged.sort()).toEqual(["b", "bc"]);
    expect(m.notes.some((x) => x.event === "autoPurge.failed" && x.data.nodeId === "a")).toBe(true);
    fail = false;
    expect((await m.auto.runOnce()).purged.sort()).toEqual(["a", "ac"]);
  });

  it("同じ木を二度は消さない（requestId が決定的）。再実行しても、何も起きない", async () => {
    const r = rig();
    r.tree("t", 1);
    const m = make(r, { nowDays: 100 });
    expect((await m.settle()).purged).toEqual(["tc", "t"]);
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
    await m.settle();
    await new Promise((res) => setImmediate(res));
    expect(reentered?.skipped).toBe(true);
    expect(m.notes.some((x) => x.event === "autoPurge.skipped")).toBe(true);
    expect(ids(r)).toEqual(["root"]);
  });

  it("start の最初の実行は 1 周期後。stop で止まる。周期ごとに続く（予告 → noticeDays 後に削除）", async () => {
    const r = rig();
    r.tree("a", 1);
    const m = make(r, { nowDays: 100 });
    m.auto.start();
    expect(noticesOf(r)).toHaveLength(0); // 起動直後は何もしない
    await m.mt.advance(30 * 60_000);
    expect(noticesOf(r)).toHaveLength(0);
    await m.mt.advance(30 * 60_000); // 1 周期（60 分）
    expect(noticesOf(r)).toHaveLength(1);
    expect(ids(r)).toContain("a");
    m.setDays(108);
    await m.mt.advance(60 * 60_000);
    expect(ids(r)).not.toContain("a");
    await m.auto.stop();
    r.tree("c", 3);
    await m.mt.advance(120 * 60_000);
    expect(noticesOf(r).filter((i) => i.summary?.includes("木 c"))).toHaveLength(0);
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
    expect(noticesOf(r)).toHaveLength(0);
  });

  it("根のノード（parentId が null）は、アーカイブ済みで保持期間を過ぎていても、対象にしない（予告も出さない。人間の node.purge だけ）", async () => {
    const r = rig();
    r.tree("t", 1);
    r.ev("root", { type: "reportDone" });
    r.ev("root", { type: "accept" });
    r.ev("root", { type: "markReclaimable", discarded: false });
    r.ev("root", { type: "archive" });
    const m = make(r, { nowDays: 100 });
    const out = await m.settle();
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
    expect(noticesOf(r)).toHaveLength(0);
    const note = m.notes.find((x) => x.event === "autoPurge.skipped");
    expect(String(note?.data.reason)).toContain("前に戻っている");
  });

  it("時計が前へ飛んだら（壁時計だけが 10 日進んだ）、その回は止めて、予告を出し直す。飛んだ時間は、予告の期間に数えない（すぐには消さない）", async () => {
    const r = rig();
    r.tree("t", 1);
    const m = make(r, { nowDays: 100 });
    m.auto.start();
    await m.auto.runOnce(); // 予告
    const firstId = noticesOf(r)[0]?.id;
    m.jumpClock(10); // 予告から 10 日（noticeDays 7 日を超える）
    const out = await m.auto.runOnce();
    expect(out.skipped).toBe(true);
    expect(String(m.notes.find((x) => x.event === "autoPurge.skipped")?.data.reason)).toContain(
      "前に飛んだ",
    );
    expect(ids(r)).toContain("t"); // すぐ消えない
    const items = noticesOf(r);
    expect(items).toHaveLength(2); // 出し直した
    expect(items.find((i) => i.id === firstId)?.resolved?.by).toEqual({ system: true });
    // 出し直した予告から noticeDays 日たつまでは、消さない
    m.setDays(m.days() + 6);
    expect((await m.auto.runOnce()).purged).toEqual([]);
    m.setDays(m.days() + 2);
    expect((await m.auto.runOnce()).purged).toEqual(["tc", "t"]);
  });

  it("時計の飛びの閾値は min(noticeDays の半分, 1 日)。noticeDays が 1 日なら 12 時間を超える飛びを検知し、それ未満は通す", async () => {
    const r = rig();
    r.tree("t", 1);
    const m = make(r, { nowDays: 100, noticeDays: 1 });
    m.auto.start();
    await m.auto.runOnce();
    m.jumpClock(0.4); // 9.6 時間: 閾値（12 時間）未満
    expect((await m.auto.runOnce()).skipped).toBe(false);
    m.jumpClock(0.6); // 14.4 時間: 閾値を超える
    expect((await m.auto.runOnce()).skipped).toBe(true);
  });

  it("時計が後ろへ戻ったら、その回は止める（予告は出し直さない）", async () => {
    const r = rig();
    r.tree("t", 1);
    const m = make(r, { nowDays: 100 });
    m.auto.start();
    await m.auto.runOnce();
    m.jumpClock(-3);
    const out = await m.auto.runOnce();
    expect(out.skipped).toBe(true);
    expect(String(m.notes.at(-1)?.data.reason)).toContain("戻った");
    expect(noticesOf(r)).toHaveLength(1);
  });

  it("daemon が止まっていた時間は、予告の期間に数えない: 起動のとき、ログの最後の記録から 1 日以上たっていたら、有効な予告を出し直す", async () => {
    const r = rig();
    r.tree("t", 1);
    const before = make(r, { nowDays: 100 });
    await before.auto.runOnce(); // 予告（100 日目）
    expect(noticesOf(r)).toHaveLength(1);
    // 10 日停止して、110 日目に起動する（起動の時点の最後の記録は、100 日目）
    const lastAt = new Date(T0 + 100 * DAY).toISOString();
    const after = make(r, { nowDays: 110, startupLastEventAt: lastAt });
    after.auto.start();
    expect(noticesOf(r)).toHaveLength(2);
    expect(noticesOf(r)[0]?.resolved?.by).toEqual({ system: true });
    // 1 周期後に動いても、すぐには消さない（出し直した予告から noticeDays 日たつまで）
    expect((await after.auto.runOnce()).purged).toEqual([]);
    expect(ids(r)).toContain("t");
    after.setDays(117);
    expect((await after.auto.runOnce()).purged).toEqual(["tc", "t"]);
  });

  it("止まっていたのが 1 日未満なら、予告を出し直さない", async () => {
    const r = rig();
    r.tree("t", 1);
    await make(r, { nowDays: 100 }).auto.runOnce();
    const lastAt = new Date(T0 + 100 * DAY).toISOString();
    const after = make(r, { nowDays: 100.5, startupLastEventAt: lastAt });
    after.auto.start();
    expect(noticesOf(r)).toHaveLength(1);
  });

  it("動きのない daemon でも、自動の削除は止まらない（ログの最後の記録からの経過では止めない）", async () => {
    const r = rig();
    r.tree("a", 1);
    const m = make(r, {
      nowDays: 100,
      retentionDays: 90,
      lastEventAt: () => new Date(T0 + 20 * DAY).toISOString(), // 80 日前（保持期間の半分より古い）
    });
    m.auto.start();
    expect((await m.auto.runOnce()).skipped).toBe(false);
    expect(noticesOf(r)).toHaveLength(1);
  });

  it("stop のあと、実行中の 1 回は、残りの木を処理しない。stop は実行中の 1 回が終わるのを待つ", async () => {
    const r = rig();
    r.tree("a", 1);
    r.tree("b", 2);
    r.tree("c", 3);
    let stopPromise: Promise<void> | undefined;
    let auto: ReturnType<typeof createAutoPurger> | undefined;
    const m = make(r, {
      nowDays: 100,
      purgeWrap: (f) => (args) => {
        const res = f(args);
        if (args.nodeId === "a") stopPromise = auto?.stop(); // 1 本目の削除の最中に stop
        return res;
      },
    });
    auto = m.auto;
    await m.auto.runOnce(); // 予告
    m.setDays(108);
    await m.auto.runOnce();
    await stopPromise;
    expect(ids(r)).not.toContain("a");
    expect(ids(r)).toContain("b"); // 2 本目以降は、処理されない
    expect(ids(r)).toContain("c");
  });

  it("長い nodeId でも、予告の requestId・ID が isSafeId の上限（128 文字）を超えない", async () => {
    const r = rig();
    const long = "x".repeat(100);
    r.tree(long, 1);
    const m = make(r, { nowDays: 100 });
    await m.auto.runOnce();
    expect(m.notes.some((x) => x.event === "autoPurge.noticePosted")).toBe(true);
    expect(noticesOf(r)).toHaveLength(1);
  });

  it("予告が 1 木 50 件に達したら、理由を付けて記録し、その木の自動の削除を止める（予告を出し続けない）", async () => {
    const r = rig();
    r.tree("t", 1);
    const plan = planPurge(r.log.state(), "t", T0 + 100 * DAY);
    const at = plan.ok ? plan.value.archivedAt : "";
    for (let i = 0; i < 50; i++) {
      const id = deriveId("apn", "system", `t:${at}:${i}`, "notice");
      r.add({ type: "inbox.added", payload: { id, kind: "info", nodeId: "root", summary: "x" } });
      r.log.append({
        requestId: `res-${i}`,
        actor: { system: true },
        body: { type: "inbox.resolved", payload: { itemId: id } },
      });
    }
    const m = make(r, { nowDays: 100 });
    const out = await m.settle();
    expect(out.purged).toEqual([]);
    expect(ids(r)).toContain("t");
    const note = m.notes.find((x) => x.event === "autoPurge.noticeFailed");
    expect(String(note?.data.reason)).toContain("上限");
    expect(noticesOf(r)).toHaveLength(50);
  });

  it("ログが空（最後の記録がない）か、最後の時刻を読めないとき: 空は動き、読めなければ止める", async () => {
    const r = rig();
    r.tree("a", 1);
    expect(
      (await make(r, { nowDays: 100, lastEventAt: () => "不正" }).auto.runOnce()).skipped,
    ).toBe(true);
    expect((await make(r, { nowDays: 100, lastEventAt: () => undefined }).settle()).purged).toEqual(
      ["ac", "a"],
    );
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
    await m.auto.runOnce(); // 予告
    m.setDays(108);
    const done = m.auto.runOnce().then(() => order.push("done"));
    setImmediate(() => order.push("tick"));
    await done;
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
    await m.auto.runOnce(); // 予告
    t += 8 * DAY;
    r.setNow(t);
    await m.auto.runOnce(); // 削除に失敗
    t += 60 * 60_000;
    r.setNow(t);
    await m.auto.runOnce();
    expect(m.notes.filter((x) => x.event === "autoPurge.failed")).toHaveLength(1);
    t += 24 * 60 * 60_000;
    r.setNow(t);
    await m.auto.runOnce();
    expect(m.notes.filter((x) => x.event === "autoPurge.failed")).toHaveLength(2);
  });

  it("実 SQLite: 予告を含むログも、開き直しても同じ状態になる。自動の削除でも、消した本文はデータベースにも WAL にも残らない", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cso-auto-purge-"));
    try {
      const path = join(dir, "e.db");
      const s = openSqliteStore(path);
      if (!s.ok) throw new Error(s.error.code);
      const r = rig({ store: s.value });
      r.tree("t", 1, true);
      const m = make(r, { nowDays: 100 });
      expect((await m.settle()).purged).toEqual(["tc", "t"]);
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
