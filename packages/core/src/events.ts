/**
 * イベント型（`OrchEvent`）と、イベント列の畳み込みによる状態の導出（純粋関数）。
 * PRD: NFR_002, NFR_003, NFR_011 / design 5 章
 *
 * - 状態はイベント列からのみ導出する。`foldEvents` は `seq` の昇順に畳み込むため、入力順に依存しない。
 * - 同じ `requestId` のイベントは重複として無視する（冪等）。内容が違えば `requestIdConflict` で拒否する。
 * - T02（木の不変条件）・T03（遷移表）と矛盾するイベントは、`seq` つきの失敗で拒否する。
 *   daemon は追記の前に `applyEvent` で検査する。
 * - 壊れたイベント（null、型の違う payload など）でも例外を出さず、失敗（`invalidPayload` など）を返す。
 * - 未知の `type` は拒否する（無視しない）。時刻と `seq` は daemon が付与する（引数で受ける）。
 *
 * 計算量: `foldEvents` は内部で可変の下書きに畳み込み、出力の前に凍結する（O(n log n)）。
 * `applyEvent` は状態から下書きを作り直すため O(n)。大きなログは、スナップショットの状態から
 * `foldEvents(以降のイベント, スナップショット)` で再開する。
 *
 * 責務の境界: 状態遷移と判断要求（`node.stateChanged` の `requestDecision` と `decision.requested`）を
 * 一組として発行するのは daemon。イベントの発行者（actor）とイベントの種類の整合は、窓口のロール別の
 * 操作表（NFR_004）が保証し、ここでは検査しない。
 */

import { briefProblem } from "./brief.js";
import { type Failure, failure, ok, type Result } from "./contract.js";
import { isSafeId, pauseNodeIdsProblem } from "./ids.js";
import { type InboxItem, isValidInboxTime } from "./inbox.js";
import { INBOX_KINDS, type InboxKind } from "./inbox-kinds.js";
import type { NodeRole, NodeState } from "./index.js";
import { isBoundedText, LIMITS } from "./limits.js";
import type { Scope, ScopeViolationReason } from "./scope.js";
import {
  COMPLETED_STATES,
  type NodeEvent,
  type TransitionFailureCode,
  transition,
} from "./transition.js";

export type Actor =
  | { readonly nodeId: string }
  | { readonly human: true }
  | { readonly system: true };

/** イベントの本体（`type` ごとに `payload` の型が決まる）。 */
export type EventBody =
  | {
      readonly type: "node.created";
      readonly payload: {
        readonly nodeId: string;
        readonly role: NodeRole;
        readonly parentId: string | null;
        readonly dependsOn: readonly string[];
        /** ブリーフ（spec 5.2）。子の生成（spawn・split）で付く。根や以前の記録では省略。付けるなら 3 つとも付ける。 */
        readonly objective?: string;
        readonly acceptanceCriteria?: readonly string[];
        readonly scope?: Scope;
      };
    }
  | {
      /** 状態の変化。payload は遷移を起こした `NodeEvent`（遷移先は T03 の表で決まる）。 */
      readonly type: "node.stateChanged";
      readonly payload: { readonly nodeId: string; readonly event: NodeEvent };
    }
  | {
      /** 範囲違反の記録。拒否した操作も残す（NFR_011）。状態は変えない。 */
      readonly type: "scope.violation";
      readonly payload: {
        readonly nodeId: string;
        readonly reason: ScopeViolationReason;
        readonly subject: string;
      };
    }
  | {
      /** 受信箱への追加。`seq`・`at` は envelope から、依存先（`dependsOn`）はノードの記録から取る。 */
      readonly type: "inbox.added";
      readonly payload: {
        readonly id: string;
        readonly kind: InboxKind;
        readonly nodeId: string;
        /** 短い要約（`LIMITS.summary` 文字以下）。 */
        readonly summary?: string;
        /** 参照 ID（`decisionId`・`reportId` など）。 */
        readonly ref?: string;
      };
    }
  | {
      /** 停止の観測の記録（猶予内に止まったか、`interrupt()` に落ちたか、`abort()` したか）。状態は変えない。 */
      readonly type: "node.stopObserved";
      readonly payload: {
        readonly nodeId: string;
        readonly outcome: StopOutcome;
        /** 対応する停止の試行（`stop`・`retryStop` の `node.stateChanged`）のイベントの `seq`。 */
        readonly stopSeq: number;
        /** そのとき有効だった猶予（ミリ秒）。穏当な停止のとき。 */
        readonly graceMs?: number;
      };
    }
  | {
      /** ツール呼び出しの拒否のうち、範囲違反でないもの（許可していないツール）。記録のみ。受信箱には載せない（NFR_011）。 */
      readonly type: "node.toolDenied";
      readonly payload: { readonly nodeId: string; readonly tool: string };
    }
  | {
      /** 子の予期しない終了（停止の要求なしに終わった）。記録のみ。状態の扱いは別のイベントで決める。 */
      readonly type: "node.exited";
      readonly payload: { readonly nodeId: string; readonly reason: string };
    }
  | {
      /** 報告の保存（進捗・完了・範囲外の申告）。記録のみ。受信箱の項目は `ref` で指す。 */
      readonly type: "report.added";
      readonly payload: {
        readonly reportId: string;
        readonly nodeId: string;
        readonly kind: ReportKind;
        readonly text: string;
        /** 完了報告の、受け入れ基準ごとの根拠（FR_022）。完了（`done`）のときだけ。 */
        readonly evidence?: readonly ReportEvidence[];
      };
    }
  | {
      readonly type: "decision.requested";
      readonly payload: {
        readonly decisionId: string;
        readonly nodeId: string;
        /** 判断を求める内容。 */
        readonly question?: string;
        readonly options?: readonly string[];
        /** 判断待ちの間に止める子。要求したノードの子孫（自分を含まない）。止める操作は別のイベントで行う。 */
        readonly pauseNodeIds?: readonly string[];
      };
    }
  | {
      /** 子の範囲の拡張要求（FR_015）。対象と理由を添える。範囲そのものは変えない（判定の結果は別のイベントで反映する）。 */
      readonly type: "scope.extensionRequested";
      readonly payload: {
        readonly extensionId: string;
        readonly nodeId: string;
        readonly target: ExtensionTarget;
        readonly reason: string;
      };
    }
  | {
      /** 拡張要求の判定: 承認・却下・切り出し。先に確定した判定だけを残し、再判定は拒否する。 */
      readonly type: "scope.extensionDecided";
      readonly payload: {
        readonly extensionId: string;
        readonly decision: ExtensionDecision;
        /** 承認（approve）のとき必須: 許可した対象（要求と同じ種類）。却下・切り出しでは付けない。 */
        readonly granted?: ExtensionTarget;
      };
    }
  | {
      /** 追加指示の記録（`node.send`）。記録のみ。届ける操作はアダプタが別に行う。本文は `LIMITS.reportText` 以下。 */
      readonly type: "node.instructed";
      readonly payload: { readonly nodeId: string; readonly text: string };
    }
  | {
      /** 受信箱の項目を解決済みにする（記録のみ。項目は消えない）。解決した者は封筒の `actor`。 */
      readonly type: "inbox.resolved";
      readonly payload: { readonly itemId: string };
    }
  | {
      /** 追加指示の配送の記録（アダプタが子へ届けた）。`instructedSeq` は、対応する `node.instructed` のイベントの `seq`。記録のみ。 */
      readonly type: "node.instructionDelivered";
      readonly payload: { readonly instructedSeq: number };
    }
  | {
      /** 停止したノードの破棄の判断（spec 5.8。成果を捨てることを含む）。判断した者は封筒の `actor`。状態は変えない。 */
      readonly type: "node.discardDecided";
      readonly payload: { readonly nodeId: string };
    }
  | {
      /**
       * 最終削除（FR_031）の標識。木のノードを主語とするイベントの行は、先に物理削除されている（`EventLog.purgeTree`）。
       * 標識は、削除を監査できるようにし、`seq` が戻らないようにするために、墓標を残さないときも残す。
       * 標識に載せたノードが、まだ存在すれば拒否する（行を消さずに標識だけを足した、不整合なログ）。
       */
      readonly type: "node.purged";
      readonly payload: {
        /** 削除した木の根（最上位のノード）。 */
        readonly rootId: string;
        /** 削除した木のノード（配下から先）。 */
        readonly nodeIds: readonly string[];
        /** 木全体のアーカイブ日（ISO 8601 UTC）。 */
        readonly archivedAt: string;
        /** 墓標（残すとき）: タイトル・結果・最終コミット（記録があるときだけ）。日付は標識の `at`。 */
        readonly tombstone?: PurgeTombstone;
      };
    }
  | {
      readonly type: "decision.answered";
      readonly payload: { readonly decisionId: string; readonly answer: string };
    };

