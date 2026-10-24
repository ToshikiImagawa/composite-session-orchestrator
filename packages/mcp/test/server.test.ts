import { failure, ok, type Result } from "@cso/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import {
  createInboxProblemReporter,
  createToolServer,
  type InboxExcludedLimitLog,
  type InboxExcludedLog,
  MCP_ROLES,
  type Relay,
  toolsFor,
  WHOAMI_TOOL,
} from "../src/index.js";

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
      // 操作のツールに、固定のメタツール whoami（T10m-wh）が最後に加わる
      expect(tools.map((t) => t.name)).toEqual([...toolsFor(role).map((t) => t.name), WHOAMI_TOOL]);
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

describe("whoami ツール（T10m-wh）", () => {
  const withWho = (who: () => ReturnType<Relay["whoami"]>) => {
    const relay = { whoami: vi.fn(who), request: vi.fn(async () => ok({ accepted: true })) };
    return relay as unknown as Relay & {
      whoami: ReturnType<typeof vi.fn>;
      request: ReturnType<typeof vi.fn>;
    };
  };

  it("ツール一覧に、統合は 18 個・子は 6 個（whoami を含む）。名前は whoami、入力はなし", async () => {
    const counts: Record<string, number> = {};
    for (const role of MCP_ROLES) {
      const { tools } = await (await connect(role, fakeRelay())).listTools();
      counts[role] = tools.length;
      const who = tools.find((t) => t.name === "whoami");
      expect(who?.inputSchema).toMatchObject({ type: "object", properties: {} });
      expect(who?.description).toContain("nodeId");
      // どのロールにも当てはまる文。tree_list への言及は、統合のときだけ
      expect(who?.description).toContain("起動の指示の先頭に書かれた ID の確認に使える");
      expect(who?.description?.includes("tree_list")).toBe(role === "integrator");
    }
    expect(counts).toEqual({ integrator: 18, child: 6 });
  });

  it.each(MCP_ROLES)(
    "%s: { nodeId, role } だけを返す。daemon に尋ねる（要求の中継はしない）",
    async (role) => {
      const relay = withWho(async () => ok({ role, nodeId: "node-1" }));
      const c = await connect(role, relay);
      const r = await c.callTool({ name: "whoami", arguments: {} });
      expect(r.isError).toBeFalsy();
      expect(text(r)).toEqual({ nodeId: "node-1", role });
      expect(relay.request).not.toHaveBeenCalled();
    },
  );

  it("呼ぶたびに、daemon に尋ねる（接続の間のキャッシュはしない）。引数なし（undefined）も通る", async () => {
    let n = 0;
    const relay = withWho(async () => ok({ role: "child", nodeId: `n${++n}` }));
    const c = await connect("child", relay);
    expect(text(await c.callTool({ name: "whoami" })).nodeId).toBe("n1");
    expect(text(await c.callTool({ name: "whoami", arguments: {} })).nodeId).toBe("n2");
    expect(relay.whoami).toHaveBeenCalledTimes(2);
  });

  it("引数があれば、daemon に尋ねずに invalid_argument（余計なキーは拒む）", async () => {
    const relay = withWho(async () => ok({ role: "child", nodeId: "n1" }));
    const c = await connect("child", relay);
    const r = await c.callTool({ name: "whoami", arguments: { nodeId: "other" } });
    expect(r.isError).toBe(true);
    expect(text(r).code).toBe("invalid_argument");
    expect(relay.whoami).not.toHaveBeenCalled();
  });

  it("daemon が nodeId を返さない（古い daemon）なら、whoami_failed。daemon を更新する案内つき", async () => {
    const relay = withWho(async () => ok({ role: "child" }));
    const r = await (await connect("child", relay)).callTool({ name: "whoami", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r).code).toBe("whoami_failed");
    expect(JSON.stringify(text(r).nextActions)).toContain("daemon を更新");
  });

  it("身元の検証の失敗（daemon_identity_failed）や、daemon の失敗は、そのまま返す。例外は internal_error", async () => {
    const f = failure("daemon_identity_failed", "身元を確認できない", "daemon を起動し直す");
    const a = withWho(async () => ({ ok: false, error: f }));
    const ra = await (await connect("child", a)).callTool({ name: "whoami", arguments: {} });
    expect(text(ra).code).toBe("daemon_identity_failed");
    const b = withWho(async () => {
      throw new Error("boom");
    });
    const rb = await (await connect("child", b)).callTool({ name: "whoami", arguments: {} });
    expect(text(rb).code).toBe("internal_error");
  });

  it("接続のロールと、daemon が返したロールが違えば、失敗にする（ロールの食い違い）", async () => {
    const relay = withWho(async () => ok({ role: "integrator", nodeId: "m1" }));
    const r = await (await connect("child", relay)).callTool({ name: "whoami", arguments: {} });
    expect(r.isError).toBe(true);
    expect(text(r).code).toBe("whoami_role_mismatch");
    expect(text(r).nextActions.length).toBeGreaterThan(0);
  });
});

