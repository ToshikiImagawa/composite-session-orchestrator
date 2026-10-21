import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CONTRACT_ROLES,
  type ContractRole,
  DAEMON_OPERATIONS,
  type DaemonOperation,
  type DaemonRequest,
  type DaemonResponse,
  DEFAULT_PURGE_TOMBSTONE,
  err,
  type Failure,
  failure,
  INTEGRATOR_OPERATION_CLASS,
  isErr,
  isFailure,
  isOk,
  mapResult,
  type OperationMap,
  ok,
  type Result,
  ROLE_OPERATIONS,
  type RoleOperation,
  SUBTREE_RULES,
  SUBTREE_SCOPED_OPERATIONS,
} from "../src/index.js";

describe("Result（NFR_010）", () => {
  it("ok は値を持つ", () => {
    const r: Result<number> = ok(1);
    expect(isOk(r)).toBe(true);
    expect(r).toEqual({ ok: true, value: 1 });
  });

  it("err は原因と次の操作を必ず持つ", () => {
    const f: Failure = failure("not_found", "ノード n1 がない", "一覧を取得する");
    const r: Result<number> = err(f);
    expect(isErr(r)).toBe(true);
    expect(r).toEqual({ ok: false, error: f });
  });

  it("mapResult は成功のみ変換し、失敗はそのまま返す", () => {
    expect(mapResult(ok(1), (n) => n + 1)).toEqual(ok(2));
    const e = err(failure("x", "c", "a"));
    expect(mapResult(e, (n: number) => n + 1)).toBe(e);
  });
});

describe("failure / isFailure", () => {
  it("次の操作が空なら型でも実行時でも拒否する", () => {
    // @ts-expect-error nextActions は 1 件以上が必要
    expect(() => failure("x", "c")).toThrow(RangeError);
  });

  it("isFailure は nextActions が空・欠落の値を弾く", () => {
    expect(isFailure({ code: "x", cause: "c", nextActions: ["a"] })).toBe(true);
    expect(isFailure({ code: "x", cause: "c", nextActions: [] })).toBe(false);
    expect(isFailure({ code: "x", cause: "c" })).toBe(false);
    expect(isFailure(null)).toBe(false);
  });
});