/** 最終削除の墓標（1 行の要約）。 */
export interface PurgeTombstone {
  readonly title: string;
  readonly outcome: "verified" | "discarded";
  readonly lastCommit?: string;
}

/** 最終削除の標識の記録。 */
export interface PurgeRecord {
  readonly seq: number;
  readonly at: string;
  readonly actor: Actor;
  readonly rootId: string;
  readonly nodeIds: readonly string[];
  readonly archivedAt: string;
  readonly tombstone?: PurgeTombstone;
}

/** 報告の種類。`review`: 完了の判定（受理）のコメント（`node.review` の `feedback`）。 */
export const REPORT_KINDS = ["progress", "done", "outOfScope", "failure", "review"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];
const isReportKind = (x: unknown): x is ReportKind =>
  typeof x === "string" && (REPORT_KINDS as readonly string[]).includes(x);

export interface ReportEvidence {
  readonly criterion: string;
  readonly evidence: string;
}

export const STOP_OUTCOMES = ["withinGrace", "interrupted", "aborted"] as const;
/** 停止の観測: 猶予内に result が来た／猶予を超えて `interrupt()` に落ちた／`abort()` した。 */
export type StopOutcome = (typeof STOP_OUTCOMES)[number];
export const isStopOutcome = (x: unknown): x is StopOutcome =>
  typeof x === "string" && (STOP_OUTCOMES as readonly string[]).includes(x);

/** 穏当な停止の猶予の上限（ミリ秒、1 時間）。 */
export const MAX_GRACE_MS = 3_600_000;
const isGraceMs = (x: unknown): x is number =>
  typeof x === "number" && Number.isInteger(x) && x >= 1 && x <= MAX_GRACE_MS;

export type OrchEvent = {
  /** daemon が採番する単調増加の番号。 */
  readonly seq: number;
  /** ISO 8601。daemon が付与する。 */
  readonly at: string;
  /** 冪等性のための要求識別子（NFR_003）。 */
  readonly requestId: string;
  readonly actor: Actor;
} & EventBody;

export const NODE_ROLES = [
  "integrator",
  "implement",
  "review",
  "investigate",
  "merge",
] as const satisfies readonly NodeRole[];

const SCOPE_VIOLATION_REASONS: ReadonlySet<string> = new Set([
  "forbiddenLocation",
  "outsideWritable",
  "commandNotAllowed",
  "backgroundExecution",
  "indirectExecution",
  "unparsable",
  "invalidPath",
  "invalidScope",
] satisfies ScopeViolationReason[]);

export interface NodeRecord {
  readonly id: string;
  readonly role: NodeRole;
  readonly parentId: string | null;
  readonly dependsOn: readonly string[];
  readonly state: NodeState;
  /** ブリーフ（子の生成時に記録。根や以前の記録にはない）。完了報告の根拠の確認（FR_022）に使う。 */
  readonly objective?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly scope?: Scope;
  /** 破棄の判断（停止したノードだけ。再開すると消える）。回収の再判定の入力 `facts.discarded` の情報源。 */
  readonly discarded?: { readonly seq: number; readonly at: string; readonly by: Actor };
  /** アーカイブした時刻（`archive` のイベントの `at`）。 */
  readonly archivedAt?: string;
  /** 直近の `start`・`restart` の `seq`。未回答の判断要求の上限（`openDecisionsPerNode`）で、数える範囲の始まり。古いスナップショットにはない（0 とみなす）。 */
  readonly runStartedSeq?: number;
}

export interface DecisionRecord {
  readonly decisionId: string;
  readonly nodeId: string;
  readonly status: "open" | "answered";
  /** 要求を記録したイベントの `seq`。古いスナップショットにはない（0 とみなし、上限の数には入れない）。 */
  readonly requestedSeq?: number;
  /** 判断を求める内容（記録されていれば）。 */
  readonly question?: string;
  readonly options?: readonly string[];
  /** 判断待ちの間に止める子（要求したノードの子孫）。 */
  readonly pauseNodeIds?: readonly string[];
  /** 採用された回答（先に確定した回答）。 */
  readonly answer?: string;
  readonly answeredBy?: Actor;
  /** 後から来て却下された回答（採用された回答を伝えるために残す。FR_019）。 */
  readonly rejected: readonly {
    readonly seq: number;
    readonly answer: string;
    readonly actor: Actor;
  }[];
}

export const EXTENSION_DECISIONS = ["approve", "reject", "split"] as const;
export type ExtensionDecision = (typeof EXTENSION_DECISIONS)[number];
const isExtensionDecision = (x: unknown): x is ExtensionDecision =>
  typeof x === "string" && (EXTENSION_DECISIONS as readonly string[]).includes(x);

const EXTENSION_STATUS: Readonly<Record<ExtensionDecision, "approved" | "rejected" | "split">> = {
  approve: "approved",
  reject: "rejected",
  split: "split",
};

/** 拡張の対象: 書き込み可能な場所の追加（`write`）か、許可するコマンドの追加（`command`）。 */
export interface ExtensionTarget {
  readonly kind: "write" | "command";
  readonly value: string;
}

/** 範囲の拡張要求（FR_015）。 */
export interface ExtensionRecord {
  readonly extensionId: string;
  readonly nodeId: string;
  readonly target: ExtensionTarget;
  readonly reason: string;
  readonly status: "open" | "approved" | "rejected" | "split";
  /** 要求のイベントの `seq`。 */
  readonly requestedSeq: number;
  /** 判定のイベントの `seq` と判定者（判定済みのとき）。 */
  readonly decidedSeq?: number;
  readonly decidedBy?: Actor;
  /** 承認したときの、許可した対象。 */
  readonly granted?: ExtensionTarget;
}

export interface ViolationRecord {
  readonly seq: number;
  readonly at: string;
  readonly nodeId: string;
  readonly reason: ScopeViolationReason;
  readonly subject: string;
  readonly actor: Actor;
}

export interface ToolDenialRecord {
  readonly seq: number;
  readonly at: string;
  readonly nodeId: string;
  readonly tool: string;
  readonly actor: Actor;
}

/** 追加指示の記録。 */
export interface InstructionRecord {
  readonly seq: number;
  readonly at: string;
  readonly nodeId: string;
  readonly text: string;
  readonly actor: Actor;
  /** 配送を記録したイベント（`node.instructionDelivered`）の `seq` と時刻。ある指示が配送済み。 */
  readonly deliveredSeq?: number;
  readonly deliveredAt?: string;
}

export interface ExitRecord {
  readonly seq: number;
  readonly at: string;
  readonly nodeId: string;
  readonly reason: string;
  readonly actor: Actor;
}

export interface ReportRecord {
  readonly seq: number;
  readonly at: string;
  readonly reportId: string;
  readonly nodeId: string;
  readonly kind: ReportKind;
  readonly text: string;
  readonly evidence?: readonly ReportEvidence[];
  readonly actor: Actor;
}

export interface StopObservation {
  readonly seq: number;
  readonly at: string;
  readonly nodeId: string;
  readonly outcome: StopOutcome;
  /** 対応する停止要求（`stop`・`retryStop` の `node.stateChanged`）のイベントの `seq`。 */
  readonly stopSeq: number;
  /** そのとき有効だった猶予時間（ミリ秒）。 */
  readonly graceMs?: number;
  /** 注意: 観測の発行者の信頼性は、窓口のロール別の操作表（NFR_004）が保証する。ここでは検査しない。 */
  readonly actor: Actor;
}

/** 停止の試行（観測の対象）: 状態を `stopping` に進めた停止要求と、`retryStop`。 */
export interface StopRequestRecord {
  readonly seq: number;
  readonly nodeId: string;
  readonly kind: "stop" | "retryStop";
  readonly mode: "graceful" | "immediate";
  readonly graceMs?: number;
}

