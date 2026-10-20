import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CONTRACT_ROLES,
  type ContractRole,
  DAEMON_OPERATIONS,
  type DaemonOperation,
  type DaemonRequest,
  DEFAULT_PURGE_TOMBSTONE,
  err,
  type Failure,
  failure,
  isErr,
  isFailure,
  isOk,
  mapResult,
  type OperationMap,
  ok,
  type Result,
  ROLE_OPERATIONS,
  type RoleOperation,
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
    };
    expect(preview.nodeIds).toHaveLength(2);
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
