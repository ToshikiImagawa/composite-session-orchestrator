/**
 * daemon 窓口の契約型と Result 型（NFR_003, NFR_004, NFR_010）。I/O を持たない型と純粋関数のみ。
 * `mcp`・`cli` は daemon に依存せず、この契約を通して 127.0.0.1 の窓口を呼ぶ（design 3 章）。
 *
 * 仮置きの範囲: 操作名は spec 4.1 の操作一覧に対応する仮の名前で、引数・結果の型は最小限
 * （識別子と主要な項目のみ）。各操作の実装タスクで確定する。境界での値の検証（zod など）は将来課題。
 */

import type { Brief } from "./brief.js";
import type { ExtensionTarget, ReportEvidence, ReportKind } from "./events.js";
import type { InboxItem } from "./inbox.js";
import type { NodeRole, NodeState } from "./index.js";
import type { Blocker, UnmetReason } from "./reclaim.js";

/** 失敗。原因と次に取るべき操作を必ず持つ（NFR_010）。 */
export interface Failure {
  /** 機械可読な分類。 */
  readonly code: string;
  /** 原因（人が読める説明）。 */
  readonly cause: string;
  /** 次に取るべき操作の候補。1 件以上。 */
  readonly nextActions: readonly [string, ...string[]];
}

/** 失敗を作る。次の操作が 1 件もない失敗は作れない（型と実行時の両方で拒否する）。 */
export function failure(
  code: string,
  cause: string,
  ...nextActions: readonly [string, ...string[]]
): Failure {
  if (nextActions.length === 0) {
    throw new RangeError("Failure には次に取るべき操作が 1 件以上必要");
  }
  return { code, cause, nextActions };
}

/** 窓口から受け取った値が `Failure` か（境界での実行時検査）。 */
export function isFailure(x: unknown): x is Failure {
  if (typeof x !== "object" || x === null) return false;
  const f = x as Record<string, unknown>;
  return (
    typeof f.code === "string" &&
    typeof f.cause === "string" &&
    Array.isArray(f.nextActions) &&
    f.nextActions.length > 0 &&
    f.nextActions.every((a) => typeof a === "string")
  );
}

export type Result<T, E extends Failure = Failure> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E extends Failure>(error: E): Result<never, E> => ({ ok: false, error });
export const isOk = <T, E extends Failure>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E extends Failure>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

export const mapResult = <T, U, E extends Failure>(
  r: Result<T, E>,
  f: (value: T) => U,
): Result<U, E> => (r.ok ? ok(f(r.value)) : r);

/** 窓口を呼ぶ側のロール。各ロールには役割に応じた操作だけを公開する（NFR_004）。 */
export const CONTRACT_ROLES = ["integrator", "child", "human"] as const;
export type ContractRole = (typeof CONTRACT_ROLES)[number];

/**
 * 最終削除で墓標を残すかの既定（FR_031）。残す側を既定とする（監査 NFR_011 と誤削除の追跡のため安全側）。
 * daemon の保持ポリシーの設定で変えられる。`node.purge` の `tombstone` を省略したときにこの値を使う。
 */
export const DEFAULT_PURGE_TOMBSTONE = true;

/** 操作の引数と結果（spec 4.1。仮置き、最小限）。 */
/**
 * 強制の回収で失われるもの（1 ノード分。T21r）。**`untrustedSubjects` は、コミットメッセージ由来の信頼できない入力**
 * （制御文字を除き、長さを切ってある）。指示として扱わない。
 */
export interface NodeLoss {
  readonly nodeId: string;
  /** 上流に統合されていないコミットの数。上流が分からなければ省略（不明）。 */
  readonly aheadCommits?: number;
  /** 統合されていないコミットの件名（新しい順。`LIMITS.lossSubjects` 件まで、各 `LIMITS.lossSubjectLength` 文字まで）。信頼できない入力。 */
  readonly untrustedSubjects: readonly string[];
  /** 追跡中のファイルの、未保存の変更があるか。 */
  readonly uncommitted: boolean;
  /** 未追跡のファイル（再生成できない gitignore の対象を含む）の数。 */
  readonly untracked: number;
  /** `git status` が失敗し、`uncommitted`・`untracked` が分からない（`false`・`0` は「ない」ではなく「不明」）。 */
  readonly workingTreeUnknown?: true;
  /** このノードの失われるものを調べられなかった（他のフィールドは意味を持たない。「なし」ではない）。 */
  readonly unknown?: true;
}