export interface OrchState {
  /** 作成順。 */
  readonly nodes: readonly NodeRecord[];
  readonly inbox: readonly InboxItem[];
  readonly decisions: readonly DecisionRecord[];
  readonly violations: readonly ViolationRecord[];
  /** 停止の試行の記録（観測の結び付け先）。 */
  readonly stopRequests: readonly StopRequestRecord[];
  /** 停止の観測の記録（猶予内に止まったかの実測。猶予の既定値の見直しに使う）。 */
  readonly stopObservations: readonly StopObservation[];
  /** 許可していないツールの拒否の記録（範囲違反ではない。受信箱には載せない）。 */
  readonly toolDenials: readonly ToolDenialRecord[];
  /** 子の予期しない終了の記録。 */
  readonly exits: readonly ExitRecord[];
  /** 保存した報告（受信箱の項目の `ref` で参照する）。 */
  readonly reports: readonly ReportRecord[];
  /** 範囲の拡張要求と判定。 */
  readonly extensions: readonly ExtensionRecord[];
  /** 追加指示の記録（時系列）。 */
  readonly instructions: readonly InstructionRecord[];
  /** 最終削除の標識（時系列。削除したノードの記録は、ログから消えている）。 */
  readonly tombstones: readonly PurgeRecord[];
  /** 最後に適用したイベントの `seq`。 */
  readonly lastSeq: number;
  /** 適用済みの要求識別子 → 内容の指紋（冪等性の判定用）。 */
  readonly requests: Readonly<Record<string, string>>;
}

export type FoldFailureCode =
  | TransitionFailureCode
  | "invalidRequestId"
  | "purgeInconsistent"
  | "seqNotIncreasing"
  | "duplicateSeq"
  | "requestIdConflict"
  | "unknownEventType"
  | "invalidPayload"
  | "invalidTree"
  | "parentNotActive"
  | "unknownDependency"
  | "dependsOnAncestor"
  | "unknownNode"
  | "dependenciesNotVerified"
  | "reclaimInvariant"
  | "duplicateInboxId"
  | "duplicateDecision"
  | "unknownDecision"
  | "unknownStopRequest"
  | "observationAlreadyRecorded"
  | "duplicateReport"
  | "unknownRef"
  | "duplicateExtension"
  | "alreadyDiscarded"
  | "unknownInboxItem"
  | "unknownInstruction"
  | "tooManyOpenExtensions"
  | "tooManyOpenDecisions"
  | "unknownExtension"
  | "extensionAlreadyDecided"
  | "invalidState";

/** どのイベント（`seq`）で拒否したかを持つ失敗。壊れたイベントで `seq` が分からないときは 0。 */
export interface FoldFailure extends Failure {
  readonly seq: number;
}

/** `applied` が `false` のときは、同じ `requestId` で同一内容の重複として無視した（状態は変わらない）。 */
export interface ApplyOutcome {
  readonly state: OrchState;
  readonly applied: boolean;
  /**
   * イベントは記録されたが、一部が無視された。`graceMsIgnored`: 停止の進行中に別の `graceMs` の停止要求が来た
   * （進行中の停止の猶予は変わらない）。
   */
  readonly ignored?: "graceMsIgnored";
}

export type ApplyResult = Result<ApplyOutcome, FoldFailure>;
export type FoldResult = Result<OrchState, FoldFailure>;

export const initialState = (): OrchState => ({
  nodes: [],
  inbox: [],
  decisions: [],
  violations: [],
  stopRequests: [],
  stopObservations: [],
  toolDenials: [],
  exits: [],
  reports: [],
  extensions: [],
  instructions: [],
  tombstones: [],
  lastSeq: 0,
  requests: {},
});

export const stateOf = (state: OrchState, nodeId: string): NodeState | undefined =>
  state.nodes.find((n) => n.id === nodeId)?.state;

// ---- 型ガード（壊れた入力でも例外を出さない） ----

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
/** 識別子（ノード・判断・報告・受信箱の項目・要求）。書き込み側でも `isSafeId` の形式に限る（読み取り側の検査と同じ規則）。 */
const isId = isSafeId;
const isIdArray = (x: unknown): x is string[] => Array.isArray(x) && x.every(isId);

function parseActor(x: unknown): Actor | undefined {
  if (!isRec(x)) return undefined;
  if (isId(x.nodeId)) return { nodeId: x.nodeId };
  if (x.human === true) return { human: true };
  if (x.system === true) return { system: true };
  return undefined;
}

/** payload の `NodeEvent` を検証し、正規化して返す。 */
function parseNodeEvent(x: unknown): NodeEvent | undefined {
  if (!isRec(x)) return undefined;
  switch (x.type) {
    case "start":
    case "requestDecision":
    case "resume":
    case "reportDone":
    case "accept":
    case "reject":
    case "stopTimeout":
    case "retryStop":
    case "confirmStopped":
    case "archive":
      return { type: x.type };
    case "stop": {
      if (x.mode !== "graceful" && x.mode !== "immediate") return undefined;
      if (x.graceMs === undefined) return { type: "stop", mode: x.mode };
      // 猶予は穏当な停止だけの設定。即時停止では指定できない。
      return x.mode === "graceful" && isGraceMs(x.graceMs)
        ? { type: "stop", mode: x.mode, graceMs: x.graceMs }
        : undefined;
    }
    case "restart":
      return typeof x.dependenciesDone === "boolean"
        ? { type: "restart", dependenciesDone: x.dependenciesDone }
        : undefined;
    case "markReclaimable":
      return typeof x.discarded === "boolean"
        ? { type: "markReclaimable", discarded: x.discarded }
        : undefined;
    default:
      return undefined;
  }
}

/** キー順に依存しない JSON。重複判定の指紋に使う。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Rec)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// ---- 下書き（内部の可変な状態） ----

interface Draft {
  nodes: NodeRecord[];
  nodeIdx: Map<string, number>;
  children: Map<string, string[]>;
  inbox: InboxItem[];
  inboxIds: Set<string>;
  decisions: DecisionRecord[];
  decisionIdx: Map<string, number>;
  violations: ViolationRecord[];
  stopRequests: StopRequestRecord[];
  stopObservations: StopObservation[];
  toolDenials: ToolDenialRecord[];
  exits: ExitRecord[];
  reports: ReportRecord[];
  reportIdx: Map<string, ReportRecord>;
  extensions: ExtensionRecord[];
  extensionIdx: Map<string, number>;
  instructions: InstructionRecord[];
  tombstones: PurgeRecord[];
  lastSeq: number;
  requests: Map<string, string>;
  /** 直前の `step` で、イベントの一部が無視されたこと（`ApplyOutcome.ignored` に渡す）。 */
  note: "graceMsIgnored" | undefined;
}

/** 受信箱の項目の `ref` が指す記録の種類。参照先のない種類（stopIncomplete など）は `ref` を持てない。violation は、拡張要求（`extensionId`）を指せる。 */
const REF_TARGET: Readonly<Record<InboxKind, "decision" | "report" | "extension" | undefined>> = {
  decision: "decision",
  answer: "decision",
  violation: "extension", // 範囲違反に起因する拡張要求（extensionId）。違反だけの項目は ref を持たない
  failure: "report",
  stopIncomplete: undefined,
  done: "report",
  progress: "report",
  info: "report",
};

/** `node.toolDenied`・`node.exited` を記録できるノードの状態（子のプロセスがありうる間）。 */
const RECORDABLE_STATES: ReadonlySet<NodeState> = new Set([
  "running",
  "waiting",
  "stopping",
  "stopIncomplete",
]);

const notRecordable = (seq: number, node: NodeRecord, what: string): Result<boolean, FoldFailure> =>
  reject(
    seq,
    "invalidTransition",
    `状態 ${node.state} のノードに ${what} は記録できない（running・waiting・stopping・stopIncomplete のとき）`,
    "ノードの状態を確認する",
  );

/** 配列の項目を検査する。`undefined`（古いスナップショットに無い項目）は空として受け入れる。壊れていれば `undefined`。 */
function arrayOf<T>(x: unknown, guard: (v: unknown) => boolean): T[] | undefined {
  if (x === undefined) return [];
  return Array.isArray(x) && x.every(guard) ? (x as T[]) : undefined;
}

const nodeShape = (n: unknown): boolean =>
  isRec(n) &&
  typeof n.id === "string" &&
  typeof n.role === "string" &&
  typeof n.state === "string" &&
  (n.parentId === null || typeof n.parentId === "string") &&
  Array.isArray(n.dependsOn);
const inboxShape = (i: unknown): boolean =>
  isRec(i) && typeof i.id === "string" && typeof i.nodeId === "string";
