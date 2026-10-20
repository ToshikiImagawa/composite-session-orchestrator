import type { Scope } from "@cso/core";
import { describe, expect, it } from "vitest";
import { type SdkAdapterDeps, SdkRuntimeAdapter } from "../../src/sdk/sdk-adapter.js";
import { FakeLauncher, FakeSink, FakeTimers, probeSequence, settle } from "./fakes.js";

const SCOPE: Scope = {
  writableLocations: ["src"],
  forbiddenLocations: ["src/secret"],
  allowedCommands: ["ls", "pnpm test"],
};
const WT = "/wt/a";
const STOP_SEQ = 17;

interface Rig {
  adapter: SdkRuntimeAdapter;
  launcher: FakeLauncher;
  sink: FakeSink;
  timers: FakeTimers;
  probeCalls: string[];
}

const rig = (
  over: Partial<SdkAdapterDeps> = {},
  probes: Parameters<typeof probeSequence> = [[]],
): Rig => {
  const launcher = new FakeLauncher();
  const sink = new FakeSink();
  const timers = new FakeTimers();
  const { probe, calls } = probeSequence(...probes);
  let n = 0;
  const adapter = new SdkRuntimeAdapter({
    launcher,
    probe,
    realpath: async (p) => (p === "/link/a" ? WT : p),
    sink,
    timers,
    newRequestId: () => `rq-${++n}`,
    parentEnv: { PATH: "/usr/bin", CLAUDE_CODE_SESSION_ID: "parent", ANTHROPIC_API_KEY: "k" },
    ...over,
  });
  return { adapter, launcher, sink, timers, probeCalls: calls };
};

const startNode = async (r: Rig, nodeId = "a") => {
  const res = await r.adapter.start({
    nodeId,
    worktreePath: "/link/a",
    scope: SCOPE,
    instruction: "do the task",
  });
  if (!res.ok) throw new Error(`start failed: ${res.error.code}`);
  return res.value;
};

describe("capabilities（CLI）", () => {
  it("追加指示は遅延（実行中はツール完了後に届く）、停止は穏当・即時とも可、フックと識別子は可", () => {
    expect(rig().adapter.capabilities("a")).toEqual({
      send: "delayed",
      stopGraceful: true,
      stopImmediate: true,
      hooks: "ok",
      sessionId: true,
    });
    expect(rig().adapter.kind).toBe("cli");
  });
});

