import type { EventBody } from "@cso/core";
import { describe, expect, it } from "vitest";
import { EventLog } from "../src/eventlog.js";
import {
  EXTERNAL_CHECK_SUMMARY,
  resolveStaleExternalChecks,
  withExternalCheckResolution,
} from "../src/external-check.js";
import { createMemoryStore } from "../src/memory-store.js";

const SYS = { system: true } as const;
const clock = (): string => "2026-10-28T00:00:00Z";

/** 根と子 a（running）と、根の受信箱の「daemon 再起動後」の依頼 1 件。 */
const rig = () => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  let k = 0;
  const add = (body: EventBody): void => {
    const r = log.append({ requestId: `t-${++k}`, actor: SYS, body });
    if (!r.ok) throw new Error(`${r.error.code} ${r.error.cause}`);
  };
  for (const [id, parentId] of [
    ["root", null],
    ["a", "root"],
  ] as const) {
    add({
      type: "node.created",
      payload: {
        nodeId: id,
        role: parentId === null ? "integrator" : "implement",
        parentId,
        dependsOn: [],
      },
    });
    add({ type: "node.stateChanged", payload: { nodeId: id, event: { type: "start" } } });
  }
  add({
    type: "inbox.added",
    payload: {
      id: "inbox-ext",
      kind: "stopIncomplete",
      nodeId: "root",
      summary: `${EXTERNAL_CHECK_SUMMARY}（1 件: a）`,
    },
  });
  const open = () => log.state().inbox.find((i) => i.id === "inbox-ext")?.resolved === undefined;
  return { log, add, open };
};

describe("根の「daemon 再起動後」の依頼の自動の解決（C2-4・案 A）", () => {
  it("動いているかもしれない子がいる間は、解決しない。いなくなったら解決済みにする。再実行で重複しない", () => {
    const r = rig();
    resolveStaleExternalChecks(r.log);
    expect(r.open()).toBe(true);
    r.add({
      type: "node.stateChanged",
      payload: { nodeId: "a", event: { type: "stop", mode: "immediate" } },
    });
    r.add({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "stopTimeout" } } });
    resolveStaleExternalChecks(r.log);
    expect(r.open()).toBe(true); // 停止未完了は、まだ動いているかもしれない
    r.add({
      type: "node.stateChanged",
      payload: { nodeId: "a", event: { type: "confirmStopped" } },
    });
    const seq = r.log.state().lastSeq;
    resolveStaleExternalChecks(r.log);
    expect(r.open()).toBe(false);
    expect(r.log.state().lastSeq).toBe(seq + 1);
    resolveStaleExternalChecks(r.log);
    expect(r.log.state().lastSeq).toBe(seq + 1);
  });

  it("包んだログ: 追記が成功したあとに判断する（完了の報告で、動いている子がいなくなっても解決する）", () => {
    const r = rig();
    const wrapped = withExternalCheckResolution(r.log);
    const done = wrapped.append({
      requestId: "done-a",
      actor: SYS,
      body: { type: "node.stateChanged", payload: { nodeId: "a", event: { type: "reportDone" } } },
    });
    expect(done.ok).toBe(true);
    expect(r.open()).toBe(false);
  });

  it("包んだログ: 追記が失敗したら、何もしない。任意の口は、元のログに結び付けて渡す", () => {
    const r = rig();
    const wrapped = withExternalCheckResolution(r.log);
    const bad = wrapped.appendAll([
      {
        requestId: "bad",
        actor: SYS,
        body: { type: "node.stateChanged", payload: { nodeId: "nope", event: { type: "start" } } },
      },
    ]);
    expect(bad.ok).toBe(false);
    expect(r.open()).toBe(true);
    expect(wrapped.firstEventOf?.("t-1")?.seq).toBe(1);
  });
});