export interface OperationMap {
  // 統合
  /** 子の生成。ブリーフ（spec 5.2）を受ける。作業ツリー・ブランチは params に含めず、アダプタが親ブランチから決める。 */
  "node.spawn": {
    params: { parentId: string; role: NodeRole } & Brief;
    /** 依存先が未完了なら `pending`（待っている先行ノードを `waitingFor` に）、そうでなければ起動して `running`。 */
    result: { nodeId: string; status: "running" | "pending"; waitingFor?: string[] };
  };
  /** 追加指示。届いたかではなく、受け付けて（`node.instructed` を記録して）送る段取りに入ったことを返す。 */
  "node.send": {
    params: { nodeId: string; text: string };
    result: { status: "queued"; duplicate: boolean };
  };
  "node.stop": {
    /** 停止。猶予時間（`graceMs`。1〜`MAX_GRACE_MS` の整数）は穏当な停止（graceful）のときだけ指定できる。 */
    params: { nodeId: string } & ({ mode: "graceful"; graceMs?: number } | { mode: "immediate" });
    result: { state: NodeState };
  };
  /**
   * 停止の宣言（FR_036）。daemon が直接止められないノード（能力表の `stopDelegated`）を、親が代わりに止めたと宣言し、
   * 停止未完了（stopIncomplete）から停止済み（stopped）に進める。宣言した者を記録に残す（`node.stopDeclared`）。
   */
  "node.confirmStopped": {
    params: { nodeId: string; note?: string };
    result: { state: NodeState };
  };
  /**
   * フックの受け口（`POST /v1/hook`）の `session_id` の結び付けを外す（T22-hu）。`/clear`・`--resume` で session_id が変わったときに使う。
   * 次に来た session_id に結び直す。人間と祖先の統合ノードだけ（本人の子は使えない: 盗まれたトークンで結び直させない）。
   * 結び付けがなくても成功する（`unbound: false`）。外した者を記録に残す（`node.hookUnbound`）。
   */
  "node.hookUnbind": {
    params: { nodeId: string };
    /** `duplicate`: 同じ requestId の再送で、すでに記録済み（もう一度は外さない。`unbound` は false）。 */
    result: { unbound: boolean; duplicate: boolean };
  };
  "inbox.fetch": { params: { sinceSeq?: number }; result: { items: readonly InboxItem[] } };
  "tree.list": { params: Record<string, never>; result: { table: string } };
  "decision.present": {
    params: { question: string; options: readonly string[]; pauseNodeIds?: readonly string[] };
    result: { decisionId: string };
  };
  "node.split": {
    /** 切り出し。新しい子のブリーフを受ける（役割は元のノードと同じ。作業ツリー・ブランチはアダプタが決める）。 */
    params: { nodeId: string; keep: "mainline" | "stop" } & Brief;
    result: { newNodeId: string };
  };
  "scope.decide": {
    params: { extensionId: string; decision: "approve" | "reject" | "split" };
    result: { state: NodeState };
  };
  "node.review": {
    /** 完了の判定。差し戻し（reject）には理由（feedback）が必須で、受理（accept）では任意。 */
    params: { nodeId: string } & (
      | { verdict: "accept"; feedback?: string }
      | { verdict: "reject"; feedback: string }
    );
    result: { state: NodeState };
  };
  /**
   * 回収の事前確認。結果は `assessReclaim` の結果の構造（満たしていない条件と、原因のノード・プロセス）。
   * `loss`: 強制の回収（人間が破棄を判断したあと）で失われるもの。対象と配下のノードのうち、失われるものがあるノードごと
   * （T21r）。人間が、破棄を指示する前に、内容を確かめるために使う。
   */
  "node.reclaimPreview": {
    params: { nodeId: string };
    result: {
      reclaimable: boolean;
      unmet: readonly UnmetReason[];
      blockers: readonly Blocker[];
      loss?: readonly NodeLoss[];
      /**
       * 人間のロールにだけ返す。対象と配下の、作業ツリーを持ち、ブランチの先端（最終コミット）を取れたノードの先端（nodeId → SHA。T21r-e）。
       * `node.reclaimInstruct` の `expectTips` に、そのまま渡す。取れなかったノードは載らない。
       */
      tips?: Readonly<Record<string, string>>;
    };
  };
  "node.reclaim": { params: { nodeId: string }; result: { reclaimed: readonly string[] } };
  "node.capabilities": {
    params: { nodeId: string };
    result: { operations: readonly DaemonOperation[] };
  };
  /** 受信箱の項目（`ref`）の判断要求の内容を読む。 */
  "decision.get": {
    params: { decisionId: string };
    result: {
      decisionId: string;
      nodeId: string;
      status: "open" | "answered";
      question?: string;
      options?: readonly string[];
      answer?: string;
    };
  };
  /** 受信箱の項目（`ref`）の報告の内容を読む。 */
  "report.get": {
    params: { reportId: string };
    result: {
      reportId: string;
      nodeId: string;
      kind: ReportKind;
      text: string;
      evidence?: readonly ReportEvidence[];
    };
  };
  // 子（報告は親へのみ）
  "report.progress": { params: { text: string }; result: { accepted: true } };
  "report.decision": {
    params: { question: string; options: readonly string[] };
    result: { decisionId: string };
  };
  "report.outOfScope": { params: { text: string }; result: { accepted: true } };
  "report.done": {
    params: { evidence: readonly { criterion: string; evidence: string }[] };
    result: { accepted: true };
  };
  /** 範囲の拡張要求。対象は書き込み可能な場所（`write`）かコマンド（`command`）の追加。 */
  "scope.extend": {
    params: { target: ExtensionTarget; reason: string };
    result: { extensionId: string };
  };
  // 人間（画面・コマンド）
  "decision.answer": {
    params: { decisionId: string } & ({ choice: string } | { text: string });
    result: { accepted: true };
  };
  /**
   * 破棄の判断（人間。停止したノードの成果を捨ててよいという判断）。**`expectTips`（必須。空でもよい）**: プレビュー（`node.reclaimPreview` の `tips`）で
   * 表示した、対象と配下のノードのブランチの先端（nodeId → SHA）。対象と配下の停止したノードの今の先端と照合し、1 つでも違えば、何も記録せず
   * `tipMismatch`。表示した先端がない（取れなかった）ノードの先端が、今は取れるときも `tipMismatch`。記録した先端は、強制の回収の直前にも照合する（T21r-e）。
   */
  "node.reclaimInstruct": {
    params: { nodeId: string; expectTips: Readonly<Record<string, string>> };
    result: { accepted: true };
  };
  /**
   * 最終削除（FR_031）。最上位の木単位。`tombstone`: 削除後に 1 行の墓標（タイトル、結果、最終コミット、日付）を残すか。
   * 省略時は保持ポリシーの既定に従う（`DEFAULT_PURGE_TOMBSTONE` = 残す。daemon の設定で変えられる）。
   * `expectNodeIds`: 事前確認（`node.purgePreview`）で見せた、削除される木のノード（T23-d）。省略すると照合しない。指定したとき、いま
   * 削除される木のノードの集合と違えば（見せたあとで、木が変わった）、何も消さずに `purgeStale` で失敗する。
   */
  "node.purge": {
    params: { nodeId: string; tombstone?: boolean; expectNodeIds?: readonly string[] };
    result: { purged: readonly string[] };
  };
  /**
   * `node.purge` の事前確認。削除される木（ノード ID）、木全体のアーカイブ日、経過日数、保持期間、墓標に残るタイトルを返す。
   * 実行できないときは、理由を `blockers`（構造化）に列挙する（保持期間・残りのログを畳み込めない〔pauseNodeIds など〕）。
   * 最上位の木でない・アーカイブでない・木の外からの依存（`dependedOn`）は、失敗として返す。何も変えない。
   */
  "node.purgePreview": {
    params: { nodeId: string };
    result: {
      nodeIds: readonly string[];
      archivedAt: string;
      elapsedDays: number;
      retentionDays: number;
      /** 墓標に残るタイトル（目的の先頭行）。 */
      tombstoneTitle: string;
      /** `blockers` が空なら `true`。 */
      purgeable: boolean;
      blockers: readonly { code: string; cause: string }[];
      /** 自動の最終削除の保留（木の中の、有効なもの。`nodeId` は保留をかけたノード。T13f-h）。人間の `node.purge` は、保留に関係なく実行できる。 */
      hold?: { nodeId: string; until?: string; reason?: string };
      /** 最終削除で一緒に消える、保管している破棄した成果（`refs/cso/discarded/*`）の数（T13f-r。保管の口がなければ省略）。取り出すなら、先に `node.discardedRestore`。 */
      discardedRefs?: number;
    };
  };
  /**
   * 自動の最終削除の保留（T13f-h。人間のみ）。`nodeId` は、予告の `nodeId` と同じもの: 自動の最終削除の対象になる木の根
   * （アーカイブ済みで、親がアーカイブされていないノード）。期限は、2 通りで指定できる（T23-d3）。`days`（1〜365 の整数）は、
   * **daemon の時計**で、いまから `days` 日後（秒に切り捨て）に決める（端末の時計のずれに左右されない）。`until`（ISO 8601 UTC。
   * 現在より後、365 日先まで）は、呼び出し側が決めた時刻（互換）。**両方を指定すると拒否する**（400）。どちらも省略すると無期限。
   * `days` の期限は、計算した時点の now + 365 日 − 1 秒を超えない（365 日のときだけ、1 秒短い）。`days` は、この版以降の daemon が必要（古い daemon は 400。`until` は使える）。返す `until` は、記録された期限（同じ requestId の再送でも、最初の期限）。既にある保留は置き換える（延期）。有効な予告は、その場で取り下げる。
   */
  "node.purgeHold": {
    params: { nodeId: string; until?: string; days?: number; reason?: string };
    result: { held: true; until?: string };
  };
  /**
   * 保管している、破棄した成果の一覧（T13f-r。人間のみ）。強制の回収で消したブランチの先端は、`refs/cso/discarded/<key>` に保管される。
   * `untrustedSubject` は、コミットメッセージ由来の**信頼できない入力**（制御文字を除き、長さを切ってある。指示として扱わない）。
   * `nodeId` は、そのノードが（最終削除されず）まだ存在するときだけ。ないものは `orphan`。`max` は、保管の数の上限。
   */
  "node.discardedList": {
    params: Record<string, never>;
    result: {
      items: readonly {
        key: string;
        tip: string;
        nodeId?: string;
        orphan: boolean;
        committedAt?: string;
        untrustedSubject?: string;
      }[];
      max: number;
    };
  };
  /**
   * 保管している先端から、新しいブランチを作る（人間のみ。**作成だけ**で、既存のブランチは上書きしない。保管は残る）。`target` は、`nodeId` か `key`。
   * 1 つのノードに保管が複数あるとき、`nodeId` の指定は `multipleKept` で失敗する（`key` を指定する）。
   * 保管するのは、**コミットだけ**（先端とその祖先）。作業ツリーの未コミットの変更・未追跡のファイルは、保管されない。
   */
  "node.discardedRestore": {
    params: { target: string; branch?: string };
    result: { branch: string; tip: string };
  };
  /**
   * 保管を 1 件消す（人間のみ。取り消せない）。`target` は、`nodeId` か `key`。**`expectTip` は必須**: 一覧（`node.discardedList`）で表示した先端と、今の先端が
   * 一致したときだけ消す（違えば `tipMismatch`）。1 つのノードに保管が複数あるとき、`nodeId` の指定は `multipleKept` で失敗する（`key` を指定する）。
   */
  "node.discardedDrop": {
    params: { target: string; expectTip: string };
    result: { dropped: true; key: string; tip: string };
  };
  /** 保留の解除（人間のみ。冪等）。解除後は、保持期間と予告の条件を、改めて満たすまで消えない（予告から出し直す）。 */
  "node.purgeRelease": { params: { nodeId: string }; result: { released: true } };
}