describe("start", () => {
  it("作業ツリーを実パスにして cwd に渡し、親のセッション識別子の環境変数を除き、利用者設定を読み込まない", async () => {
    const r = rig();
    const v = await startNode(r);
    const opts = r.launcher.sessions[0]?.options;
    expect(opts?.cwd).toBe(WT);
    expect(opts?.env).toEqual({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "k" });
    expect(opts?.settingSources).toEqual([]);
    expect(opts?.initialPrompt).toBe("do the task");
    expect(v).toMatchObject({
      sessionId: "session-1",
      cwd: WT,
      removedEnv: ["CLAUDE_CODE_SESSION_ID"],
    });
    expect(JSON.stringify(v)).not.toContain("parent");
  });

  it("MCP の接続設定（ノード専用トークン付き HTTP）を注入する", async () => {
    const r = rig();
    await r.adapter.start({
      nodeId: "a",
      worktreePath: "/link/a",
      scope: SCOPE,
      instruction: "x",
      mcp: { url: "http://127.0.0.1:9/mcp", token: "tok" },
    });
    expect(r.launcher.sessions[0]?.options.mcpServers).toEqual({
      node: {
        type: "http",
        url: "http://127.0.0.1:9/mcp",
        headers: { Authorization: "Bearer tok" },
      },
    });
  });

  it("作業ツリーを解決できなければ失敗（子を起動しない）", async () => {
    const r = rig({
      realpath: async () => {
        throw new Error("ENOENT");
      },
    });
    const res = await r.adapter.start({
      nodeId: "a",
      worktreePath: "/nope",
      scope: SCOPE,
      instruction: "x",
    });
    expect(res.ok ? null : res.error.code).toBe("worktreeInvalid");
    expect(r.launcher.sessions).toHaveLength(0);
  });

  it("要求の形が不正なら失敗（例外を出さない）", async () => {
    const r = rig();
    for (const bad of [
      null,
      {},
      { nodeId: "", worktreePath: "/x", scope: SCOPE, instruction: "x" },
      { nodeId: "a", worktreePath: "rel", scope: SCOPE, instruction: "x" },
    ]) {
      const res = await r.adapter.start(bad as never);
      expect(res.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("起動に失敗したら失敗を返し、セッションを打ち切る", async () => {
    const r = rig();
    r.launcher.autoInit = false;
    const p = r.adapter.start({
      nodeId: "a",
      worktreePath: "/link/a",
      scope: SCOPE,
      instruction: "x",
    });
    await settle();
    r.launcher.sessions[0]?.failToStart("auth");
    const res = await p;
    expect(res.ok ? null : res.error.code).toBe("startFailed");
    expect(r.launcher.sessions[0]?.calls).toContain("abort");
  });

  it("init が時間内に来なければ失敗（startTimeout）し、打ち切る", async () => {
    const r = rig({ startTimeoutMs: 5000 });
    r.launcher.autoInit = false;
    const p = r.adapter.start({
      nodeId: "a",
      worktreePath: "/link/a",
      scope: SCOPE,
      instruction: "x",
    });
    await settle();
    await r.timers.advance(5000);
    const res = await p;
    expect(res.ok ? null : res.error.code).toBe("startFailed");
    expect(r.launcher.sessions[0]?.calls).toContain("abort");
  });

  it("同じノードの二重起動は失敗", async () => {
    const r = rig();
    await startNode(r);
    const again = await r.adapter.start({
      nodeId: "a",
      worktreePath: "/link/a",
      scope: SCOPE,
      instruction: "x",
    });
    expect(again.ok ? null : again.error.code).toBe("alreadyStarted");
    expect(r.launcher.sessions).toHaveLength(1);
  });
});

describe("send（追加指示）", () => {
  it("稼働中のノードへ指示を送る（受け付けた結果を返す。届くのはツール完了後）", async () => {
    const r = rig();
    await startNode(r);
    const res = await r.adapter.send("a", "もう一つお願い");
    expect(res.ok && res.value).toEqual({ status: "queued" });
    expect(r.launcher.sessions[0]?.sent).toEqual(["もう一つお願い"]);
  });

  it("未知のノード・空の指示は失敗", async () => {
    const r = rig();
    await startNode(r);
    const a = await r.adapter.send("zzz", "x");
    expect(a.ok ? null : a.error.code).toBe("unknownNode");
    const b = await r.adapter.send("a", "");
    expect(b.ok ? null : b.error.code).toBe("invalidRequest");
  });
});

describe("フック（PreToolUse）", () => {
  const hook = (r: Rig) =>
    (r.launcher.sessions[0] as NonNullable<(typeof r.launcher.sessions)[0]>).options.hooks
      .preToolUse;

  it("範囲内の操作は許可し、何も記録しない", async () => {
    const r = rig();
    await startNode(r);
    const d = await hook(r)({ toolName: "Write", toolInput: { file_path: "src/a.ts" }, cwd: WT });
    expect(d).toEqual({ allow: true });
    expect(r.sink.records).toHaveLength(0);
  });

  it("範囲外の操作は拒否し、理由をモデルへ伝え、範囲違反を記録する（拒否した操作も残す。NFR_011）", async () => {
    const r = rig();
    await startNode(r);
    const d = await hook(r)({
      toolName: "Write",
      toolInput: { file_path: "package.json" },
      cwd: WT,
    });
    expect(d.allow).toBe(false);
    expect(d.allow ? "" : d.reason).toContain("範囲");
    expect(r.sink.records).toHaveLength(1);
    expect(r.sink.records[0]).toMatchObject({
      actor: { system: true },
      body: {
        type: "scope.violation",
        payload: { nodeId: "a", reason: "outsideWritable", subject: "/wt/a/package.json" },
      },
    });
  });

  it("未知のツールとバックグラウンド実行は拒否する", async () => {
    const r = rig();
    await startNode(r);
    expect((await hook(r)({ toolName: "WebFetch", toolInput: {}, cwd: WT })).allow).toBe(false);
    expect(
      (
        await hook(r)({
          toolName: "Bash",
          toolInput: { command: "ls", run_in_background: true },
          cwd: WT,
        })
      ).allow,
    ).toBe(false);
    expect(r.sink.types).toEqual(["scope.violation", "scope.violation"]);
  });

  it("記録に失敗しても、拒否は変えない（フェイルクローズ）", async () => {
    const r = rig();
    await startNode(r);
    r.sink.failNext = 1;
    const d = await hook(r)({
      toolName: "Write",
      toolInput: { file_path: "package.json" },
      cwd: WT,
    });
    expect(d.allow).toBe(false);
  });

  it("壊れた入力でも例外を出さず拒否する", async () => {
    const r = rig();
    await startNode(r);
    for (const bad of [null, undefined, {}, { toolName: 5 }]) {
      const d = await hook(r)(bad as never);
      expect(d.allow, JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("stop: 穏当な停止（2 段階）", () => {
  it("猶予内に result が来たら、停止指示のメッセージを送り、打ち切らず、停止を確認して記録する", async () => {
    const r = rig();
    await startNode(r);
    const p = r.adapter.stop("a", { mode: "graceful", stopSeq: STOP_SEQ });
    await settle();
    const s = r.launcher.sessions[0];
    expect(s?.sent).toHaveLength(1);
    expect(s?.sent[0]).toContain("停止");
    s?.emitResult();
    const res = await p;
    expect(res.ok && res.value).toMatchObject({ state: "stopped", outcome: "withinGrace" });
    expect(s?.calls).not.toContain("interrupt");
    expect(s?.calls).toContain("close");
    expect(r.sink.types).toEqual([
      "node.stopObserved:withinGrace",
      "node.stateChanged:confirmStopped",
    ]);
  });

  it("猶予（既定 60 秒）を超えたら interrupt で打ち切り、interrupted を記録する", async () => {
    const r = rig();
    await startNode(r);
    const p = r.adapter.stop("a", { mode: "graceful", stopSeq: STOP_SEQ });
    await settle();
    await r.timers.advance(59_999);
    expect(r.launcher.sessions[0]?.calls).not.toContain("interrupt");
    await r.timers.advance(1);
    const res = await p;
    expect(r.launcher.sessions[0]?.calls).toContain("interrupt");
    expect(res.ok && res.value).toMatchObject({ state: "stopped", outcome: "interrupted" });
    expect(r.sink.types).toEqual([
      "node.stopObserved:interrupted",
      "node.stateChanged:confirmStopped",
    ]);
  });

  it("猶予は停止要求ごとに上書きできる", async () => {
    const r = rig();
    await startNode(r);
    const p = r.adapter.stop("a", { mode: "graceful", graceMs: 5000, stopSeq: STOP_SEQ });
    await settle();
    await r.timers.advance(5000);
    const res = await p;
    expect(res.ok && res.value.outcome).toBe("interrupted");
  });

  it("result が先に来たら、猶予のタイマーは取り消される", async () => {
    const r = rig();
    await startNode(r);
    const p = r.adapter.stop("a", { mode: "graceful", stopSeq: STOP_SEQ });
    await settle();
    r.launcher.sessions[0]?.emitResult();
    await p;
    expect(r.timers.pendingCount).toBe(0);
  });
});

describe("stop: 即時停止", () => {
  it("猶予なしで abort し、停止指示は送らない", async () => {
    const r = rig();
    await startNode(r);
    const res = await r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    const s = r.launcher.sessions[0];
    expect(s?.calls).toContain("abort");
    expect(s?.sent).toHaveLength(0);
    expect(res.ok && res.value).toMatchObject({ state: "stopped", outcome: "aborted" });
    expect(r.sink.types).toEqual(["node.stopObserved:aborted", "node.stateChanged:confirmStopped"]);
  });

  it("穏当な停止の猶予中に即時停止が来たら、すぐ abort に切り替える", async () => {
    const r = rig();
    await startNode(r);
    const graceful = r.adapter.stop("a", { mode: "graceful", stopSeq: STOP_SEQ });
    await settle();
    const immediate = r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    await settle();
    const g = await graceful;
    const i = await immediate;
    expect(r.launcher.sessions[0]?.calls).toContain("abort");
    expect(g.ok && g.value.outcome).toBe("aborted");
    expect(i.ok && i.value.state).toBe("stopped");
    expect(r.timers.pendingCount).toBe(0);
    expect(r.sink.types.filter((t) => t === "node.stateChanged:confirmStopped")).toHaveLength(1);
  });

  it("穏当な停止の最中の穏当な停止の再送は、同じ停止を共有する（二重に送らない）", async () => {
    const r = rig();
    await startNode(r);
    const a = r.adapter.stop("a", { mode: "graceful", stopSeq: STOP_SEQ });
    const b = r.adapter.stop("a", { mode: "graceful", stopSeq: STOP_SEQ });
    await settle();
    r.launcher.sessions[0]?.emitResult();
    expect((await a).ok && (await b).ok).toBe(true);
    expect(r.launcher.sessions[0]?.sent).toHaveLength(1);
  });
});

describe("stop: 停止の確認（作業ツリー配下のプロセス）", () => {
  const proc = (pid: number) => ({ pid, cwd: WT, hasOpenFiles: false as const });

  it("プロセスが残っている間は確認を繰り返し、いなくなったら停止と記録する", async () => {
    const r = rig({}, [[proc(7)], [proc(7)], []]);
    await startNode(r);
    const p = r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    await settle();
    await r.timers.advance(1000);
    await r.timers.advance(1000);
    const res = await p;
    expect(res.ok && res.value.state).toBe("stopped");
    expect(r.probeCalls).toEqual([WT, WT, WT]);
    expect(r.sink.types.at(-1)).toBe("node.stateChanged:confirmStopped");
  });

  it("所定の時間（既定 30 秒）を超えても残っていれば、stopTimeout を記録して停止未完了（pid を名指し）を返す", async () => {
    const r = rig({}, [[proc(7), proc(9)]]);
    await startNode(r);
    const p = r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    await settle();
    await r.timers.advance(30_000);
    const res = await p;
    expect(res.ok && res.value).toMatchObject({ state: "stopIncomplete", blockers: [7, 9] });
    expect(r.sink.types).toEqual(["node.stopObserved:aborted", "node.stateChanged:stopTimeout"]);
  });

  it("プロセス一覧が取得できない（null）間は停止と確認できない。時間切れで停止未完了になる", async () => {
    const r = rig({}, [null]);
    await startNode(r);
    const p = r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    await settle();
    await r.timers.advance(30_000);
    const res = await p;
    expect(res.ok && res.value.state).toBe("stopIncomplete");
    expect(res.ok && res.value.blockers).toEqual([]);
  });

  it("確認の時間と間隔は設定できる", async () => {
    const r = rig({ verifyTimeoutMs: 3000, verifyIntervalMs: 500 }, [[proc(1)]]);
    await startNode(r);
    const p = r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    await settle();
    await r.timers.advance(3000);
    const res = await p;
    expect(res.ok && res.value.state).toBe("stopIncomplete");
    expect(r.probeCalls.length).toBe(7); // 0、500、…、3000 ミリ秒
  });

  it("停止未完了のあとの再試行（即時停止）で、いなくなれば停止を確認して記録する", async () => {
    const r = rig({ verifyTimeoutMs: 2000 }, [[proc(7)], [proc(7)], [proc(7)], []]);
    await startNode(r);
    const first = r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    await settle();
    await r.timers.advance(2000);
    const incomplete = await first;
    expect(incomplete.ok && incomplete.value.state).toBe("stopIncomplete");
    const retry = await r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    expect(retry.ok && retry.value).toMatchObject({ state: "stopped" });
    expect(r.launcher.sessions[0]?.calls.filter((c) => c === "abort")).toHaveLength(2);
  });

  it("停止を確認できたノードは管理から外れ、以後の操作は失敗する", async () => {
    const r = rig();
    await startNode(r);
    await r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    const s = await r.adapter.send("a", "x");
    expect(s.ok ? null : s.error.code).toBe("unknownNode");
    const again = await r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    expect(again.ok ? null : again.error.code).toBe("unknownNode");
  });
});

describe("stop: 失敗", () => {
  it("未知のノード・不正な要求は失敗", async () => {
    const r = rig();
    const a = await r.adapter.stop("zzz", { mode: "graceful", stopSeq: STOP_SEQ });
    expect(a.ok ? null : a.error.code).toBe("unknownNode");
    await startNode(r);
    for (const bad of [
      null,
      {},
      { mode: "soon", stopSeq: 1 },
      { mode: "graceful", stopSeq: 1, graceMs: 0 },
      { mode: "graceful", stopSeq: 1, graceMs: Number.NaN },
      { mode: "graceful", stopSeq: 1, graceMs: 1.5 },
      { mode: "graceful", stopSeq: 1, graceMs: 3_600_001 },
      { mode: "immediate", stopSeq: 1, graceMs: 1000 },
      { mode: "graceful" },
      { mode: "graceful", stopSeq: 0 },
      { mode: "graceful", stopSeq: 1.5 },
      { mode: "graceful", stopSeq: "1" },
    ]) {
      const res = await r.adapter.stop("a", bad as never);
      expect(res.ok ? null : res.error.code, JSON.stringify(bad)).toBe("invalidRequest");
    }
  });

  it("観測には、停止要求の seq（stopSeq）と、そのとき有効だった猶予（graceMs）を載せる", async () => {
    // 穏当: 要求の graceMs
    const a = rig();
    await startNode(a);
    const pa = a.adapter.stop("a", { mode: "graceful", graceMs: 5000, stopSeq: 21 });
    await settle();
    a.launcher.sessions[0]?.emitResult();
    await pa;
    expect(a.sink.records[0]?.body).toEqual({
      type: "node.stopObserved",
      payload: { nodeId: "a", outcome: "withinGrace", stopSeq: 21, graceMs: 5000 },
    });
    // 穏当で graceMs 省略: 既定値（60 秒）
    const b = rig();
    await startNode(b);
    const pb = b.adapter.stop("a", { mode: "graceful", stopSeq: 22 });
    await settle();
    await b.timers.advance(60_000);
    await pb;
    expect(b.sink.records[0]?.body).toEqual({
      type: "node.stopObserved",
      payload: { nodeId: "a", outcome: "interrupted", stopSeq: 22, graceMs: 60_000 },
    });
    // 即時: graceMs なし
    const c = rig();
    await startNode(c);
    await c.adapter.stop("a", { mode: "immediate", stopSeq: 23 });
    expect(c.sink.records[0]?.body).toEqual({
      type: "node.stopObserved",
      payload: { nodeId: "a", outcome: "aborted", stopSeq: 23 },
    });
    // 穏当の猶予中に即時へ切り替え: 穏当の停止要求に結び付き、そのときの猶予を載せる
    const d = rig();
    await startNode(d);
    const gd = d.adapter.stop("a", { mode: "graceful", graceMs: 9000, stopSeq: 24 });
    await settle();
    void d.adapter.stop("a", { mode: "immediate", stopSeq: 25 });
    await gd;
    expect(d.sink.records[0]?.body).toEqual({
      type: "node.stopObserved",
      payload: { nodeId: "a", outcome: "aborted", stopSeq: 24, graceMs: 9000 },
    });
  });

  it("既定の猶予の設定が不正（整数でない・上限超過）なら、穏当な停止は invalidRequest", async () => {
    const r = rig({ defaultGraceMs: 0.5 });
    await startNode(r);
    const res = await r.adapter.stop("a", { mode: "graceful", stopSeq: 1 });
    expect(res.ok ? null : res.error.code).toBe("invalidRequest");
  });

  it("記録に失敗したら recordFailed を返す（停止の状態を記録できなかった）", async () => {
    const r = rig();
    await startNode(r);
    r.sink.failNext = 1;
    const res = await r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    expect(res.ok ? null : res.error.code).toBe("recordFailed");
  });
});
