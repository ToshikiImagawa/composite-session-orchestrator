import type { EventBody, NodeEvent } from "@cso/core";
import { describe, expect, it } from "vitest";
import { createBindCodes } from "../../../src/api/bind.js";
import { createBindHandlers } from "../../../src/api/handlers/bind-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-10-20T00:00:00Z";
let n = 0;

/** root ─ m1 ─ a（running）・p（pending）。root ─ m2。 */
const rig = (opts: { desktop?: boolean; instructions?: Record<string, string> } = {}) => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody) => {
    const r = log.append({ requestId: `seed-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(r.error.code);
  };
  const node = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
    add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  node("root", "integrator", null);
  ev("root", { type: "start" });
  node("m1", "integrator", "root");
  ev("m1", { type: "start" });
  node("a", "implement", "m1");
  ev("a", { type: "start" });
  node("p", "implement", "m1");
  node("m2", "integrator", "root");
  ev("m2", { type: "start" });
  const bind = createBindCodes({ clock: () => Date.parse("2026-10-20T00:00:00Z") });
  const instructions = opts.instructions ?? { a: "あなたのノード ID: a\n目的: x" };
  const h = createBindHandlers({
    log,
    bind,
    ...(opts.desktop === false ? {} : { desktop: { instructionOf: (id) => instructions[id] } }),
    baseUrl: () => "http://127.0.0.1:7777",
  });
  const call = (caller: string, nodeId: string, requestId = `q-${++n}`) =>
    h["node.bindCode"]({
      requestId,
      operation: "node.bindCode",
      role: caller === "human" ? "human" : "integrator",
      ...(caller === "human" ? {} : { caller: { nodeId: caller } }),
      params: { nodeId },
    } as unknown as HandlerRequest<"node.bindCode">);
  return { log, bind, call };
};
const codeOf = (instruction: string): string => {
  const m = /"bindCode":"([0-9A-Z-]+)"/.exec(instruction);
  if (!m) throw new Error("no code");
  return m[1] as string;
};

describe("node.bindCode（Desktop の子の紐付けの文面。T21・仮置き）", () => {
  it("祖先の統合ノードか人間に、起動の指示＋紐付けと報告の手順を返す。期限つき", () => {
    const r = rig();
    const res = r.call("m1", "a");
    if (!res.ok) throw new Error(res.error.code);
    expect(res.value.instruction.startsWith("あなたのノード ID: a\n目的: x")).toBe(true);
    expect(res.value.instruction).toContain("http://127.0.0.1:7777/v1/bind");
    expect(res.value.instruction).toContain('"nodeId":"a"');
    expect(res.value.instruction).toContain("$CSO_TOKEN");
    expect(res.value.expiresAt).toBe("2026-10-20T00:10:00.000Z");
    expect(r.call("human", "a").ok).toBe(true);
  });

  it("部分木の外・自分自身は forbidden。Desktop でない木は notDesktop。起動前は notActive。指示がなければ notManaged", () => {
    const r = rig({ instructions: {} });
    const code = (x: ReturnType<typeof r.call>) => (x.ok ? "ok" : x.error.code);
    expect(code(r.call("m2", "a"))).toBe("forbidden");
    expect(code(r.call("a", "a"))).toBe("forbidden");
    expect(code(r.call("m1", "p"))).toBe("notActive");
    expect(code(r.call("m1", "a"))).toBe("notManaged");
    expect(code(r.call("human", "zz"))).toBe("notFound");
    const cli = rig({ desktop: false });
    expect(code(cli.call("m1", "a"))).toBe("notDesktop");
  });

  it("中間の統合ノードは、紐付けできない（理由と代わりの手段つき。仮置き）", () => {
    const r = rig({ instructions: { m1: "x" } });
    const res = r.call("root", "m1");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("integratorNotSupported");
    expect(res.error.nextActions.length).toBeGreaterThan(0);
  });

  it("文面のコマンドは、トークン・コードを引数に置かない（標準入力から渡す）", () => {
    const r = rig();
    const res = r.call("m1", "a");
    if (!res.ok) throw new Error(res.error.code);
    const lines = res.value.instruction.split("\n");
    const bind = lines.find((l) => l.startsWith("CSO_TOKEN=")) as string;
    const report = lines.find((l) => l.startsWith("printf 'authorization")) as string;
    expect(bind).toMatch(/^CSO_TOKEN=\$\(printf '%s' '\{.*\}' \| curl .* -d @- \|/);
    expect(report).toContain("-H @-");
    // curl の引数に、トークン（$CSO_TOKEN）・コードを置かない
    const curlArgs = (line: string) => line.slice(line.indexOf("curl "));
    expect(curlArgs(report)).not.toContain("CSO_TOKEN");
    expect(curlArgs(bind)).not.toContain("bindCode");
  });

  it("呼ぶたびに新しいコード（古いものは使えない）。同じ requestId の再送も、新しいコードを出す", () => {
    const r = rig();
    const first = r.call("m1", "a", "same");
    const second = r.call("m1", "a", "same");
    if (!first.ok || !second.ok) throw new Error("failed");
    const c1 = codeOf(first.value.instruction);
    const c2 = codeOf(second.value.instruction);
    expect(c1).not.toBe(c2);
    expect(r.bind.redeem("a", c1).ok).toBe(false);
    expect(r.bind.redeem("a", c2).ok).toBe(true);
  });

  it("コードを記録しない（イベントログに何も追記しない）", () => {
    const r = rig();
    const before = r.log.state().lastSeq;
    const res = r.call("m1", "a");
    expect(res.ok).toBe(true);
    expect(r.log.state().lastSeq).toBe(before);
  });
});
