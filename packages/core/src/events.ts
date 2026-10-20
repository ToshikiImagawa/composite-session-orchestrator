/**
 * イベント型（`OrchEvent`）と、イベント列の畳み込みによる状態の導出（純粋関数）。
 * PRD: NFR_002, NFR_003, NFR_011 / design 5 章
 *
 * - 状態はイベント列からのみ導出する。`foldEvents` は `seq` の昇順に畳み込むため、入力順に依存しない。
 * - 同じ `requestId` のイベントは重複として無視する（冪等）。内容が違えば `requestIdConflict` で拒否する。
 * - T02（木の不変条件）・T03（遷移表）と矛盾するイベントは、`seq` つきの失敗で拒否する。
 *   daemon は追記の前に `applyEvent` で検査する。
 * - 未知の `type` は拒否する（無視しない）。時刻と `seq` は daemon が付与する（引数で受ける）。
 */

import { type Failure, failure, ok, type Result } from "./contract.js";
import type { InboxItem } from "./inbox.js";
import { INBOX_KINDS, type InboxKind } from "./inbox-kinds.js";
import type { NodeRole, NodeState } from "./index.js";
import type { ScopeViolationReason } from "./scope.js";
import { type NodeEvent, transition } from "./transition.js";
import { addChild, reclaimInvariantViolations, type TreeNode } from "./tree.js";

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
      readonly type: "inbox.added";
      readonly payload: {
        readonly id: string;
        readonly kind: InboxKind;
        readonly nodeId: string;
        readonly dependsOn: readonly string[];
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
  | "invalidRequestId"
  | "seqNotIncreasing"
  | "duplicateSeq"
  | "requestIdConflict"
  | "unknownEventType"
  | "invalidPayload"
  | "invalidTree"
  | "unknownDependency"
  | "unknownNode"
  | "invalidTransition"
  | "alreadyFinished"
  | "discardRequired"
  | "dependenciesNotVerified"
  | "reclaimInvariant"
  | "duplicateInboxId"
  | "duplicateDecision"
  | "unknownDecision";

/** どのイベント（`seq`）で拒否したかを持つ失敗。 */
export interface FoldFailure extends Failure {
  readonly seq: number;
}

export type ApplyResult = Result<OrchState, FoldFailure>;

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

const reject = (
  seq: number,
  code: FoldFailureCode,
  cause: string,
  ...nextActions: readonly [string, ...string[]]
): ApplyResult => ({ ok: false, error: { ...failure(code, cause, ...nextActions), seq } });

/** キー順に依存しない JSON。重複判定の指紋に使う。 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

const fingerprint = (e: OrchEvent): string =>
  canonical({ actor: e.actor, type: e.type, payload: e.payload });

const isNonEmpty = (s: unknown): s is string => typeof s === "string" && s !== "";

const NODE_EVENT_TYPES: ReadonlySet<string> = new Set([
  "start",
  "requestDecision",
  "resume",
  "reportDone",
  "accept",
  "reject",
  "stop",
  "stopTimeout",
  "retryStop",
  "confirmStopped",
  "restart",
  "markReclaimable",
  "archive",
]);

const toTree = (nodes: readonly NodeRecord[]): TreeNode[] =>
  nodes.map((n) => ({ id: n.id, role: n.role, parentId: n.parentId }));

const dependenciesVerified = (state: OrchState, node: NodeRecord): boolean =>
  node.dependsOn.every((d) => stateOf(state, d) === "verified");

function applyBody(state: OrchState, e: OrchEvent): ApplyResult {
  const next = (patch: Partial<OrchState>): ApplyResult =>
    ok({
      ...state,
      ...patch,
      lastSeq: e.seq,
      requests: { ...state.requests, [e.requestId]: fingerprint(e) },
    });
  const nodeOf = (id: string): NodeRecord | undefined => state.nodes.find((n) => n.id === id);
  const unknownNode = (id: unknown): ApplyResult =>
    reject(e.seq, "unknownNode", `ノード ${String(id)} は存在しない`, "ノードの一覧を確認する");

  switch (e.type) {
    case "node.created": {
      const { nodeId, role, parentId, dependsOn } = e.payload;
      if (!isNonEmpty(nodeId) || !Array.isArray(dependsOn)) {
        return reject(
          e.seq,
          "invalidPayload",
          "node.created の payload が不正",
          "payload を確認する",
        );
      }
      if (dependsOn.some((d) => d === nodeId || nodeOf(d) === undefined)) {
        return reject(
          e.seq,
          "unknownDependency",
          "依存先が存在しない、または自分自身",
          "依存先の ID を確認する",
        );
      }
      const r = addChild(toTree(state.nodes), { id: nodeId, role, parentId });
      if (!r.ok) {
        return reject(
          e.seq,
          "invalidTree",
          `木の不変条件に反する: ${r.violation.kind}`,
          "親と役割を確認する",
        );
      }
      return next({
        nodes: [
          ...state.nodes,
          { id: nodeId, role, parentId, dependsOn: [...dependsOn], state: "pending" },
        ],
      });
    }

    case "node.stateChanged": {
      const { nodeId, event } = e.payload;
      const node = nodeOf(nodeId);
      if (node === undefined) return unknownNode(nodeId);
      if (typeof event !== "object" || event === null || !NODE_EVENT_TYPES.has(event.type)) {
        return reject(
          e.seq,
          "invalidPayload",
          "node.stateChanged の event が不正",
          "payload を確認する",
        );
      }
      const depsOk = dependenciesVerified(state, node);
      // restart の dependenciesDone は payload を信用せず、状態から判定する。
      const effective: NodeEvent =
        event.type === "restart" ? { type: "restart", dependenciesDone: depsOk } : event;
      const t = transition(node.state, effective);
      if (!t.ok) {
        return reject(
          e.seq,
          t.error.code as FoldFailureCode,
          t.error.cause,
          ...t.error.nextActions,
        );
      }
      if (event.type === "start" && !depsOk) {
        return reject(
          e.seq,
          "dependenciesNotVerified",
          `ノード ${nodeId} の依存先がすべて検証済み（verified）になっていない`,
          "依存先の完了を待つ",
        );
      }
      const nodes = state.nodes.map((n) => (n.id === nodeId ? { ...n, state: t.value.state } : n));
      if (t.value.state === "reclaimable" || t.value.state === "archived") {
        const done = new Set(
          nodes.filter((n) => n.state === "reclaimable" || n.state === "archived").map((n) => n.id),
        );
        if (reclaimInvariantViolations(toTree(nodes), done).length > 0) {
          return reject(
            e.seq,
            "reclaimInvariant",
            `ノード ${nodeId} の配下に、回収可能でないノードがある`,
            "配下を先に回収可能にする",
          );
        }
      }
      return next({ nodes });
    }

    case "scope.violation": {
      const { nodeId, reason, subject } = e.payload;
      if (nodeOf(nodeId) === undefined) return unknownNode(nodeId);
      return next({
        violations: [
          ...state.violations,
          { seq: e.seq, at: e.at, nodeId, reason, subject, actor: e.actor },
        ],
      });
    }

    case "inbox.added": {
      const { id, kind, nodeId, dependsOn } = e.payload;
      if (!isNonEmpty(id) || !INBOX_KINDS.includes(kind) || !Array.isArray(dependsOn)) {
        return reject(
          e.seq,
          "invalidPayload",
          "inbox.added の payload が不正",
          "payload を確認する",
        );
      }
      if (nodeOf(nodeId) === undefined) return unknownNode(nodeId);
      if (state.inbox.some((i) => i.id === id)) {
        return reject(e.seq, "duplicateInboxId", `受信箱の項目 ${id} は既にある`, "別の ID を使う");
      }
      return next({
        inbox: [
          ...state.inbox,
          { seq: e.seq, id, kind, nodeId, dependsOn: [...dependsOn], at: e.at },
        ],
      });
    }

    case "decision.requested": {
      const { decisionId, nodeId } = e.payload;
      if (!isNonEmpty(decisionId)) {
        return reject(
          e.seq,
          "invalidPayload",
          "decision.requested の payload が不正",
          "payload を確認する",
        );
      }
      if (nodeOf(nodeId) === undefined) return unknownNode(nodeId);
      if (state.decisions.some((d) => d.decisionId === decisionId)) {
        return reject(
          e.seq,
          "duplicateDecision",
          `判断要求 ${decisionId} は既にある`,
          "別の ID を使う",
        );
      }
      return next({
        decisions: [...state.decisions, { decisionId, nodeId, status: "open", rejected: [] }],
      });
    }

    case "decision.answered": {
      const { decisionId, answer } = e.payload;
      const d = state.decisions.find((x) => x.decisionId === decisionId);
      if (d === undefined) {
        return reject(
          e.seq,
          "unknownDecision",
          `判断要求 ${String(decisionId)} は存在しない`,
          "判断要求の一覧を確認する",
        );
      }
      const updated: DecisionRecord =
        d.status === "open"
          ? { ...d, status: "answered", answer, answeredBy: e.actor }
          : { ...d, rejected: [...d.rejected, { seq: e.seq, answer, actor: e.actor }] };
      return next({
        decisions: state.decisions.map((x) => (x.decisionId === decisionId ? updated : x)),
      });
    }

    default: {
      const unknown = e as { seq: number; type: unknown };
      return reject(
        unknown.seq,
        "unknownEventType",
        `未知のイベント種別: ${String(unknown.type)}`,
        "イベントの種別を確認する",
      );
    }
  }
}

/**
 * イベントを 1 件適用する。daemon は追記の前に呼び、失敗なら追記しない。
 * 同じ `requestId` で同一内容なら、状態を変えずに成功を返す（冪等）。
 */
export function applyEvent(state: OrchState, e: OrchEvent): ApplyResult {
  if (!isNonEmpty(e.requestId)) {
    return reject(e.seq, "invalidRequestId", "requestId が空", "requestId を付ける");
  }
  const seen = state.requests[e.requestId];
  if (seen !== undefined) {
    return seen === fingerprint(e)
      ? ok(state)
      : reject(
          e.seq,
          "requestIdConflict",
          `requestId ${e.requestId} は別の内容で使用済み`,
          "新しい requestId で送る",
        );
  }
  if (!Number.isInteger(e.seq) || e.seq <= state.lastSeq) {
    return reject(
      e.seq,
      "seqNotIncreasing",
      `seq ${e.seq} は直前の ${state.lastSeq} より大きくない`,
      "seq を採番し直す",
    );
  }
  return applyBody(state, e);
}

/**
 * イベント列を `seq` の昇順に畳み込んで状態を得る。入力順に依存しない。
 * 矛盾するイベントがあれば、そのイベントの `seq` つきの失敗で全体を拒否する。
 */
export function foldEvents(events: readonly OrchEvent[]): ApplyResult {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i] as OrchEvent;
    if (cur.seq === (sorted[i - 1] as OrchEvent).seq) {
      return reject(cur.seq, "duplicateSeq", `seq ${cur.seq} が重複している`, "ログを確認する");
    }
  }
  let state = initialState();
  for (const e of sorted) {
    const r = applyEvent(state, e);
    if (!r.ok) return r;
    state = r.value;
  }
  return ok(state);
}
