/**
 * フック（PreToolUse）の判定。ツール呼び出しを、core の `evaluateScope`（作業範囲の判定）に対応づける純粋関数。
 * PRD: FR_014, IR_002 / design 6.3
 *
 * - 読み込み系（Read・Glob・Grep・NotebookRead）と、読み取りのみで無害なツール（LS・TodoWrite・ToolSearch・BashOutput）は
 *   常に許可（FR_014: 読み込みは制限しない）。許可するツール名は T10b の実機確認で固定する。
 * - 書き込み系（Write・Edit・MultiEdit・NotebookEdit）は、対象のパス（絶対にして、最も深い既存の祖先を実パスにしたもの。
 *   リンク経由の範囲外への書き込みを防ぐ）を書き込みとして判定する。解決に失敗したら拒否する。
 *   フック入力の `cwd`（`HookInput.cwd`）は使わない。基準は、起動時に実パスにした作業ツリー。
 * - Bash は、コマンドとして判定する。`run_in_background` が `undefined`・`false` 以外、
 *   `dangerouslyDisableSandbox` が `true` なら拒否する（ADR 未決の既定）。
 * - 自ノードの MCP ツール（`mcp__node__*`）は許可する。権限の絞り込みは窓口のロール別の操作表（NFR_004）の責務。
 * - それ以外（別の MCP サーバー、サブエージェント、ウェブ、未知のツール）は拒否する（フェイルクローズ）。
 *   範囲の違反ではないため `violation` は持たず（`unknownTool`）、`scope.violation` として記録しない（受信箱に載せない）。
 * 例外を出さない: 入力の形が不正なら拒否する。
 */

import { evaluateScope, type Scope, type ScopeViolationReason } from "@cso/core";

/** パスの実パス化（書き込み先の判定用）。解決できなければ reject する。 */
export type ResolvePath = (absPath: string) => Promise<string>;

export interface ToolViolation {
  readonly reason: ScopeViolationReason;
  /** 違反した場所またはコマンド（記録用）。 */
  readonly subject: string;
}

export type ToolDecision =
  | { readonly allow: true }
  | {
      readonly allow: false;
      /** 範囲の違反（記録する）。未知のツールの拒否では持たない。 */
      readonly violation?: ToolViolation;
      /** 許可していないツールの名前（範囲の違反ではない）。 */
      readonly unknownTool?: string;
      /** モデルへ伝える理由（フックの拒否の理由）。 */
      readonly reason: string;
    };

const ALLOW: ToolDecision = { allow: true };

const READ_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "NotebookRead",
  "LS",
  "TodoWrite",
  "ToolSearch",
  "BashOutput",
]);
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

const denyUnknown = (tool: string): ToolDecision => ({
  allow: false,
  unknownTool: tool,
  reason: `ツール ${tool} は、このノードでは使えない。`,
});

/** scope の場所（writable・forbidden）を実パスにする。解決できない writable は落とし、forbidden は絶対パスのまま残す。 */
export async function resolveScope(
  scope: Scope,
  cwd: string,
  resolve: ResolvePath,
): Promise<Scope> {
  const abs = (d: string): string => (d.startsWith("/") ? d : `${cwd}/${d}`);
  const real = async (d: string): Promise<string | undefined> => {
    if (typeof d !== "string" || d.trim() === "" || d.includes("\0")) return undefined;
    try {
      return await resolve(abs(d));
    } catch {
      return undefined;
    }
  };
  const writable: string[] = [];
  for (const d of scope.writableLocations) {
    const r = await real(d);
    if (r !== undefined) writable.push(r);
  }
  const forbidden: string[] = [];
  for (const d of scope.forbiddenLocations) {
    if (typeof d !== "string") continue;
    forbidden.push((await real(d)) ?? abs(d));
  }
  return { ...scope, writableLocations: writable, forbiddenLocations: forbidden };
}

/** `scope` は `resolveScope` で実パスにしたもの、`cwd` は実パスの作業ツリー。 */
export async function decideToolUse(
  scope: Scope,
  cwd: string,
  toolName: string,
  toolInput: unknown,
  resolve: ResolvePath,
): Promise<ToolDecision> {
  if (typeof toolName !== "string") return denyUnknown("(ツール名が不正)");
  if (READ_TOOLS.has(toolName)) return ALLOW;

  if (Object.hasOwn(WRITE_TOOLS, toolName)) {
    const key = WRITE_TOOLS[toolName] as string;
    const path = isRec(toolInput) ? toolInput[key] : undefined;
    if (typeof path !== "string" || path.trim() === "")
      return deny("invalidPath", `${toolName}（${key} がない）`);
    let target: string;
    try {
      target = await resolve(path.startsWith("/") ? path : `${cwd}/${path}`);
    } catch {
      return deny("invalidPath", `${path}（実パスを解決できない）`);
    }
    const d = evaluateScope(scope, cwd, { kind: "write", path: target });
    return d.allowed ? ALLOW : deny(d.reason, d.subject);
  }

  if (toolName === "Bash") {
    const command = isRec(toolInput) ? toolInput.command : undefined;
    if (typeof command !== "string" || command.trim() === "")
      return deny("commandNotAllowed", "Bash（command がない）");
    const input = toolInput as Record<string, unknown>;
    if (input.run_in_background !== undefined && input.run_in_background !== false)
      return deny("backgroundExecution", command);
    if (input.dangerouslyDisableSandbox === true)
      return deny("commandNotAllowed", `${command}（dangerouslyDisableSandbox）`);
    const d = evaluateScope(scope, cwd, { kind: "command", command });
    return d.allowed ? ALLOW : deny(d.reason, d.subject);
  }

  if (toolName.startsWith(OWN_MCP_PREFIX) && toolName.length > OWN_MCP_PREFIX.length) return ALLOW;
  return denyUnknown(toolName === "" ? "(ツール名が空)" : toolName);
}