describe("受信箱の不備のログ（T24-m2）", () => {
  const good = (id: string, seq: number) => ({
    seq,
    id,
    kind: "info",
    nodeId: "a",
    dependsOn: [],
    at: "2026-01-01T00:00:00Z",
  });
  const XSS = '<img src=x onerror="x">';

  it("除外があれば、固定の記号と項目 ID だけを 1 回ログに出す。応答は変わらない（不備の理由を含まない）", async () => {
    const logs: (InboxExcludedLog | InboxExcludedLimitLog)[] = [];
    const items = [
      good("i1", 1),
      { ...good("b1", 2), kind: "zzz", summary: `秘密 ${XSS}` },
      { ...good("b2", 3), ref: XSS },
    ];
    const relay = fakeRelay(async () => ok({ items }));
    const server = createToolServer({
      role: "integrator",
      relay,
      onInboxProblems: createInboxProblemReporter({
        log: (e) => void logs.push(e),
        clock: () => "T",
      }),
    });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const page = text(await client.callTool({ name: "inbox_fetch", arguments: {} }));
    expect(page.excluded).toBe(2);
    expect(page.total).toBe(1);
    expect(JSON.stringify(page)).not.toContain("badKind");
    expect(logs).toEqual([
      {
        event: "inboxExcluded",
        count: 2,
        problems: [
          { itemId: "b1", reason: "badKind" },
          { itemId: "b2", reason: "badRef" },
        ],
        at: "T",
      },
    ]);
    expect(JSON.stringify(logs)).not.toContain("秘密");
    expect(JSON.stringify(logs)).not.toContain("<img");
    // 同じ不備の 2 回目は出さない
    await client.callTool({ name: "inbox_fetch", arguments: {} });
    expect(logs).toHaveLength(1);
  });

  it("除外がなければ出さない", async () => {
    const logs: (InboxExcludedLog | InboxExcludedLimitLog)[] = [];
    const relay = fakeRelay(async () => ok({ items: [good("i1", 1)] }));
    const server = createToolServer({
      role: "integrator",
      relay,
      onInboxProblems: createInboxProblemReporter({ log: (e) => void logs.push(e) }),
    });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    await client.callTool({ name: "inbox_fetch", arguments: {} });
    expect(logs).toEqual([]);
  });

  const lines = (logs: (InboxExcludedLog | InboxExcludedLimitLog)[]) =>
    logs.filter((l): l is InboxExcludedLog => l.event === "inboxExcluded");
  const many = (n: number, prefix = "x") =>
    Array.from({ length: n }, (_, i) => ({ itemId: `${prefix}${i}`, reason: "badKind" as const }));

  it("報告: 新しい不備だけを出す。1 行は 20 件まで。出さなかった分は覚えず、次の取得で出る（21 件 → 2 回目に残りの 1 件）", () => {
    const logs: (InboxExcludedLog | InboxExcludedLimitLog)[] = [];
    const report = createInboxProblemReporter({ log: (e) => void logs.push(e), clock: () => "T" });
    const p = many(21);
    report(p);
    expect(lines(logs)[0]?.count).toBe(20);
    expect(lines(logs)[0]?.truncated).toBe(true);
    report(p);
    expect(lines(logs)[1]?.problems).toEqual([{ itemId: "x20", reason: "badKind" }]);
    expect(lines(logs)[1]?.truncated).toBeUndefined();
    report(p); // すべて出したので、もう出さない
    expect(logs).toHaveLength(2);
    report([{ itemId: "new", reason: "badSeq" }]);
    expect(lines(logs)[2]?.problems).toEqual([{ itemId: "new", reason: "badSeq" }]);
  });

  it("報告: ID のない不備は、理由ごとに 1 回。同じ取得の中の重複も 1 回", () => {
    const logs: (InboxExcludedLog | InboxExcludedLimitLog)[] = [];
    const report = createInboxProblemReporter({ log: (e) => void logs.push(e) });
    report([{ reason: "notObject" }, { reason: "notObject" }, { reason: "badId" }]);
    report([{ reason: "notObject" }]);
    expect(lines(logs).map((l) => l.problems)).toEqual([
      [{ reason: "notObject" }, { reason: "badId" }],
    ]);
  });

  it("報告: 覚える数の上限に達したら、inboxExcludedLimit を 1 回だけ出し、以後は黙る（1500 件を 5 回取得しても、行が出続けない）", () => {
    const logs: (InboxExcludedLog | InboxExcludedLimitLog)[] = [];
    const report = createInboxProblemReporter({
      log: (e) => void logs.push(e),
      maxRemembered: 30,
      clock: () => "T",
    });
    const p = many(1500);
    for (let i = 0; i < 5; i++) report(p);
    // 1 回目: 20 件。2 回目: 残りの容量 10 件と、上限の 1 行。3〜5 回目: 何も出さない
    expect(logs.map((l) => l.event)).toEqual([
      "inboxExcluded",
      "inboxExcluded",
      "inboxExcludedLimit",
    ]);
    expect(lines(logs).map((l) => l.count)).toEqual([20, 10]);
    expect(logs.at(-1)).toEqual({ event: "inboxExcludedLimit", remembered: 30, at: "T" });
    report([{ itemId: "new", reason: "badSeq" }]); // 新しい不備も、もう出さない
    expect(logs).toHaveLength(3);
  });

  it("報告: 既定の上限（1000）でも、1500 件を何度取得しても、行は有限（20 件ずつ 50 行と、上限の 1 行）", () => {
    const logs: (InboxExcludedLog | InboxExcludedLimitLog)[] = [];
    const report = createInboxProblemReporter({ log: (e) => void logs.push(e) });
    const p = many(1500);
    for (let i = 0; i < 100; i++) report(p);
    expect(lines(logs)).toHaveLength(50);
    expect(logs.filter((l) => l.event === "inboxExcludedLimit")).toHaveLength(1);
  });

  it("報告とツール: ログ・報告の失敗で、例外にせず、応答を変えない", async () => {
    const broken = createInboxProblemReporter({
      log: () => {
        throw new Error("x");
      },
    });
    expect(() => broken([{ reason: "notObject" }])).not.toThrow();
    const relay = fakeRelay(async () => ok({ items: ["x"] }));
    const server = createToolServer({
      role: "integrator",
      relay,
      onInboxProblems: () => {
        throw new Error("x");
      },
    });
    const client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
    const r = await client.callTool({ name: "inbox_fetch", arguments: {} });
    expect(text(r).excluded).toBe(1);
  });
});
