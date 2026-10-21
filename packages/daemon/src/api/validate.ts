/**
 * 窓口への要求の検証。封筒（requestId・operation・params）と、操作ごとの引数の形を検査する。
 * 入力は信頼しない: 余計なキー・欠けたキー・型の違い・上限（`LIMITS`）超過・禁止文字（`isBoundedText`）は
 * `invalidRequest` で拒否する（フェイルクローズ）。例外は出さない。
 *
 * 封筒の `role`・`caller` は申告として読むだけで、判定には使わない（呼び出したロールとノードは、認証で決める）。
 */

import {
  type Brief,
  briefProblem,
  DAEMON_OPERATIONS,
  type DaemonOperation,
  failure,
  ID_MAX_LENGTH,
  isBoundedText,
  isSafeId,
  LIMITS,
  MAX_GRACE_MS,
  NODE_ROLES,
  type OperationMap,
  pauseNodeIdsProblem,
  type Result,
} from "@cso/core";

type Rec = Record<string, unknown>;
type Failure = ReturnType<typeof failure>;

export interface Envelope {
  readonly requestId: string;
  readonly operation: DaemonOperation;
  readonly params: unknown;
  /** 申告されたロール（判定には使わず、認証したロールと食い違えば拒否するために読む）。 */
  readonly claimedRole?: string;
  /** 申告された caller の nodeId（同上）。 */
  readonly claimedCaller?: string;
}

const isRec = (x: unknown): x is Rec => typeof x === "object" && x !== null && !Array.isArray(x);
const OPERATIONS: ReadonlySet<string> = new Set(DAEMON_OPERATIONS);

const bad = (cause: string): Failure =>
  failure("invalidRequest", cause, "要求の形を確認する", "操作の引数の仕様を確認する");

const hasOnly = (o: Rec, allowed: readonly string[]): boolean =>
  Object.keys(o).every((k) => allowed.includes(k));

/** 要求の封筒を検査する。 */
export function parseEnvelope(body: unknown): Result<Envelope, Failure> {
  if (!isRec(body)) return { ok: false, error: bad("本文が JSON のオブジェクトでない") };
  if (!hasOnly(body, ["requestId", "operation", "params", "role", "caller"])) {
    return { ok: false, error: bad("封筒に未知のキーがある") };
  }
  const { requestId, operation, params, role, caller } = body;
  if (!isSafeId(requestId)) {
    return {
      ok: false,
      error: bad(
        `requestId が不正（英数字で始まり、英数字と . _ : - のみ、${ID_MAX_LENGTH} 文字以下）`,
      ),
    };
  }
  if (typeof operation !== "string" || !OPERATIONS.has(operation)) {
    return {
      ok: false,
      error: failure("unknownOperation", "未知の操作", "公開されている操作の一覧を確認する"),
    };
  }
  if (!isRec(params)) return { ok: false, error: bad("params が JSON のオブジェクトでない") };
  if (role !== undefined && typeof role !== "string") {
    return { ok: false, error: bad("role が文字列でない") };
  }
  if (
    caller !== undefined &&
    !(isRec(caller) && typeof caller.nodeId === "string" && hasOnly(caller, ["nodeId"]))
  ) {
    return { ok: false, error: bad("caller が { nodeId } でない") };
  }
  return {
    ok: true,
    value: {
      requestId,
      operation: operation as DaemonOperation,
      params,
      ...(role === undefined ? {} : { claimedRole: role }),
      ...(isRec(caller) ? { claimedCaller: caller.nodeId as string } : {}),
    },
  };
}

// ---- 引数の検査 ----

class Invalid extends Error {}
const fail = (cause: string): never => {
  throw new Invalid(cause);
};

