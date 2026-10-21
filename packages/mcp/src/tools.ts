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
    "子を生成する。引数: parentId・role・objective（目的）・acceptanceCriteria（受け入れ基準）・scope（writableLocations・forbiddenLocations・allowedCommands）・dependsOn（省略可）。作業ツリーとブランチは指定しない（システムが親のブランチから決める）。受け付け結果を即座に返す",
  "node.send":
    '稼働中の子へ追加指示を送る。結果は { status: "queued" }（受け付けた。届いたかは受信箱・状態で確認する）',
  "node.stop":
    "子を停止する。mode は graceful（穏当）か immediate（即時）。graceMs（1〜3600000 ミリ秒の整数）は graceful のときだけ指定でき、省略すると既定の猶予になる",
  "inbox.fetch": "受信箱を取得する。優先度・依存関係・時刻の順。detail と limit で量を絞れる",
  "tree.list": "木の一覧表を取得する",
  "decision.present":
    "選択肢と自由入力欄を持つ判断要求を人間に提示する。pauseNodeIds で、判断待ちの間に止める子（自分の子孫）を指定できる。回答は受信箱に届く",
  "node.split":
    "脱線部分を新しい子へ移す。引数: nodeId・keep（mainline か stop。元の子を本筋に戻すか停止するか）と、新しい子のブリーフ（objective・acceptanceCriteria・scope・dependsOn）",
  "scope.decide":
    "子の範囲の拡張要求（extensionId）を承認（approve）・却下（reject）・切り出し（split）のいずれかで判定する",
  "node.review":
    "子の完了報告を受理（accept）するか差し戻す（reject）。reject には feedback（理由）が必須で、accept では任意",
  "node.reclaimPreview": "回収の事前確認。何が回収されるかを示す",
  "node.reclaim": "事前確認で示した対象を回収する。実行時に条件を再判定する",
  "node.capabilities": "ノードごとに可能な操作を参照する",
  "decision.get": "受信箱の項目（ref）の判断要求の内容を読む。自分の部分木のものだけ",
  "report.get": "受信箱の項目（ref）の報告の内容を読む。自分の部分木のものだけ",
  "report.progress": "進捗を親へ報告する",
  "report.decision": "判断要求を親へ出す。人間へは親を経由する",
  "report.outOfScope": "作業範囲外の課題を親へ申告する",
  "report.done": "完了を親へ報告する。受け入れ基準ごとの根拠を付ける",
  "scope.extend":
    "作業範囲の拡張を親へ要求する。target は { kind: write（書き込み可能な場所の追加）か command（許可するコマンドの追加）, value } で、理由（reason）を添える。未判定の要求は 10 件まで。結果の extensionId は、親の判定（scope_decide）の対象になる",
};

/** 操作名から MCP のツール名への変換（`.` を `_` にする）。ツール名を扱う箇所はすべてこれを使う。 */
export const toolName = (op: DaemonOperation): string => op.replaceAll(".", "_");

/** ロールに公開するツールの一覧。MCP のロールでなければ何も公開しない。 */
export function toolsFor(role: McpRole): readonly ToolDefinition[] {
  if (!isMcpRole(role)) return [];
  return ROLE_OPERATIONS[role].map((op) => ({
    name: toolName(op),
    operation: op,
    description: DESCRIPTIONS[op],
  }));
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
export function operationForTool(role: McpRole, name: string): Result<DaemonOperation> {
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
  const tools = toolsFor(role);
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