const decisionShape = (d: unknown): boolean =>
  isRec(d) && typeof d.decisionId === "string" && Array.isArray(d.rejected);
const violationShape = (v: unknown): boolean => isRec(v) && typeof v.nodeId === "string";
const stopRequestShape = (r: unknown): boolean =>
  isRec(r) &&
  Number.isInteger(r.seq) &&
  isId(r.nodeId) &&
  (r.kind === "stop" || r.kind === "retryStop") &&
  (r.mode === "graceful" || r.mode === "immediate") &&
  (r.graceMs === undefined || isGraceMs(r.graceMs));
const toolDenialShape = (r: unknown): boolean =>
  isRec(r) &&
  Number.isInteger(r.seq) &&
  isId(r.nodeId) &&
  typeof r.tool === "string" &&
  r.tool !== "" &&
  parseActor(r.actor) !== undefined;
const exitShape = (r: unknown): boolean =>
  isRec(r) &&
  Number.isInteger(r.seq) &&
  isId(r.nodeId) &&
  typeof r.reason === "string" &&
  parseActor(r.actor) !== undefined;
const purgeShape = (r: unknown): boolean =>
  isRec(r) &&
  Number.isInteger(r.seq) &&
  isId(r.rootId) &&
  isIdArray(r.nodeIds) &&
  typeof r.archivedAt === "string" &&
  parseActor(r.actor) !== undefined;
const reportShape = (r: unknown): boolean =>
  isRec(r) &&
  Number.isInteger(r.seq) &&
  isId(r.reportId) &&
  isId(r.nodeId) &&
  isReportKind(r.kind) &&
  typeof r.text === "string" &&
  parseActor(r.actor) !== undefined;
const extensionShape = (x: unknown): boolean =>
  isRec(x) &&
  isId(x.extensionId) &&
  isId(x.nodeId) &&
  isRec(x.target) &&
  typeof x.reason === "string" &&
  (x.status === "open" ||
    x.status === "approved" ||
    x.status === "rejected" ||
    x.status === "split") &&
  Number.isInteger(x.requestedSeq);
const instructionShape = (x: unknown): boolean =>
  isRec(x) &&
  Number.isInteger(x.seq) &&
  typeof x.at === "string" &&
  isId(x.nodeId) &&
  typeof x.text === "string" &&
  parseActor(x.actor) !== undefined;
const observationShape = (o: unknown): boolean =>
  isRec(o) &&
  Number.isInteger(o.seq) &&
  typeof o.at === "string" &&
  isId(o.nodeId) &&
  isStopOutcome(o.outcome) &&
  Number.isInteger(o.stopSeq) &&
  (o.graceMs === undefined || isGraceMs(o.graceMs)) &&
  parseActor(o.actor) !== undefined;

/** 状態から下書きを作る。状態が壊れていれば（スナップショットの破損など）`undefined`。例外は出さない。 */
function toDraft(state: OrchState): Draft | undefined {
  if (!isRec(state) || !Number.isInteger(state.lastSeq) || !isRec(state.requests)) return undefined;
  if (!Object.values(state.requests).every((v) => typeof v === "string")) return undefined;
  const nodes =
    Array.isArray(state.nodes) && state.nodes.every(nodeShape) ? state.nodes : undefined;
  const inbox =
    Array.isArray(state.inbox) && state.inbox.every(inboxShape) ? state.inbox : undefined;
  const decisions =
    Array.isArray(state.decisions) && state.decisions.every(decisionShape)
      ? state.decisions
      : undefined;
  const violations =
    Array.isArray(state.violations) && state.violations.every(violationShape)
      ? state.violations
      : undefined;
  // 古いスナップショットには無い項目なので、欠けていても受け入れる。
  const stopRequests = arrayOf<StopRequestRecord>(state.stopRequests, stopRequestShape);
  const stopObservations = arrayOf<StopObservation>(state.stopObservations, observationShape);
  const toolDenials = arrayOf<ToolDenialRecord>(state.toolDenials, toolDenialShape);
  const exits = arrayOf<ExitRecord>(state.exits, exitShape);
  const reports = arrayOf<ReportRecord>(state.reports, reportShape);
  const extensions = arrayOf<ExtensionRecord>(state.extensions, extensionShape);
  const instructions = arrayOf<InstructionRecord>(state.instructions, instructionShape);
  const tombstones = arrayOf<PurgeRecord>(state.tombstones, purgeShape);
  if (
    !nodes ||
    !inbox ||
    !decisions ||
    !violations ||
    !stopRequests ||
    !stopObservations ||
    !toolDenials ||
    !exits ||
    !reports ||
    !extensions ||
    !instructions ||
    !tombstones
  )
    return undefined;

  const d: Draft = {
    nodes: [...nodes],
    nodeIdx: new Map(),
    children: new Map(),
    inbox: [...inbox],
    inboxIds: new Set(inbox.map((i) => i.id)),
    decisions: [...decisions],
    decisionIdx: new Map(),
    violations: [...violations],
    stopRequests: [...stopRequests],
    stopObservations: [...stopObservations],
    toolDenials: [...toolDenials],
    exits: [...exits],
    reports: [...reports],
    reportIdx: new Map(reports.map((r) => [r.reportId, r])),
    extensions: [...extensions],
    extensionIdx: new Map(extensions.map((x, i) => [x.extensionId, i])),
    instructions: [...instructions],
    tombstones: [...tombstones],
    lastSeq: state.lastSeq,
    requests: new Map(Object.entries(state.requests)),
    note: undefined,
  };
  nodes.forEach((n, i) => {
    d.nodeIdx.set(n.id, i);
    if (n.parentId !== null)
      d.children.set(n.parentId, [...(d.children.get(n.parentId) ?? []), n.id]);
  });
  decisions.forEach((x, i) => {
    d.decisionIdx.set(x.decisionId, i);
  });
  return d;
}

const freezeRecord = <T extends object>(x: T): T => Object.freeze(x);

function toState(d: Draft): OrchState {
  return Object.freeze({
    nodes: Object.freeze(d.nodes),
    inbox: Object.freeze(d.inbox),
    decisions: Object.freeze(d.decisions),
    violations: Object.freeze(d.violations),
    stopRequests: Object.freeze(d.stopRequests),
    stopObservations: Object.freeze(d.stopObservations),
    toolDenials: Object.freeze(d.toolDenials),
    exits: Object.freeze(d.exits),
    reports: Object.freeze(d.reports),
    extensions: Object.freeze(d.extensions),
    instructions: Object.freeze(d.instructions),
    tombstones: Object.freeze(d.tombstones),
    lastSeq: d.lastSeq,
    requests: Object.freeze(Object.fromEntries(d.requests)),
  });
}

/** 検査済みのブリーフを、凍結した写しにして記録に入れる。 */
function briefRecord(
  objective: unknown,
  acceptanceCriteria: unknown,
  scope: unknown,
): Pick<NodeRecord, "objective" | "acceptanceCriteria" | "scope"> {
  const sc = scope as Scope;
  return {
    objective: objective as string,
    acceptanceCriteria: Object.freeze([...(acceptanceCriteria as string[])]),
    scope: Object.freeze({
      writableLocations: Object.freeze([...sc.writableLocations]),
      forbiddenLocations: Object.freeze([...sc.forbiddenLocations]),
      allowedCommands: Object.freeze([...sc.allowedCommands]),
    }),
  };
}

/** 拡張の対象の形を検査して写す。不正なら `undefined`。 */
function parseExtensionTarget(x: unknown): ExtensionTarget | undefined {
  if (!isRec(x) || Object.keys(x).some((k) => k !== "kind" && k !== "value")) return undefined;
  if (x.kind !== "write" && x.kind !== "command") return undefined;
  if (!isBoundedText(x.value, LIMITS.extensionTarget) || x.value.trim() === "") return undefined;
  return Object.freeze({ kind: x.kind, value: x.value });
}

const reject = (
  seq: number,
  code: FoldFailureCode,
  cause: string,
  ...nextActions: readonly [string, ...string[]]
): Result<boolean, FoldFailure> => ({
  ok: false,
  error: { ...failure(code, cause, ...nextActions), seq },
});

const invalid = (seq: number, what: string): Result<boolean, FoldFailure> =>
  reject(seq, "invalidPayload", `${what} が不正`, "payload を確認する");

const nodeAt = (d: Draft, id: string): NodeRecord | undefined => {
  const i = d.nodeIdx.get(id);
  return i === undefined ? undefined : d.nodes[i];
};

