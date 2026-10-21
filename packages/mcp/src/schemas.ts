/**
 * MCP の境界でのツール入力の検証（zod）。エージェントから来る入力は信頼しない。
 * 規則は core の `LIMITS`・`isSafeId`・`isBoundedText`・`briefProblem`・`pauseNodeIdsProblem` を呼んで揃える
 * （規則を複製しない）。未知のキーは拒否する（strict）。daemon の検査（`validateParams`）とは別に、
 * 境界で早く・分かりやすく失敗させるための層。
 */
import {
  briefProblem,
  type DaemonOperation,
  failure,
  ID_MAX_LENGTH,
  isBoundedText,
  isSafeId,
  LIMITS,
  MAX_GRACE_MS,
  NODE_ROLES,
  ok,
  pauseNodeIdsProblem,
  type Result,
  type RoleOperation,
} from "@cso/core";
import { z } from "zod";
import { MAX_LIMIT } from "./inbox-response.js";
import { type McpRole, operationForTool } from "./tools.js";

type McpOperation = RoleOperation<"integrator"> | RoleOperation<"child">;

const id = z.string().refine(isSafeId, {
  message: `英数字で始まり、英数字と . _ : - だけの ${ID_MAX_LENGTH} 文字以下`,
});
const text = (max: number) =>
  z.string().refine((v) => isBoundedText(v, max), {
    message: `${max} 文字以下の文字列（制御文字なし）`,
  });
const nonBlank = (max: number) =>
  text(max).refine((v) => v.trim() !== "", { message: "空白だけは不可" });
const options = z
  .array(text(LIMITS.optionLength).refine((v) => v !== "", { message: "空は不可" }))
  .min(1)
  .max(LIMITS.optionCount)
  .refine((v) => new Set(v).size === v.length, { message: "重複は不可" });
const seq = z.number().int().min(0);

/** ブリーフ（spec 5.2）。規則は `briefProblem` に委ね、場所は相対パスに限る。 */
const briefShape = {
  objective: z.unknown(),
  acceptanceCriteria: z.unknown(),
  scope: z.unknown(),
  dependsOn: z.unknown().optional(),
};
const withBrief = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject({ ...shape, ...briefShape }).superRefine((o, ctx) => {
    const problem = briefProblem(o);
    if (problem !== undefined) ctx.addIssue({ code: "custom", message: problem });
  });

const nodeIdOnly = z.strictObject({ nodeId: id });

const SCHEMAS: Readonly<Record<McpOperation, z.ZodType>> = {
  "node.spawn": withBrief({ parentId: id, role: z.enum(NODE_ROLES) }),
  "node.send": z.strictObject({ nodeId: id, text: text(LIMITS.reportText) }),
  "node.stop": z.discriminatedUnion("mode", [
    z.strictObject({
      nodeId: id,
      mode: z.literal("graceful"),
      graceMs: z.number().int().min(1).max(MAX_GRACE_MS).optional(),
    }),
    z.strictObject({ nodeId: id, mode: z.literal("immediate") }),
  ]),
  "inbox.fetch": z.strictObject({
    sinceSeq: seq.optional(),
    detail: z.enum(["brief", "full"]).optional(),
    limit: z.number().int().min(1).max(MAX_LIMIT).optional(),
    offset: seq.optional(),
    asOfSeq: seq.optional(),
  }),
  "tree.list": z.strictObject({}),
  "decision.present": z
    .strictObject({
      question: text(LIMITS.question),
      options,
      pauseNodeIds: z.unknown().optional(),
    })
    .superRefine((o, ctx) => {
      if (o.pauseNodeIds === undefined) return;
      const problem = pauseNodeIdsProblem(o.pauseNodeIds);
      if (problem !== undefined)
        ctx.addIssue({ code: "custom", path: ["pauseNodeIds"], message: problem });
    }),
  "node.split": withBrief({ nodeId: id, keep: z.enum(["mainline", "stop"]) }),
  "scope.decide": z.strictObject({
    extensionId: id,
    decision: z.enum(["approve", "reject", "split"]),
  }),
  "node.review": z.discriminatedUnion("verdict", [
    z.strictObject({
      nodeId: id,
      verdict: z.literal("accept"),
      feedback: text(LIMITS.feedback).optional(),
    }),
    z.strictObject({
      nodeId: id,
      verdict: z.literal("reject"),
      feedback: nonBlank(LIMITS.feedback),
    }),
  ]),
  "node.reclaimPreview": nodeIdOnly,
  "node.reclaim": nodeIdOnly,
  "node.capabilities": nodeIdOnly,
  "decision.get": z.strictObject({ decisionId: id }),
  "report.get": z.strictObject({ reportId: id }),
  "report.progress": z.strictObject({ text: text(LIMITS.reportText) }),
  "report.decision": z.strictObject({ question: text(LIMITS.question), options }),
  "report.outOfScope": z.strictObject({ text: text(LIMITS.reportText) }),
  "report.done": z.strictObject({
    evidence: z
      .array(
        z.strictObject({
          criterion: nonBlank(LIMITS.evidenceLength),
          evidence: nonBlank(LIMITS.evidenceLength),
        }),
      )
      .max(LIMITS.evidenceCount),
  }),
  "scope.extend": z.strictObject({
    target: z.strictObject({
      kind: z.enum(["write", "command"]),
      value: nonBlank(LIMITS.extensionTarget),
    }),
    reason: nonBlank(LIMITS.extensionReason),
  }),
};

