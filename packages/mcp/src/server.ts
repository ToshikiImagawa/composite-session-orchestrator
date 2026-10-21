/**
 * MCP のツールサーバー（transport に依存しない）。接続したロールのツールだけを公開し、呼び出しは
 * 入力の検査（`parseToolInput`）を通ったものだけを daemon の窓口へ中継する。ログにトークン・本文は出さない。
 */
import { type Failure, failure, ok, type Result } from "@cso/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { renderInbox } from "./inbox-response.js";
import type { Relay } from "./relay.js";
import { inputSchemaFor, parseToolInput } from "./schemas.js";
import { isMcpRole, MCP_ROLES, type McpRole, toolsFor } from "./tools.js";

export interface ToolServerDeps {
  readonly role: McpRole;
  readonly relay: Relay;
}

const asError = (f: Failure) => ({
  isError: true as const,
  content: [
    {
      type: "text" as const,
      text: JSON.stringify({ code: f.code, cause: f.cause, nextActions: f.nextActions }),
    },
  ],
});
const asValue = (v: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(v ?? null) }],
});

export function createToolServer(deps: ToolServerDeps): Server {
  const server = new Server({ name: "cso-mcp", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsFor(deps.role).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: inputSchemaFor(t.operation),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const parsed = parseToolInput(deps.role, req.params.name, req.params.arguments ?? {});
      if (!parsed.ok) return asError(parsed.error);
      const { operation, forward, view } = parsed.value;
      const r = await deps.relay.request(operation, forward);
      if (!r.ok) return asError(r.error);
      if (operation === "inbox.fetch") {
        const items = (r.value as { items?: unknown } | null)?.items;
        const page = renderInbox(items as never, view);
        return page.ok ? asValue(page.value) : asError(page.error);
      }
      return asValue(r.value);
    } catch {
      return asError(
        failure(
          "internal_error",
          "ツールの処理で例外が起きた",
          "少し待って呼び直す",
          "管理者（人間）に知らせる",
        ),
      );
    }
  });
  return server;
}

/**
 * 接続のトークンのロールを daemon に尋ね（接続ごとに 1 回）、そのロールのツールサーバーを作る。
 * MCP で公開しないロール（人間・不明）には、何も公開せず失敗にする。daemon の 401・403 は、そのまま失敗にする。
 */
export async function openSession(relay: Relay): Promise<Result<Server>> {
  try {
    const who = await relay.whoami();
    if (!who.ok) return who;
    if (!isMcpRole(who.value.role)) {
      return {
        ok: false,
        error: failure(
          "role_not_exposed",
          "このロールには MCP のツールを公開していない",
          `接続のロールを確認する（${MCP_ROLES.join(" / ")} のみ）`,
        ),
      };
    }
    const role = who.value.role;
    // ロールは接続の間だけ持つ（キャッシュはこの接続の間のみ）。
    return ok(createToolServer({ role, relay }));
  } catch {
    return {
      ok: false,
      error: failure("whoami_failed", "ロールを確認できなかった", "daemon の状態を確認する"),
    };
  }
}
