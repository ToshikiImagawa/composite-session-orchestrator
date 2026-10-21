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

/** 標識の代わり（`node.purged` は core の T26 後。ここでは、前提なしに畳み込める既存のイベントを使う）。 */
const marker = (nodeId: string): EventBody => ({
  type: "node.toolDenied",
  payload: { nodeId, tool: "purged-marker" },
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
      marker: marker("root"),
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
      marker: marker("root"),
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
      marker: marker("root"),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("purgeUnsafe");
    expect(store.open().readAll().length).toBe(rowsBefore);
    expect(log.state()).toEqual(stateBefore);
  });

  it("結果の状態が「木のノードを除いたもの」と合わなければ、拒否する（存在しないノードを指定した場合）", () => {
    const { log } = setup();
    const r = log.purgeTree({
      requestId: "purge-y",
      actor: { human: true },
      nodeIds: ["c", "t", "ghost"],
      marker: marker("root"),
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
        marker: marker("root"),
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
        marker: marker("root"),
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
});
