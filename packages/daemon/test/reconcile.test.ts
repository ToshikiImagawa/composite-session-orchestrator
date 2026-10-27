import {
  type EventBody,
  INBOX_SUMMARY_MAX,
  type NodeEvent,
  type ProcessInfo,
  stateOf,
} from "@cso/core";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/eventlog.js";
import { createMemoryStore } from "../src/memory-store.js";
import { EXTERNAL_CHECK_SUMMARY, reconcileOnStartup } from "../src/reconcile.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-10-20T00:00:00Z";
let n = 0;

/** root ─ a(running)・w(waiting)・s(stopping)・i(stopIncomplete)・d(done)・p(pending)・g(別名で管理中の running) */
const rig = (
  opts: {
    processes?: Record<string, readonly ProcessInfo[] | null>;
    managed?: string[];
    noCwd?: string[];
    external?: boolean;
  } = {},
) => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  const node = (nodeId: string, parentId: string | null) =>
    add({
      type: "node.created",
      payload: {
        nodeId,
        role: parentId === null ? "integrator" : "implement",
        parentId,
        dependsOn: [],
      },
    });
  node("root", null);
  ev("root", { type: "start" });
  for (const id of ["a", "w", "s", "i", "d", "g"]) {
    node(id, "root");
    ev(id, { type: "start" });
  }
  node("p", "root");
  ev("w", { type: "requestDecision" });
  ev("s", { type: "stop", mode: "immediate" });
  ev("i", { type: "stop", mode: "immediate" });
  ev("i", { type: "stopTimeout" });
  ev("d", { type: "reportDone" });
  const probed: string[] = [];
  const run = () =>
    reconcileOnStartup({
      log,
      clock,
      cwdOf: async (id) => (opts.noCwd?.includes(id) ? undefined : `/wt/${id}`),
      probe: async (path) => {
        probed.push(path);
        const id = path.replace("/wt/", "");
        return opts.processes !== undefined && id in opts.processes
          ? (opts.processes[id] ?? null)
          : [];
      },
      has: (id) => opts.managed?.includes(id) ?? false,
      ...(opts.external === true ? { external: () => true } : {}),
    });
  return { log, run, probed, s: () => log.state() };
};

const proc = (pid: number): ProcessInfo => ({ pid, cwd: "/x", hasOpenFiles: true });