export type DaemonOperation = keyof OperationMap;

/** ロールごとに公開する操作（NFR_004）。`node.purge`・`node.purgePreview` は人間のコマンドだけ（DC_003）。 */
export const ROLE_OPERATIONS = {
  integrator: [
    "node.spawn",
    "node.send",
    "node.stop",
    "node.confirmStopped",
    "node.hookUnbind",
    "inbox.fetch",
    "tree.list",
    "decision.present",
    "node.split",
    "scope.decide",
    "node.review",
    "node.reclaimPreview",
    "node.reclaim",
    "node.capabilities",
    "decision.get",
    "report.get",
  ],
  child: ["report.progress", "report.decision", "report.outOfScope", "report.done", "scope.extend"],
  human: [
    "decision.answer",
    "node.confirmStopped",
    "node.hookUnbind",
    "scope.decide",
    "node.reclaimInstruct",
    "node.reclaimPreview",
    "node.purge",
    "node.purgePreview",
    "node.purgeHold",
    "node.purgeRelease",
    "node.discardedList",
    "node.discardedRestore",
    "node.discardedDrop",
  ],
} as const satisfies Record<ContractRole, readonly DaemonOperation[]>;

export type RoleOperation<R extends ContractRole> = (typeof ROLE_OPERATIONS)[R][number];

