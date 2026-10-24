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
  over: {
    retentionDays?: number;
    defaultTombstone?: boolean;
    discarded?: boolean;
    lastCommit?: string;
    onPurgedThrows?: boolean;
    /** イベントの時刻を、daemon の時計（`nowMs`）に合わせる（本番は、同じ時計）。 */
    syncClock?: boolean;
  } = {},
) => {
  let nowMs = ARCHIVED_AT;
  const opened = EventLog.open(createMemoryStore().open(), {
    clock: over.syncClock === true ? () => new Date(nowMs).toISOString() : clock,
  });
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

  if (over.lastCommit !== undefined) {
    add({ type: "node.lastCommit", payload: { nodeId: "t", commit: over.lastCommit } });
  }

  const calls = {
    revoked: [] as string[],
    audit: [] as string[],
    failures: [] as string[],
    purged: [] as string[][],
  };
  const h = createPurgeHandlers({
    log,
    nowMs: () => nowMs,
    retentionDays: over.retentionDays ?? 90,
    defaultTombstone: over.defaultTombstone ?? true,
    revokeNode: (id) => calls.revoked.push(id),
    audit: (event) => calls.audit.push(event),
    onFailure: (_id, cause) => calls.failures.push(cause),
    onPurged: (ids) => {
      calls.purged.push([...ids]);
      if (over.onPurgedThrows === true) throw new Error("後始末の失敗");
    },
  });
  const call = (
    op: "node.purge" | "node.purgePreview" | "node.purgeHold" | "node.purgeRelease",
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
      retentionDays: 90,
      tombstoneTitle: "木の目的",
      purgeable: false,
      blockers: [{ code: "retentionNotElapsed", cause: expect.stringContaining("残り 80 日") }],
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

  it("expectNodeIds（事前確認で見せた木）: 順序が違っても、集合が一致すれば消す。違えば、何も消さずに purgeStale（T23-d）", () => {
    const stale = rig();
    stale.advance(90);
    const before = stale.log.state();
    for (const wrong of [["t"], ["c"], ["t", "c", "o"], ["t", "x"]]) {
      const res = stale.call("node.purge", { nodeId: "t", expectNodeIds: wrong });
      expect(res.ok, JSON.stringify(wrong)).toBe(false);
      expect(res.error?.code).toBe("purgeStale");
    }
    expect(stale.log.state()).toEqual(before);
    expect(stale.calls.revoked).toEqual([]);
    expect(stale.calls.audit).toEqual([]);
    const ok = stale.call("node.purge", { nodeId: "t", expectNodeIds: ["t", "c"] });
    expect(ok.ok).toBe(true);
    expect(ok.value.purged).toEqual(["c", "t"]);
  });

  it("expectNodeIds: 木がもうないときの同じ requestId の再送は、照合せずに最初の結果を返す。expectNodeIds なしは、これまでどおり", () => {
    const r = rig();
    r.advance(90);
    const first = r.call("node.purge", { nodeId: "t", expectNodeIds: ["c", "t"] }, "human", "same");
    const second = r.call(
      "node.purge",
      { nodeId: "t", expectNodeIds: ["c", "t"] },
      "human",
      "same",
    );
    expect(second.ok).toBe(true);
    expect(second.value).toEqual(first.value);
    const plain = rig();
    plain.advance(90);
    expect(plain.call("node.purge", { nodeId: "t" }).ok).toBe(true);
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
      checkPurge: () => ({ ok: true as const, value: { deleteCount: 0 } }),
      appendAll: () => ({ ok: true as const, value: [] }),
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

  it("最終コミットの記録（node.lastCommit）があれば、墓標の lastCommit に載せる。なければ載せない", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const a = rig({ lastCommit: sha });
    a.advance(90);
    expect(a.call("node.purge", { nodeId: "t" }).ok).toBe(true);
    expect(a.log.state().tombstones[0]?.tombstone).toEqual({
      title: "木の目的",
      outcome: "verified",
      lastCommit: sha,
    });
    const b = rig();
    b.advance(90);
    b.call("node.purge", { nodeId: "t" });
    expect(b.log.state().tombstones[0]?.tombstone?.lastCommit).toBeUndefined();
  });

  it("破棄された木（根が破棄の判断を経たもの）は、結果が discarded になる", () => {
    const r = rig({ discarded: true });
    r.advance(90);
    expect(r.call("node.purge", { nodeId: "t" }).ok).toBe(true);
    expect(r.log.state().tombstones[0]?.tombstone?.outcome).toBe("discarded");
  });

  it("事前確認は、保持期間が過ぎていれば purgeable（blockers は空）", () => {
    const r = rig();
    r.advance(90);
    const ok1 = r.call("node.purgePreview", { nodeId: "t" });
    expect(ok1.value.purgeable).toBe(true);
    expect(ok1.value.blockers).toEqual([]);
  });

  it("再送で、標識の木の根が違えば requestIdConflict（同じ requestId を別の対象に使い回せない）", () => {
    const r = rig();
    r.advance(90);
    r.call("node.purge", { nodeId: "t" }, "human", "same");
    const other = r.call("node.purge", { nodeId: "o" }, "human", "same");
    expect(other.ok).toBe(false);
    expect(other.error?.code).toBe("requestIdConflict");
  });

  it("木の外の判断要求が pauseNodeIds で木のノードを指していても、事前確認の blockers に入れず、purge できる", () => {
    const r = rig();
    r.advance(90);
    const add = r.log.append({
      requestId: "dx",
      actor: SYS,
      body: {
        type: "decision.requested",
        payload: { decisionId: "dx", nodeId: "root", question: "q", pauseNodeIds: ["c"] },
      },
    });
    expect(add.ok).toBe(true);
    const preview = r.call("node.purgePreview", { nodeId: "t" });
    expect(preview.value.blockers).toEqual([]);
    expect(preview.value.purgeable).toBe(true);
    const res = r.call("node.purge", { nodeId: "t" });
    expect(res.ok).toBe(true);
    expect(r.log.state().nodes.some((x) => x.id === "t")).toBe(false);
  });
});

describe("node.purgeHold・node.purgeRelease（自動の最終削除の保留。T13f-h）", () => {
  const UNTIL = "2026-03-01T00:00:00Z";

  it("人間以外は、どちらも拒否する（forbidden）。何も記録しない", () => {
    const r = rig();
    const before = r.log.state().lastSeq;
    for (const op of ["node.purgeHold", "node.purgeRelease"] as const) {
      for (const role of ["integrator", "child"]) {
        const res = r.call(op, { nodeId: "t" }, role);
        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe("forbidden");
      }
    }
    expect(r.log.state().lastSeq).toBe(before);
  });

  it("保留を記録する（無期限・期限つき・理由つき）。事前確認に、有効な保留が出る", () => {
    const r = rig();
    const res = r.call("node.purgeHold", { nodeId: "t", until: UNTIL, reason: "調査中" });
    expect(res).toEqual({ ok: true, value: { held: true, until: UNTIL } });
    expect(r.log.state().nodes.find((x) => x.id === "t")?.purgeHold).toMatchObject({
      until: UNTIL,
      reason: "調査中",
      by: { human: true },
    });
    r.advance(40);
    const preview = r.call("node.purgePreview", { nodeId: "t" });
    expect(preview.value.hold).toEqual({ nodeId: "t", until: UNTIL, reason: "調査中" });
    expect(r.calls.audit).toContain("held");
  });

  it("期限が過ぎた保留は、事前確認に出ない（期限は、daemon の時計で判定する）", () => {
    const r = rig();
    r.call("node.purgeHold", { nodeId: "t", until: UNTIL });
    r.advance(100); // 2026-04 ごろ（期限は 2026-03-01）
    expect(r.call("node.purgePreview", { nodeId: "t" }).value.hold).toBeUndefined();
  });

  it("木の根でないノード・存在しないノード・不正な期限は失敗する", () => {
    const r = rig();
    expect(r.call("node.purgeHold", { nodeId: "c" }).error?.code).toBe("notPurgeRoot");
    expect(r.call("node.purgeHold", { nodeId: "zz" }).error?.code).toBe("notFound");
    expect(
      r.call("node.purgeHold", { nodeId: "t", until: "2020-01-01T00:00:00Z" }).error?.code,
    ).toBe("invalidPurgeHoldUntil");
  });

  it("同じ requestId の再送は、重複して記録しない", () => {
    const r = rig();
    r.call("node.purgeHold", { nodeId: "t" }, "human", "same");
    const seq = r.log.state().lastSeq;
    expect(r.call("node.purgeHold", { nodeId: "t" }, "human", "same").ok).toBe(true);
    expect(r.log.state().lastSeq).toBe(seq);
  });

  it("days: 期限は、daemon の時計で、いまから days 日後（秒に切り捨て）。365 日も、短縮なしで通る", () => {
    const r = rig({ syncClock: true });
    for (const days of [1, 30, 364, 365]) {
      const res = r.call("node.purgeHold", { nodeId: "t", days });
      const until = new Date(ARCHIVED_AT + days * DAY).toISOString().replace(/\.\d{3}Z$/, "Z");
      expect(res, String(days)).toEqual({ ok: true, value: { held: true, until } });
      expect(r.log.state().nodes.find((x) => x.id === "t")?.purgeHold?.until).toBe(until);
    }
  });

  it("days: 時計の端数（ミリ秒）は切り捨てる。365 日でも、イベントの時刻から 365 日以内に収まる", () => {
    const r = rig({ syncClock: true });
    r.advance(0.5 / DAY); // 0.5 ミリ秒
    const res = r.call("node.purgeHold", { nodeId: "t", days: 365 });
    expect(res.value.until).toBe(
      new Date(ARCHIVED_AT + 365 * DAY).toISOString().replace(".000Z", "Z"),
    );
  });

  it("days: 同じ requestId の再送は、重複して記録せず、最初の期限を返す（再計算しない）", () => {
    const r = rig({ syncClock: true });
    const first = r.call("node.purgeHold", { nodeId: "t", days: 30 }, "human", "same-days");
    const seq = r.log.state().lastSeq;
    r.advance(10); // 10 日後の再送
    const again = r.call("node.purgeHold", { nodeId: "t", days: 30 }, "human", "same-days");
    expect(again).toEqual(first);
    expect(r.log.state().lastSeq).toBe(seq);
  });

  it("解除する。保留がなければ、そのまま成功する（冪等）。記録も増やさない", () => {
    const r = rig();
    r.call("node.purgeHold", { nodeId: "t" });
    expect(r.call("node.purgeRelease", { nodeId: "t" })).toEqual({
      ok: true,
      value: { released: true },
    });
    expect(r.log.state().nodes.find((x) => x.id === "t")?.purgeHold).toBeUndefined();
    const seq = r.log.state().lastSeq;
    expect(r.call("node.purgeRelease", { nodeId: "t" }).ok).toBe(true);
    expect(r.log.state().lastSeq).toBe(seq);
    expect(r.call("node.purgeRelease", { nodeId: "zz" }).error?.code).toBe("notFound");
  });

  it("人間の node.purge は、保留を無視して消せる。無視したことを監査に残す", () => {
    const r = rig();
    r.advance(90);
    r.call("node.purgeHold", { nodeId: "t" });
    const res = r.call("node.purge", { nodeId: "t" });
    expect(res.ok).toBe(true);
    expect(r.calls.audit).toContain("purgeHoldIgnored");
    expect(r.log.state().nodes.some((x) => x.id === "t")).toBe(false);
  });

  it("R1: 保留を無視して消したことは、標識（永続する記録）に残る。墓標を残さないときも残る（期限があれば holdUntil も）", () => {
    for (const tombstone of [true, false]) {
      const r = rig();
      r.advance(90);
      r.call("node.purgeHold", { nodeId: "t", until: "2026-12-01T00:00:00Z" });
      expect(r.call("node.purge", { nodeId: "t", tombstone }).ok).toBe(true);
      const rec = r.log.state().tombstones.at(-1);
      expect(rec?.holdIgnored).toBe(true);
      expect(rec?.holdUntil).toBe("2026-12-01T00:00:00Z");
      expect(rec?.tombstone !== undefined).toBe(tombstone);
    }
    const none = rig();
    none.advance(90);
    none.call("node.purge", { nodeId: "t" });
    expect(none.log.state().tombstones.at(-1)?.holdIgnored).toBeUndefined();
  });

  it("保留のない木では、保留の無視の監査を出さない", () => {
    const r = rig();
    r.advance(90);
    r.call("node.purge", { nodeId: "t" });
    expect(r.calls.audit).not.toContain("purgeHoldIgnored");
  });
});

describe("最終削除のあとの後始末（onPurged。T13f-r）", () => {
  it("最終削除に成功したら、消えた木のノードを渡す（保管している破棄した成果の掃除に使う）。失敗した最終削除・事前確認では呼ばない", () => {
    const r = rig();
    r.call("node.purgePreview", { nodeId: "t" });
    expect(r.calls.purged).toEqual([]);
    expect(r.call("node.purge", { nodeId: "t" }).ok).toBe(false); // 保持期間が過ぎていない
    expect(r.calls.purged).toEqual([]);
    r.advance(90);
    expect(r.call("node.purge", { nodeId: "t" }).ok).toBe(true);
    expect(r.calls.purged).toEqual([["c", "t"]]);
  });

  it("後始末が例外を投げても、最終削除は成功のまま。原因は onFailure に残る", () => {
    const r = rig({ onPurgedThrows: true });
    r.advance(90);
    expect(r.call("node.purge", { nodeId: "t" }).ok).toBe(true);
    expect(r.calls.failures.join("\n")).toContain("後始末に失敗");
  });
});

describe("事前確認の、保管している破棄した成果の数（discardedFor。T13f-r）", () => {
  it("discardedFor があれば、事前確認に discardedRefs を出す。失敗したら出さないだけ（事前確認は成功のまま）", async () => {
    const base = rig();
    const mk = (f: (ids: readonly string[]) => Promise<number>) =>
      createPurgeHandlers({
        log: base.log,
        nowMs: () => ARCHIVED_AT,
        retentionDays: 90,
        defaultTombstone: true,
        revokeNode: () => {},
        discardedFor: f,
      });
    const seen: string[][] = [];
    const ok = await mk(async (ids) => {
      seen.push([...ids]);
      return 4;
    })["node.purgePreview"]({
      requestId: "q",
      operation: "node.purgePreview",
      role: "human",
      params: { nodeId: "t" },
    } as unknown as HandlerRequest<"node.purgePreview">);
    expect(ok.ok && ok.value.discardedRefs).toBe(4);
    expect(seen).toEqual([["c", "t"]]);
    const bad = await mk(async () => {
      throw new Error("git が壊れている");
    })["node.purgePreview"]({
      requestId: "q",
      operation: "node.purgePreview",
      role: "human",
      params: { nodeId: "t" },
    } as unknown as HandlerRequest<"node.purgePreview">);
    expect(bad.ok).toBe(true);
    expect(bad.ok && bad.value.discardedRefs).toBeUndefined();
  });
});
