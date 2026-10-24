import { ID_MAX_LENGTH, type Scope } from "@cso/core";
import { describe, expect, it } from "vitest";
import { summarize } from "../../src/api/handlers/context.js";
import { EventLog } from "../../src/eventlog.js";
import { createMemoryStore } from "../../src/memory-store.js";
import {
  DELEGATION_STEPS,
  DESKTOP_CAPABILITIES,
  type DesktopAdapterDeps,
  DesktopRuntimeAdapter,
} from "../../src/sdk/desktop-adapter.js";
import { FakeSink } from "./fakes.js";

const SCOPE: Scope = { writableLocations: ["src"], forbiddenLocations: [], allowedCommands: [] };
const START = { nodeId: "a", worktreePath: "/wt/a", scope: SCOPE, instruction: "作業する" };

const rig = (over: Partial<DesktopAdapterDeps> = {}) => {
  const sink = new FakeSink();
  const warnings: [string, string][] = [];
  const adapter = new DesktopRuntimeAdapter({
    sink,
    onWarning: (nodeId, text) => warnings.push([nodeId, text]),
    ...over,
  });
  return { adapter, sink, warnings };
};

describe("DesktopRuntimeAdapter の能力表（Spike 01 の確認前の控えめな値）", () => {
  it("直接の指示・停止はできず、停止は代行。フックは未確認、識別子は取れない", () => {
    const { adapter } = rig();
    expect(adapter.kind).toBe("desktop");
    expect(adapter.capabilities("a")).toEqual({
      send: "unsupported",
      stopGraceful: false,
      stopImmediate: false,
      stopDelegated: true,
      hooks: "unverified",
      sessionId: false,
    });
    expect(DESKTOP_CAPABILITIES.hooks).toBe("unverified");
  });
});

