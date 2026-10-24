/**
 * MCP のツールサーバー（transport に依存しない）。接続したロールのツールだけを公開し、呼び出しは
 * 入力の検査（`parseToolInput`）を通ったものだけを daemon の窓口へ中継する。ログにトークン・本文は出さない。
 */
import { type Failure, failure, ok, type Result } from "@cso/core";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { type InboxProblem, inboxProblems, renderInbox } from "./inbox-response.js";
import type { Relay } from "./relay.js";
import { inputSchemaFor, parseToolInput } from "./schemas.js";
import {
  isMcpRole,
  MCP_ROLES,
  type McpRole,
  toolsFor,
  WHOAMI_TOOL,
  whoamiDescription,
} from "./tools.js";

export interface ToolServerDeps {
  readonly role: McpRole;
  readonly relay: Relay;
  /** 受信箱で除外した項目の不備を知らせる（T24-m2。ログに出す）。省略すると知らせない。 */
  readonly onInboxProblems?: (problems: readonly InboxProblem[]) => void;
}

/** 受信箱の不備のログ（T24-m2）。固定の記号と、識別子の形式の項目 ID だけ（項目の内容は出さない）。 */
export interface InboxExcludedLog {
  readonly event: "inboxExcluded";
  /** この行に出した不備の数（新しい不備だけ）。 */
  readonly count: number;
  readonly problems: readonly InboxProblem[];
  /** 1 行の上限を超えて、出さなかった不備があった。 */
  readonly truncated?: true;
  readonly at: string;
}

/** 覚える数の上限に達した（T24-m2。1 回だけ出す。以後、新しい不備は出さない）。 */
export interface InboxExcludedLimitLog {
  readonly event: "inboxExcludedLimit";
  /** 覚えている不備の数（上限）。 */
  readonly remembered: number;
  readonly at: string;
}

/**
 * 受信箱の不備を、プロセスの間に 1 回だけログに出す（T24-m2）。受信箱は LLM のターンごとに読まれるので、同じ不備（項目 ID と理由。
 * 項目 ID のない不備は、理由ごとに 1 つ）は 2 回目から出さない。1 行に出すのは 20 件まで（超えたら `truncated`。出さなかった分は、
 * 覚えないので、次の取得で出る）。覚える数が上限（既定 1000）に達したら、`inboxExcludedLimit` を 1 回だけ出し、以後は出さない
 * （不備が多すぎるときに、行が出続けないため）。プロセスを再起動すると、覚えたものは消える（また 1 回出る）。
 */
export function createInboxProblemReporter(opts: {
  readonly log: (e: InboxExcludedLog | InboxExcludedLimitLog) => void;
  readonly maxRemembered?: number;
  readonly perLine?: number;
  readonly clock?: () => string;
}): (problems: readonly InboxProblem[]) => void {
  const max = opts.maxRemembered ?? 1000;
  const perLine = opts.perLine ?? 20;
  const clock = opts.clock ?? (() => new Date().toISOString());
  const seen = new Set<string>();
  let full = false;
  const emit = (e: InboxExcludedLog | InboxExcludedLimitLog): void => {
    try {
      opts.log(e);
    } catch {
      // ログの失敗で、ツールの応答を変えない
    }
  };
  return (problems) => {
    if (full) return;
    const fresh: { key: string; p: InboxProblem }[] = [];
    const inBatch = new Set<string>();
    for (const p of problems) {
      const key = `${p.itemId ?? ""}\0${p.reason}`;
      if (seen.has(key) || inBatch.has(key)) continue;
      inBatch.add(key);
      fresh.push({ key, p });
    }
    if (fresh.length === 0) return;
    // 覚えるのは、実際に出した分だけ（出さなかった分は、次の取得で出る）。上限を超える分は出さない
    const room = max - seen.size;
    const shown = fresh.slice(0, Math.min(perLine, room));
    for (const f of shown) seen.add(f.key);
    if (shown.length > 0) {
      emit({
        event: "inboxExcluded",
        count: shown.length,
        problems: shown.map((f) => f.p),
        ...(fresh.length > shown.length ? { truncated: true as const } : {}),
        at: clock(),
      });
    }
    if (seen.size >= max && fresh.length > shown.length) {
      full = true;
      emit({ event: "inboxExcludedLimit", remembered: seen.size, at: clock() });
    }
  };
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
  if (who.value.role !== deps.role) {
    return asError(
      failure(
        "whoami_role_mismatch",
        "daemon が返したロールが、この接続のロールと違う",
        "接続のトークンを確認する（別のロールのトークンで接続していないか）",
        "daemon → cso-mcp → 子の順に起動し直す",
      ),
    );
  }
  if (who.value.nodeId === undefined) {
    return asError(
      failure(
        "whoami_failed",
        "daemon が nodeId を返さなかった（古い daemon の可能性）",
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
        description: whoamiDescription(deps.role),
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
        // 除外した項目があれば、不備の理由をログに出す（応答には出さない。T24-m2）
        if (page.ok && page.value.excluded > 0) {
          try {
            deps.onInboxProblems?.(inboxProblems(items));
          } catch {
            // 報告の失敗で、ツールの応答を変えない
          }
        }
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
export async function openSession(
  relay: Relay,
  onInboxProblems?: (problems: readonly InboxProblem[]) => void,
): Promise<Result<Server>> {
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
    return ok(
      createToolServer({
        role,
        relay,
        ...(onInboxProblems === undefined ? {} : { onInboxProblems }),
      }),
    );
  } catch {
    return {
      ok: false,
      error: failure("whoami_failed", "ロールを確認できなかった", "daemon の状態を確認する"),
    };
  }
}
