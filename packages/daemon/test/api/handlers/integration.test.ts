import { type EventBody, stateOf } from "@cso/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../../src/api/credentials.js";
import { createHandlers } from "../../../src/api/handlers/index.js";
import { type ApiServer, createApiServer } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";
import type { RuntimeAdapter } from "../../../src/sdk/runtime.js";

// 応答の本文（値の形は操作ごとに違うため、テストでは緩く扱う）。
interface Json {
  ok: boolean;
  // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
  value?: any;
  // biome-ignore lint/suspicious/noExplicitAny: テスト用に緩く扱う
  error?: any;
}
const HUMAN = "human-token-human-token-human-token-1234";
let server: ApiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const boot = async (adapter?: RuntimeAdapter) => {
  const clock = (): string => "2026-10-20T00:00:00Z";
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  let n = 0;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: { system: true }, body });
    if (!r.ok) throw new Error(r.error.code);
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
  const credentials = createCredentialStore({ humanToken: HUMAN });
  server = createApiServer({
    credentials,
    getState: () => log.state(),
    handlers: createHandlers({ log, clock }, adapter ? { adapterFor: () => adapter } : undefined),
  });
  const { url } = await server.listen(0);
  const tokens = {
    human: HUMAN,
    root: credentials.issueNodeToken("root", "integrator"),
    a: credentials.issueNodeToken("a", "child"),
  };
  let q = 0;
  const call = async (token: string, operation: string, params: unknown) => {
    const res = await fetch(`${url}/v1/request`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ requestId: `http-${++q}`, operation, params }),
    });
    return {
      status: res.status,
      json: (await res.json()) as Json,
    };
  };
  return { log, tokens, call };
};

describe("窓口の通し（HTTP → 認証 → 認可 → ハンドラ → イベントログ）", () => {
  it("子が判断を求め、人間が答え、子が再開し、完了を報告し、統合ノードが受理する", async () => {
    const t = await boot();
    const ask = await t.call(t.tokens.a, "report.decision", {
      question: "どちら？",
      options: ["A", "B"],
    });
    expect(ask.status).toBe(200);
    const decisionId = ask.json.value.decisionId as string;
    expect(stateOf(t.log.state(), "a")).toBe("waiting");

    const inbox = await t.call(t.tokens.root, "inbox.fetch", {});
    expect(inbox.json.value.items.map((i: { kind: string }) => i.kind)).toEqual(["decision"]);
    const got = await t.call(t.tokens.root, "decision.get", { decisionId });
    expect(got.json.value).toMatchObject({ status: "open", question: "どちら？" });

    expect(
      (await t.call(t.tokens.human, "decision.answer", { decisionId, choice: "A" })).status,
    ).toBe(200);
    expect(stateOf(t.log.state(), "a")).toBe("running");

    expect(
      (await t.call(t.tokens.a, "report.done", { evidence: [{ criterion: "c", evidence: "e" }] }))
        .status,
    ).toBe(200);
    const review = await t.call(t.tokens.root, "node.review", { nodeId: "a", verdict: "accept" });
    expect(review.json).toEqual({ ok: true, value: { state: "verified" } });
    const tree = await t.call(t.tokens.root, "tree.list", {});
    expect(tree.json.value.table).toContain("verified");
  });

  it("子は、統合ノードの操作（review）も、人間の操作（answer）もできない", async () => {
    const t = await boot();
    expect(
      (await t.call(t.tokens.a, "node.review", { nodeId: "a", verdict: "accept" })).status,
    ).toBe(403);
    expect(
      (await t.call(t.tokens.a, "decision.answer", { decisionId: "x", choice: "A" })).status,
    ).toBe(403);
  });
});

describe("窓口の通し（アダプタを伴う操作）", () => {
  it("統合ノードが、子へ指示を送り、停止を要求する。停止要求は記録され、アダプタには stopSeq が渡る", async () => {
    const sent: string[] = [];
    const stops: { mode: string; stopSeq: number }[] = [];
    const adapter = {
      kind: "cli",
      capabilities: () => ({
        send: "delayed",
        stopGraceful: true,
        stopImmediate: true,
        hooks: "ok",
        sessionId: true,
      }),
      send: async (_: string, text: string) => {
        sent.push(text);
        return { ok: true, value: { status: "queued" } };
      },
      stop: async (_: string, r: { mode: string; stopSeq: number }) => {
        stops.push(r);
        return { ok: true, value: { state: "stopped", outcome: "aborted", blockers: [] } };
      },
    } as unknown as RuntimeAdapter;
    const t = await boot(adapter);
    expect(
      (await t.call(t.tokens.root, "node.send", { nodeId: "a", text: "続けて" })).json,
    ).toEqual({
      ok: true,
      value: { status: "queued" },
    });
    const stop = await t.call(t.tokens.root, "node.stop", { nodeId: "a", mode: "graceful" });
    expect(stop.json).toEqual({ ok: true, value: { state: "stopping" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toEqual(["続けて"]);
    expect(stops).toEqual([{ mode: "graceful", stopSeq: t.log.state().stopRequests[0]?.seq }]);
    const caps = await t.call(t.tokens.root, "node.capabilities", { nodeId: "a" });
    expect(caps.json.value.operations).toContain("node.stop");
    // 自分自身の停止は、統合ノードにはできない（認可）
    expect(
      (await t.call(t.tokens.root, "node.stop", { nodeId: "root", mode: "graceful" })).status,
    ).toBe(403);
  });

  it("アダプタを渡さなければ、アダプタを伴う操作は未実装（501）", async () => {
    const t = await boot();
    expect((await t.call(t.tokens.root, "node.send", { nodeId: "a", text: "x" })).status).toBe(501);
  });
});