const unknownNode = (seq: number, id: string): Result<boolean, FoldFailure> =>
  reject(seq, "unknownNode", `ノード ${id} は存在しない`, "ノードの一覧を確認する");

/** 自分より上の親から根までの ID。 */
function ancestorIds(d: Draft, parentId: string | null): Set<string> {
  const out = new Set<string>();
  let cur = parentId;
  while (cur !== null && !out.has(cur)) {
    out.add(cur);
    cur = nodeAt(d, cur)?.parentId ?? null;
  }
  return out;
}

function descendantIds(d: Draft, id: string): string[] {
  const out: string[] = [];
  const stack = [...(d.children.get(id) ?? [])];
  for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
    out.push(n);
    stack.push(...(d.children.get(n) ?? []));
  }
  return out;
}

const dependenciesCompleted = (d: Draft, node: NodeRecord): boolean =>
  node.dependsOn.every((dep) => {
    const s = nodeAt(d, dep)?.state;
    return s !== undefined && COMPLETED_STATES.has(s);
  });

/** 1 件を下書きに適用する。成功なら `true`（適用）か `false`（重複で無視）。失敗のとき下書きは変わらない。 */
function step(d: Draft, raw: unknown): Result<boolean, FoldFailure> {
  d.note = undefined;
  if (!isRec(raw)) return invalid(0, "イベント");
  const seq = Number.isInteger(raw.seq) ? (raw.seq as number) : 0;
  if (!isId(raw.requestId)) {
    return reject(
      seq,
      "invalidRequestId",
      "requestId が識別子の形式でない（英数字で始まり、英数字と . _ : - のみ、128 文字以下）",
      "requestId を付ける",
    );
  }
  const actor = parseActor(raw.actor);
  if (typeof raw.type !== "string" || typeof raw.at !== "string" || actor === undefined) {
    return invalid(seq, "イベントの envelope（type・at・actor）");
  }
  if (!isRec(raw.payload)) return invalid(seq, "payload");
  const requestId = raw.requestId;
  const fp = canonical({ actor, type: raw.type, payload: raw.payload });

  const seen = d.requests.get(requestId);
  if (seen !== undefined) {
    return seen === fp
      ? ok(false)
      : reject(
          seq,
          "requestIdConflict",
          `requestId ${requestId} は別の内容で使用済み`,
          "新しい requestId で送る",
        );
  }
  if (!Number.isInteger(raw.seq) || seq <= d.lastSeq) {
    return reject(
      seq,
      "seqNotIncreasing",
      `seq ${String(raw.seq)} は直前の ${d.lastSeq} より大きい整数でない`,
      "seq を採番し直す",
    );
  }

  const p = raw.payload;
  const commit = (): Result<boolean, FoldFailure> => {
    d.lastSeq = seq;
    d.requests.set(requestId, fp);
    return ok(true);
  };

  switch (raw.type) {
    case "node.created": {
      const { nodeId, role, parentId, dependsOn } = p;
      if (!isId(nodeId) || !NODE_ROLES.includes(role as NodeRole) || !isIdArray(dependsOn)) {
        return invalid(seq, "node.created の payload");
      }
      if (parentId !== null && !isId(parentId)) return invalid(seq, "node.created の parentId");
      if (d.nodeIdx.has(nodeId)) {
        return reject(
          seq,
          "invalidTree",
          `木の不変条件に反する: duplicateId（${nodeId}）`,
          "別の ID を使う",
        );
      }
      if (parentId === null) {
        if (d.nodes.length > 0) {
          return reject(seq, "invalidTree", "木の不変条件に反する: multipleRoots", "親を指定する");
        }
        if (role !== "integrator") {
          return reject(
            seq,
            "invalidTree",
            "木の不変条件に反する: rootNotIntegrator",
            "根は統合ノードにする",
          );
        }
      } else {
        const parent = nodeAt(d, parentId);
        if (parent === undefined) {
          return reject(
            seq,
            "invalidTree",
            `木の不変条件に反する: missingParent（${parentId}）`,
            "親の ID を確認する",
          );
        }
        if (parent.role !== "integrator") {
          return reject(
            seq,
            "invalidTree",
            "木の不変条件に反する: parentNotIntegrator",
            "親は統合ノードにする",
          );
        }
        // 子を作れるのは、親が動作中（running）か判断待ち（waiting）のときだけ。
        if (parent.state !== "running" && parent.state !== "waiting") {
          return reject(
            seq,
            "parentNotActive",
            `親 ${parentId} は ${parent.state} で、子を作れない（running か waiting のときだけ）`,
            "親の状態を確認する",
          );
        }
      }
      const { objective, acceptanceCriteria, scope } = p;
      const hasBrief =
        objective !== undefined || acceptanceCriteria !== undefined || scope !== undefined;
      if (hasBrief) {
        const problem = briefProblem({ objective, acceptanceCriteria, scope, dependsOn });
        if (problem !== undefined) return invalid(seq, `node.created のブリーフ（${problem}）`);
      }
      const ancestors = ancestorIds(d, parentId);
      for (const dep of dependsOn) {
        if (dep === nodeId || !d.nodeIdx.has(dep)) {
          return reject(
            seq,
            "unknownDependency",
            "依存先が存在しない、または自分自身",
            "依存先の ID を確認する",
          );
        }
        if (ancestors.has(dep)) {
          return reject(
            seq,
            "dependsOnAncestor",
            `依存先 ${dep} は自分の親・祖先で、相互に待ち合う`,
            "親・祖先以外を依存先にする",
          );
        }
      }
      d.nodeIdx.set(nodeId, d.nodes.length);
      d.nodes.push(
        freezeRecord({
          id: nodeId,
          role: role as NodeRole,
          parentId,
          dependsOn: [...dependsOn],
          state: "pending",
          ...(hasBrief ? briefRecord(objective, acceptanceCriteria, scope) : {}),
        }),
      );
      if (parentId !== null)
        d.children.set(parentId, [...(d.children.get(parentId) ?? []), nodeId]);
      return commit();
    }

    case "node.stateChanged": {
      const { nodeId } = p;
      if (!isId(nodeId)) return invalid(seq, "node.stateChanged の nodeId");
      const event = parseNodeEvent(p.event);
      if (event === undefined) return invalid(seq, "node.stateChanged の event");
      const node = nodeAt(d, nodeId);
      if (node === undefined) return unknownNode(seq, nodeId);
      if (event.type === "stop" && event.graceMs !== undefined && node.state === "waiting") {
        return invalid(
          seq,
          "停止要求の graceMs（判断待ちのノードは猶予なしの即時停止のため指定できない）",
        );
      }
      const depsOk = dependenciesCompleted(d, node);
      // restart の dependenciesDone は payload を信用せず、状態から判定する。
      // markReclaimable の discarded も同様に、破棄の判断（node.discardDecided）の記録から判定する。
      const effective: NodeEvent =
        event.type === "restart"
          ? { type: "restart", dependenciesDone: depsOk }
          : event.type === "markReclaimable"
            ? { type: "markReclaimable", discarded: node.discarded !== undefined }
            : event;
      const t = transition(node.state, effective);
      if (!t.ok)
        return reject(
          seq,
          t.error.code as TransitionFailureCode,
          t.error.cause,
          ...t.error.nextActions,
        );
      if (event.type === "start" && !depsOk) {
        return reject(
          seq,
          "dependenciesNotVerified",
          `ノード ${nodeId} の依存先がすべて完了（verified 以降）になっていない`,
          "依存先の完了を待つ",
        );
      }
      const next = t.value.state;
      if (next === "reclaimable" || next === "archived") {
        const blocked = descendantIds(d, nodeId).some((id) => {
          const s = nodeAt(d, id)?.state;
          return s !== "reclaimable" && s !== "archived";
        });
        if (blocked) {
          return reject(
            seq,
            "reclaimInvariant",
            `ノード ${nodeId} の配下に、回収可能でないノードがある`,
            "配下を先に回収可能にする",
          );
        }
      }
      const { discarded: _discarded, ...rest } = node;
      d.nodes[d.nodeIdx.get(nodeId) as number] = freezeRecord({
        // 停止したノードの再開（restart）で、破棄の判断は消える。
        ...(event.type === "restart" ? rest : node),
        state: next,
        ...(event.type === "start" || event.type === "restart" ? { runStartedSeq: seq } : {}),
        ...(next === "archived" ? { archivedAt: raw.at } : {}),
      });
      if (event.type === "stop" && t.value.changed && t.value.effect !== "cancelStart") {
        d.stopRequests.push(
          freezeRecord({
            seq,
            nodeId,
            kind: "stop" as const,
            mode: event.mode,
            ...(event.graceMs === undefined ? {} : { graceMs: event.graceMs }),
          }),
        );
      } else if (event.type === "retryStop" && t.value.changed) {
        d.stopRequests.push(
          freezeRecord({ seq, nodeId, kind: "retryStop" as const, mode: "immediate" as const }),
        );
      } else if (event.type === "stop" && !t.value.changed && event.graceMs !== undefined) {
        // 進行中の停止に、別の猶予の停止要求が来た。進行中の猶予は変えない。
        const latest = [...d.stopRequests].reverse().find((r) => r.nodeId === nodeId);
        if (latest?.graceMs !== event.graceMs) d.note = "graceMsIgnored";
      }
      return commit();
    }

    case "scope.violation": {
      const { nodeId, reason, subject } = p;
      if (
        !isId(nodeId) ||
        typeof reason !== "string" ||
        !SCOPE_VIOLATION_REASONS.has(reason) ||
        typeof subject !== "string"
      ) {
        return invalid(seq, "scope.violation の payload");
      }
      if (nodeAt(d, nodeId) === undefined) return unknownNode(seq, nodeId);
      d.violations.push(
        freezeRecord({
          seq,
          at: raw.at,
          nodeId,
          reason: reason as ScopeViolationReason,
          subject,
          actor,
        }),
      );
      return commit();
    }

    case "node.stopObserved": {
      const { nodeId, outcome, stopSeq, graceMs } = p;
      if (
        !isId(nodeId) ||
        !isStopOutcome(outcome) ||
        !Number.isInteger(stopSeq) ||
        (stopSeq as number) < 1 ||
        (graceMs !== undefined && !isGraceMs(graceMs))
      ) {
        return invalid(seq, "node.stopObserved の payload");
      }
      const node = nodeAt(d, nodeId);
      if (node === undefined) return unknownNode(seq, nodeId);
      if (
        node.state !== "stopping" &&
        node.state !== "stopIncomplete" &&
        node.state !== "stopped"
      ) {
        return reject(
          seq,
          "invalidTransition",
          `状態 ${node.state} のノードに停止の観測は記録できない（stopping・stopIncomplete・stopped のとき）`,
          "停止要求を先に出す",
        );
      }
      const request = d.stopRequests.find((r) => r.seq === stopSeq);
      if (request === undefined || request.nodeId !== nodeId) {
        return reject(
          seq,
          "unknownStopRequest",
          `seq ${String(stopSeq)} は ${nodeId} の停止要求ではない`,
          "停止要求（stop・retryStop）のイベントの seq を指定する",
        );
      }
      if (d.stopObservations.some((o) => o.stopSeq === stopSeq)) {
        return reject(
          seq,
          "observationAlreadyRecorded",
          `停止要求 ${String(stopSeq)} の観測は記録済み（1 件だけ）`,
          "別の停止要求（retryStop など）に対して観測する",
        );
      }
      d.stopObservations.push(
        freezeRecord({
          seq,
          at: raw.at,
          nodeId,
          outcome,
          stopSeq: stopSeq as number,
          ...(graceMs === undefined ? {} : { graceMs: graceMs as number }),
          actor,
        }),
      );
      return commit();
    }

    case "inbox.added": {
      const { id, kind, nodeId, summary, ref } = p;
      if (!isId(id) || !isId(nodeId) || !INBOX_KINDS.includes(kind as InboxKind)) {
        return invalid(seq, "inbox.added の payload");
      }
      if (summary !== undefined && !isBoundedText(summary, LIMITS.summary)) {
        return invalid(seq, `inbox.added の summary（${LIMITS.summary} 文字以下、制御文字なし）`);
      }
      if (ref !== undefined && !isId(ref)) return invalid(seq, "inbox.added の ref");
      if (!isValidInboxTime(raw.at)) return invalid(seq, "inbox.added の at（ISO 8601 UTC）");
      const node = nodeAt(d, nodeId);
      if (node === undefined) return unknownNode(seq, nodeId);
      if (d.inboxIds.has(id)) {
        return reject(seq, "duplicateInboxId", `受信箱の項目 ${id} は既にある`, "別の ID を使う");
      }
      if (ref !== undefined) {
        // 参照先は、記録済みで、項目の種類に合い、同じノードのものに限る。
        const target = REF_TARGET[kind as InboxKind];
        const owner =
          target === "decision"
            ? d.decisions[d.decisionIdx.get(ref as string) ?? -1]?.nodeId
            : target === "report"
              ? d.reportIdx.get(ref as string)?.nodeId
              : target === "extension"
                ? d.extensions[d.extensionIdx.get(ref as string) ?? -1]?.nodeId
                : undefined;
        if (owner !== nodeId) {
          return reject(
            seq,
            "unknownRef",
            `ref ${String(ref)} は、種類 ${String(kind)} の項目が指せる、ノード ${nodeId} の記録ではない`,
            "判断要求・報告を先に記録する",
            "種類に合う ID（decision・answer は decisionId、報告系は reportId、violation は extensionId）を指定する",
          );
        }
      }
      d.inboxIds.add(id);
      d.inbox.push(
        freezeRecord({
          seq,
          id,
          kind: kind as InboxKind,
          nodeId,
          dependsOn: [...node.dependsOn],
          at: raw.at,
          ...(summary === undefined ? {} : { summary: summary as string }),
          ...(ref === undefined ? {} : { ref: ref as string }),
        }),
      );
      return commit();
    }

    case "node.toolDenied": {
      const { nodeId, tool } = p;
      if (!isId(nodeId) || !isBoundedText(tool, LIMITS.tool) || tool === "")
        return invalid(seq, "node.toolDenied の payload");
      const node = nodeAt(d, nodeId);
      if (node === undefined) return unknownNode(seq, nodeId);
      if (!RECORDABLE_STATES.has(node.state)) return notRecordable(seq, node, "node.toolDenied");
      d.toolDenials.push(freezeRecord({ seq, at: raw.at, nodeId, tool, actor }));
      return commit();
    }

    case "node.exited": {
      const { nodeId, reason } = p;
      if (!isId(nodeId) || !isBoundedText(reason, LIMITS.reason))
        return invalid(seq, "node.exited の payload");
      const node = nodeAt(d, nodeId);
      if (node === undefined) return unknownNode(seq, nodeId);
      if (!RECORDABLE_STATES.has(node.state)) return notRecordable(seq, node, "node.exited");
      d.exits.push(freezeRecord({ seq, at: raw.at, nodeId, reason, actor }));
      return commit();
    }

    case "report.added": {
      const { reportId, nodeId, kind, text, evidence } = p;
      if (
        !isId(reportId) ||
        !isId(nodeId) ||
        !isReportKind(kind) ||
        !isBoundedText(text, LIMITS.reportText)
      ) {
        return invalid(seq, "report.added の payload");
      }
      let evidenceList: ReportEvidence[] | undefined;
      if (evidence !== undefined) {
        // 根拠は完了報告（FR_022）だけが持つ。
        if (
          kind !== "done" ||
          !Array.isArray(evidence) ||
          evidence.length > LIMITS.evidenceCount ||
          !evidence.every(
            (x) =>
              isRec(x) &&
              isBoundedText(x.criterion, LIMITS.evidenceLength) &&
              x.criterion.trim() !== "" &&
              isBoundedText(x.evidence, LIMITS.evidenceLength) &&
              x.evidence.trim() !== "",
          )
        ) {
          return invalid(
            seq,
            `report.added の evidence（完了報告の { criterion, evidence（どちらも空白だけでない） } の ${LIMITS.evidenceCount} 件以下の配列）`,
          );
        }
        evidenceList = evidence.map((x: Rec) => ({
          criterion: x.criterion as string,
          evidence: x.evidence as string,
        }));
      }
      if (nodeAt(d, nodeId) === undefined) return unknownNode(seq, nodeId);
      if (d.reportIdx.has(reportId)) {
        return reject(seq, "duplicateReport", `報告 ${reportId} は既にある`, "別の ID を使う");
      }
      const record = freezeRecord({
        seq,
        at: raw.at,
        reportId,
        nodeId,
        kind,
        text,
        ...(evidenceList === undefined ? {} : { evidence: Object.freeze(evidenceList) }),
        actor,
      });
      d.reportIdx.set(reportId, record);
      d.reports.push(record);
      return commit();
    }

    case "decision.requested": {
      const { decisionId, nodeId, question, options, pauseNodeIds } = p;
      if (!isId(decisionId) || !isId(nodeId)) return invalid(seq, "decision.requested の payload");
      if (question !== undefined && !isBoundedText(question, LIMITS.question)) {
        return invalid(seq, `decision.requested の question（${LIMITS.question} 文字以下）`);
      }
      if (options !== undefined) {
        // 選択肢を示すなら問いが要る。空・重複は不可。
        if (
          question === undefined ||
          !Array.isArray(options) ||
          options.length < 1 ||
          options.length > LIMITS.optionCount ||
          !options.every((o) => isBoundedText(o, LIMITS.optionLength) && o !== "") ||
          new Set(options).size !== options.length
        ) {
          return invalid(
            seq,
            `decision.requested の options（question が必須。重複なし、1〜${LIMITS.optionCount} 件、各 ${LIMITS.optionLength} 文字以下）`,
          );
        }
      }
      if (nodeAt(d, nodeId) === undefined) return unknownNode(seq, nodeId);
      if (pauseNodeIds !== undefined) {
        if (pauseNodeIdsProblem(pauseNodeIds) !== undefined) {
          return invalid(
            seq,
            `decision.requested の pauseNodeIds（重複なしの識別子、${LIMITS.pauseNodeCount} 件以下）`,
          );
        }
        const below = new Set(descendantIds(d, nodeId));
        for (const target of pauseNodeIds as string[]) {
          if (nodeAt(d, target) === undefined) return unknownNode(seq, target);
          if (!below.has(target)) {
            return invalid(
              seq,
              `decision.requested の pauseNodeIds（${target} は ${nodeId} の子孫でない）`,
            );
          }
        }
      }
      if (d.decisionIdx.has(decisionId)) {
        return reject(
          seq,
          "duplicateDecision",
          `判断要求 ${decisionId} は既にある`,
          "別の ID を使う",
        );
      }
      // 数えるのは、そのノードの直近の start・restart より後の open の要求だけ。古い要求は回答できるまま残す。
      const runStartedSeq = nodeAt(d, nodeId)?.runStartedSeq ?? 0;
      const openDecisions = d.decisions.filter(
        (x) => x.nodeId === nodeId && x.status === "open" && (x.requestedSeq ?? 0) > runStartedSeq,
      ).length;
      if (openDecisions >= LIMITS.openDecisionsPerNode) {
        return reject(
          seq,
          "tooManyOpenDecisions",
          `ノード ${nodeId} の未回答の判断要求が上限（${LIMITS.openDecisionsPerNode} 件）に達している`,
          "回答を待つ",
          "まとめて 1 件で聞き直す",
        );
      }
      d.decisionIdx.set(decisionId, d.decisions.length);
      d.decisions.push(
        freezeRecord({
          decisionId,
          nodeId,
          status: "open",
          requestedSeq: seq,
          ...(question === undefined ? {} : { question: question as string }),
          ...(options === undefined ? {} : { options: Object.freeze([...(options as string[])]) }),
          ...(pauseNodeIds === undefined
            ? {}
            : { pauseNodeIds: Object.freeze([...(pauseNodeIds as string[])]) }),
          rejected: Object.freeze([]),
        }),
      );
      return commit();
    }

    case "decision.answered": {
      const { decisionId, answer } = p;
      if (!isId(decisionId) || typeof answer !== "string")
        return invalid(seq, "decision.answered の payload");
      const i = d.decisionIdx.get(decisionId);
      const cur = i === undefined ? undefined : d.decisions[i];
      if (i === undefined || cur === undefined) {
        return reject(
          seq,
          "unknownDecision",
          `判断要求 ${decisionId} は存在しない`,
          "判断要求の一覧を確認する",
        );
      }
      d.decisions[i] = freezeRecord(
        cur.status === "open"
          ? { ...cur, status: "answered" as const, answer, answeredBy: actor }
          : { ...cur, rejected: Object.freeze([...cur.rejected, { seq, answer, actor }]) },
      );
      return commit();
    }

    case "node.instructed": {
      const { nodeId, text } = p;
      if (!isId(nodeId)) return invalid(seq, "node.instructed の nodeId");
      if (!isBoundedText(text, LIMITS.reportText) || text.trim() === "") {
        return invalid(seq, `node.instructed の text（空でない ${LIMITS.reportText} 文字以下）`);
      }
      const node = nodeAt(d, nodeId);
      if (node === undefined) return unknownNode(seq, nodeId);
      if (!RECORDABLE_STATES.has(node.state)) return notRecordable(seq, node, "追加指示");
      d.instructions.push(freezeRecord({ seq, at: raw.at as string, nodeId, text, actor }));
      return commit();
    }

    case "inbox.resolved": {
      const { itemId } = p;
      if (!isId(itemId)) return invalid(seq, "inbox.resolved の itemId");
      const i = d.inbox.findIndex((x) => x.id === itemId);
      const cur = d.inbox[i];
      if (cur === undefined) {
        return reject(
          seq,
          "unknownInboxItem",
          `受信箱の項目 ${itemId} は存在しない`,
          "受信箱の項目の ID を確認する",
        );
      }
      // 二度目の解決は、最初の記録を残す（状態は変えない）。
      if (cur.resolved === undefined) {
        d.inbox[i] = freezeRecord({
          ...cur,
          resolved: Object.freeze({ seq, at: raw.at as string, by: actor }),
        });
      }
      return commit();
    }

    case "node.instructionDelivered": {
      const { instructedSeq } = p;
      if (!Number.isInteger(instructedSeq) || (instructedSeq as number) < 0) {
        return invalid(seq, "node.instructionDelivered の instructedSeq");
      }
      const i = d.instructions.findIndex((x) => x.seq === instructedSeq);
      const cur = d.instructions[i];
      if (cur === undefined) {
        return reject(
          seq,
          "unknownInstruction",
          `指示（seq ${String(instructedSeq)}）は存在しない`,
          "node.instructed の seq を確認する",
        );
      }
      // 二度目の配送の記録は、最初の記録を残す（状態は変えない）。
      if (cur.deliveredSeq === undefined) {
        d.instructions[i] = freezeRecord({
          ...cur,
          deliveredSeq: seq,
          deliveredAt: raw.at as string,
        });
      }
      return commit();
    }

    case "node.purged": {
      const { rootId, nodeIds, archivedAt, tombstone } = p;
      if (
        !isId(rootId) ||
        !isIdArray(nodeIds) ||
        nodeIds.length > LIMITS.purgeNodeCount ||
        typeof archivedAt !== "string" ||
        !isValidInboxTime(archivedAt)
      ) {
        return invalid(seq, "node.purged の payload（rootId・nodeIds・archivedAt）");
      }
      let record: PurgeTombstone | undefined;
      if (tombstone !== undefined) {
        const t = tombstone as Record<string, unknown>;
        if (
          !isRec(t) ||
          !isBoundedText(t.title, LIMITS.summary) ||
          t.title === "" ||
          (t.outcome !== "verified" && t.outcome !== "discarded") ||
          (t.lastCommit !== undefined && !isBoundedText(t.lastCommit, LIMITS.commit))
        ) {
          return invalid(seq, "node.purged の tombstone（title・outcome・lastCommit）");
        }
        record = {
          title: t.title as string,
          outcome: t.outcome as "verified" | "discarded",
          ...(t.lastCommit === undefined ? {} : { lastCommit: t.lastCommit as string }),
        };
      }
      const alive = nodeIds.find((id) => d.nodeIdx.has(id));
      if (alive !== undefined) {
        return reject(
          seq,
          "purgeInconsistent",
          `標識に載せたノード ${alive} が、まだ存在する（行の削除と標識が食い違っている）`,
          "イベントログを確認する",
        );
      }
      d.tombstones.push(
        freezeRecord({
          seq,
          at: raw.at as string,
          actor,
          rootId,
          nodeIds: Object.freeze([...nodeIds]),
          archivedAt,
          ...(record === undefined ? {} : { tombstone: freezeRecord(record) }),
        }),
      );
      return commit();
    }

    case "node.discardDecided": {
      const { nodeId } = p;
      if (!isId(nodeId)) return invalid(seq, "node.discardDecided の nodeId");
      const node = nodeAt(d, nodeId);
      if (node === undefined) return unknownNode(seq, nodeId);
      if (node.state !== "stopped") {
        return reject(
          seq,
          "invalidTransition",
          `状態 ${node.state} のノードに破棄の判断は記録できない（stopped のときだけ）`,
          "ノードの状態を確認する",
        );
      }
      if (node.discarded !== undefined) {
        return reject(
          seq,
          "alreadyDiscarded",
          `ノード ${nodeId} の破棄は判断済み`,
          "判断の結果を確認する",
        );
      }
      d.nodes[d.nodeIdx.get(nodeId) as number] = freezeRecord({
        ...node,
        discarded: Object.freeze({ seq, at: raw.at as string, by: actor }),
      });
      return commit();
    }

    case "scope.extensionRequested": {
      const { extensionId, nodeId, reason } = p;
      if (!isId(extensionId) || !isId(nodeId)) {
        return invalid(seq, "scope.extensionRequested の payload");
      }
      const target = parseExtensionTarget(p.target);
      if (target === undefined) {
        return invalid(
          seq,
          `scope.extensionRequested の target（{ kind: write か command, value: 空でない ${LIMITS.extensionTarget} 文字以下 }）`,
        );
      }
      if (!isBoundedText(reason, LIMITS.extensionReason) || reason.trim() === "") {
        return invalid(
          seq,
          `scope.extensionRequested の reason（空でない ${LIMITS.extensionReason} 文字以下）`,
        );
      }
      const node = nodeAt(d, nodeId);
      if (node === undefined) return unknownNode(seq, nodeId);
      if (node.state !== "running" && node.state !== "waiting") {
        return reject(
          seq,
          "invalidTransition",
          `状態 ${node.state} のノードは範囲の拡張を要求できない（running か waiting のときだけ）`,
          "ノードの状態を確認する",
        );
      }
      if (d.extensionIdx.has(extensionId)) {
        return reject(
          seq,
          "duplicateExtension",
          `拡張要求 ${extensionId} は既にある`,
          "別の ID を使う",
        );
      }
      const open = d.extensions.filter((x) => x.nodeId === nodeId && x.status === "open").length;
      if (open >= LIMITS.openExtensionsPerNode) {
        return reject(
          seq,
          "tooManyOpenExtensions",
          `ノード ${nodeId} の未判定の拡張要求が上限（${LIMITS.openExtensionsPerNode} 件）に達している`,
          "親の判定を待つ",
          "まとめて 1 件で要求し直す",
        );
      }
      d.extensionIdx.set(extensionId, d.extensions.length);
      d.extensions.push(
        freezeRecord({
          extensionId,
          nodeId,
          target,
          reason,
          status: "open" as const,
          requestedSeq: seq,
        }),
      );
      return commit();
    }

    case "scope.extensionDecided": {
      const { extensionId, decision } = p;
      if (!isId(extensionId) || !isExtensionDecision(decision)) {
        return invalid(seq, "scope.extensionDecided の payload");
      }
      // 承認には許可した対象（granted）が要り、却下・切り出しには付けない。
      const granted = p.granted === undefined ? undefined : parseExtensionTarget(p.granted);
      if (decision === "approve" ? granted === undefined : p.granted !== undefined) {
        return invalid(
          seq,
          "scope.extensionDecided の granted（approve のときだけ、許可した対象を付ける）",
        );
      }
      const i = d.extensionIdx.get(extensionId);
      const cur = i === undefined ? undefined : d.extensions[i];
      if (i === undefined || cur === undefined) {
        return reject(
          seq,
          "unknownExtension",
          `拡張要求 ${extensionId} は存在しない`,
          "拡張要求の ID を確認する",
        );
      }
      if (cur.status !== "open") {
        return reject(
          seq,
          "extensionAlreadyDecided",
          `拡張要求 ${extensionId} は判定済み（${cur.status}）`,
          "判定の結果を確認する",
        );
      }
      if (granted !== undefined && granted.kind !== cur.target.kind) {
        return invalid(
          seq,
          `scope.extensionDecided の granted（要求の種類 ${cur.target.kind} と違う）`,
        );
      }
      d.extensions[i] = freezeRecord({
        ...cur,
        status: EXTENSION_STATUS[decision],
        decidedSeq: seq,
        decidedBy: actor,
        ...(granted === undefined ? {} : { granted }),
      });
      return commit();
    }

    default:
      return reject(
        seq,
        "unknownEventType",
        `未知のイベント種別: ${raw.type}`,
        "イベントの種別を確認する",
      );
  }
}

