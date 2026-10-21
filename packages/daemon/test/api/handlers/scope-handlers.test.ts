import {
  type EventBody,
  type Failure,
  failure,
  type NodeEvent,
  ok,
  type Result,
  type Scope,
  stateOf,
} from "@cso/core";
import { describe, expect, it } from "vitest";
import { createScopeHandlers } from "../../../src/api/handlers/scope-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";
import type { RuntimeAdapter } from "../../../src/sdk/runtime.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-10-20T00:00:00Z";
let n = 0;
const PARENT: Scope = {
  writableLocations: ["src", "docs"],
  forbiddenLocations: [".git"],
  allowedCommands: ["pnpm test", "git status"],
};
const CHILD: Scope = {
  writableLocations: ["src/ui"],
  forbiddenLocations: [".git"],
  allowedCommands: ["pnpm test"],
};

/** root ─ m1(範囲 PARENT) ─ a(範囲 CHILD・running)。root ─ m2 ─ b。 */
const rig = () => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  const node = (
    nodeId: string,
    role: "integrator" | "implement",
    parentId: string | null,
    scope?: Scope,
  ) =>
    add({
      type: "node.created",
      payload: {
        nodeId,
        role,
        parentId,
        dependsOn: [],
        ...(scope === undefined ? {} : { objective: "o", acceptanceCriteria: ["c"], scope }),
      },
    });
  node("root", "integrator", null);
  ev("root", { type: "start" });
  node("m1", "integrator", "root", PARENT);
  ev("m1", { type: "start" });
  node("a", "implement", "m1", CHILD);
  ev("a", { type: "start" });
  node("m2", "integrator", "root", PARENT);
  ev("m2", { type: "start" });
  node("b", "implement", "m2", CHILD);
  ev("b", { type: "start" });

  const calls = { updated: [] as [string, Scope][], failures: [] as string[] };
  const flags = { updateFails: false };
  const adapter = {
    kind: "cli" as const,
    updateScope: (id: string, scope: Scope): Result<undefined, Failure> => {
      calls.updated.push([id, scope]);
      return flags.updateFails
        ? { ok: false, error: failure("updateFailed", "x", "y") }
        : ok(undefined);
    },
  } as unknown as RuntimeAdapter;
  const h = createScopeHandlers({
    log,
    clock,
    adapterFor: () => adapter,
    cwdOf: async (id) => `/wt/${id}`,
    onFailure: (_id, cause) => calls.failures.push(cause),
  });
  // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
  type Loose = { ok: boolean; value?: any; error?: Failure };
  const extend = async (params: Record<string, unknown>, caller = "a", requestId = `q-${++n}`) =>
    (await h["scope.extend"]({
      requestId,
      operation: "scope.extend",
      role: "child",
      caller: { nodeId: caller },
      params,
    } as unknown as HandlerRequest<"scope.extend">)) as Loose;
  const decide = async (params: Record<string, unknown>, caller = "m1", requestId = `q-${++n}`) =>
    (await h["scope.decide"]({
      requestId,
      operation: "scope.decide",
      role: "integrator",
      caller: { nodeId: caller },
      params,
    } as unknown as HandlerRequest<"scope.decide">)) as Loose;
  return { log, extend, decide, calls, flags, ev, s: () => log.state() };
};
const GIT = { target: { kind: "command", value: "git status" }, reason: "状態を見たい" };

