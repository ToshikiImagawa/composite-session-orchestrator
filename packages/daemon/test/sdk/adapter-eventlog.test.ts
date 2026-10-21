import { type EventBody, stateOf } from "@cso/core";
import { describe, expect, it } from "vitest";
import { EventLog } from "../../src/eventlog.js";
import { createMemoryStore } from "../../src/memory-store.js";
import { SdkRuntimeAdapter } from "../../src/sdk/sdk-adapter.js";
import { FakeLauncher, FakeTimers, probeSequence, settle } from "./fakes.js";

/** 実際のイベントログ（畳み込み）に、アダプタの記録（1 トランザクション）が通ることを確かめる。 */
const setup = (probes: Parameters<typeof probeSequence> = [[]]) => {
  const opened = EventLog.open(createMemoryStore().open(), {
    clock: () => "2026-10-20T00:00:00Z",
  });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  let n = 0;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  add({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  });
  add({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } });
  add({
    type: "node.created",
    payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
  });
  add({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } });
  const launcher = new FakeLauncher();
  const { probe } = probeSequence(...probes);
  let k = 0;
  const adapter = new SdkRuntimeAdapter({
    launcher,
    probe,
    realpath: async (p) => p,
    resolvePath: async (p) => p,
    sink: { record: (r) => log.append(r), recordAll: (rs) => log.appendAll(rs) },
    timers: new FakeTimers(),
    newRequestId: () => `adp-${++k}`,
    parentEnv: {},
  });
  return { log, adapter, launcher };
};

const start = (s: ReturnType<typeof setup>) =>
  s.adapter.start({
    nodeId: "a",
    worktreePath: "/wt/a",
    scope: { writableLocations: ["src"], forbiddenLocations: [], allowedCommands: [] },
    instruction: "x",
  });

describe("アダプタの記録は、実際のイベントログに通る", () => {
  it("予期しない終了: プロセスが残っていなければ stopped。受信箱に failure", async () => {
    const s = setup([[]]);
    await start(s);
    s.launcher.sessions[0]?.finish(new Error("crashed"));
    await settle();
    expect(stateOf(s.log.state(), "a")).toBe("stopped");
    expect(s.log.state().exits.map((e) => e.nodeId)).toEqual(["a"]);
    expect(s.log.state().inbox.map((i) => i.kind)).toEqual(["failure"]);
  });

  it("予期しない終了: プロセスが残っていれば stopIncomplete。受信箱に failure と stopIncomplete", async () => {
    const s = setup([[{ pid: 9, cwd: "/wt/a", hasOpenFiles: false }]]);
    await start(s);
    s.launcher.sessions[0]?.finish(new Error("crashed"));
    await settle();
    expect(stateOf(s.log.state(), "a")).toBe("stopIncomplete");
    expect(s.log.state().inbox.map((i) => i.kind)).toEqual(["failure", "stopIncomplete"]);
  });

  it("範囲違反: 記録と、受信箱の violation の項目が、親から見える（inbox の nodeId は子）", async () => {
    const s = setup();
    await start(s);
    const hook = s.launcher.sessions[0]?.options.hooks.preToolUse;
    await hook?.({ toolName: "Write", toolInput: { file_path: "/wt/a/x.txt" }, cwd: "/wt/a" });
    expect(s.log.state().violations).toHaveLength(1);
    const items = s.log.state().inbox.filter((i) => i.kind === "violation");
    expect(items).toHaveLength(1);
    expect(items[0]?.nodeId).toBe("a");
    expect(items[0]?.summary).toContain("outsideWritable");
  });
});