/** MCP の `tools/list` に載せる、操作の入力の JSON Schema。変換できなければ、緩い object（検査は `parseToolInput` が行う）。 */
export function inputSchemaFor(operation: DaemonOperation): {
  type: "object";
  [k: string]: unknown;
} {
  try {
    const schema = Object.hasOwn(SCHEMAS, operation)
      ? SCHEMAS[operation as McpOperation]
      : undefined;
    if (schema !== undefined) {
      const js = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" }) as Record<
        string,
        unknown
      >;
      if (js.type === "object" || js.oneOf !== undefined || js.anyOf !== undefined) {
        return { type: "object", ...js };
      }
    }
  } catch {
    // 下の既定にする
  }
  return { type: "object" };
}

export interface ParsedToolInput {
  readonly operation: DaemonOperation;
  /** daemon へ送る検証済みの引数。top レベルは新しいオブジェクトで、入れ子の値（ブリーフの scope など）は入力と共有する。 */
  readonly forward: Readonly<Record<string, unknown>>;
  /** daemon へは送らず、mcp の応答の整形だけに使う入力（`inbox_fetch` の detail・limit・offset・asOfSeq）。 */
  readonly view: Readonly<Record<string, unknown>>;
}

/** `inbox_fetch` の入力のうち、daemon へ送るのは `sinceSeq` だけ。 */
const FORWARDED: Readonly<Partial<Record<McpOperation, readonly string[]>>> = {
  "inbox.fetch": ["sinceSeq"],
};

const CAUSE_MAX = 300;
const invalid = (cause: string) =>
  failure(
    "invalid_argument",
    cause.length > CAUSE_MAX ? `${cause.slice(0, CAUSE_MAX)}…` : cause,
    "ツールの説明を読み、引数を直して再度呼ぶ",
    "未知のキーは受け付けない。引数名を確認する",
  );

/** ツール入力を検証する。ツールがロールに公開されていなければ、その失敗を返す。例外は出さない。 */
export function parseToolInput(
  role: McpRole,
  name: string,
  input: unknown,
): Result<ParsedToolInput> {
  const resolved = operationForTool(role, name);
  if (!resolved.ok) return resolved;
  const operation = resolved.value;
  try {
    const schema = Object.hasOwn(SCHEMAS, operation)
      ? SCHEMAS[operation as McpOperation]
      : undefined;
    if (schema === undefined) {
      return { ok: false, error: invalid(`ツール ${name} の入力の定義がない`) };
    }
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const cause = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(入力)"}: ${i.message}`)
        .join("; ");
      return { ok: false, error: invalid(`${name} の入力が不正: ${cause}`) };
    }
    const data = parsed.data as Record<string, unknown>;
    const keys = FORWARDED[operation as McpOperation];
    if (keys === undefined) return ok({ operation, forward: data, view: {} });
    const forward: Record<string, unknown> = {};
    const view: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(data)) (keys.includes(k) ? forward : view)[k] = v;
    return ok({ operation, forward, view });
  } catch {
    return { ok: false, error: invalid(`${name} の入力を検査できない`) };
  }
}