describe("操作の契約（NFR_004, DC_003）", () => {
  it("DAEMON_OPERATIONS に重複がない", () => {
    expect(new Set(DAEMON_OPERATIONS).size).toBe(DAEMON_OPERATIONS.length);
  });

  it("node.purge は人間のコマンドだけが持つ", () => {
    const holders = CONTRACT_ROLES.filter((r) =>
      (ROLE_OPERATIONS[r] as readonly string[]).includes("node.purge"),
    );
    expect(holders).toEqual(["human"]);
  });

  it("人間は purge の事前確認（node.purgePreview）を持ち、統合ノードは decision.get・report.get を持つ", () => {
    expect(ROLE_OPERATIONS.human).toContain("node.purgePreview");
    expect(ROLE_OPERATIONS.integrator).toEqual(
      expect.arrayContaining(["decision.get", "report.get"]),
    );
    for (const op of ["node.purgePreview", "decision.get", "report.get"]) {
      const holders = CONTRACT_ROLES.filter((r) =>
        (ROLE_OPERATIONS[r] as readonly string[]).includes(op),
      );
      expect(holders, op).toHaveLength(1);
    }
  });

  it("node.purge の墓標の選択は任意（省略は後方互換）、purgePreview は削除される木・アーカイブ日・経過日数を返す", () => {
    const human = (r: DaemonRequest<"human">) => r;
    const b = { requestId: "r3", role: "human" } as const;
    human({ ...b, operation: "node.purge", params: { nodeId: "n" } });
    human({ ...b, operation: "node.purge", params: { nodeId: "n", tombstone: false } });
    // @ts-expect-error tombstone は真偽値
    human({ ...b, operation: "node.purge", params: { nodeId: "n", tombstone: "yes" } });
    const preview: OperationMap["node.purgePreview"]["result"] = {
      nodeIds: ["root", "a"],
      archivedAt: "2026-07-01T00:00:00Z",
      elapsedDays: 111,
      retentionDays: 90,
      tombstoneTitle: "目的",
      purgeable: true,
      blockers: [],
    };
    expect(preview.nodeIds).toHaveLength(2);
  });

  it("統合ノードの操作を、部分木の規則・呼び出し側で絞る・拒否の 3 つに分類する（表は型で網羅される）", () => {
    for (const op of ROLE_OPERATIONS.integrator) {
      expect(["subtree", "callerFiltered", "denied"], op).toContain(INTEGRATOR_OPERATION_CLASS[op]);
    }
    expect(Object.keys(INTEGRATOR_OPERATION_CLASS).sort()).toEqual(
      [...ROLE_OPERATIONS.integrator].sort(),
    );
    expect(INTEGRATOR_OPERATION_CLASS["inbox.fetch"]).toBe("callerFiltered");
    expect(INTEGRATOR_OPERATION_CLASS["tree.list"]).toBe("callerFiltered");
    // 拡張要求の判定は、発生元（拡張要求の nodeId）が自分の部分木のときだけ（人間は全ノード）
    expect(INTEGRATOR_OPERATION_CLASS["scope.decide"]).toBe("subtree");
  });

  it("部分木の規則の表: 操作ごとに strictDescendant・directChild・selfOrDescendant を決める", () => {
    expect(SUBTREE_RULES).toEqual({
      "node.spawn": "selfOrDescendant", // parentId。自分の子を作れる
      "node.send": "strictDescendant",
      "node.stop": "strictDescendant", // 自分の停止は、親か人間だけができる
      "node.split": "strictDescendant",
      "node.review": "directChild", // 完了の判定は親だけ
      "node.reclaimPreview": "strictDescendant",
      "node.reclaim": "strictDescendant",
      "node.capabilities": "strictDescendant",
      "decision.present": "strictDescendant", // pauseNodeIds のすべて
      "scope.decide": "strictDescendant", // 拡張の発生元のノード
      "decision.get": "selfOrDescendant", // 記録のノード
      "report.get": "selfOrDescendant",
    });
    expect([...SUBTREE_SCOPED_OPERATIONS].sort()).toEqual(Object.keys(SUBTREE_RULES).sort());
    for (const op of SUBTREE_SCOPED_OPERATIONS) {
      expect(INTEGRATOR_OPERATION_CLASS[op], op).toBe("subtree");
    }
  });

  it("要求の caller（daemon が認証で決めるノード）は任意で、クライアントは必須にされない", () => {
    const integ = (r: DaemonRequest<"integrator">) => r;
    const b = { requestId: "r9", role: "integrator", operation: "node.stop" } as const;
    integ({ ...b, params: { nodeId: "n1", mode: "graceful" } });
    const withCaller = integ({
      ...b,
      caller: { nodeId: "m1" },
      params: { nodeId: "n1", mode: "graceful" },
    });
    expect(withCaller.caller?.nodeId).toBe("m1");
  });

  it("墓標の既定は「残す」（監査 NFR_011 と誤削除の追跡のため安全側。保持ポリシーの設定で変えられる）", () => {
    expect(DEFAULT_PURGE_TOMBSTONE).toBe(true);
  });

  it("child ロールは spawn / purge を型で表せない", () => {
    const child = (r: DaemonRequest<"child">) => r;
    const b = { requestId: "r1", role: "child" } as const;
    const good = child({ ...b, operation: "report.progress", params: { text: "半分" } });
    expect(good.operation).toBe("report.progress");
    // @ts-expect-error child は node.purge を持たない
    child({ ...b, operation: "node.purge", params: { nodeId: "n" } });
    // @ts-expect-error child は node.spawn を持たない
    child({ ...b, operation: "node.spawn", params: { brief: "", parentId: "" } });
  });

  it("操作ごとに params の型が決まる", () => {
    const integ = (r: DaemonRequest<"integrator">) => r;
    const b = { requestId: "r2", role: "integrator", operation: "node.stop" } as const;
    const good = integ({ ...b, params: { nodeId: "n1", mode: "graceful" } });
    expect(good.params).toEqual({ nodeId: "n1", mode: "graceful" });
    // @ts-expect-error mode は graceful / immediate のみ
    integ({ ...b, params: { nodeId: "n1", mode: "now" } });
  });

  it("すべての操作がいずれかのロールに属する（型）", () => {
    type Unassigned = Exclude<DaemonOperation, RoleOperation<ContractRole>>;
    expectTypeOf<Unassigned>().toEqualTypeOf<never>();
    expect(new Set(DAEMON_OPERATIONS).size).toBeGreaterThan(0);
  });
});

