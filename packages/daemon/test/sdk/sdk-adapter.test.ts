import { isBoundedText, isSafeId, LIMITS, type Scope } from "@cso/core";
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
    resolvePath: async (p) => p,
    sink,
    timers,
    newRequestId: () => `rq-${++n}`,
    parentEnv: { PATH: "/usr/bin", CLAUDE_CODE_SESSION_ID: "parent", ANTHROPIC_API_KEY: "k" },
    ...over,
  });
  return { adapter, launcher, sink, timers, probeCalls: calls };
};

const sessionOf = (r: Rig) => {
  const s = r.launcher.sessions[0];
  if (s === undefined) throw new Error("no session");
  return s;
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

const LOOPBACK_NO_PROXY = {
  NO_PROXY: "127.0.0.1,localhost,[::1]",
  no_proxy: "127.0.0.1,localhost,[::1]",
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

describe("has（管理している子か）", () => {
  it("起動したら true。起動していない・知らないノードは false", async () => {
    const r = rig();
    expect(r.adapter.has("a")).toBe(false);
    await startNode(r);
    expect(r.adapter.has("a")).toBe(true);
    expect(r.adapter.has("zzz")).toBe(false);
  });
});

describe("start", () => {
  it("作業ツリーを実パスにして cwd に渡し、親のセッション識別子の環境変数を除き、利用者設定を読み込まない", async () => {
    const r = rig();
    const v = await startNode(r);
    const opts = r.launcher.sessions[0]?.options;
    expect(opts?.cwd).toBe(WT);
    expect(opts?.env).toEqual({ PATH: "/usr/bin", ANTHROPIC_API_KEY: "k", ...LOOPBACK_NO_PROXY });
    expect(opts?.settingSources).toEqual([]);
    expect(opts?.initialPrompt).toBe("do the task");
    expect(v).toMatchObject({
      sessionId: "session-1",
      cwd: WT,
      removedEnv: ["CLAUDE_CODE_SESSION_ID"],
    });
    expect(JSON.stringify(v)).not.toContain("parent");
  });

  it("MCP の接続設定（ノード専用トークン付き HTTP）を注入する。トークンは設定に置かず、子の環境変数で渡して参照する（T21-ce）", async () => {
    const token = "tok-0123456789-secret";
    const r = rig({
      parentEnv: {
        PATH: "/usr/bin",
        ANTHROPIC_API_KEY: "k",
        CSO_MCP_TOKEN: "from-parent",
        CSO_NODE_TOKEN: "hook-from-parent",
      },
      childEnvAllow: ["CSO_MCP_TOKEN", "CSO_NODE_TOKEN"],
    });
    await r.adapter.start({
      nodeId: "a",
      worktreePath: "/link/a",
      scope: SCOPE,
      instruction: "x",
      mcp: { url: "http://127.0.0.1:9/mcp", token },
    });
    const opts = r.launcher.sessions[0]?.options;
    expect(opts?.mcpServers).toEqual({
      node: {
        type: "http",
        url: "http://127.0.0.1:9/mcp",
        headers: { Authorization: `Bearer $${"{"}CSO_MCP_TOKEN}` },
      },
    });
    // SDK が --mcp-config の引数にする文字列（{ mcpServers } の JSON）に、トークンが入らない
    expect(JSON.stringify({ mcpServers: opts?.mcpServers })).not.toContain(token);
    // 値は、子の環境変数で渡す（親の同じ名前の値は、追加の許可があっても通さない）
    expect(opts?.env.CSO_MCP_TOKEN).toBe(token);
    expect(opts?.env.CSO_NODE_TOKEN).toBeUndefined();
  });

  it("MCP なしで起動したときは、子の環境変数にトークンを入れない（T21-ce）", async () => {
    const r = rig({ parentEnv: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "k", CSO_MCP_TOKEN: "p" } });
    await startNode(r);
    const opts = sessionOf(r).options;
    expect(opts.mcpServers).toBeUndefined();
    expect(opts.env.CSO_MCP_TOKEN).toBeUndefined();
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
    // 範囲違反の記録と、親（統合ノード）の受信箱の項目（violation）を、1 トランザクションで記録する（T10v）。
    expect(r.sink.types).toEqual(["scope.violation", "inbox.added"]);
    expect(r.sink.groups).toEqual([2]);
    expect(r.sink.records[0]).toMatchObject({
      actor: { system: true },
      body: {
        type: "scope.violation",
        payload: { nodeId: "a", reason: "outsideWritable", subject: "/wt/a/package.json" },
      },
    });
    const item = r.sink.records[1]?.body;
    expect(item).toMatchObject({
      type: "inbox.added",
      payload: { nodeId: "a", kind: "violation" },
    });
    const summary = item?.type === "inbox.added" ? (item.payload.summary ?? "") : "";
    expect(summary).toContain("outsideWritable");
    expect(summary).toContain("/wt/a/package.json");
    expect(isSafeId(item?.type === "inbox.added" ? item.payload.id : "")).toBe(true);
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
    // 未知のツールは範囲違反ではないので、scope.violation（受信箱に載る）にせず、node.toolDenied として記録する。
    expect(r.sink.types).toEqual(["node.toolDenied", "scope.violation", "inbox.added"]);
    expect(r.sink.records[0]).toMatchObject({
      actor: { system: true },
      body: { type: "node.toolDenied", payload: { nodeId: "a", tool: "WebFetch" } },
    });
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

  it("最後の確認が取れなかった（null・時間切れ）ときも、それまでに見つけた pid を失わない（「pid 不明」にしない。T24-sp）", async () => {
    const r = rig({}, [[{ ...proc(7), command: "zsh" }], null]);
    await startNode(r);
    const p = r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    await settle();
    await r.timers.advance(30_000);
    const res = await p;
    expect(res.ok && res.value).toMatchObject({
      state: "stopIncomplete",
      blockers: [7],
      processes: [{ pid: 7, command: "zsh" }],
    });
  });

  it("期限ぎわの確認にも最低限の持ち時間（2 秒）を与え、期限ちょうどに探査が成功してプロセスがなければ stopped にする", async () => {
    let r: Rig | undefined;
    let deadline = Number.POSITIVE_INFINITY;
    const probe = async () => {
      const t = r?.timers;
      if (t === undefined || t.now() < deadline) return [proc(7)];
      await t.sleep(1_500); // 期限を過ぎた最後の 1 回は、時間がかかる
      return [];
    };
    r = rig({ probe });
    await startNode(r);
    const p = r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    deadline = r.timers.now() + 30_000;
    await settle();
    await r.timers.advance(30_000);
    await r.timers.advance(1_500);
    const res = await p;
    expect(res.ok && res.value.state).toBe("stopped");
    expect(r.sink.types.at(-1)).toBe("node.stateChanged:confirmStopped");
  });

  it("停止未完了の結果に、整えたコマンドの名前つきの processes を添える（blockers は pid のまま。T24-sp）", async () => {
    const r = rig({}, [[{ ...proc(7), command: "z\u001b[2Jsh" }, proc(9)]]);
    await startNode(r);
    const p = r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    await settle();
    await r.timers.advance(30_000);
    const res = await p;
    expect(res.ok && res.value).toMatchObject({
      state: "stopIncomplete",
      blockers: [7, 9],
      processes: [{ pid: 7, command: "z[2Jsh" }, { pid: 9 }],
    });
  });

  it("予期しない終了の受信箱の要約（イベントログに残る）に、整えた名前を「pid 7（zsh）」の形で出す（T24-sp）", async () => {
    const r = rig({}, [[{ ...proc(7), command: "zsh\u001b]0;\u0007\u202e" }]]);
    await startNode(r);
    r.launcher.sessions[0]?.finish(new Error("crashed"));
    await settle();
    const summaries = r.sink.records
      .map((x) => x.body)
      .filter((b) => b.type === "inbox.added")
      .map((b) => (b.payload as { summary: string }).summary);
    const left = summaries.find((t) => t.includes("残っている"));
    expect(left).toContain("（pid 7（zsh]0;））");
    expect(JSON.stringify(r.sink.records)).not.toMatch(/\\u001b|\\u0007|\u202e/);
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

  it("観測の記録に失敗しても警告として続行し、検証と confirmStopped を行う", async () => {
    const r = rig();
    await startNode(r);
    r.sink.failNext = 1;
    const res = await r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    expect(res.ok && res.value.state).toBe("stopped");
    expect(res.ok && res.value.warnings?.[0]).toContain("観測");
    expect(r.sink.types).toEqual(["node.stateChanged:confirmStopped"]);
  });

  it("停止の確認の記録に失敗したら recordFailed を返す", async () => {
    const r = rig();
    await startNode(r);
    r.sink.failNext = 2;
    const res = await r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    expect(res.ok ? null : res.error.code).toBe("recordFailed");
  });
});

describe("stop: 堅牢化（例外・戻らない・result が来ない）", () => {
  const session = (r: Rig) =>
    r.launcher.sessions[0] as NonNullable<(typeof r.launcher.sessions)[0]>;

  it("interrupt が例外なら abort に切り替え、aborted を記録する（行った手段で記録）", async () => {
    const r = rig();
    await startNode(r);
    session(r).throwOn.add("interrupt");
    const p = r.adapter.stop("a", { mode: "graceful", graceMs: 1000, stopSeq: STOP_SEQ });
    await settle();
    await r.timers.advance(1000);
    const res = await p;
    expect(sessionOf(r).calls).toEqual(expect.arrayContaining(["interrupt", "abort"]));
    expect(res.ok && res.value).toMatchObject({ state: "stopped", outcome: "aborted" });
  });

  it("interrupt が戻らなければ、時間制限（既定 10 秒。timers と競合）で abort に切り替える", async () => {
    const r = rig();
    await startNode(r);
    session(r).interruptMode = "hang";
    const p = r.adapter.stop("a", { mode: "graceful", graceMs: 1000, stopSeq: STOP_SEQ });
    await settle();
    await r.timers.advance(1000);
    expect(sessionOf(r).calls).not.toContain("abort");
    await r.timers.advance(9_999);
    expect(sessionOf(r).calls).not.toContain("abort");
    await r.timers.advance(1);
    const res = await p;
    expect(sessionOf(r).calls).toContain("abort");
    expect(res.ok && res.value.outcome).toBe("aborted");
    expect(r.timers.pendingCount).toBe(0);
  });

  it("interrupt の時間制限は設定でき、interrupt 中の即時停止の要求でもすぐ abort する", async () => {
    const r = rig({ interruptTimeoutMs: 500 });
    await startNode(r);
    session(r).interruptMode = "hang";
    const p = r.adapter.stop("a", { mode: "graceful", graceMs: 1000, stopSeq: STOP_SEQ });
    await settle();
    await r.timers.advance(1500);
    expect((await p).ok).toBe(true);
    const r2 = rig();
    await startNode(r2);
    sessionOf(r2).interruptMode = "hang";
    const p2 = r2.adapter.stop("a", { mode: "graceful", graceMs: 1000, stopSeq: STOP_SEQ });
    await settle();
    await r2.timers.advance(1000);
    void r2.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    await settle();
    expect(r2.launcher.sessions[0]?.calls).toContain("abort");
    expect((await p2).ok).toBe(true);
  });

  it("interrupt は戻るが result が来なくても、止まらずに検証へ進む", async () => {
    const r = rig();
    await startNode(r);
    session(r).interruptMode = "noResult";
    const p = await Promise.race([
      (async () => {
        const q = r.adapter.stop("a", { mode: "graceful", graceMs: 1000, stopSeq: STOP_SEQ });
        await settle();
        await r.timers.advance(1000);
        return q;
      })(),
    ]);
    expect(p.ok && p.value).toMatchObject({ state: "stopped", outcome: "interrupted" });
  });

  it("abort が例外でも reject せず、検証へ進む（stop は常に Result）", async () => {
    const r = rig();
    await startNode(r);
    session(r).throwOn.add("abort");
    const res = await r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    expect(res.ok && res.value.state).toBe("stopped");
    expect(res.ok && res.value.warnings?.some((w) => w.includes("abort"))).toBe(true);
  });

  it("send・close・nextResult が例外でも、停止は続行する", async () => {
    for (const op of ["send", "close", "nextResult"] as const) {
      const r = rig();
      await startNode(r);
      session(r).throwOn.add(op);
      const p = r.adapter.stop("a", { mode: "graceful", graceMs: 1000, stopSeq: STOP_SEQ });
      await settle();
      session(r).emitResult();
      await r.timers.advance(1000);
      const res = await p;
      expect(res.ok, op).toBe(true);
    }
  });

  it("記録口が例外を投げても reject しない", async () => {
    const explode = () => {
      throw new Error("sink exploded");
    };
    const sink = { record: explode, recordAll: explode };
    const r = rig({ sink });
    await startNode(r);
    const res = await r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    expect(res.ok ? null : res.error.code).toBe("recordFailed");
  });

  it("プローブが戻らなくても、全体の時間（実時間）で打ち切って停止未完了にする", async () => {
    const hang = rig({ verifyTimeoutMs: 5000, probe: () => new Promise(() => undefined) });
    await startNode(hang);
    const p = hang.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    await settle();
    await hang.timers.advance(5000);
    const res = await p;
    expect(res.ok && res.value.state).toBe("stopIncomplete");
    expect(hang.timers.pendingCount).toBe(0);
  });

  it("プローブ自体に時間がかかる場合も、実時間で数える（間隔の回数では数えない）", async () => {
    const timersRef: { t?: FakeTimers } = {};
    let calls = 0;
    const r = rig({
      verifyTimeoutMs: 5000,
      verifyIntervalMs: 1000,
      probe: async () => {
        calls += 1;
        await timersRef.t?.sleep(2000);
        return [{ pid: 7, cwd: WT, hasOpenFiles: false as const }];
      },
    });
    timersRef.t = r.timers;
    await startNode(r);
    const p = r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    await settle();
    await r.timers.advance(5000);
    const res = await p;
    expect(res.ok && res.value.state).toBe("stopIncomplete");
    expect(calls).toBeLessThanOrEqual(3);
  });
});

describe("検証フェーズ中の即時停止", () => {
  it("abort を呼び、返す outcome を aborted にする", async () => {
    const r = rig({}, [[{ pid: 7, cwd: WT, hasOpenFiles: false }], []]);
    await startNode(r);
    const g = r.adapter.stop("a", { mode: "graceful", graceMs: 1000, stopSeq: STOP_SEQ });
    await settle();
    r.launcher.sessions[0]?.emitResult(); // 猶予内に result。次は検証（pid 7 が残る）
    await settle();
    const callsBefore = r.launcher.sessions[0]?.calls.filter((c) => c === "abort").length;
    expect(callsBefore).toBe(0);
    void r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    await settle();
    expect(r.launcher.sessions[0]?.calls).toContain("abort");
    await r.timers.advance(1000);
    const res = await g;
    expect(res.ok && res.value.outcome).toBe("aborted");
    expect(r.sink.types.filter((t) => t.startsWith("node.stopObserved"))).toEqual([
      "node.stopObserved:withinGrace",
    ]);
  });
});

describe("停止中のノードへの send", () => {
  it("停止中は stopping として拒否する。例外を投げる send は sendFailed", async () => {
    const r = rig({}, [[{ pid: 7, cwd: WT, hasOpenFiles: false }]]);
    await startNode(r);
    void r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    await settle();
    const res = await r.adapter.send("a", "続けて");
    expect(res.ok ? null : res.error.code).toBe("stopping");

    const r2 = rig();
    await startNode(r2);
    r2.launcher.sessions[0]?.throwOn.add("send");
    const res2 = await r2.adapter.send("a", "x");
    expect(res2.ok ? null : res2.error.code).toBe("sendFailed");
  });
});

describe("予期しない終了（finished の監視）", () => {
  it("稼働中に子が終了したら、onUnexpectedExit で通知し、管理から外す", async () => {
    const seen: [string, string][] = [];
    const r = rig({ onUnexpectedExit: (nodeId, reason) => void seen.push([nodeId, reason]) });
    await startNode(r);
    r.launcher.sessions[0]?.finish(new Error("crashed"));
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.[0]).toBe("a");
    expect(seen[0]?.[1]).toContain("crashed");
    // 記録: 予期しない終了、失敗の報告、受信箱の failure の項目（報告を ref で指す）
    expect(r.sink.types).toEqual([
      "node.exited",
      "node.stateChanged:stop",
      "node.stateChanged:confirmStopped",
      "report.added",
      "inbox.added",
    ]);
    expect(r.sink.records[0]).toMatchObject({
      actor: { system: true },
      body: { type: "node.exited", payload: { nodeId: "a" } },
    });
    const report = r.sink.records[3]?.body;
    const inbox = r.sink.records[4]?.body;
    expect(report).toMatchObject({
      type: "report.added",
      payload: { nodeId: "a", kind: "failure" },
    });
    expect(inbox).toMatchObject({ type: "inbox.added", payload: { nodeId: "a", kind: "failure" } });
    expect(
      (inbox?.type === "inbox.added" ? inbox.payload.ref : undefined) ===
        (report?.type === "report.added" ? report.payload.reportId : null),
    ).toBe(true);
    expect(JSON.stringify(r.sink.records[0]?.body)).toContain("crashed");
    const s = await r.adapter.send("a", "x");
    expect(s.ok ? null : s.error.code).toBe("unknownNode");
  });

  it("終了と状態の遷移（stopped）を、1 トランザクションで記録する。プロセスが残っていなければ stopped（起動時の整合と同じ規則。T10c）", async () => {
    const r = rig({}, [[]]);
    await startNode(r);
    r.launcher.sessions[0]?.finish(new Error("crashed"));
    await settle();
    expect(r.sink.types).toEqual([
      "node.exited",
      "node.stateChanged:stop",
      "node.stateChanged:confirmStopped",
      "report.added",
      "inbox.added",
    ]);
    expect(r.sink.groups).toEqual([5]);
    expect(r.probeCalls).toEqual([WT]);
    expect(r.sink.records[1]?.body).toMatchObject({
      type: "node.stateChanged",
      payload: { nodeId: "a", event: { type: "stop", mode: "immediate" } },
    });
  });

  it("作業ツリー配下にプロセスが残っている（または調べられない）なら、stopIncomplete にして、受信箱に stopIncomplete の項目を出す", async () => {
    const leftover = [{ pid: 4321, cwd: WT, hasOpenFiles: false }];
    for (const probes of [[leftover], [null]] as const) {
      const r = rig({}, probes as never);
      await startNode(r);
      r.launcher.sessions[0]?.finish(new Error("crashed"));
      await settle();
      expect(r.sink.types).toEqual([
        "node.exited",
        "node.stateChanged:stop",
        "node.stateChanged:stopTimeout",
        "report.added",
        "inbox.added",
        "inbox.added",
      ]);
      expect(r.sink.groups).toEqual([6]);
      const kinds = r.sink.records.flatMap((x) =>
        x.body.type === "inbox.added" ? [x.body.payload.kind] : [],
      );
      expect(kinds).toEqual(["failure", "stopIncomplete"]);
    }
  });

  it("プロセスの調査が例外でも、stopIncomplete にする（フェイルクローズ）。通知と掃除は行う", async () => {
    const seen: string[] = [];
    const r = rig({
      onUnexpectedExit: (n) => void seen.push(n),
      probe: async () => {
        throw new Error("lsof failed");
      },
    });
    await startNode(r);
    r.launcher.sessions[0]?.finish(new Error("crashed"));
    await settle();
    expect(seen).toEqual(["a"]);
    expect(r.sink.types).toContain("node.stateChanged:stopTimeout");
    expect(r.adapter.has("a")).toBe(false);
  });

  it("同じ範囲違反（種類と対象）は、受信箱に 1 度だけ出す。違反ごとの記録は残す。ノードごとに受信箱の項目の上限がある", async () => {
    const r = rig();
    await startNode(r);
    const h = sessionOf(r).options.hooks.preToolUse;
    const write = (f: string) => h({ toolName: "Write", toolInput: { file_path: f }, cwd: WT });
    await write("a.txt");
    await write("a.txt");
    expect(r.sink.types).toEqual(["scope.violation", "inbox.added", "scope.violation"]);
    for (let i = 0; i < 40; i++) await write(`f${i}.txt`);
    const items = r.sink.types.filter((t) => t === "inbox.added").length;
    const violations = r.sink.types.filter((t) => t === "scope.violation").length;
    // 受信箱は 20 件まで。超えたら「ほかにも違反がある」を 1 件だけ出す（21 件目）。違反の記録は、毎回残る。
    expect(items).toBe(21);
    expect(violations).toBe(42);
    const last = [...r.sink.records].reverse().find((x) => x.body.type === "inbox.added")?.body;
    expect(last).toMatchObject({ type: "inbox.added", payload: { kind: "violation" } });
    expect(last?.type === "inbox.added" ? (last.payload.summary ?? "") : "").toContain("ほかにも");
  });

  it("範囲違反の記録にも上限がある: 同じ対象は 50 件、ノード全体で 1000 件まで。超えた分は、件数だけ数える（記録しない）", async () => {
    const r = rig();
    await startNode(r);
    const h = sessionOf(r).options.hooks.preToolUse;
    for (let i = 0; i < 70; i++) {
      await h({ toolName: "Write", toolInput: { file_path: "same.txt" }, cwd: WT });
    }
    expect(r.sink.types.filter((t) => t === "scope.violation")).toHaveLength(50);
    expect(r.sink.types.filter((t) => t === "inbox.added")).toHaveLength(1);
    for (let i = 0; i < 1100; i++) {
      await h({ toolName: "Write", toolInput: { file_path: `d${i}.txt` }, cwd: WT });
    }
    expect(r.sink.types.filter((t) => t === "scope.violation")).toHaveLength(1000);
    // 拒否は、記録の上限を超えても、変わらない
    const denied = await h({ toolName: "Write", toolInput: { file_path: "z.txt" }, cwd: WT });
    expect(denied.allow).toBe(false);
  });

  it("終了の記録（1 トランザクション）に失敗したら、onFailure に出し、停止を除いた最小の記録（終了・失敗の報告・受信箱）で記録し直す", async () => {
    const failures: string[] = [];
    const seen: string[] = [];
    const r = rig({
      onFailure: (id, cause) => void failures.push(`${id}: ${cause}`),
      onUnexpectedExit: (n) => void seen.push(n),
    });
    await startNode(r);
    r.sink.failNext = 1;
    r.launcher.sessions[0]?.finish(new Error("crashed"));
    await settle();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("a");
    expect(r.sink.types).toEqual(["node.exited", "report.added", "inbox.added"]);
    expect(r.sink.groups).toEqual([3]);
    expect(seen).toEqual(["a"]);
  });

  it("最小の記録にも失敗したら、onFailure に出して、通知と掃除は行う", async () => {
    const failures: string[] = [];
    const seen: string[] = [];
    const r = rig({
      onFailure: (id, cause) => void failures.push(`${id}: ${cause}`),
      onUnexpectedExit: (n) => void seen.push(n),
    });
    await startNode(r);
    r.sink.failNext = 2;
    r.launcher.sessions[0]?.finish(new Error("crashed"));
    await settle();
    expect(failures).toHaveLength(2);
    expect(seen).toEqual(["a"]);
    expect(r.adapter.has("a")).toBe(false);
  });

  it("子の HOME を、ノードごとのディレクトリに分ける（homeFor を渡したとき）。作れなければ、起動しない（フェイルクローズ）", async () => {
    const made: string[] = [];
    const r = rig({
      parentEnv: { PATH: "/bin", HOME: "/root", ANTHROPIC_API_KEY: "k" },
      homeFor: (id) => {
        made.push(id);
        return `/state/homes/${id}`;
      },
    });
    await startNode(r);
    expect(made).toEqual(["a"]);
    expect(sessionOf(r).options.env).toEqual({
      PATH: "/bin",
      HOME: "/state/homes/a",
      ANTHROPIC_API_KEY: "k",
      ...LOOPBACK_NO_PROXY,
    });
    const bad = rig({
      homeFor: () => {
        throw new Error("EACCES");
      },
    });
    const res = await bad.adapter.start({
      nodeId: "a",
      worktreePath: "/link/a",
      scope: SCOPE,
      instruction: "x",
    });
    expect(res.ok ? null : res.error.code).toBe("startFailed");
    expect(bad.launcher.sessions).toHaveLength(0);
  });

  it("除いた環境変数の名前は、50 件で打ち切り、残りは「ほか N 件」と 1 つにまとめる", async () => {
    const parentEnv: Record<string, string> = { PATH: "/bin" };
    for (let i = 0; i < 120; i++) parentEnv[`SECRET_${String(i).padStart(3, "0")}`] = "v";
    const r = rig({ parentEnv });
    const v = await startNode(r);
    expect(v.removedEnv).toHaveLength(51);
    expect(v.removedEnv[50]).toBe("ほか 70 件");
    expect(JSON.stringify(v.removedEnv)).not.toContain('"v"');
  });

  it("停止の最中の終了は、予期しない終了にしない", async () => {
    const seen: string[] = [];
    const r = rig({ onUnexpectedExit: (n) => void seen.push(n) });
    await startNode(r);
    const p = r.adapter.stop("a", { mode: "immediate", stopSeq: STOP_SEQ });
    r.launcher.sessions[0]?.finish();
    await p;
    expect(seen).toEqual([]);
    expect(r.sink.types.some((t) => t === "node.exited")).toBe(false);
  });

  it("理由に制御文字や長い文字列があっても、記録できる形にして記録する", async () => {
    const r = rig();
    await startNode(r);
    r.launcher.sessions[0]?.finish(new Error(`\u001b[31m${"x".repeat(5000)}`));
    await settle();
    const exited = r.sink.records[0]?.body;
    expect(exited?.type).toBe("node.exited");
    const reason = exited?.type === "node.exited" ? exited.payload.reason : "";
    expect(isBoundedText(reason, LIMITS.reason)).toBe(true);
    expect(r.sink.types).toEqual([
      "node.exited",
      "node.stateChanged:stop",
      "node.stateChanged:confirmStopped",
      "report.added",
      "inbox.added",
    ]);
  });

  it("未知のツール名が長い・制御文字を含んでも、記録できる形にして記録する", async () => {
    const r = rig();
    await startNode(r);
    const hook = sessionOf(r).options.hooks.preToolUse;
    await hook({ toolName: `Evil\u202e${"y".repeat(3000)}`, toolInput: {}, cwd: WT });
    const body = r.sink.records[0]?.body;
    expect(body?.type).toBe("node.toolDenied");
    const tool = body?.type === "node.toolDenied" ? body.payload.tool : "";
    expect(isBoundedText(tool, LIMITS.tool)).toBe(true);
  });

  it("生成する報告・受信箱の ID は、newRequestId が安全でない文字を返しても isSafeId を満たす", async () => {
    let n = 0;
    const r = rig({ newRequestId: () => `req ${++n}/x\u202e${"y".repeat(300)}` });
    await startNode(r);
    r.launcher.sessions[0]?.finish(new Error("x"));
    await settle();
    const ids: string[] = [];
    for (const rec of r.sink.records) {
      if (rec.body.type === "report.added") ids.push(rec.body.payload.reportId);
      if (rec.body.type === "inbox.added")
        ids.push(rec.body.payload.id, rec.body.payload.ref ?? "");
    }
    expect(ids).toHaveLength(3);
    for (const id of ids) expect(isSafeId(id), id).toBe(true);
    expect(ids[0]).toBe(ids[2]); // inbox の ref は、報告の ID
  });

  it("node.exited の記録に失敗しても、通知と掃除は行う", async () => {
    const seen: string[] = [];
    const r = rig({ onUnexpectedExit: (n) => void seen.push(n) });
    await startNode(r);
    r.sink.failNext = 1;
    r.launcher.sessions[0]?.finish(new Error("x"));
    await settle();
    expect(seen).toEqual(["a"]);
  });
});

describe("範囲の更新（FR_015）", () => {
  it("updateScope の後のフック判定は、新しい範囲を使う", async () => {
    const r = rig();
    await startNode(r);
    const hook = sessionOf(r).options.hooks.preToolUse;
    const call = () => hook({ toolName: "Write", toolInput: { file_path: "docs/a.md" }, cwd: WT });
    expect((await call()).allow).toBe(false);
    const u = r.adapter.updateScope("a", { ...SCOPE, writableLocations: ["src", "docs"] });
    expect(u.ok).toBe(true);
    expect((await call()).allow).toBe(true);
    const bad = r.adapter.updateScope("zzz", SCOPE);
    expect(bad.ok ? null : bad.error.code).toBe("unknownNode");
  });
});

describe("フック: リンクの解決", () => {
  it("書き込み先の解決に失敗したら拒否し、解決した実パスで判定する", async () => {
    const r = rig({
      resolvePath: async (p) => {
        if (p.includes("boom")) throw new Error("EACCES");
        return p.replace("/wt/a/src/link", "/etc");
      },
    });
    await startNode(r);
    const hook = sessionOf(r).options.hooks.preToolUse;
    expect(
      (await hook({ toolName: "Write", toolInput: { file_path: "src/link/x" }, cwd: WT })).allow,
    ).toBe(false);
    expect(
      (await hook({ toolName: "Write", toolInput: { file_path: "src/boom" }, cwd: WT })).allow,
    ).toBe(false);
    expect(r.sink.types).toEqual([
      "scope.violation",
      "inbox.added",
      "scope.violation",
      "inbox.added",
    ]);
  });
});

describe("停止の宣言の release（Desktop だけ）", () => {
  it("CLI のアダプタは release を持たず、能力表に stopDelegated を出さない（停止の宣言の対象外）", () => {
    const { adapter } = rig();
    expect((adapter as { release?: unknown }).release).toBeUndefined();
    expect(adapter.capabilities("a").stopDelegated).not.toBe(true);
  });
});

describe("ファイルで設定するフックの判定（decideHook。T22-h）", () => {
  it("Skill（子に渡した skill を読む。T22-c）は、受け口（decideHook）でも許可する", async () => {
    const r = rig();
    await startNode(r);
    expect(
      await r.adapter.decideHook("a", "Skill", { skill: "cso-child-skills:cso-child" }),
    ).toEqual({ allow: true });
  });

  it("SDK のコールバックと同じ判定・同じ記録をする（範囲外の書き込みは拒否して scope.violation と受信箱。未知のツールは node.toolDenied）", async () => {
    const r = rig();
    await startNode(r);
    expect(await r.adapter.decideHook("a", "Write", { file_path: "src/a.ts" })).toEqual({
      allow: true,
    });
    const d = await r.adapter.decideHook("a", "Write", { file_path: "a.txt" });
    expect(d.allow).toBe(false);
    expect(r.sink.types).toEqual(["scope.violation", "inbox.added"]);
    // 同じ違反は、SDK のコールバックから来ても、受信箱に 2 度は出さない（数え上げを共有する）
    await sessionOf(r).options.hooks.preToolUse({
      toolName: "Write",
      toolInput: { file_path: "a.txt" },
      cwd: WT,
    });
    expect(r.sink.types).toEqual(["scope.violation", "inbox.added", "scope.violation"]);
    const u = await r.adapter.decideHook("a", "WebFetch", { url: "https://x" });
    expect(u.allow).toBe(false);
    expect(r.sink.types.at(-1)).toBe("node.toolDenied");
  });

  it("daemon が作業ツリーを知らないノードは、拒否する（フェイルクローズ。記録しない）", async () => {
    const r = rig();
    const d = await r.adapter.decideHook("zzz", "Read", { file_path: "a" });
    expect(d.allow).toBe(false);
    expect(r.sink.records).toHaveLength(0);
  });
});

describe("子に渡す skill（T22-c）", () => {
  it("childPluginPath があれば、role に応じた skill の plugin を渡し、指示の末尾に skill に従う旨を足す", async () => {
    const r = rig({ childPluginPath: "/state/child-plugin" });
    for (const [nodeId, role] of [
      ["a", "implement"],
      ["b", "integrator"],
    ] as const) {
      const res = await r.adapter.start({
        nodeId,
        role,
        worktreePath: "/link/a",
        scope: SCOPE,
        instruction: "do the task",
      });
      expect(res.ok).toBe(true);
    }
    const [a, b] = r.launcher.sessions.map((x) => x.options);
    expect(a?.plugin).toEqual({ path: "/state/child-plugin", skill: "cso-child-skills:cso-child" });
    expect(b?.plugin).toEqual({
      path: "/state/child-plugin",
      skill: "cso-child-skills:cso-integrator",
    });
    expect(a?.initialPrompt.startsWith("do the task\n")).toBe(true);
    expect(a?.initialPrompt).toContain("skill「cso-child-skills:cso-child」に従う");
    expect(a?.settingSources).toEqual([]);
  });

  it("childPluginPath がなければ、plugin を渡さず、指示も変えない（role の省略は統合ノードでない子）", async () => {
    const r = rig();
    await startNode(r);
    expect(sessionOf(r).options.plugin).toBeUndefined();
    expect(sessionOf(r).options.initialPrompt).toBe("do the task");
    const r2 = rig({ childPluginPath: "/p" });
    await startNode(r2);
    expect(sessionOf(r2).options.plugin?.skill).toBe("cso-child-skills:cso-child");
  });
});

describe("子の認証の確認（T22-auth）", () => {
  it("HOME を分ける（homeFor）とき、認証の環境変数がなければ、SDK を起動せずに childAuthMissing。値は出さない", async () => {
    const r = rig({
      homeFor: (id) => `/state/homes/${id}`,
      parentEnv: { PATH: "/bin", GH_TOKEN: "ghp-secret-value" },
    });
    const res = await r.adapter.start({
      nodeId: "a",
      worktreePath: "/link/a",
      scope: SCOPE,
      instruction: "x",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("childAuthMissing");
    expect(r.launcher.sessions).toHaveLength(0);
    expect(r.adapter.has("a")).toBe(false);
    expect(JSON.stringify(res.error)).not.toContain("ghp-secret-value");
  });

  it("認証を、HOME のディレクトリを作る前に確かめる（失敗したときに、空の HOME を残さない）", async () => {
    const made: string[] = [];
    const r = rig({
      homeFor: (id) => {
        made.push(id);
        return `/state/homes/${id}`;
      },
      parentEnv: { PATH: "/bin" },
    });
    const res = await r.adapter.start({
      nodeId: "a",
      worktreePath: "/link/a",
      scope: SCOPE,
      instruction: "x",
    });
    expect(res.ok).toBe(false);
    expect(made).toEqual([]);
  });

  it("HOME を共有する（inherit。homeFor なし）ときは、確かめない", async () => {
    const r = rig({ parentEnv: { PATH: "/bin" } });
    const res = await r.adapter.start({
      nodeId: "a",
      worktreePath: "/link/a",
      scope: SCOPE,
      instruction: "x",
    });
    expect(res.ok).toBe(true);
    expect(r.launcher.sessions).toHaveLength(1);
  });
});

describe("読み取りも禁じる場所（FR_014 の例外。T21-pr）", () => {
  it("SDK のコールバックとファイルのフックの両方で、stateDir の読み取りを拒否し、scope.violation に種類だけを記録する", async () => {
    const S = "/state";
    const r = rig({
      protectedPaths: () => ({ roots: [{ path: S, kind: "stateDir" }], allow: [] }),
    });
    await startNode(r);
    const viaFile = await r.adapter.decideHook("a", "Read", { file_path: `${S}/human-token` });
    expect(viaFile.allow).toBe(false);
    const viaSdk = await sessionOf(r).options.hooks.preToolUse({
      toolName: "Read",
      toolInput: { file_path: `${S}/root-token` },
      cwd: WT,
    });
    expect(viaSdk.allow).toBe(false);
    expect(r.sink.types).toContain("scope.violation");
    expect(JSON.stringify(r.sink.records)).not.toContain(`${S}/`);
    expect((await r.adapter.decideHook("a", "Read", { file_path: "/etc/hosts" })).allow).toBe(true);
  });
});
