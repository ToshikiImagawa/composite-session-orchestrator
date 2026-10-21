/**
 * 実際の Agent SDK（`@anthropic-ai/claude-agent-sdk` の `query()`）への結線。`AgentLauncher` の実装。
 * PRD: FR_005, FR_009, FR_010, FR_033, IR_001, IR_002 / Spike 02
 *
 * - 常にストリーミング入力（`AsyncIterable<SDKUserMessage>`）で起動する（`interrupt()` はストリーミング入力限定）。最初の
 *   指示（ブリーフ）は入力の最初のメッセージ。`send` は、そのあとに積む（実行中はツール完了後に届く）。
 * - `settingSources: []`（利用者設定のフックの混入を防ぐ）、`cwd` は作業ツリー、`env` は呼び出し側が除いたもの
 *   （`options.env` は `process.env` を置き換える）。MCP は HTTP + ヘッダ（ノード専用トークン）。
 * - 権限: `permissionMode: "dontAsk"`（事前に許可していない操作は、確認せず拒否）。PreToolUse フックが、許可したツールだけに
 *   明示的な `allow` を返す。フックが例外・不正な入力のときは `deny`（フェイルクローズ）。
 * - 停止: `interrupt()` は `query.interrupt()`、`abort()` は `AbortController`。出力の終了・例外は `finished()` に伝える。
 * 自動テストはフェイクの `query` で行う（実 SDK の起動は認証情報が要るので CI に入れない。手動確認は docs の手順書）。
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { AgentLauncher, AgentSession, HookOutcome, LaunchOptions } from "./agent.js";

type QueryFn = typeof sdkQuery;

type Msg = Record<string, unknown>;
const isRec = (x: unknown): x is Msg => typeof x === "object" && x !== null && !Array.isArray(x);

const deny = (reason: string) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse" as const,
    permissionDecision: "deny" as const,
    permissionDecisionReason: reason,
  },
});
const allow = () => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse" as const,
    permissionDecision: "allow" as const,
  },
});

/** 実 SDK ではなく、渡された `query` を使う launcher（試験用の口。`createClaudeLauncher` が実 SDK を渡す）。 */
export function launcherWith(queryFn: QueryFn): AgentLauncher {
  return {
    launch(options: LaunchOptions): AgentSession {
      const ac = new AbortController();

      // 入力: 積んだ順に流す。close で終わる。
      const queue: Msg[] = [];
      let wake: (() => void) | undefined;
      let closed = false;
      const push = (text: string): void => {
        if (closed) throw new Error("セッションの入力は閉じている");
        queue.push({
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
        });
        wake?.();
        wake = undefined;
      };
      async function* input(): AsyncGenerator<Msg> {
        for (;;) {
          const m = queue.shift();
          if (m !== undefined) {
            yield m;
            continue;
          }
          if (closed) return;
          await new Promise<void>((r) => {
            wake = r;
          });
        }
      }
      push(options.initialPrompt);

      const preToolUse = async (raw: unknown) => {
        try {
          if (
            !isRec(raw) ||
            raw.hook_event_name !== "PreToolUse" ||
            typeof raw.tool_name !== "string" ||
            typeof raw.cwd !== "string"
          ) {
            return deny("フックの入力の形が不正");
          }
          const outcome: HookOutcome = await options.hooks.preToolUse({
            toolName: raw.tool_name,
            toolInput: raw.tool_input,
            cwd: raw.cwd,
          });
          return outcome.allow ? allow() : deny(outcome.reason);
        } catch {
          return deny("フックの判定に失敗したため拒否する");
        }
      };

      const q = queryFn({
        prompt: input() as never,
        options: {
          cwd: options.cwd,
          env: { ...options.env },
          settingSources: [],
          abortController: ac,
          permissionMode: "dontAsk",
          ...(options.mcpServers === undefined
            ? {}
            : {
                mcpServers: Object.fromEntries(
                  Object.entries(options.mcpServers).map(([name, s]) => [
                    name,
                    { type: "http" as const, url: s.url, headers: { ...s.headers } },
                  ]),
                ),
              }),
          hooks: { PreToolUse: [{ hooks: [(input) => preToolUse(input) as never] }] },
        },
      });

      // 出力を読み続ける。init で ready、result で nextResult、終了・例外で finished。
      let readyResolve!: (v: { sessionId: string }) => void;
      let readyReject!: (e: Error) => void;
      const ready = new Promise<{ sessionId: string }>((res, rej) => {
        readyResolve = res;
        readyReject = rej;
      });
      ready.catch(() => undefined);
      let initialized = false;
      let finishedResolve!: () => void;
      let finishedReject!: (e: unknown) => void;
      const finished = new Promise<void>((res, rej) => {
        finishedResolve = res;
        finishedReject = rej;
      });
      finished.catch(() => undefined);
      let resultWaiters: (() => void)[] = [];

      void (async () => {
        try {
          for await (const m of q as AsyncIterable<unknown>) {
            if (!isRec(m)) continue;
            if (m.type === "system" && m.subtype === "init" && !initialized) {
              initialized = true;
              readyResolve({ sessionId: String(m.session_id) });
            } else if (m.type === "result") {
              const w = resultWaiters;
              resultWaiters = [];
              for (const r of w) r();
            }
          }
          if (!initialized) readyReject(new Error("init を受ける前に、出力が終わった"));
          finishedResolve();
        } catch (e) {
          if (!initialized) readyReject(e instanceof Error ? e : new Error(String(e)));
          finishedReject(e);
        }
      })();

      return {
        ready: () => ready,
        send: (text) => push(text),
        nextResult: () => new Promise<void>((r) => resultWaiters.push(r)),
        interrupt: async () => {
          await q.interrupt();
        },
        abort: () => ac.abort(),
        close: () => {
          closed = true;
          wake?.();
          wake = undefined;
        },
        finished: () => finished,
      };
    },
  };
}

/** `cso-daemon` の `loaders` が読み込む入口。実際の Agent SDK を使う launcher。 */
export function createClaudeLauncher(_config?: unknown): AgentLauncher {
  return launcherWith(sdkQuery);
}
