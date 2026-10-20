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

import { type Failure, failure, ok, type Result } from "./contract.js";
import { type InboxItem, isValidInboxTime } from "./inbox.js";
import { INBOX_KINDS, type InboxKind } from "./inbox-kinds.js";
import type { NodeRole, NodeState } from "./index.js";
import type { ScopeViolationReason } from "./scope.js";
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
      };
    }
  | {
      readonly type: "decision.requested";
      readonly payload: { readonly decisionId: string; readonly nodeId: string };
    }
  | {
      readonly type: "decision.answered";
      readonly payload: { readonly decisionId: string; readonly answer: string };
    };

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
}

export interface DecisionRecord {
  readonly decisionId: string;
  readonly nodeId: string;
  readonly status: "open" | "answered";
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

export interface ViolationRecord {
  readonly seq: number;
  readonly at: string;
  readonly nodeId: string;
  readonly reason: ScopeViolationReason;
  readonly subject: string;
  readonly actor: Actor;
}

export interface OrchState {
  /** 作成順。 */
  readonly nodes: readonly NodeRecord[];
  readonly inbox: readonly InboxItem[];
  readonly decisions: readonly DecisionRecord[];
  readonly violations: readonly ViolationRecord[];
  /** 最後に適用したイベントの `seq`。 */
  readonly lastSeq: number;
  /** 適用済みの要求識別子 → 内容の指紋（冪等性の判定用）。 */
  readonly requests: Readonly<Record<string, string>>;
}

export type FoldFailureCode =
  | TransitionFailureCode
  | "invalidRequestId"
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
  | "unknownDecision";

/** どのイベント（`seq`）で拒否したかを持つ失敗。壊れたイベントで `seq` が分からないときは 0。 */
export interface FoldFailure extends Failure {
  readonly seq: number;
}

/** `applied` が `false` のときは、同じ `requestId` で同一内容の重複として無視した（状態は変わらない）。 */
export interface ApplyOutcome {
  readonly state: OrchState;
  readonly applied: boolean;
}

export type ApplyResult = Result<ApplyOutcome, FoldFailure>;
export type FoldResult = Result<OrchState, FoldFailure>;

export const initialState = (): OrchState => ({
  nodes: [],
  inbox: [],
  decisions: [],
  violations: [],
  lastSeq: 0,
  requests: {},
});

export const stateOf = (state: OrchState, nodeId: string): NodeState | undefined =>
  state.nodes.find((n) => n.id === nodeId)?.state;

// ---- 型ガード（壊れた入力でも例外を出さない） ----

type Rec = Record<string, unknown>;
const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const isId = (x: unknown): x is string => typeof x === "string" && x !== "";
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
    case "stop":
      return x.mode === "graceful" || x.mode === "immediate"
        ? { type: "stop", mode: x.mode }
        : undefined;
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
  lastSeq: number;
  requests: Map<string, string>;
}

function toDraft(state: OrchState): Draft {
  const d: Draft = {
    nodes: [...state.nodes],
    nodeIdx: new Map(),
    children: new Map(),
    inbox: [...state.inbox],
    inboxIds: new Set(state.inbox.map((i) => i.id)),
    decisions: [...state.decisions],
    decisionIdx: new Map(),
    violations: [...state.violations],
    lastSeq: state.lastSeq,
    requests: new Map(Object.entries(state.requests)),
  };
  state.nodes.forEach((n, i) => {
    d.nodeIdx.set(n.id, i);
    if (n.parentId !== null)
      d.children.set(n.parentId, [...(d.children.get(n.parentId) ?? []), n.id]);
  });
  state.decisions.forEach((x, i) => {
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
    lastSeq: d.lastSeq,
    requests: Object.freeze(Object.fromEntries(d.requests)),
  });
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
  if (!isRec(raw)) return invalid(0, "イベント");
  const seq = Number.isInteger(raw.seq) ? (raw.seq as number) : 0;
  if (!isId(raw.requestId)) {
    return reject(
      seq,
      "invalidRequestId",
      "requestId が空または文字列でない",
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
      const depsOk = dependenciesCompleted(d, node);
      // restart の dependenciesDone は payload を信用せず、状態から判定する。
      const effective: NodeEvent =
        event.type === "restart" ? { type: "restart", dependenciesDone: depsOk } : event;
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
      d.nodes[d.nodeIdx.get(nodeId) as number] = freezeRecord({ ...node, state: next });
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

    case "inbox.added": {
      const { id, kind, nodeId } = p;
      if (!isId(id) || !isId(nodeId) || !INBOX_KINDS.includes(kind as InboxKind)) {
        return invalid(seq, "inbox.added の payload");
      }
      if (!isValidInboxTime(raw.at)) return invalid(seq, "inbox.added の at（ISO 8601 UTC）");
      const node = nodeAt(d, nodeId);
      if (node === undefined) return unknownNode(seq, nodeId);
      if (d.inboxIds.has(id)) {
        return reject(seq, "duplicateInboxId", `受信箱の項目 ${id} は既にある`, "別の ID を使う");
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
        }),
      );
      return commit();
    }

    case "decision.requested": {
      const { decisionId, nodeId } = p;
      if (!isId(decisionId) || !isId(nodeId)) return invalid(seq, "decision.requested の payload");
      if (nodeAt(d, nodeId) === undefined) return unknownNode(seq, nodeId);
      if (d.decisionIdx.has(decisionId)) {
        return reject(
          seq,
          "duplicateDecision",
          `判断要求 ${decisionId} は既にある`,
          "別の ID を使う",
        );
      }
      d.decisionIdx.set(decisionId, d.decisions.length);
      d.decisions.push(
        freezeRecord({ decisionId, nodeId, status: "open", rejected: Object.freeze([]) }),
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
  const r = step(draft, e);
  if (!r.ok) return r;
  return ok({ state: r.value ? toState(draft) : state, applied: r.value });
}

/**
 * イベント列を `seq` の昇順に畳み込んで状態を得る。入力順に依存しない。
 * `base` を渡すと、そのスナップショットの状態から再開する（以降のイベントだけを渡せる）。
 * 矛盾するイベントがあれば、そのイベントの `seq` つきの失敗で全体を拒否する。
 */
export function foldEvents(
  events: readonly OrchEvent[],
  base: OrchState = initialState(),
): FoldResult {
  const bad = events.find((e) => !isRec(e) || !Number.isInteger((e as unknown as Rec).seq));
  if (bad !== undefined)
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
  for (const e of sorted) {
    const r = step(draft, e);
    if (!r.ok) return r;
  }
  return ok(toState(draft));
}
