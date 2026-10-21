import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EventBody, NodeEvent, OrchState } from "@cso/core";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/eventlog.js";
import { createMemoryStore } from "../src/memory-store.js";
import { openSqliteStore } from "../src/sqlite-store.js";

const SYS = { system: true } as const;
let tick = 0;
const clock = (): string => `2026-10-20T00:00:${String(++tick % 60).padStart(2, "0")}Z`;

/** 標識（`node.purged`）。 */
const marker = (rootId: string): EventBody => ({
  type: "node.purged",
  payload: { rootId, nodeIds: ["c", "t"], archivedAt: "2026-01-10T00:00:00Z" },
});

const setup = (store = createMemoryStore().open(), onFatal?: (cause: string) => void) => {
  const opened = EventLog.open(store, {
    clock,
    ...(onFatal === undefined ? {} : { onFatal }),
  });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  let n = 0;
  const add = (body: EventBody) => {
    const r = log.append({ requestId: `s-${++n}-${Math.random()}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
    return r.value;
  };
  const ev = (nodeId: string, event: NodeEvent) =>
    add({ type: "node.stateChanged", payload: { nodeId, event } });
  const node = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
    add({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
  const archive = (nodeId: string) => {
    ev(nodeId, { type: "reportDone" });
    ev(nodeId, { type: "accept" });
    ev(nodeId, { type: "markReclaimable", discarded: false });
    ev(nodeId, { type: "archive" });
  };
  node("root", "integrator", null);
  ev("root", { type: "start" });
  node("t", "integrator", "root");
  ev("t", { type: "start" });
  node("c", "implement", "t");
  ev("c", { type: "start" });
  add({
    type: "report.added",
    payload: { reportId: "rc", nodeId: "c", kind: "progress", text: "t" },
  });
  add({ type: "inbox.added", payload: { id: "ic", kind: "progress", nodeId: "c", ref: "rc" } });
  node("o", "implement", "root");
  ev("o", { type: "start" });
  add({
    type: "report.added",
    payload: { reportId: "ro", nodeId: "o", kind: "progress", text: "t" },
  });
  archive("c");
  archive("t");
  return { log, add, ev };
};

const ids = (s: OrchState) => s.nodes.map((n) => n.id).sort();

describe("EventLog.purgeTree（最終削除）", () => {
  it("木のイベントを消し、標識を足す。状態は木を除いたものになり、開き直しても同じ。seq は戻らない", () => {
    const store = createMemoryStore();
    const { log } = setup(store.open());
    const before = log.state();
    const r = log.purgeTree({
      requestId: "purge-1",
      actor: { human: true },
      nodeIds: ["c", "t"],
      marker: marker("t"),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.applied).toBe(true);
    expect(ids(log.state())).toEqual(["o", "root"]);
    expect(log.state().inbox.some((i) => i.nodeId === "c")).toBe(false);
    expect(log.state().lastSeq).toBe(before.lastSeq + 1);
    expect(r.value.event.seq).toBe(before.lastSeq + 1);
    const reopened = EventLog.open(store.open(), { clock });
    expect(reopened.ok && reopened.value.state()).toEqual(log.state());
    expect(log.state().tombstones.map((x) => x.rootId)).toEqual(["t"]);
    const next = log.append({
      requestId: "after",
      actor: SYS,
      body: { type: "node.toolDenied", payload: { nodeId: "o", tool: "x" } },
    });
    expect(next.ok && next.value.event.seq).toBe(before.lastSeq + 2);
  });

  it("同じ requestId の再送は、何も消さずに最初の結果を返す", () => {
    const { log } = setup();
    const req = {
      requestId: "purge-1",
      actor: { human: true } as const,
      nodeIds: ["c", "t"],
      marker: marker("t"),
    };
    const first = log.purgeTree(req);
    const second = log.purgeTree(req);
    expect(first.ok && second.ok && second.value.applied).toBe(false);
    expect(second.ok && second.value.event.seq).toBe(first.ok && first.value.event.seq);
  });

  it("残りのログを畳み込めない（木の外のノードが依存している）なら、何も消さずに拒否する", () => {
    const store = createMemoryStore();
    const { log, add } = setup(store.open());
    add({
      type: "node.created",
      payload: { nodeId: "d", role: "implement", parentId: "root", dependsOn: ["c"] },
    });
    const rowsBefore = store.open().readAll().length;
    const stateBefore = log.state();
    const r = log.purgeTree({
      requestId: "purge-x",
      actor: { human: true },
      nodeIds: ["c", "t"],
      marker: marker("t"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("purgeUnsafe");
      expect(r.error.cause).toContain("node.created"); // 原因のイベントの種類と seq
      expect(r.error.cause).toMatch(/seq \d+/);
    }
    expect(store.open().readAll().length).toBe(rowsBefore);
    expect(log.state()).toEqual(stateBefore);
  });

  it("結果の状態が「木のノードを除いたもの」と合わなければ、拒否する（存在しないノードを指定した場合）", () => {
    const { log } = setup();
    const r = log.purgeTree({
      requestId: "purge-y",
      actor: { human: true },
      nodeIds: ["c", "t", "ghost"],
      marker: marker("t"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("purgeUnsafe");
  });

  it("追記のみのトリガーの復旧を確かめられなければ、onFatal を呼び、以降の書き込みを拒否する（fail closed）", () => {
    const dir = mkdtempSync(join(tmpdir(), "cso-purge-"));
    try {
      const s = openSqliteStore(join(dir, "e.db"), {
        beforeTriggerCheck: (db) => db.exec("DROP TRIGGER events_no_update"),
      });
      if (!s.ok) throw new Error(s.error.code);
      const fatal: string[] = [];
      const { log } = setup(s.value, (cause) => fatal.push(cause));
      const r = log.purgeTree({
        requestId: "purge-z",
        actor: { human: true },
        nodeIds: ["c", "t"],
        marker: marker("t"),
      });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("storeIntegrity");
      expect(fatal).toHaveLength(1);
      const w = log.append({
        requestId: "after",
        actor: SYS,
        body: { type: "node.toolDenied", payload: { nodeId: "o", tool: "x" } },
      });
      expect(w.ok === false && w.error.code).toBe("logBroken");
      const w2 = log.appendAll([
        {
          requestId: "after2",
          actor: SYS,
          body: { type: "node.toolDenied", payload: { nodeId: "o", tool: "x" } },
        },
      ]);
      expect(w2.ok === false && w2.error.code).toBe("logBroken");
      s.value.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("実 SQLite でも、木を消し、開き直しても同じ状態になる。消した行はファイルから無くなり、追記は続く", () => {
    const dir = mkdtempSync(join(tmpdir(), "cso-purge-"));
    try {
      const path = join(dir, "e.db");
      const s = openSqliteStore(path);
      if (!s.ok) throw new Error(s.error.code);
      const { log } = setup(s.value);
      const r = log.purgeTree({
        requestId: "purge-sql",
        actor: { human: true },
        nodeIds: ["c", "t"],
        marker: marker("t"),
      });
      expect(r.ok && r.value.deleted).toBeGreaterThan(0);
      const state = log.state();
      s.value.close();
      const again = openSqliteStore(path);
      if (!again.ok) throw new Error(again.error.code);
      const reopened = EventLog.open(again.value, { clock, verifySnapshot: true });
      expect(reopened.ok && reopened.value.state()).toEqual(state);
      expect(again.value.readAll().some((row) => row.payload.includes('"nodeId":"c"'))).toBe(false);
      const next = reopened.ok
        ? reopened.value.append({
            requestId: "after",
            actor: SYS,
            body: { type: "node.toolDenied", payload: { nodeId: "o", tool: "x" } },
          })
        : undefined;
      expect(next?.ok).toBe(true);
      again.value.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("コミットの後の確認の例外も、storeIntegrity として扱う（onFatal・書き込みの拒否。状態はコミットした結果）", () => {
    const dir = mkdtempSync(join(tmpdir(), "cso-purge-"));
    try {
      const s = openSqliteStore(join(dir, "e.db"), {
        beforeTriggerCheck: () => {
          throw new Error("確認中の例外");
        },
      });
      if (!s.ok) throw new Error(s.error.code);
      const fatal: string[] = [];
      const { log } = setup(s.value, (cause) => fatal.push(cause));
      const r = log.purgeTree({
        requestId: "purge-post",
        actor: { human: true },
        nodeIds: ["c", "t"],
        marker: marker("t"),
      });
      expect(r.ok === false && r.error.code).toBe("storeIntegrity");
      expect(fatal).toHaveLength(1);
      expect(
        log
          .state()
          .nodes.map((n) => n.id)
          .sort(),
      ).toEqual(["o", "root"]);
      const w = log.append({
        requestId: "after",
        actor: SYS,
        body: { type: "node.toolDenied", payload: { nodeId: "o", tool: "x" } },
      });
      expect(w.ok === false && w.error.code).toBe("logBroken");
      s.value.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("木の外のノードの判断要求が、木のノードを止める対象にしていても（pauseNodeIds）、最終削除できる。再生しても畳み込める", () => {
    const store = createMemoryStore();
    const { log, add } = setup(store.open());
    // root の判断要求が、子孫の c を止める対象にしている（root は木の外）
    add({
      type: "decision.requested",
      payload: { decisionId: "dx", nodeId: "root", question: "q", pauseNodeIds: ["c"] },
    });
    const r = log.purgeTree({
      requestId: "purge-p",
      actor: { human: true },
      nodeIds: ["c", "t"],
      marker: marker("t"),
    });
    expect(r.ok).toBe(true);
    expect(log.state().decisions.some((d) => d.decisionId === "dx")).toBe(true);
    expect(log.state().nodes.some((n) => n.id === "c")).toBe(false);
  });

  it("checkPurge は、何も書かずに、実行と同じ検証をする", () => {
    const store = createMemoryStore();
    const { log } = setup(store.open());
    const before = store.open().readAll().length;
    const ok1 = log.checkPurge({
      requestId: "dry",
      actor: { human: true },
      nodeIds: ["c", "t"],
      marker: marker("t"),
    });
    expect(ok1.ok && ok1.value.deleteCount).toBeGreaterThan(0);
    const ng = log.checkPurge({
      requestId: "dry2",
      actor: { human: true },
      nodeIds: ["ghost"],
      marker: marker("t"),
    });
    expect(ng.ok === false && ng.error.code).toBe("purgeUnsafe");
    expect(store.open().readAll().length).toBe(before);
    expect(log.state().nodes.some((n) => n.id === "t")).toBe(true);
  });
});