const id = (o: Rec, key: string): string => {
  const v = o[key];
  if (!isSafeId(v))
    fail(`${key} が不正（英数字で始まり、英数字と . _ : - だけの ${ID_MAX_LENGTH} 文字以下）`);
  return v as string;
};
const text = (o: Rec, key: string, max: number): string => {
  const v = o[key];
  if (!isBoundedText(v, max)) fail(`${key} が不正（${max} 文字以下の文字列。制御文字なし）`);
  return v as string;
};
const oneOf = <T extends string>(o: Rec, key: string, values: readonly T[]): T => {
  const v = o[key];
  if (typeof v !== "string" || !values.includes(v as T))
    fail(`${key} は ${values.join("・")} のいずれか`);
  return v as T;
};
const options = (o: Rec, key: string): string[] => {
  const v = o[key];
  if (
    !Array.isArray(v) ||
    v.length < 1 ||
    v.length > LIMITS.optionCount ||
    !v.every((x) => isBoundedText(x, LIMITS.optionLength) && x !== "") ||
    new Set(v).size !== v.length
  ) {
    fail(
      `${key} が不正（重複なし、1〜${LIMITS.optionCount} 件、各 ${LIMITS.optionLength} 文字以下）`,
    );
  }
  return [...(v as string[])];
};
const strict = (o: unknown, allowed: readonly string[]): Rec => {
  if (!isRec(o)) return fail("params が JSON のオブジェクトでない");
  if (!hasOnly(o, allowed)) fail(`未知のキーがある（許可: ${allowed.join("・") || "なし"}）`);
  return o;
};
const nodeIdOnly = (p: unknown) => {
  const o = strict(p, ["nodeId"]);
  return { nodeId: id(o, "nodeId") };
};

const BRIEF_KEYS = ["objective", "acceptanceCriteria", "scope", "dependsOn"] as const;
/** ブリーフ（spec 5.2）の検査は core の `briefProblem` を使う（作業ツリー・ブランチは受けない）。 */
const brief = (o: Rec): Brief => {
  const problem = briefProblem(o);
  if (problem !== undefined) fail(problem);
  const b = o as unknown as Brief;
  return {
    objective: b.objective,
    acceptanceCriteria: [...b.acceptanceCriteria],
    scope: {
      writableLocations: [...b.scope.writableLocations],
      forbiddenLocations: [...b.scope.forbiddenLocations],
      allowedCommands: [...b.scope.allowedCommands],
    },
    ...(b.dependsOn === undefined ? {} : { dependsOn: [...b.dependsOn] }),
  };
};

type Validators = { [Op in DaemonOperation]: (p: unknown) => OperationMap[Op]["params"] };