describe("フックのゲート（既定で有効）", () => {
  it("フックが確認済みでない間は、起動を拒否する（理由と代替手段つき）", async () => {
    const { adapter, warnings } = rig();
    const r = await adapter.start(START);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("hooksUnverified");
    expect(r.error.cause).toContain("未確認");
    expect(r.error.cause).toContain("hooks: unverified");
    expect(r.error.nextActions.length).toBeGreaterThan(0);
    expect(adapter.has("a")).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("フックが未対応（unsupported）なら、拒否の文面に未対応と出す", async () => {
    const { adapter } = rig({ capabilities: { ...DESKTOP_CAPABILITIES, hooks: "unsupported" } });
    const r = await adapter.start(START);
    if (r.ok) throw new Error("started");
    expect(r.error.cause).toContain("未対応");
    expect(r.error.cause).toContain("hooks: unsupported");
  });

  it("設定でゲートを外すと起動を受け付け、起動のたびに警告を記録する", async () => {
    const { adapter, warnings } = rig({ requireVerifiedHooks: false });
    const r = await adapter.start(START);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cwd).toBe("/wt/a");
    expect(r.value.removedEnv).toEqual([]);
    expect(adapter.has("a")).toBe(true);
    await adapter.start({ ...START, nodeId: "b", worktreePath: "/wt/b" });
    expect(warnings.map(([id]) => id)).toEqual(["a", "b"]);
    expect(warnings[0]?.[1]).toContain("FR_014");
  });

  it("フックが確認済み（ok）になれば、ゲートが有効でも起動できる", async () => {
    const { adapter, warnings } = rig({
      capabilities: { ...DESKTOP_CAPABILITIES, hooks: "ok" },
    });
    expect((await adapter.start(START)).ok).toBe(true);
    expect(warnings).toEqual([]);
  });
});

describe("指示（send）", () => {
  it("直接は送れない。理由と代替手段（親に代行を頼む）つきで失敗する", async () => {
    const { adapter } = rig({ requireVerifiedHooks: false });
    await adapter.start(START);
    const r = await adapter.send("a", "続けて");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("unsupported");
    expect(r.error.nextActions.join()).toContain("親");
  });
});

describe("停止（受信箱を通じた代行）", () => {
  it("停止未完了（stopTimeout）を記録し、代行の文面（親・手順・ノード）を返す", async () => {
    const { adapter, sink } = rig({ requireVerifiedHooks: false });
    await adapter.start(START);
    const r = await adapter.stop("a", { mode: "immediate", stopSeq: 7 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    if (r.value.state !== "stopIncomplete") throw new Error(r.value.state);
    expect(r.value.blockers).toEqual([]);
    expect(r.value.delegation).toContain("親");
    expect(r.value.delegation).toContain("a");
    expect(r.value.delegation).toContain("Desktop");
    expect(sink.types).toEqual(["node.stateChanged:stopTimeout"]);
  });

  it("文面は手順が先、ID が後ろ。ID が最長（128 文字）でも、受信箱の要約で手順も ID も切れない", async () => {
    const { adapter } = rig({ requireVerifiedHooks: false });
    const id = "n".repeat(ID_MAX_LENGTH);
    await adapter.start({ ...START, nodeId: id });
    const r = await adapter.stop(id, { mode: "immediate", stopSeq: 1 });
    if (!r.ok) throw new Error(r.error.code);
    if (r.value.state !== "stopIncomplete") throw new Error(r.value.state);
    const shown = summarize(r.value.delegation ?? "");
    expect(shown.startsWith(DELEGATION_STEPS)).toBe(true);
    expect(shown.endsWith(id)).toBe(true);
  });

  it("同じ停止の試行（stopSeq）の再送では、同じ要求 ID で記録する（重複しない）", async () => {
    const { adapter, sink } = rig({ requireVerifiedHooks: false });
    await adapter.start(START);
    await adapter.stop("a", { mode: "graceful", stopSeq: 7 });
    await adapter.stop("a", { mode: "immediate", stopSeq: 7 });
    const ids = sink.records.map((x) => x.requestId);
    expect(new Set(ids).size).toBe(1);
  });

  it("記録に失敗したら、理由つきの失敗を返す", async () => {
    const { adapter, sink } = rig({ requireVerifiedHooks: false });
    await adapter.start(START);
    sink.failNext = 1;
    const r = await adapter.stop("a", { mode: "immediate", stopSeq: 7 });
    expect(r.ok).toBe(false);
  });

  it("管理していないノード（daemon の再起動のあと）でも、代行依頼を出せる（能力表どおり。T21）", async () => {
    const { adapter, sink } = rig();
    expect(adapter.has("x")).toBe(false);
    const r = await adapter.stop("x", { mode: "immediate", stopSeq: 1 });
    expect(r.ok).toBe(true);
    if (!r.ok || r.value.state !== "stopIncomplete") throw new Error("not delegated");
    expect(r.value.delegation).toContain("x");
    expect(sink.types).toEqual(["node.stateChanged:stopTimeout"]);
  });

  it("ノードがなければ、記録（stopTimeout）が拒否され、理由つきで失敗する", async () => {
    const opened = EventLog.open(createMemoryStore().open(), {
      clock: () => "2026-10-20T00:00:00Z",
    });
    if (!opened.ok) throw new Error(opened.error.code);
    const log = opened.value;
    const adapter = new DesktopRuntimeAdapter({
      sink: { record: (q) => log.append(q), recordAll: (qs) => log.appendAll(qs) },
    });
    const r = await adapter.stop("nothing", { mode: "immediate", stopSeq: 1 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("recordFailed");
    expect(log.state().lastSeq).toBe(0);
  });

  it("起動の指示を保持し（instructionOf）、release で消える", async () => {
    const { adapter } = rig({ requireVerifiedHooks: false });
    expect(adapter.instructionOf("a")).toBeUndefined();
    await adapter.start(START);
    expect(adapter.instructionOf("a")).toBe("作業する");
    adapter.release("a");
    expect(adapter.instructionOf("a")).toBeUndefined();
  });
});

describe("範囲の更新", () => {
  it("管理しているノードは受け付け、していなければ失敗", async () => {
    const { adapter } = rig({ requireVerifiedHooks: false });
    await adapter.start(START);
    expect(adapter.updateScope("a", SCOPE).ok).toBe(true);
    expect(adapter.updateScope("x", SCOPE).ok).toBe(false);
  });
});

describe("管理から外す（release。停止の宣言の後）", () => {
  it("外したノードは管理していない扱いになる", async () => {
    const { adapter } = rig({ requireVerifiedHooks: false });
    await adapter.start(START);
    adapter.release("a");
    expect(adapter.has("a")).toBe(false);
  });
});
