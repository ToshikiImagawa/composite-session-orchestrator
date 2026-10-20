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
  "report.progress": "進捗を親へ報告する",
  "report.decision": "判断要求を親へ出す。人間へは親を経由する",
  "report.outOfScope": "作業範囲外の課題を親へ申告する",
  "report.done": "完了を親へ報告する。受け入れ基準ごとの根拠を付ける",
  "scope.extend": "作業範囲の拡張を親へ要求する。対象と理由を添える",
  "node.bind": "紐付けコードで自分をノードの子ロールに結ぶ（Desktop のみ）",
};

const toolName = (op: DaemonOperation): string => op.replaceAll(".", "_");

/** ロールに公開するツールの一覧。 */
export function toolsFor(role: McpRole): readonly ToolDefinition[] {
  return ROLE_OPERATIONS[role].map((op) => ({
    name: toolName(op),
    operation: op,
    description: DESCRIPTIONS[op],
  }));
}

/** ツール名を、そのロールに公開された操作へ解決する。公開されていなければ失敗にする。 */
export function operationForTool(role: McpRole, name: string): Result<DaemonOperation> {
  const tool = toolsFor(role).find((t) => t.name === name);
  if (tool === undefined) {
    return {
      ok: false,
      error: failure(
        "tool_not_exposed",
        `ツール ${name} は ${role} ロールに公開されていない`,
        "tools/list で、このロールに公開されたツールを確認する",
        "必要な操作は親（統合セッション）に依頼する",
      ),
    };
  }
  return ok(tool.operation);
}