const VALIDATORS: Validators = {
  "node.spawn": (p) => {
    const o = strict(p, ["parentId", "role", ...BRIEF_KEYS]);
    return {
      parentId: id(o, "parentId"),
      role: oneOf(o, "role", NODE_ROLES),
      ...brief(o),
    };
  },
  "node.send": (p) => {
    const o = strict(p, ["nodeId", "text"]);
    return { nodeId: id(o, "nodeId"), text: text(o, "text", LIMITS.reportText) };
  },
  "node.stop": (p) => {
    const o = strict(p, ["nodeId", "mode", "graceMs"]);
    const nodeId = id(o, "nodeId");
    const mode = oneOf(o, "mode", ["graceful", "immediate"] as const);
    if (o.graceMs === undefined) {
      return mode === "graceful" ? { nodeId, mode: "graceful" } : { nodeId, mode: "immediate" };
    }
    // 猶予時間は穏当な停止（graceful）のときだけ。即時停止に猶予はない。
    if (mode !== "graceful") fail("graceMs は mode が graceful のときだけ指定できる");
    const g = o.graceMs;
    if (typeof g !== "number" || !Number.isInteger(g) || g < 1 || g > MAX_GRACE_MS) {
      fail(`graceMs が不正（1〜${MAX_GRACE_MS} の整数）`);
    }
    return { nodeId, mode, graceMs: g as number };
  },
  "inbox.fetch": (p) => {
    const o = strict(p, ["sinceSeq"]);
    const s = o.sinceSeq;
    if (s === undefined) return {};
    if (typeof s !== "number" || !Number.isInteger(s) || s < 0)
      fail("sinceSeq が 0 以上の整数でない");
    return { sinceSeq: s as number };
  },
  "tree.list": (p) => {
    strict(p, []);
    return {};
  },
  "decision.present": (p) => {
    const o = strict(p, ["question", "options", "pauseNodeIds"]);
    const base = { question: text(o, "question", LIMITS.question), options: options(o, "options") };
    if (o.pauseNodeIds === undefined) return base;
    const problem = pauseNodeIdsProblem(o.pauseNodeIds);
    if (problem !== undefined) fail(problem);
    const ids = [...(o.pauseNodeIds as string[])];
    return { ...base, pauseNodeIds: ids };
  },
  "node.split": (p) => {
    const o = strict(p, ["nodeId", "keep", ...BRIEF_KEYS]);
    return {
      nodeId: id(o, "nodeId"),
      keep: oneOf(o, "keep", ["mainline", "stop"] as const),
      ...brief(o),
    };
  },
  "scope.decide": (p) => {
    const o = strict(p, ["extensionId", "decision"]);
    return {
      extensionId: id(o, "extensionId"),
      decision: oneOf(o, "decision", ["approve", "reject", "split"] as const),
    };
  },
  "node.review": (p) => {
    const o = strict(p, ["nodeId", "verdict", "feedback"]);
    const nodeId = id(o, "nodeId");
    const verdict = oneOf(o, "verdict", ["accept", "reject"] as const);
    if (verdict === "reject") {
      // 差し戻しには理由が要る（子が直す手がかり）。
      const feedback = text(o, "feedback", LIMITS.feedback);
      if (feedback.trim() === "") fail("reject には feedback（差し戻しの理由）が必要");
      return { nodeId, verdict, feedback };
    }
    if (o.feedback === undefined) return { nodeId, verdict };
    return { nodeId, verdict, feedback: text(o, "feedback", LIMITS.feedback) };
  },
  "node.reclaimPreview": nodeIdOnly,
  "node.reclaim": nodeIdOnly,
  "node.capabilities": nodeIdOnly,
  "decision.get": (p) => {
    const o = strict(p, ["decisionId"]);
    return { decisionId: id(o, "decisionId") };
  },
  "report.get": (p) => {
    const o = strict(p, ["reportId"]);
    return { reportId: id(o, "reportId") };
  },
  "report.progress": (p) => {
    const o = strict(p, ["text"]);
    return { text: text(o, "text", LIMITS.reportText) };
  },
  "report.decision": (p) => {
    const o = strict(p, ["question", "options"]);
    return { question: text(o, "question", LIMITS.question), options: options(o, "options") };
  },
  "report.outOfScope": (p) => {
    const o = strict(p, ["text"]);
    return { text: text(o, "text", LIMITS.reportText) };
  },
  "report.done": (p) => {
    const o = strict(p, ["evidence"]);
    const v = o.evidence;
    if (!Array.isArray(v) || v.length > LIMITS.evidenceCount)
      fail(`evidence が不正（${LIMITS.evidenceCount} 件以下の配列）`);
    const evidence = (v as unknown[]).map((x) => {
      const e = strict(x, ["criterion", "evidence"]);
      const criterion = text(e, "criterion", LIMITS.evidenceLength);
      const body = text(e, "evidence", LIMITS.evidenceLength);
      if (criterion.trim() === "" || body.trim() === "") fail("criterion・evidence が空白だけ");
      return { criterion, evidence: body };
    });
    return { evidence };
  },
  "scope.extend": (p) => {
    const o = strict(p, ["target", "reason"]);
    const t = strict(o.target, ["kind", "value"]);
    const value = text(t, "value", LIMITS.extensionTarget);
    if (value.trim() === "") fail("target.value が空");
    const reason = text(o, "reason", LIMITS.extensionReason);
    if (reason.trim() === "") fail("reason が空");
    return { target: { kind: oneOf(t, "kind", ["write", "command"] as const), value }, reason };
  },
  "decision.answer": (p) => {
    const o = strict(p, ["decisionId", "choice", "text"]);
    const decisionId = id(o, "decisionId");
    const hasChoice = o.choice !== undefined;
    const hasText = o.text !== undefined;
    if (hasChoice === hasText) fail("choice か text のどちらか一方を指定する");
    return hasChoice
      ? { decisionId, choice: text(o, "choice", LIMITS.optionLength) }
      : { decisionId, text: text(o, "text", LIMITS.reportText) };
  },
  "node.reclaimInstruct": nodeIdOnly,
  "node.purge": (p) => {
    const o = strict(p, ["nodeId", "tombstone"]);
    const nodeId = id(o, "nodeId");
    if (o.tombstone === undefined) return { nodeId };
    if (typeof o.tombstone !== "boolean") fail("tombstone が真偽値でない");
    return { nodeId, tombstone: o.tombstone as boolean };
  },
  "node.purgePreview": nodeIdOnly,
};

/** 操作ごとの引数を検査し、新しいオブジェクトに写して返す。 */
export function validateParams<Op extends DaemonOperation>(
  operation: Op,
  params: unknown,
): Result<OperationMap[Op]["params"], Failure> {
  try {
    const validator = Object.hasOwn(VALIDATORS, operation) ? VALIDATORS[operation] : undefined;
    if (validator === undefined) return { ok: false, error: bad("未知の操作") };
    return { ok: true, value: validator(params) as OperationMap[Op]["params"] };
  } catch (e) {
    return { ok: false, error: bad(e instanceof Invalid ? e.message : "引数を検査できない") };
  }
}
