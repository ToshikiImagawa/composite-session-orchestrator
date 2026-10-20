/**
 * フック（PreToolUse）の判定。ツール呼び出しを、core の `evaluateScope`（作業範囲の判定）に対応づける純粋関数。
 * PRD: FR_014, IR_002 / design 6.3
 *
 * - 読み込み系（Read・Glob・Grep・NotebookRead）は常に許可（FR_014: 読み込みは制限しない）。
 * - 書き込み系（Write・Edit・MultiEdit・NotebookEdit）は、対象のパスを書き込みとして判定する。
 * - Bash は、コマンドとして判定する。`run_in_background` が `undefined`・`false` 以外なら拒否する（ADR 未決の既定）。
 * - 自ノードの MCP ツール（`mcp__node__*`）は許可する。権限の絞り込みは窓口のロール別の操作表（NFR_004）の責務。
 * - それ以外（別の MCP サーバー、サブエージェント、ウェブ、未知のツール）は拒否する（フェイルクローズ）。
 *   未知のツールには、core の違反の理由のうち `commandNotAllowed` を使う。
 * 例外を出さない: 入力の形が不正なら拒否する。
 */

import { evaluateScope, type Scope, type ScopeViolationReason } from "@cso/core";

export interface ToolViolation {
  readonly reason: ScopeViolationReason;
  /** 違反した場所またはコマンド（記録用）。 */
  readonly subject: string;
}

export type ToolDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      readonly violation: ToolViolation;
      /** モデルへ伝える理由（フックの拒否の理由）。 */
      readonly reason: string;
    };

const ALLOW: ToolDecision = { allow: true };

const READ_TOOLS: ReadonlySet<string> = new Set(["Read", "Glob", "Grep", "NotebookRead"]);
/** 書き込み系のツール → 対象のパスを持つ入力のキー。 */
const WRITE_TOOLS: Readonly<Record<string, string>> = {
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};
const OWN_MCP_PREFIX = "mcp__node__";

const isRec = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const deny = (reason: ScopeViolationReason, subject: string): ToolDecision => ({
  allow: false,
  violation: { reason, subject },
  reason: `作業範囲の外の操作です（${reason}: ${subject}）。範囲の拡張が必要なら、親へ拡張要求を出してください。`,
});

export function decideToolUse(
  scope: Scope,
  cwd: string,
  toolName: string,
  toolInput: unknown,
): ToolDecision {
  if (typeof toolName !== "string") return deny("commandNotAllowed", "(ツール名が不正)");
  if (READ_TOOLS.has(toolName)) return ALLOW;

  if (Object.hasOwn(WRITE_TOOLS, toolName)) {
    const key = WRITE_TOOLS[toolName] as string;
    const path = isRec(toolInput) ? toolInput[key] : undefined;
    if (typeof path !== "string" || path.trim() === "")
      return deny("invalidPath", `${toolName}（${key} がない）`);
    const d = evaluateScope(scope, cwd, { kind: "write", path });
    return d.allowed ? ALLOW : deny(d.reason, d.subject);
  }

  if (toolName === "Bash") {
    const command = isRec(toolInput) ? toolInput.command : undefined;
    if (typeof command !== "string" || command.trim() === "")
      return deny("commandNotAllowed", "Bash（command がない）");
    const background = (toolInput as Record<string, unknown>).run_in_background;
    if (background !== undefined && background !== false)
      return deny("backgroundExecution", command);
    const d = evaluateScope(scope, cwd, { kind: "command", command });
    return d.allowed ? ALLOW : deny(d.reason, d.subject);
  }

  if (toolName.startsWith(OWN_MCP_PREFIX) && toolName.length > OWN_MCP_PREFIX.length) return ALLOW;
  return deny("commandNotAllowed", toolName === "" ? "(ツール名が空)" : toolName);
}
