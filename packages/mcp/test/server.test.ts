import { failure, ok, type Result } from "@cso/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createToolServer, MCP_ROLES, type Relay, toolsFor } from "../src/index.js";

const fakeRelay = (
  request: Relay["request"] = async () => ok({ accepted: true }),
  role = "child",
): Relay & { request: ReturnType<typeof vi.fn> } => {
  const req = vi.fn(request);
  return { whoami: async () => ok({ role }), request: req } as never;
};

async function connect(role: "integrator" | "child", relay: Relay) {
  const server = createToolServer({ role, relay });
  const client = new Client({ name: "t", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
const text = (r: unknown) =>
  JSON.parse(((r as { content: { text: string }[] }).content[0] as { text: string }).text);

describe("tools/list", () => {
  it.each(MCP_ROLES)(
    "%s には、そのロールのツールだけを、入力のスキーマつきで公開する",
    async (role) => {
      const c = await connect(role, fakeRelay());
      const { tools } = await c.listTools();
      expect(tools.map((t) => t.name)).toEqual(toolsFor(role).map((t) => t.name));
      for (const t of tools) {
        expect(t.inputSchema.type).toBe("object");
        expect(t.description?.length).toBeGreaterThan(0);
      }
    },
  );
});

describe("tools/call", () => {
  it("検査を通った入力だけを中継し、成功の値を返す", async () => {
    const relay = fakeRelay();
    const c = await connect("child", relay);
    const r = await c.callTool({ name: "report_progress", arguments: { text: "進捗" } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toEqual({ accepted: true });
    expect(relay.request).toHaveBeenCalledWith("report.progress", { text: "進捗" });
  });

  it("入力が不正なら、中継せずに invalid_argument を返す", async () => {
    const relay = fakeRelay();
    const c = await connect("child", relay);
    const r = await c.callTool({ name: "report_progress", arguments: { text: 1, extra: true } });
    expect(r.isError).toBe(true);
    expect(text(r).code).toBe("invalid_argument");
    expect(text(r).nextActions.length).toBeGreaterThan(0);
    expect(relay.request).not.toHaveBeenCalled();
  });

  it("公開されていないツールは、中継せずに tool_not_exposed を返す", async () => {
    const relay = fakeRelay();
    const c = await connect("child", relay);
    const r = await c.callTool({ name: "node_spawn", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r).code).toBe("tool_not_exposed");
    expect(relay.request).not.toHaveBeenCalled();
  });

  it("daemon の失敗は、code・cause・nextActions のまま isError で返す", async () => {
    const f = failure("forbidden", "権限がない", "親に依頼する");
    const c = await connect(
      "child",
      fakeRelay(async () => ({ ok: false, error: f }) as Result<never>),
    );
    const r = await c.callTool({ name: "report_progress", arguments: { text: "t" } });
    expect(r.isError).toBe(true);
    expect(text(r)).toEqual({
      code: "forbidden",
      cause: "権限がない",
      nextActions: ["親に依頼する"],
    });
  });

  it("relay が例外を投げても、isError で返す（トークン・本文を含めない）", async () => {
    const c = await connect(
      "child",
      fakeRelay(async () => {
        throw new Error("secret-body");
      }),
    );
    const r = await c.callTool({ name: "report_progress", arguments: { text: "t" } });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain("secret-body");
  });

  it("inbox_fetch は、sinceSeq だけを daemon へ送り、応答を表示用の入力で整形する", async () => {
    const items = [
      { seq: 1, id: "i1", kind: "info", nodeId: "a", dependsOn: [], at: "2026-01-01T00:00:00Z" },
      { seq: 2, id: "i2", kind: "info", nodeId: "a", dependsOn: [], at: "2026-01-01T00:00:01Z" },
    ];
    const relay = fakeRelay(async () => ok({ items }));
    const c = await connect("integrator", relay);
    const r = await c.callTool({
      name: "inbox_fetch",
      arguments: { sinceSeq: 0, limit: 1, detail: "full" },
    });
    expect(relay.request).toHaveBeenCalledWith("inbox.fetch", { sinceSeq: 0 });
    const page = text(r);
    expect(page.entries).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.nextOffset).toBe(1);
    expect(page.entries[0].nextActions).toBeDefined();
  });
});
