import type { EventBody, Failure, NodeEvent } from "@cso/core";
import { failure } from "@cso/core";
import { describe, expect, it } from "vitest";
import { createPurgeHandlers } from "../../../src/api/handlers/purge-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";
import { EventLog } from "../../../src/eventlog.js";
import { createMemoryStore } from "../../../src/memory-store.js";

const SYS = { system: true } as const;
let n = 0;
const clock = (): string => `2026-01-10T00:00:${String(++n % 60).padStart(2, "0")}Z`;
const SCOPE = { writableLocations: ["src"], forbiddenLocations: [".git"], allowedCommands: [] };
const DAY = 86_400_000;
const ARCHIVED_AT = Date.parse("2026-01-10T00:02:00Z");

const rig = (
  over: { retentionDays?: number; defaultTombstone?: boolean; discarded?: boolean } = {},
) => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `seed-${++n}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  const node = (
    nodeId: string,
    role: "integrator" | "implement",
    parentId: string | null,
    objective?: string,
  ) =>
    add({
      type: "node.created",
      payload: {
        nodeId,
        role,
        parentId,
        dependsOn: [],
        ...(objective === undefined ? {} : { objective, acceptanceCriteria: ["c"], scope: SCOPE }),
      },
    });
  node("root", "integrator", null);
  ev("root", { type: "start" });
  node("t", "integrator", "root", "木の目的\n二行目");
  ev("t", { type: "start" });
  node("c", "implement", "t", "子の目的");
  ev("c", { type: "start" });
  node("o", "implement", "root", "別の木");
  ev("o", { type: "start" });
  ev("c", { type: "reportDone" });
  ev("c", { type: "accept" });
  ev("c", { type: "markReclaimable", discarded: false });
  ev("c", { type: "archive" });
  if (over.discarded === true) {
    ev("t", { type: "stop", mode: "immediate" });
    ev("t", { type: "confirmStopped" });
    add({ type: "node.discardDecided", payload: { nodeId: "t" } });
    ev("t", { type: "markReclaimable", discarded: true });
    ev("t", { type: "archive" });
  } else {
    ev("t", { type: "reportDone" });
    ev("t", { type: "accept" });
    ev("t", { type: "markReclaimable", discarded: false });
    ev("t", { type: "archive" });
  }

  const calls = {
    revoked: [] as string[],
    audit: [] as string[],
    failures: [] as string[],
  };
  let nowMs = ARCHIVED_AT;
  const h = createPurgeHandlers({
    log,
    nowMs: () => nowMs,
    retentionDays: over.retentionDays ?? 90,
    defaultTombstone: over.defaultTombstone ?? true,
    revokeNode: (id) => calls.revoked.push(id),
    audit: (event) => calls.audit.push(event),
    onFailure: (_id, cause) => calls.failures.push(cause),
  });
  const call = (
    op: "node.purge" | "node.purgePreview",
    params: Record<string, unknown>,
    role = "human",
    requestId = `q-${++n}`,
  ) =>
    // biome-ignore lint/suspicious/noExplicitAny: 操作ごとの型は呼び出し側で保証
    (h[op] as any)({
      requestId,
      operation: op,
      role,
      params,
    } as unknown as HandlerRequest<never>) as {
      ok: boolean;
      // biome-ignore lint/suspicious/noExplicitAny: テスト用
      value?: any;
      error?: Failure;
    };
  return {
    log,
    call,
    calls,
    advance: (days: number) => {
      nowMs = ARCHIVED_AT + days * DAY;
    },
  };
};

describe("node.purgePreview・node.purge（最終削除）", () => {
  it("人間以外は、どちらも拒否する", () => {
    const r = rig();
    for (const op of ["node.purge", "node.purgePreview"] as const) {
      const res = r.call(op, { nodeId: "t" }, "integrator");
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("forbidden");
    }
  });

  it("事前確認は、削除される木・アーカイブ日・経過日数を返し、何も変えない", () => {
    const r = rig();
    r.advance(10);
    const before = r.log.state();
    const res = r.call("node.purgePreview", { nodeId: "t" });
    expect(res.value).toEqual({
      nodeIds: ["c", "t"],
      archivedAt: expect.any(String),
      elapsedDays: 10,
    });
    expect(r.log.state()).toEqual(before);
  });

  it("保持期間が過ぎていなければ、残り日数つきで拒否する。何も消えない", () => {
    const r = rig();
    r.advance(89);
    const before = r.log.state();
    const res = r.call("node.purge", { nodeId: "t" });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("retentionNotElapsed");
    expect(res.error?.cause).toContain("残り 1 日");
    expect(r.log.state()).toEqual(before);
    expect(r.calls.revoked).toEqual([]);
  });

  it("保持期間後は、木を消し、標識を残す。木のノードのトークンを失効し、前後の監査を記録する", () => {
    const r = rig();
    r.advance(90);
    const res = r.call("node.purge", { nodeId: "t" });
    expect(res.ok).toBe(true);
    expect(res.value.purged).toEqual(["c", "t"]);
    expect(
      r.log
        .state()
        .nodes.map((x) => x.id)
        .sort(),
    ).toEqual(["o", "root"]);
    expect(r.calls.revoked).toEqual(["c", "t"]);
    expect(r.calls.audit).toEqual(["purgeStarting", "purged"]);
  });

  it("墓標は既定で残す（タイトルは目的の先頭行、結果は verified）。tombstone の指定・設定の既定で変えられる", () => {
    const a = rig();
    a.advance(90);
    a.call("node.purge", { nodeId: "t" });
    expect(a.log.state().tombstones[0]?.tombstone).toEqual({
      title: "木の目的",
      outcome: "verified",
    });
    const b = rig();
    b.advance(90);
    b.call("node.purge", { nodeId: "t", tombstone: false });
    expect(b.log.state().tombstones[0]?.tombstone).toBeUndefined();
    const c = rig({ defaultTombstone: false });
    c.advance(90);
    c.call("node.purge", { nodeId: "t" });
    expect(c.log.state().tombstones[0]?.tombstone).toBeUndefined();
    const d = rig({ defaultTombstone: false });
    d.advance(90);
    d.call("node.purge", { nodeId: "t", tombstone: true });
    expect(d.log.state().tombstones[0]?.tombstone?.title).toBe("木の目的");
  });

  it("設定で保持期間を 0 にすれば、すぐ消せる", () => {
    const r = rig({ retentionDays: 0 });
    expect(r.call("node.purge", { nodeId: "t" }).ok).toBe(true);
  });

  it("同じ requestId の再送は、何も消さずに最初の結果を返す（トークンの失効・監査を重ねない）", () => {
    const r = rig();
    r.advance(90);
    const first = r.call("node.purge", { nodeId: "t" }, "human", "same");
    const second = r.call("node.purge", { nodeId: "t" }, "human", "same");
    expect(second.ok).toBe(true);
    expect(second.value).toEqual(first.value);
    expect(r.calls.revoked).toEqual(["c", "t"]);
    expect(r.calls.audit).toEqual(["purgeStarting", "purged"]);
  });

  it("削除できない木（最上位でない・アーカイブでない・存在しない）は、理由つきで拒否する", () => {
    const r = rig();
    r.advance(90);
    expect(r.call("node.purge", { nodeId: "c" }).error?.code).toBe("notTopOfTree");
    expect(r.call("node.purge", { nodeId: "o" }).error?.code).toBe("notArchived");
    expect(r.call("node.purge", { nodeId: "zz" }).error?.code).toBe("notFound");
  });

  it("ログの削除が失敗したら、失敗を返し、監査と onFailure に残す（トークンは失効しない）", () => {
    const base = rig();
    base.advance(90);
    const failing = {
      state: () => base.log.state(),
      purgeTree: () => ({ ok: false as const, error: failure("storeIntegrity", "x", "y") }),
    };
    const audits: string[] = [];
    const failures: string[] = [];
    const revoked: string[] = [];
    const h = createPurgeHandlers({
      log: failing,
      nowMs: () => ARCHIVED_AT + 90 * DAY,
      retentionDays: 90,
      defaultTombstone: true,
      revokeNode: (id) => revoked.push(id),
      audit: (e) => audits.push(e),
      onFailure: (_id, cause) => failures.push(cause),
    });
    const res = h["node.purge"]({
      requestId: "q",
      operation: "node.purge",
      role: "human",
      params: { nodeId: "t" },
    } as never);
    expect(res.ok).toBe(false);
    expect(audits).toEqual(["purgeStarting", "purgeFailed"]);
    expect(failures[0]).toContain("storeIntegrity");
    expect(revoked).toEqual([]);
  });

  it("破棄された木（根が破棄の判断を経たもの）は、結果が discarded になる", () => {
    const r = rig({ discarded: true });
    r.advance(90);
    expect(r.call("node.purge", { nodeId: "t" }).ok).toBe(true);
    expect(r.log.state().tombstones[0]?.tombstone?.outcome).toBe("discarded");
  });
});