/**
 * イベントを 1 件適用する。daemon は追記の前に呼び、失敗なら追記しない。
 * 同じ `requestId` で同一内容なら、状態を変えずに成功（`applied: false`）を返す（冪等）。
 */
export function applyEvent(state: OrchState, e: OrchEvent): ApplyResult {
  const draft = toDraft(state);
  if (draft === undefined) return invalidState(seqOf(e));
  const r = step(draft, e);
  if (!r.ok) return r;
  return ok({
    state: r.value ? toState(draft) : state,
    applied: r.value,
    ...(r.value && draft.note !== undefined ? { ignored: draft.note } : {}),
  });
}

const seqOf = (e: unknown): number => (isRec(e) && Number.isInteger(e.seq) ? (e.seq as number) : 0);

const invalidState = (seq: number): Result<never, FoldFailure> => ({
  ok: false,
  error: {
    ...failure(
      "invalidState",
      "状態が壊れている（スナップショットの破損など）",
      "スナップショットを捨てて、ログ全体から再構築する",
    ),
    seq,
  },
});

/**
 * イベント列を `seq` の昇順に畳み込んで状態を得る。入力順に依存しない。
 * `base` を渡すと、そのスナップショットの状態から再開する（以降のイベントだけを渡せる）。
 * 矛盾するイベントがあれば、そのイベントの `seq` つきの失敗で全体を拒否する。
 */
