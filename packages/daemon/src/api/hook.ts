/**
 * ファイルで設定するフック（plugin の `hooks/hooks.json`）の受け口 `POST /v1/hook` の、入力の検証と、`session_id` とノードの結び付け（T22-h）。
 * PRD: FR_014, IR_002 / `docs/plugin.md` の「フック」
 *
 * - 入力は Claude Code のフック入力（`hook_event_name`・`session_id`・`tool_name`・`tool_input`。`cwd` は判定に使わない）。
 * - `session_id` は、ノードごとに最初に来た値に結ぶ（メモリだけ。daemon を再起動すると結び直しになる）。別の値は拒否する
 *   （同じトークンを、別のセッションで使い回させない）。結び付けは、`node.hookUnbind`（人間・祖先の統合ノード）と、
 *   トークンの発行し直し・失効で外れる（T22-hu）。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type Failure, failure, type Result } from "@cso/core";

export type HookEventName = "PreToolUse" | "PostToolUse" | "Stop";

export interface HookRequest {
  readonly event: HookEventName;
  readonly sessionId: string;
  readonly toolName?: string;
  readonly toolInput?: unknown;
}

/** PreToolUse の判定（ノードの範囲で、許可・拒否）。`reason` はモデルへ伝える拒否の理由。 */
export type HookDecider = (
  nodeId: string,
  toolName: string,
  toolInput: unknown,
) => Promise<{ readonly allow: true } | { readonly allow: false; readonly reason: string }>;

const EVENTS: ReadonlySet<string> = new Set(["PreToolUse", "PostToolUse", "Stop"]);
const SESSION_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const TOOL_NAME = /^[A-Za-z0-9_.:-]{1,200}$/;

const bad = (cause: string): { ok: false; error: Failure } => ({
  ok: false,
  error: failure("invalidRequest", cause, "Claude Code のフック入力をそのまま送る"),
});

export function parseHookRequest(body: unknown): Result<HookRequest, Failure> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return bad("フック入力がオブジェクトでない");
  }
  const b = body as Record<string, unknown>;
  const event = b.hook_event_name;
  if (typeof event !== "string" || !EVENTS.has(event)) {
    return bad("hook_event_name が PreToolUse・PostToolUse・Stop のどれでもない");
  }
  const sessionId = b.session_id;
  if (typeof sessionId !== "string" || !SESSION_ID.test(sessionId)) {
    return bad("session_id がないか、形が正しくない");
  }
  if (event === "Stop") return { ok: true, value: { event, sessionId } };
  const toolName = b.tool_name;
  if (typeof toolName !== "string" || !TOOL_NAME.test(toolName)) {
    return bad("tool_name がないか、形が正しくない");
  }
  return {
    ok: true,
    value: { event: event as HookEventName, sessionId, toolName, toolInput: b.tool_input },
  };
}

export interface SessionBinder {
  /** 最初の値なら結び、結んだ値と同じなら真。別の値なら偽。 */
  check(nodeId: string, sessionId: string): boolean;
  /** 結び付けを外す（T22-hu）。外したら真（結び付けがなければ偽）。次に来た session_id に結び直す。 */
  unbind(nodeId: string): boolean;
  /** 結び付けがあるか（記録の `hadBinding` 用）。 */
  has(nodeId: string): boolean;
}

export function createSessionBinder(): SessionBinder {
  const bound = new Map<string, string>();
  return {
    check(nodeId, sessionId) {
      const s = bound.get(nodeId);
      if (s === undefined) {
        bound.set(nodeId, sessionId);
        return true;
      }
      return s === sessionId;
    },
    unbind(nodeId) {
      return bound.delete(nodeId);
    },
    has(nodeId) {
      return bound.has(nodeId);
    },
  };
}

/**
 * 手動の CLI セッション用の、フック専用のトークンの表（T22-ht）。ノードのトークン（`CredentialStore`）とは別に持ち、`POST /v1/hook` だけで使う。
 * ノードごとに 1 つ（発行し直すと、古いものは無効）。ハッシュだけを持ち、メモリだけ（daemon の再起動で無効）。
 */
export interface HookTokens {
  /** 発行する（そのノードの古いフック用トークンは無効になる）。 */
  issue(nodeId: string): string;
  /** トークンのノード。未知・不正なら undefined。 */
  authenticate(token: unknown): string | undefined;
  revoke(nodeId: string): void;
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s).digest();

export function createHookTokens(
  options: { readonly randomBytes?: (n: number) => Buffer } = {},
): HookTokens {
  const random = options.randomBytes ?? randomBytes;
  const byNode = new Map<string, Buffer>();
  return {
    issue(nodeId) {
      const token = random(32).toString("base64url");
      byNode.set(nodeId, sha256(token));
      return token;
    },
    authenticate(token) {
      if (typeof token !== "string" || token === "") return undefined;
      const h = sha256(token);
      for (const [nodeId, stored] of byNode) {
        if (timingSafeEqual(stored, h)) return nodeId;
      }
      return undefined;
    },
    revoke(nodeId) {
      byNode.delete(nodeId);
    },
  };
}
