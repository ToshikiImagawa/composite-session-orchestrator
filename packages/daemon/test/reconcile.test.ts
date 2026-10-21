import { type EventBody, type NodeEvent, type ProcessInfo, stateOf } from "@cso/core";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/eventlog.js";
import { createMemoryStore } from "../src/memory-store.js";
import { reconcileOnStartup } from "../src/reconcile.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-10-20T00:00:00Z";
let n = 0;

/** root ─ a(running)・w(waiting)・s(stopping)・i(stopIncomplete)・d(done)・p(pending)・g(別名で管理中の running) */
const rig = (
  opts: {
    processes?: Record<string, readonly ProcessInfo[] | null>;
    managed?: string[];
    noCwd?: string[];
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
