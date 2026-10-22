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

describe("tools/list の入力スキーマ（Anthropic API が受け付ける形）", () => {
  it.each(MCP_ROLES)(
    "%s の全ツールが、トップレベルに type: object と properties を持ち、oneOf・anyOf・allOf を持たない",
    async (role) => {
      const c = await connect(role, fakeRelay());
      for (const t of (await c.listTools()).tools) {
        const s = t.inputSchema as Record<string, unknown>;
        expect(s.type, t.name).toBe("object");
        expect(s.properties, t.name).toBeDefined();
        for (const k of ["oneOf", "anyOf", "allOf", "enum", "not"])
          expect(s[k], `${t.name}.${k}`).toBeUndefined();
      }
    },
  );

  it("node_stop は mode の enum と graceMs、node_review は verdict の enum と feedback を持つ", async () => {
    const c = await connect("integrator", fakeRelay());
    const tools = (await c.listTools()).tools;
    const props = (n: string) =>
      (
        (tools.find((t) => t.name === n) as { inputSchema: unknown }).inputSchema as {
          properties: Record<string, { enum?: string[]; type?: string; description?: string }>;
        }
      ).properties;
    expect(props("node_stop").mode?.enum).toEqual(["graceful", "immediate"]);
    expect(props("node_stop").graceMs?.type).toBe("integer");
    expect(props("node_stop").graceMs?.description).toContain("graceful");
    expect(props("node_review").verdict?.enum).toEqual(["accept", "reject"]);
    expect(props("node_review").feedback?.description).toContain("reject");
  });

  it("ブリーフの項目（node_spawn・node_split）は、型を持つ", async () => {
    const c = await connect("integrator", fakeRelay());
    const tools = (await c.listTools()).tools;
    for (const n of ["node_spawn", "node_split"]) {
      const p = (
        (tools.find((t) => t.name === n) as { inputSchema: unknown }).inputSchema as {
          properties: Record<
            string,
            {
              type?: string;
              items?: { type?: string };
              properties?: Record<string, { type?: string }>;
            }
          >;
        }
      ).properties;
      expect(p.objective?.type, n).toBe("string");
      expect(p.acceptanceCriteria?.type, n).toBe("array");
      expect(p.acceptanceCriteria?.items?.type, n).toBe("string");
      expect(p.dependsOn?.type, n).toBe("array");
      expect(p.scope?.type, n).toBe("object");
      for (const k of ["writableLocations", "forbiddenLocations", "allowedCommands"]) {
        expect(p.scope?.properties?.[k]?.type, `${n}.${k}`).toBe("array");
      }
    }
  });
});

describe("rate_limited（daemon の 429）", () => {
  it("tools/call は、isError で code: rate_limited と nextActions を返す", async () => {
    const f = failure("rate_limited", "要求が多すぎる（実行されていない）", "待ってから呼び直す");
    const c = await connect(
      "child",
      fakeRelay(async () => ({ ok: false, error: f }) as Result<never>),
    );
    const r = await c.callTool({ name: "report_progress", arguments: { text: "t" } });
    expect(r.isError).toBe(true);
    expect(text(r).code).toBe("rate_limited");
    expect(text(r).nextActions.length).toBeGreaterThan(0);
  });
});