describe("scope.extend（範囲の拡張要求）", () => {
  it("要求を記録し、親の受信箱に項目（violation）を出す。再送は重複させない", async () => {
    const r = rig();
    const res = await r.extend(GIT, "a", "e-1");
    expect(res.ok).toBe(true);
    const id = res.value.extensionId as string;
    expect(r.s().extensions[0]).toMatchObject({
      extensionId: id,
      nodeId: "a",
      status: "open",
      target: GIT.target,
    });
    expect(r.s().inbox.at(-1)).toMatchObject({ kind: "violation", nodeId: "a" });
    expect(r.s().inbox.at(-1)?.summary).toContain(id);
    const seq = r.s().lastSeq;
    expect(await r.extend(GIT, "a", "e-1")).toEqual(res);
    expect(r.s().lastSeq).toBe(seq);
  });

  it("書き込み先の絶対パス・.. ・/ は、何も記録せずに拒否する", async () => {
    const r = rig();
    const seq = r.s().lastSeq;
    for (const value of ["/etc", "../x", "src/../../x", "/"]) {
      const res = await r.extend({ target: { kind: "write", value }, reason: "r" });
      expect(res.ok, value).toBe(false);
      expect(res.error?.code).toBe("invalidTarget");
    }
    expect(r.s().lastSeq).toBe(seq);
  });

  it("未判定が上限（10 件）を超えたら、tooManyOpenExtensions", async () => {
    const r = rig();
    for (let i = 0; i < 10; i++) {
      expect(
        (await r.extend({ target: { kind: "command", value: `cmd${i}` }, reason: "r" })).ok,
      ).toBe(true);
    }
    const res = await r.extend({ target: { kind: "command", value: "cmd10" }, reason: "r" });
    expect(res.error?.code).toBe("tooManyOpenExtensions");
  });

  it("動作中でないノードは要求できない", async () => {
    const r = rig();
    r.ev("a", { type: "reportDone" });
    expect((await r.extend(GIT)).ok).toBe(false);
  });
});

describe("scope.decide（拡張の判定。承認でアダプタの範囲を更新する）", () => {
  const ask = async (r: ReturnType<typeof rig>, target = GIT.target) =>
    (await r.extend({ target, reason: "r" })).value.extensionId as string;

  it("承認: 許可した対象を記録し、有効な範囲でアダプタを更新する", async () => {
    const r = rig();
    const id = await ask(r);
    const res = await r.decide({ extensionId: id, decision: "approve" });
    expect(res).toEqual({ ok: true, value: { state: "running" } });
    expect(r.s().extensions[0]).toMatchObject({ status: "approved", granted: GIT.target });
    expect(r.calls.updated).toHaveLength(1);
    expect(r.calls.updated[0]?.[0]).toBe("a");
    expect(r.calls.updated[0]?.[1].allowedCommands).toEqual(["pnpm test", "git status"]);
  });

  it("却下・切り出し: 記録だけ。アダプタは更新しない", async () => {
    const r = rig();
    const id = await ask(r);
    expect((await r.decide({ extensionId: id, decision: "reject" })).ok).toBe(true);
    expect(r.s().extensions[0]?.status).toBe("rejected");
    const id2 = await ask(r, { kind: "command", value: "ls" });
    expect((await r.decide({ extensionId: id2, decision: "split" })).ok).toBe(true);
    expect(r.calls.updated).toEqual([]);
  });

  it("親の範囲を超える拡張は、承認しない（何も記録しない）", async () => {
    const r = rig();
    const id = await ask(r, { kind: "command", value: "rm" });
    const seq = r.s().lastSeq;
    const res = await r.decide({ extensionId: id, decision: "approve" });
    expect(res.error?.code).toBe("scopeNotSubset");
    expect(r.s().lastSeq).toBe(seq);
    expect(r.calls.updated).toEqual([]);
  });

  it("更新に失敗したら、判定は記録済みのまま、受信箱に failure を出して失敗を返す。同じ要求の再送で更新をやり直す", async () => {
    const r = rig();
    const id = await ask(r);
    r.flags.updateFails = true;
    const res = await r.decide({ extensionId: id, decision: "approve" }, "m1", "d-1");
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("scopeUpdateFailed");
    expect(r.s().extensions[0]?.status).toBe("approved");
    expect(r.s().inbox.at(-1)).toMatchObject({ kind: "failure", nodeId: "a" });
    r.flags.updateFails = false;
    const retry = await r.decide({ extensionId: id, decision: "approve" }, "m1", "d-1");
    expect(retry.ok).toBe(true);
    expect(r.calls.updated).toHaveLength(2);
  });

  it("対象のノードの親（の祖先）でなければ forbidden。判定済みの再判定は拒否される", async () => {
    const r = rig();
    const id = await ask(r);
    expect((await r.decide({ extensionId: id, decision: "approve" }, "m2")).error?.code).toBe(
      "forbidden",
    );
    expect((await r.decide({ extensionId: id, decision: "approve" }, "a")).error?.code).toBe(
      "forbidden",
    );
    await r.decide({ extensionId: id, decision: "reject" });
    const again = await r.decide({ extensionId: id, decision: "approve" });
    expect(again.error?.code).toBe("extensionAlreadyDecided");
  });
});
