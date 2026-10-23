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
import {
  isMcpRole,
  MCP_ROLES,
  type McpRole,
  toolsFor,
  WHOAMI_DESCRIPTION,
  WHOAMI_TOOL,
} from "./tools.js";

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

/** `whoami`: 引数なし。呼ぶたびに daemon に尋ねる。nodeId がない（古い daemon）・ロールが接続のロールと違うときは、失敗にする。 */
async function whoamiTool(deps: ToolServerDeps, args: unknown) {
  if (
    args !== undefined &&
    (typeof args !== "object" || args === null || Object.keys(args).length > 0)
  ) {
    return asError(failure("invalid_argument", "whoami に引数はない", "引数なしで呼び直す"));
  }
  const who = await deps.relay.whoami();
  if (!who.ok) return asError(who.error);
  if (who.value.nodeId === undefined || who.value.role !== deps.role) {
    return asError(
      failure(
        "whoami_failed",
        who.value.nodeId === undefined
          ? "daemon が nodeId を返さなかった（古い daemon の可能性）"
          : "daemon が返したロールが、接続のロールと違う",
        "daemon を更新して、起動し直す",
        "接続のトークンを確認する（daemon → cso-mcp → 子の順に起動する）",
      ),
    );
  }
  return asValue({ nodeId: who.value.nodeId, role: who.value.role });
}

export function createToolServer(deps: ToolServerDeps): Server {
  const server = new Server({ name: "cso-mcp", version: "0.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...toolsFor(deps.role).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: inputSchemaFor(t.operation),
      })),
      // 固定のメタツール（daemon の操作ではない）。入力はなし
      {
        name: WHOAMI_TOOL,
        description: WHOAMI_DESCRIPTION,
        inputSchema: { type: "object" as const, properties: {}, additionalProperties: false },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      if (req.params.name === WHOAMI_TOOL) return await whoamiTool(deps, req.params.arguments);
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