/** 操作の一覧（重複なし）。 */
export const DAEMON_OPERATIONS: readonly RoleOperation<ContractRole>[] = [
  ...new Set(CONTRACT_ROLES.flatMap((r) => ROLE_OPERATIONS[r])),
];

/** 部分木の規則: 対象は、呼び出した統合ノードの、自分自身を含まない子孫／直接の子／自分自身か子孫。 */
export type SubtreeRule = "strictDescendant" | "directChild" | "selfOrDescendant";

/** 統合ノードの、呼び出し側のノードの部分木では判定しない操作（一覧系は、呼び出し側で絞る）。 */
type NonSubtreeIntegratorOperation = "inbox.fetch" | "tree.list";
export type SubtreeOperation = Exclude<RoleOperation<"integrator">, NonSubtreeIntegratorOperation>;

/**
 * 統合ノードの、ノード・判断・報告を指す操作の、部分木の規則（spec 4.1）。対象は、`caller` の部分木に限る。
 * - `strictDescendant`: 自分自身を含まない子孫。自分の停止・自分への指示は、親か人間だけができる。
 * - `directChild`: 完了の判定（受理・差し戻し）は、直接の親だけ。
 * - `selfOrDescendant`: 自分か子孫。子の生成（`parentId`）と、記録（判断・報告）の読み取り（記録のノード）。
 * `decision.present` は `pauseNodeIds` のすべてに、`node.spawn` は `parentId` に適用する。
 * 型で網羅を保証する（統合ノードの操作を足すと、ここか `INTEGRATOR_OPERATION_CLASS` の例外に足すまでコンパイルできない）。
 * 適用は窓口（daemon の `authorize`）。
 */
