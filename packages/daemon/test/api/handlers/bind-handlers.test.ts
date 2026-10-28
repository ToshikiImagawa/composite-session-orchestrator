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
const DRAWER = "/home/u/state/children.noindex/0123abcd";
const CSO = ["node", "/opt/cso/packages/cli/dist/bin.js"];
const rig = (
  opts: {
    desktop?: boolean;
    instructions?: Record<string, string>;
    cso?: boolean;
    drawerFails?: boolean;
  } = {},
) => {
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
    ...(opts.cso === false ? {} : { csoCommand: CSO }),
    prepareDrawer: (id) => {
      if (opts.drawerFails === true) throw new Error("EACCES");
      prepared.push(id);
      return DRAWER;
    },
  });
  const call = (caller: string, nodeId: string, requestId = `q-${++n}`) =>
    h["node.bindCode"]({
      requestId,
      operation: "node.bindCode",
      role: caller === "human" ? "human" : "integrator",
      ...(caller === "human" ? {} : { caller: { nodeId: caller } }),
      params: { nodeId },
    } as unknown as HandlerRequest<"node.bindCode">);
  return { log, bind, call, prepared };
};
const prepared: string[] = [];
const codeOf = (instruction: string): string => {
  const m = /中身: ([0-9A-Z-]+)/.exec(instruction);
  if (!m) throw new Error("no code");
  return m[1] as string;
};

describe("node.bindCode（Desktop の子の紐付けの文面。T21・仮置き）", () => {
  it("祖先の統合ノードか人間に、起動の指示＋紐付けと報告の手順を返す。期限つき", () => {
    const r = rig();
    const res = r.call("m1", "a");
    if (!res.ok) throw new Error(res.error.code);
    expect(res.value.instruction.startsWith("あなたのノード ID: a\n目的: x")).toBe(true);
    expect(res.value.instruction).toContain(`ファイル: ${DRAWER}/code`);
    expect(res.value.instruction).toContain(
      `node /opt/cso/packages/cli/dist/bin.js child bind --dir ${DRAWER} --url http://127.0.0.1:7777`,
    );
    expect(res.value.instruction).toContain("報告に秘密");
    expect(res.value.instruction).toContain("bind と同じ URL");
    expect(r.prepared).toContain("a");
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

  it("文面の Bash のコマンドに、コードを置かない（コードは Write で code のファイルに書く。M2）。毎回、絶対パスと URL を書く（V5）", () => {
    const r = rig();
    const res = r.call("m1", "a");
    if (!res.ok) throw new Error(res.error.code);
    const code = codeOf(res.value.instruction);
    const lines = res.value.instruction.split("\n");
    const commands = lines.filter((l) => l.includes(" child "));
    expect(commands).toHaveLength(2);
    for (const c of commands) {
      expect(c).not.toContain(code);
      expect(c).toContain(`--dir ${DRAWER} `);
      expect(c).toContain("--url http://127.0.0.1:7777");
      expect(c).not.toContain("--dir=");
      expect(c).not.toMatch(/token/i);
    }
    // コードが出るのは、Write で書く中身の行だけ
    expect(lines.filter((l) => l.includes(code))).toEqual([`   中身: ${code}`]);
  });

  it("csoCommand がなければ csoCommandMissing。引き出しを用意できなければ childDirFailed（コードを出さない）", () => {
    const code = (x: { ok: boolean; error?: { code: string } }) => (x.ok ? "ok" : x.error?.code);
    expect(code(rig({ cso: false }).call("m1", "a"))).toBe("csoCommandMissing");
    const f = rig({ drawerFails: true });
    expect(code(f.call("m1", "a"))).toBe("childDirFailed");
  });

  it("パスに空白などがあれば、単一引用符で 1 語にする", async () => {
    const { shellWord } = await import("../../../src/api/handlers/bind-handlers.js");
    expect(shellWord("/a/b-c_d.e")).toBe("/a/b-c_d.e");
    expect(shellWord("/Users/x/Application Support/s")).toBe("'/Users/x/Application Support/s'");
    expect(shellWord("/a/it's")).toBe("'/a/it'\\''s'");
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

  it("文面の done・decision・scope-extend の本文の例は、そのまま daemon の検査を通る形（C1' で done の形が分からず送り直した）", async () => {
    const { validateParams } = await import("../../../src/api/validate.js");
    const r = rig();
    const res = r.call("m1", "a");
    if (!res.ok) throw new Error(res.error.code);
    const lines = res.value.instruction.split("\n").map((l) => l.trim());
    const example = (kind: string) => {
      const line = lines.find((l) => l.startsWith(`${kind}: {`)) as string;
      return JSON.parse(line.slice(kind.length + 2).replace(/（.*$/, ""));
    };
    for (const [kind, op] of [
      ["done", "report.done"],
      ["decision", "report.decision"],
      ["scope-extend", "scope.extend"],
    ] as const) {
      const v = validateParams(op, example(kind));
      expect(v.ok, `${kind}: ${JSON.stringify(v)}`).toBe(true);
    }
  });
});