describe("紐付けは契約から外れている（T13c）", () => {
  it("node.bind はどのロールにも、操作の一覧にもない（紐付けは POST /v1/bind）", () => {
    expect((DAEMON_OPERATIONS as readonly string[]).includes("node.bind")).toBe(false);
    for (const r of CONTRACT_ROLES) {
      expect((ROLE_OPERATIONS[r] as readonly string[]).includes("node.bind")).toBe(false);
    }
  });
});

describe("ブリーフを受ける操作（spec 5.2）", () => {
  const scope = { writableLocations: ["/w"], forbiddenLocations: [], allowedCommands: [] };
  const brief = { objective: "o", acceptanceCriteria: ["a"], scope };
  const integ = (r: DaemonRequest<"integrator">) => r;

  it("node.spawn は parentId・role と、ブリーフ（dependsOn は省略可）を受ける", () => {
    const b = { requestId: "r", role: "integrator", operation: "node.spawn" } as const;
    const r = integ({ ...b, params: { parentId: "p", role: "implement", ...brief } });
    expect(r.params).toMatchObject({ role: "implement" });
    integ({ ...b, params: { parentId: "p", role: "review", ...brief, dependsOn: ["n1"] } });
    const p = { parentId: "p", role: "implement" } as const;
    // @ts-expect-error 作業ツリー・ブランチは params に含めない（アダプタが決める）
    integ({ ...b, params: { ...p, ...brief, branch: "x" } });
    const old = { parentId: "p", brief: "x" } as const;
    // @ts-expect-error 旧形式（brief 文字列）は受けない
    integ({ ...b, params: old });
  });

  it("node.split は nodeId・keep と同じブリーフを受ける", () => {
    const b = { requestId: "r", role: "integrator", operation: "node.split" } as const;
    integ({ ...b, params: { nodeId: "n", keep: "mainline", ...brief } });
    const noObjective = { nodeId: "n", keep: "stop", acceptanceCriteria: ["a"], scope } as const;
    // @ts-expect-error ブリーフ（目的）がない
    integ({ ...b, params: noObjective });
  });

  it("node.review: 差し戻し（reject）には feedback が必須、受理（accept）では任意", () => {
    const b = { requestId: "r", role: "integrator", operation: "node.review" } as const;
    integ({ ...b, params: { nodeId: "n", verdict: "accept" } });
    integ({ ...b, params: { nodeId: "n", verdict: "accept", feedback: "よい" } });
    integ({ ...b, params: { nodeId: "n", verdict: "reject", feedback: "基準 2 の根拠がない" } });
    const noFeedback = { nodeId: "n", verdict: "reject" } as const;
    // @ts-expect-error reject には feedback が要る
    integ({ ...b, params: noFeedback });
  });
});

describe("node.send・node.stop・scope.extend の契約", () => {
  const integ = (r: DaemonRequest<"integrator">) => r;
  const child = (r: DaemonRequest<"child">) => r;

  it("node.send の結果は { status: 'queued' }（届いたかではなく、受け付けた）", () => {
    expectTypeOf<DaemonResponse<"node.send">>().toEqualTypeOf<
      Result<{ status: "queued"; duplicate: boolean }>
    >();
  });

  it("node.stop の graceMs は graceful のときだけ指定できる", () => {
    const b = { requestId: "r", role: "integrator", operation: "node.stop" } as const;
    integ({ ...b, params: { nodeId: "n", mode: "graceful" } });
    integ({ ...b, params: { nodeId: "n", mode: "graceful", graceMs: 5000 } });
    integ({ ...b, params: { nodeId: "n", mode: "immediate" } });
    // @ts-expect-error immediate には猶予がない
    integ({ ...b, params: { nodeId: "n", mode: "immediate", graceMs: 1000 } });
  });

  it("scope.extend の対象は { kind, value } に構造化される", () => {
    const b = { requestId: "r", role: "child", operation: "scope.extend" } as const;
    child({ ...b, params: { target: { kind: "write", value: "/w/docs" }, reason: "必要" } });
    child({ ...b, params: { target: { kind: "command", value: "git status" }, reason: "必要" } });
    const old = { target: "docs", reason: "必要" } as const;
    // @ts-expect-error 文字列の対象は受けない
    child({ ...b, params: old });
  });
});
