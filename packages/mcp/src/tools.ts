/**
 * ロール別のツール定義（NFR_004）。公開する操作は core の `ROLE_OPERATIONS` を唯一の情報源とする。
 * MCP で公開するのは統合と子だけで、人間用の操作（最終削除を含む）は含めない（DC_003）。
 *
 * 入力の検証（zod など）は、依存を追加する際の最新版確認と合わせて将来課題とする。
 */
import {
  type DaemonOperation,
  failure,
  ok,
  type Result,
  ROLE_OPERATIONS,
  type RoleOperation,
} from "@cso/core";

export const MCP_ROLES = ["integrator", "child"] as const;
export type McpRole = (typeof MCP_ROLES)[number];

/** 実行環境。`node.bind`（紐付けコード）は Desktop の子だけが使う（FR_032）。 */
export type McpRuntime = "cli" | "desktop";

/** 接続元のロールが MCP で公開するロールか。境界から来た値は、必ずこれで検査する。 */
export const isMcpRole = (role: unknown): role is McpRole =>
  typeof role === "string" && (MCP_ROLES as readonly string[]).includes(role);

export interface ToolDefinition {
  /** MCP のツール名。操作名の `.` を `_` に置き換えたもの。 */
  readonly name: string;
  readonly operation: DaemonOperation;
  readonly description: string;
}

/** MCP のどちらかのロールが持つ操作。人間用の操作はここに含まれない。 */
type McpOperation = RoleOperation<McpRole>;

/** 操作ごとの説明。`McpOperation` を網羅しないと型エラーになる。 */
const DESCRIPTIONS: Readonly<Record<McpOperation, string>> = {
  "node.spawn":
    "ブリーフ（目的・受け入れ基準・作業範囲・依存関係）から子を生成する。受け付け結果を即座に返す",
  "node.send": "稼働中の子へ追加指示を送る。届いたかどうかは結果で確認する",
  "node.stop": "子を停止する。graceful（穏当）か immediate（即時）を選ぶ",
  "inbox.fetch": "受信箱を取得する。優先度・依存関係・時刻の順。detail と limit で量を絞れる",
  "tree.list": "木の一覧表を取得する",
  "decision.present": "選択肢と自由入力欄を持つ判断要求を人間に提示する。回答は受信箱に届く",
  "node.split": "脱線部分を新しい子へ移し、元の子を本筋に戻すか停止する",
  "scope.decide": "子の範囲の拡張要求を承認・却下・切り出しのいずれかで判定する",
  "node.review": "子の完了報告を受理するか差し戻す",
  "node.reclaimPreview": "回収の事前確認。何が回収されるかを示す",
  "node.reclaim": "事前確認で示した対象を回収する。実行時に条件を再判定する",
  "node.capabilities": "ノードごとに可能な操作を参照する",
  "decision.get": "受信箱の項目（ref）の判断要求の内容を読む。自分の部分木のものだけ",
  "report.get": "受信箱の項目（ref）の報告の内容を読む。自分の部分木のものだけ",
  "report.progress": "進捗を親へ報告する",
  "report.decision": "判断要求を親へ出す。人間へは親を経由する",
  "report.outOfScope": "作業範囲外の課題を親へ申告する",
  "report.done": "完了を親へ報告する。受け入れ基準ごとの根拠を付ける",
  "scope.extend": "作業範囲の拡張を親へ要求する。対象と理由を添える",
  "node.bind": "紐付けコードで自分をノードの子ロールに結ぶ（Desktop のみ）",
};

/** 操作名から MCP のツール名への変換（`.` を `_` にする）。ツール名を扱う箇所はすべてこれを使う。 */
export const toolName = (op: DaemonOperation): string => op.replaceAll(".", "_");

const DESKTOP_ONLY: readonly DaemonOperation[] = ["node.bind"];

/** ロールに公開するツールの一覧。MCP のロールでなければ何も公開しない。 */
export function toolsFor(role: McpRole, runtime: McpRuntime = "cli"): readonly ToolDefinition[] {
  if (!isMcpRole(role)) return [];
  return ROLE_OPERATIONS[role]
    .filter((op) => runtime === "desktop" || !DESKTOP_ONLY.includes(op))
    .map((op) => ({ name: toolName(op), operation: op, description: DESCRIPTIONS[op] }));
}

/** 編集距離（綴りの近い名前の候補を出すため）。 */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[b.length] as number;
}

/** ツール名を、そのロールに公開された操作へ解決する。公開されていなければ失敗にする。 */
export function operationForTool(
  role: McpRole,
  name: string,
  runtime: McpRuntime = "cli",
): Result<DaemonOperation> {
  if (!isMcpRole(role)) {
    return {
      ok: false,
      error: failure(
        "role_not_exposed",
        `ロール ${String(role)} には MCP のツールを公開していない`,
        `接続のロールを確認する（${MCP_ROLES.join(" / ")} のみ）`,
      ),
    };
  }
  const tools = toolsFor(role, runtime);
  const tool = tools.find((t) => t.name === name);
  if (tool !== undefined) return ok(tool.operation);
  const near = tools
    .map((t) => ({ name: t.name, d: distance(name, t.name) }))
    .filter((c) => c.d <= 2)
    .sort((x, y) => x.d - y.d || (x.name < y.name ? -1 : 1))
    .slice(0, 3)
    .map((c) => c.name);
  const base = [
    "tools/list で、このロールに公開されたツールを確認する",
    "必要な操作は親（統合セッション）に依頼する",
  ] as const;
  const next: [string, ...string[]] =
    near.length > 0 ? [`もしかして: ${near.join(", ")}`, ...base] : [...base];
  return {
    ok: false,
    error: failure(
      "tool_not_exposed",
      `ツール ${name} は ${role} ロールに公開されていない`,
      ...next,
    ),
  };
}
