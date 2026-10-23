/**
 * ロール別のツール定義（NFR_004）。公開する操作は core の `ROLE_OPERATIONS` を唯一の情報源とする。
 * MCP で公開するのは統合と子だけで、人間用の操作（最終削除を含む）は含めない（DC_003）。
 *
 * 入力の検証は `schemas.ts`（zod）。
 */
import {
  type DaemonOperation,
  failure,
  LIMITS,
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
    "子を生成する。parentId は、自分の ID（起動の指示の先頭か、tree_list の self 列が「あなた」の行で分かる）か、子孫の ID を、短縮しないでそのまま渡す（作業ツリーのディレクトリ名は ID ではない）。引数: parentId・role・objective（目的）・acceptanceCriteria（受け入れ基準）・scope（writableLocations・forbiddenLocations は作業ツリー内の相対パス、allowedCommands）・dependsOn（省略可）。作業ツリーとブランチは指定しない（システムが親のブランチから決める）。結果は { nodeId, status: running か pending, waitingFor? }（依存先が未完了なら pending で、待っている先行ノードを waitingFor に示す）",
  "node.send":
    "稼働中の子へ追加指示を送る。結果は { status: queued, duplicate }（受け付けた。duplicate は同じ要求の重複。届いたかは受信箱・状態で確認する）",
  "node.stop":
    "子を停止する。mode は graceful（穏当）か immediate（即時）。graceMs（1〜3600000 ミリ秒の整数）は graceful のときだけ指定でき、省略すると既定の猶予になる",
  "inbox.fetch":
    "受信箱を取得する。優先度・依存関係・時刻の順（中間統合ノードの配下の要約 digest は、配下の未解決の項目の最高の優先度の帯に並ぶ）。detail と limit で量を絞れる",
  "tree.list":
    "木の一覧表を取得する。self 列が「あなた」の行が、自分のノード（起動した子は、自分の ID が起動の指示の先頭にも書いてある）",
  "decision.present": `選択肢と自由入力欄を持つ判断要求を人間に提示する。pauseNodeIds で、判断待ちの間に止める子（自分の子孫。ID は、起動の指示の先頭か tree_list に出たものを、短縮しないでそのまま渡す）を指定できる。未回答の判断要求は 1 ノードにつき ${LIMITS.openDecisionsPerNode} 件まで（再開後の要求を数える。超えると tooManyOpenDecisions）。回答は受信箱に届く`,
  "node.split":
    "脱線部分を新しい子へ移す。ID は、起動の指示の先頭か tree_list に出たものを、短縮しないでそのまま渡す。引数: nodeId・keep（mainline か stop。元の子を本筋に戻すか停止するか）と、新しい子のブリーフ（objective・acceptanceCriteria・scope・dependsOn）",
  "scope.decide":
    "子の範囲の拡張要求（extensionId）を承認（approve）・却下（reject）・切り出し（split）のいずれかで判定する。拡張の発生元のノードが自分の子孫のときだけ使える",
  "node.review":
    "子の完了報告を受理（accept）するか差し戻す（reject）。reject には feedback（理由）が必須で、accept では任意",
  "node.reclaimPreview":
    "回収の事前確認。結果は { reclaimable, unmet（満たしていない条件）, blockers（原因のノード・プロセス）}",
  "node.reclaim": "事前確認で示した対象を回収する。実行時に条件を再判定する",
  "node.capabilities": "ノードごとに可能な操作を参照する",
  "decision.get": "受信箱の項目（ref）の判断要求の内容を読む。自分の部分木のものだけ",
  "report.get": "受信箱の項目（ref）の報告の内容を読む。自分の部分木のものだけ",
  "report.progress": `進捗を親へ報告する。進捗・範囲外の報告は 1 ノードにつき ${LIMITS.reportsPerNode} 件まで（再開後の報告を数える。超えると tooManyReports。完了報告は数えない）`,
  "report.decision": `判断要求を親へ出す。人間へは親を経由する。未回答の判断要求は 1 ノードにつき ${LIMITS.openDecisionsPerNode} 件まで（再開後の要求を数える。超えると tooManyOpenDecisions）`,
  "report.outOfScope": `作業範囲外の課題を親へ申告する。進捗・範囲外の報告は 1 ノードにつき ${LIMITS.reportsPerNode} 件まで（再開後の報告を数える。超えると tooManyReports）`,
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
