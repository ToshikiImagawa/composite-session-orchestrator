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
import { recoverAnswerDeliveries } from "../../../src/api/handlers/answer-delivery.js";
import { createInstructionDelivery } from "../../../src/api/handlers/instruction-delivery.js";
import { createPauseHandlers } from "../../../src/api/handlers/pause-handlers.js";
import { createRuntimeHandlers } from "../../../src/api/handlers/runtime-handlers.js";
import { createStateHandlers } from "../../../src/api/handlers/state-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";
import type { RuntimeAdapter } from "../../../src/sdk/runtime.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-10-22T00:00:00Z";
let n = 0;
const SCOPE: Scope = { writableLocations: ["src"], forbiddenLocations: [], allowedCommands: [] };

/** root ─ m1(統合) ─ a(running の子)。a が report.decision で判断を出す */
const rig = (opts: { live?: boolean } = {}) => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  add({
    type: "node.created",
    payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
  });
  ev("root", { type: "start" });
  add({
    type: "node.created",
    payload: { nodeId: "m1", role: "integrator", parentId: "root", dependsOn: [] },
  });
  ev("m1", { type: "start" });
  add({
    type: "node.created",
    payload: {
      nodeId: "a",
      role: "implement",
      parentId: "m1",
      dependsOn: [],
      objective: "o",
      acceptanceCriteria: ["c"],
      scope: SCOPE,
    },
  });
  ev("a", { type: "start" });

  const flags = { sendFails: false, live: opts.live ?? true };
  const sent: { nodeId: string; text: string }[] = [];
  const failures: string[] = [];
  const adapter = {
    kind: "cli" as const,
    capabilities: () => ({
      send: "ok",
      stopGraceful: true,
      stopImmediate: true,
      hooks: "ok",
      sessionId: true,
    }),
    async send(nodeId: string, text: string): Promise<Result<{ status: "queued" }, Failure>> {
      if (flags.sendFails) return { ok: false, error: failure("sendFailed", "x", "y") };
      sent.push({ nodeId, text });
      return ok({ status: "queued" as const });
    },
    async stop() {
      return ok({ state: "stopped" as const, outcome: "aborted" as const, blockers: [] });
    },
    updateScope: () => ok(undefined),
  } as unknown as RuntimeAdapter;
  const adapterFor = (id: string) => (flags.live && id === "a" ? adapter : undefined);
  const delivery = createInstructionDelivery({ log, clock, adapterFor });
  const runtime = createRuntimeHandlers({ log, clock, adapterFor });
  const state = createStateHandlers({ log, clock, allowPause: true });
  const h = createPauseHandlers({
    log,
    clock,
    present: state["decision.present"],
    answer: state["decision.answer"],
    stop: runtime["node.stop"],
    adapterFor,
    deliver: delivery.deliver,
    canDeliver: delivery.available,
    ports: { cwdOf: async (id) => `/wt/${id}`, mcpUrl: "http://127.0.0.1:1/mcp" },
    credentials: { issueNodeToken: (id) => `tok-${id}`, revokeNode: () => undefined },
    onFailure: (_id, cause) => failures.push(cause),
  });
  const decide = async (question = "形式は？", options = ["JSON", "YAML"]) => {
    const r = (await state["report.decision"]({
      requestId: `d-${++n}`,
      operation: "report.decision",
      role: "child",
      caller: { nodeId: "a" },
      params: { question, options },
    } as unknown as HandlerRequest<"report.decision">)) as Loose<{ decisionId: string }>;
    return r.value?.decisionId as string;
  };
  const answer = async (decisionId: string, params: object, requestId = `q-${++n}`) =>
    (await h["decision.answer"]({
      requestId,
      operation: "decision.answer",
      role: "human",
      params: { decisionId, ...params },
    } as unknown as HandlerRequest<"decision.answer">)) as Loose<{ accepted: true }>;
  const inbox = (kind: string) => log.state().inbox.filter((i) => i.kind === kind);
  return { log, add, ev, decide, answer, flags, sent, failures, delivery, adapterFor, inbox };
};
type Loose<V> = { ok: boolean; value?: V; error?: Failure };