export function foldEvents(
  events: readonly OrchEvent[],
  base: OrchState = initialState(),
): FoldResult {
  const bad = events.findIndex((e) => !isRec(e) || !Number.isInteger((e as unknown as Rec).seq));
  if (bad >= 0)
    return invalid(0, "イベント（seq が整数でない、またはオブジェクトでない）") as FoldResult;
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i] as OrchEvent;
    if (cur.seq === (sorted[i - 1] as OrchEvent).seq) {
      return reject(
        cur.seq,
        "duplicateSeq",
        `seq ${cur.seq} が重複している`,
        "ログを確認する",
      ) as FoldResult;
    }
  }
  const draft = toDraft(base);
  if (draft === undefined) return invalidState(0);
  for (const e of sorted) {
    const r = step(draft, e);
    if (!r.ok) return r;
  }
  return ok(toState(draft));
}

/**
 * ノードの有効な範囲: ブリーフの範囲に、承認済みの拡張（`granted`）を判定の順に加えたもの。
 * 書き込み可能な場所（`write`）と許可するコマンド（`command`）だけが増え、禁止の場所は変わらない。
 * ブリーフのないノード・存在しないノードは `undefined`。純粋関数（イベント列から導かれ、状態に二重に持たない）。
 */
export function effectiveScope(state: OrchState, nodeId: string): Scope | undefined {
  const node = state.nodes.find((n) => n.id === nodeId);
  if (node?.scope === undefined) return undefined;
  const writable = [...node.scope.writableLocations];
  const commands = [...node.scope.allowedCommands];
  const granted = (state.extensions ?? [])
    .filter((x) => x.nodeId === nodeId && x.status === "approved" && x.granted !== undefined)
    .sort((a, b) => (a.decidedSeq ?? 0) - (b.decidedSeq ?? 0));
  for (const x of granted) {
    const g = x.granted as ExtensionTarget;
    const list = g.kind === "write" ? writable : commands;
    if (!list.includes(g.value)) list.push(g.value);
  }
  return Object.freeze({
    writableLocations: Object.freeze(writable),
    forbiddenLocations: Object.freeze([...node.scope.forbiddenLocations]),
    allowedCommands: Object.freeze(commands),
  });
}

/** 破棄の判断（`node.discardDecided`）を経たノードの識別子。回収の再判定の入力 `facts.discarded` の情報源（二重に持たない）。 */
export function discardedNodeIds(state: OrchState): string[] {
  return state.nodes.filter((n) => n.discarded !== undefined).map((n) => n.id);
}