export const SUBTREE_RULES: Readonly<Record<SubtreeOperation, SubtreeRule>> = {
  "node.spawn": "selfOrDescendant",
  "node.send": "strictDescendant",
  "node.stop": "strictDescendant",
  "node.confirmStopped": "strictDescendant",
  "node.hookUnbind": "strictDescendant",
  "node.split": "strictDescendant",
  "node.review": "directChild",
  "node.reclaimPreview": "strictDescendant",
  "node.reclaim": "strictDescendant",
  "node.capabilities": "strictDescendant",
  "decision.present": "strictDescendant",
  "scope.decide": "strictDescendant", // 対象は拡張の発生元のノード（拡張要求の `nodeId`）。人間は全ノード
  "decision.get": "selfOrDescendant",
  "report.get": "selfOrDescendant",
};

export const SUBTREE_SCOPED_OPERATIONS = Object.keys(SUBTREE_RULES) as readonly SubtreeOperation[];

/**
 * 統合ノードの操作の分類（型で網羅）。`subtree`: `SUBTREE_RULES` で判定する。`callerFiltered`: 呼び出し側の部分木に
 * 絞った結果だけを返す（ハンドラの責務。`visibleState` を使う）。`denied`: 発生元の記録がまだないので、記録ができる
 * までは統合ロールからの呼び出しを拒否する（`scope.decide`。フェイルクローズ）。
 */
export const INTEGRATOR_OPERATION_CLASS: Readonly<
  Record<RoleOperation<"integrator">, "subtree" | "callerFiltered" | "denied">
> = {
  "node.spawn": "subtree",
  "node.send": "subtree",
  "node.stop": "subtree",
  "node.confirmStopped": "subtree",
  "node.hookUnbind": "subtree",
  "inbox.fetch": "callerFiltered",
  "tree.list": "callerFiltered",
  "decision.present": "subtree",
  "node.split": "subtree",
  "scope.decide": "subtree",
  "node.review": "subtree",
  "node.reclaimPreview": "subtree",
  "node.reclaim": "subtree",
  "node.capabilities": "subtree",
  "decision.get": "subtree",
  "report.get": "subtree",
};

/**
 * 窓口への要求の封筒。`requestId` で冪等にする（NFR_003）。`requestId` は `isSafeId` の形式（英数字で始まり、
 * 英数字と `.` `_` `:` `-` のみ、128 文字以下）。窓口（daemon）と cli が同じ規則で検査する。
 * ロールが持たない操作は型で表せない。
 */
export type DaemonRequest<R extends ContractRole = ContractRole> = {
  [Role in R]: {
    [Op in RoleOperation<Role>]: {
      readonly requestId: string;
      readonly role: Role;
      /** 呼び出したノード。クライアントは指定せず、daemon が認証（ノード専用の資格情報）で決めて付ける。 */
      readonly caller?: { readonly nodeId: string };
      readonly operation: Op;
      readonly params: OperationMap[Op]["params"];
    };
  }[RoleOperation<Role>];
}[R];

/** 窓口からの応答。成功も失敗も Result にそろえる。 */
export type DaemonResponse<Op extends DaemonOperation = DaemonOperation> = Result<
  OperationMap[Op]["result"]
>;