describe("判断の回答を、判断を出した子へ届ける（T10b-r）", () => {
  it("回答を子へ追加指示として届け、node.instructed と node.instructionDelivered を記録する", async () => {
    const r = rig();
    const id = await r.decide();
    const res = await r.answer(id, { choice: "YAML" });
    expect(res.ok).toBe(true);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.nodeId).toBe("a");
    expect(r.sent[0]?.text).toContain("人間からの回答");
    expect(r.sent[0]?.text).toContain(id);
    expect(r.sent[0]?.text).toContain("形式は？");
    expect(r.sent[0]?.text).toContain("YAML");
    const ins = r.log.state().instructions.filter((i) => i.nodeId === "a");
    expect(ins).toHaveLength(1);
    expect(ins[0]?.actor).toEqual({ system: true });
    expect(ins[0]?.deliveredSeq).toBeDefined();
    expect(stateOf(r.log.state(), "a")).toBe("running");
  });

  it("自由記述の回答（text）も届ける", async () => {
    const r = rig();
    const id = await r.decide();
    await r.answer(id, { text: "TOML にして" });
    expect(r.sent[0]?.text).toContain("TOML にして");
  });

  it("同じ回答の再送（同じ requestId・別の requestId）で、二重に届けない", async () => {
    const r = rig();
    const id = await r.decide();
    await r.answer(id, { choice: "YAML" }, "same");
    await r.answer(id, { choice: "YAML" }, "same");
    await r.answer(id, { choice: "YAML" }, "other");
    expect(r.sent).toHaveLength(1);
    expect(r.log.state().instructions.filter((i) => i.nodeId === "a")).toHaveLength(1);
  });

  it("後から来た別の回答（alreadyAnswered）は届けない", async () => {
    const r = rig();
    const id = await r.decide();
    await r.answer(id, { choice: "YAML" });
    const late = await r.answer(id, { choice: "JSON" });
    expect(late.ok).toBe(false);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]?.text).toContain("YAML");
  });

  it("本文は信頼できない入力として整える（制御文字を置き換え、上限に収める）", async () => {
    const r = rig();
    const id = await r.decide("質問です", ["A"]);
    const ans = await r.answer(id, { text: `x\u0007${"あ".repeat(2_000)}` });
    expect(ans.ok, JSON.stringify(ans.error)).toBe(true);
    const text = r.sent[0]?.text ?? "";
    expect(text).not.toContain("\u0000");
    expect(text).not.toContain("\u0007");
    expect(Array.from(text).length).toBeLessThanOrEqual(64 * 1024);
    expect(r.log.state().instructions.filter((i) => i.nodeId === "a")).toHaveLength(1);
  });

  it("配送に失敗したら、回答は記録済みのまま失敗を返し、受信箱に failure を出す。同じ回答の再送でやり直す", async () => {
    const r = rig();
    const id = await r.decide();
    r.flags.sendFails = true;
    const first = await r.answer(id, { choice: "YAML" }, "retry-1");
    expect(first.ok).toBe(false);
    expect(first.error?.code).toBe("resumePending");
    expect(r.log.state().decisions[0]?.status).toBe("answered");
    const failed = r.inbox("failure");
    expect(failed).toHaveLength(1);
    expect(failed[0]?.nodeId).toBe("a");
    expect(failed[0]?.summary).toContain("届いていない");
    expect(r.log.state().instructions[0]?.deliveredSeq).toBeUndefined();
    expect(r.sent).toHaveLength(0);

    r.flags.sendFails = false;
    const again = await r.answer(id, { choice: "YAML" }, "retry-1");
    expect(again.ok).toBe(true);
    expect(r.sent).toHaveLength(1);
    expect(r.log.state().instructions).toHaveLength(1);
    expect(r.log.state().instructions[0]?.deliveredSeq).toBeDefined();
    // 失敗の項目は、再送を繰り返しても重複しない
    r.flags.sendFails = true;
    expect(r.inbox("failure")).toHaveLength(1);
  });

  it("終わった子（done など）には届けず、受信箱に info を出す", async () => {
    const r = rig();
    const id = await r.decide();
    r.ev("a", { type: "resume" });
    r.ev("a", { type: "reportDone" });
    const res = await r.answer(id, { choice: "YAML" });
    expect(res.ok).toBe(true);
    expect(r.sent).toHaveLength(0);
    expect(
      r.inbox("info").some((i) => i.nodeId === "a" && i.summary?.includes("届けなかった")),
    ).toBe(true);
  });

  it("届ける手段（アダプタ）のない判断者（daemon の外で動く統合ノードなど）には、何もしない", async () => {
    const r = rig({ live: false });
    const id = await r.decide();
    const res = await r.answer(id, { choice: "YAML" });
    expect(res.ok).toBe(true);
    expect(r.sent).toHaveLength(0);
    expect(r.log.state().instructions).toHaveLength(0);
  });
});

describe("起動時の回復（記録と配送の間で daemon が落ちた回答）", () => {
  /** 回答の記録だけがあり、配送の記録がない状態を作る（配送の直前で落ちたとみなす）。 */
  const crashed = async () => {
    const r = rig();
    const id = await r.decide();
    r.flags.sendFails = true;
    await r.answer(id, { choice: "YAML" }, "crash");
    r.flags.sendFails = false;
    return { r, id };
  };

  it("node.instructed はあるが node.instructionDelivered がない回答を、もう一度配送する", async () => {
    const { r } = await crashed();
    expect(r.sent).toHaveLength(0);
    const out = await recoverAnswerDeliveries({
      log: r.log,
      clock,
      deliver: r.delivery.deliver,
      canDeliver: r.delivery.available,
    });
    expect(out).toEqual([{ nodeId: "a", result: "delivered" }]);
    expect(r.sent).toHaveLength(1);
    expect(r.log.state().instructions[0]?.deliveredSeq).toBeDefined();
    // 2 回目は、何もしない
    const again = await recoverAnswerDeliveries({
      log: r.log,
      clock,
      deliver: r.delivery.deliver,
      canDeliver: r.delivery.available,
    });
    expect(again).toEqual([]);
    expect(r.sent).toHaveLength(1);
  });

  it("子のセッションが失われていて届けられないときは、受信箱に failure を 1 度だけ出す", async () => {
    const { r } = await crashed();
    r.flags.live = false;
    const deps = {
      log: r.log,
      clock,
      deliver: r.delivery.deliver,
      canDeliver: r.delivery.available,
    };
    const out = await recoverAnswerDeliveries(deps);
    expect(out).toEqual([{ nodeId: "a", result: "unavailable" }]);
    await recoverAnswerDeliveries(deps);
    const failed = r.inbox("failure").filter((i) => i.summary?.includes("届いていない"));
    expect(failed).toHaveLength(1);
  });

  it("人間・統合ノードが送った追加指示（node.send など）は、対象にしない", async () => {
    const r = rig();
    r.add({ type: "node.instructed", payload: { nodeId: "a", text: "追加の指示" } });
    const out = await recoverAnswerDeliveries({
      log: r.log,
      clock,
      deliver: r.delivery.deliver,
      canDeliver: r.delivery.available,
    });
    expect(out).toEqual([]);
    expect(r.sent).toHaveLength(0);
  });
});