describe("reconcileOnStartup（再起動の後、記録と実際のプロセスを合わせる）", () => {
  it("プロセスのない running・waiting は、予期しない終了として記録し、停止済みにして、受信箱に失敗を出す", async () => {
    const r = rig();
    await r.run();
    for (const id of ["a", "w"]) {
      expect(stateOf(r.s(), id), id).toBe("stopped");
      expect(r.s().exits.some((e) => e.nodeId === id)).toBe(true);
      expect(r.s().inbox.some((i) => i.nodeId === id && i.kind === "failure")).toBe(true);
    }
  });

  it("プロセスのない stopping・stopIncomplete は、停止を確認して stopped にする", async () => {
    const r = rig();
    await r.run();
    expect(stateOf(r.s(), "s")).toBe("stopped");
    expect(stateOf(r.s(), "i")).toBe("stopped");
  });

  it("プロセスが残っている running は、停止未完了（pid つきの受信箱の項目）にする。stopping は stopTimeout にする", async () => {
    const r = rig({ processes: { a: [proc(111)], s: [proc(222)] } });
    await r.run();
    expect(stateOf(r.s(), "a")).toBe("stopIncomplete");
    expect(stateOf(r.s(), "s")).toBe("stopIncomplete");
    const items = r.s().inbox.filter((i) => i.kind === "stopIncomplete");
    expect(items.map((i) => i.summary).join(" ")).toContain("111");
    expect(items.map((i) => i.summary).join(" ")).toContain("222");
  });

  it("残っているプロセスの名前を、整えて要約に添える（T24-sp）", async () => {
    const r = rig({ processes: { a: [{ ...proc(111), command: "vim\u0007" }, proc(112)] } });
    await r.run();
    const item = r.s().inbox.find((i) => i.kind === "stopIncomplete" && i.nodeId === "a");
    expect(item?.summary).toContain("残っているプロセス pid 111（vim）、112");
  });

  it("プロセスを調べられない・作業ツリーが分からないときも、安全側（停止未完了）にする。stopIncomplete のまま残っていれば、そのまま", async () => {
    const r = rig({ processes: { a: null }, noCwd: ["w"] });
    await r.run();
    expect(stateOf(r.s(), "a")).toBe("stopIncomplete");
    expect(stateOf(r.s(), "w")).toBe("stopIncomplete");
    const r2 = rig({ processes: { i: [proc(9)] } });
    await r2.run();
    expect(stateOf(r2.s(), "i")).toBe("stopIncomplete");
  });

  it("対象外: 根・完了・起動前・アダプタが管理している子。根は調べない", async () => {
    const r = rig({ managed: ["g"] });
    await r.run();
    expect(stateOf(r.s(), "root")).toBe("running");
    expect(stateOf(r.s(), "d")).toBe("done");
    expect(stateOf(r.s(), "p")).toBe("pending");
    expect(stateOf(r.s(), "g")).toBe("running");
    expect(r.probed).not.toContain("/wt/root");
    expect(r.probed).not.toContain("/wt/g");
  });

  it("2 回目の実行では、何も変えない（冪等）", async () => {
    const r = rig({ processes: { a: [proc(1)] } });
    await r.run();
    const seq = r.s().lastSeq;
    await r.run();
    expect(r.s().lastSeq).toBe(seq);
  });
});

describe("daemon の外で動く子（Desktop。T21）", () => {
  it("照合せず状態を変えない。根の受信箱に、優先度のある項目（stopIncomplete）をまとめて 1 件。再実行で重複しない", async () => {
    const r = rig({ external: true });
    const before = r.s().nodes.map((x) => [x.id, x.state]);
    const out = await r.run();
    expect(out).toEqual([]);
    expect(r.probed).toEqual([]);
    expect(r.s().nodes.map((x) => [x.id, x.state])).toEqual(before);
    const asks = () =>
      r.s().inbox.filter((i) => i.summary?.startsWith(EXTERNAL_CHECK_SUMMARY) === true);
    expect(asks()).toHaveLength(1);
    const [ask] = asks();
    expect(ask).toMatchObject({ kind: "stopIncomplete", nodeId: "root" });
    // 対象: running（a・g）・waiting（w）・stopping（s）・stopIncomplete（i）の 5 件。done（d）・pending（p）・根は対象外
    expect(ask?.summary).toContain("5 件");
    for (const id of ["a", "w", "s", "i", "g"]) expect(ask?.summary).toContain(id);
    await r.run();
    expect(asks()).toHaveLength(1);
  });

  it("文面: 仮置きを外し、決めつけない・画面で子ごとに確かめる・アーカイブで止めて確かめてから宣言する、を書く。docs を指す。長さの上限に収まる", async () => {
    expect(EXTERNAL_CHECK_SUMMARY).not.toContain("仮置き");
    for (const word of [
      "決めつけない",
      "子ごとに確かめ",
      "アーカイブで止め",
      "止まったと確かめて",
      "宣言",
      "desktop-runtime.md",
    ]) {
      expect(EXTERNAL_CHECK_SUMMARY, word).toContain(word);
    }
    const r = rig({ external: true });
    await r.run();
    const [ask] = r.s().inbox.filter((i) => i.summary?.startsWith(EXTERNAL_CHECK_SUMMARY) === true);
    expect(ask?.summary?.length ?? 0).toBeLessThanOrEqual(INBOX_SUMMARY_MAX);
    expect(ask?.summary).toContain("5 件");
  });

  it("前の版の文面の未解決の依頼があれば、新しい文面でも出さない（判定は変えない）", async () => {
    const r = rig({ external: true });
    const seeded = r.log.append({
      requestId: "legacy-ask",
      actor: SYS,
      body: {
        type: "inbox.added",
        payload: {
          id: "inbox-legacy",
          kind: "stopIncomplete",
          nodeId: "root",
          summary:
            "daemon の再起動のあと、Desktop の子の状態は daemon から確かめられない。Desktop で確かめ、止まっていれば停止して止めたと宣言する（仮置き）（5 件: a、w、s、i、g）",
        },
      },
    });
    expect(seeded.ok).toBe(true);
    const seq = r.s().lastSeq;
    await r.run();
    expect(r.s().lastSeq).toBe(seq);
    expect(
      r.s().inbox.filter((i) => i.summary?.startsWith(EXTERNAL_CHECK_SUMMARY) === true),
    ).toHaveLength(0);
  });

  it("前の版の文面の依頼が解決済みなら、新しい文面で 1 件出す", async () => {
    const r = rig({ external: true });
    const add = (requestId: string, body: EventBody) => {
      const x = r.log.append({ requestId, actor: SYS, body });
      expect(x.ok).toBe(true);
    };
    add("legacy-ask-2", {
      type: "inbox.added",
      payload: {
        id: "inbox-legacy-2",
        kind: "stopIncomplete",
        nodeId: "root",
        summary:
          "daemon の再起動のあと、Desktop の子の状態は daemon から確かめられない。Desktop で確かめ、止まっていれば停止して止めたと宣言する（仮置き）（5 件: a、w、s、i、g）",
      },
    });
    add("legacy-resolve", { type: "inbox.resolved", payload: { itemId: "inbox-legacy-2" } });
    await r.run();
    expect(
      r.s().inbox.filter((i) => i.summary?.startsWith(EXTERNAL_CHECK_SUMMARY) === true),
    ).toHaveLength(1);
  });

  it("本物の長さの ID（node- ＋ 32 桁の 16 進）が 5 件でも、固定文は切られず、ID が少なくとも 3 件、完全な形で載る", async () => {
    const opened = EventLog.open(createMemoryStore().open(), { clock });
    if (!opened.ok) throw new Error(opened.error.code);
    const log = opened.value;
    let k = 0;
    const add = (body: EventBody): void => {
      const x = log.append({ requestId: `long-${++k}`, actor: SYS, body });
      if (!x.ok) throw new Error(`${x.error.code} ${x.error.cause}`);
    };
    const ids = Array.from(
      { length: 5 },
      (_, i) => `node-${"0123456789abcdef"[i + 1]?.repeat(32)}`,
    );
    const nodes: [string, string | null][] = [
      ["root", null],
      ...ids.map((x): [string, string] => [x, "root"]),
    ];
    for (const [id, parentId] of nodes) {
      add({
        type: "node.created",
        payload: {
          nodeId: id,
          role: parentId === null ? "integrator" : "implement",
          parentId,
          dependsOn: [],
        },
      });
      add({ type: "node.stateChanged", payload: { nodeId: id, event: { type: "start" } } });
    }
    await reconcileOnStartup({
      log,
      clock,
      cwdOf: async () => undefined,
      probe: async () => [],
      has: () => false,
      external: () => true,
    });
    const [ask] = log
      .state()
      .inbox.filter((i) => i.summary?.startsWith(EXTERNAL_CHECK_SUMMARY) === true);
    const summary = ask?.summary ?? "";
    expect(summary.length).toBeLessThanOrEqual(INBOX_SUMMARY_MAX);
    expect(summary.startsWith(EXTERNAL_CHECK_SUMMARY)).toBe(true);
    const full = ids.filter((id) => new RegExp(`(?:: |、)${id}(?:、|）|…)`).test(summary));
    expect(full.length, summary).toBeGreaterThanOrEqual(3);
  });
});
