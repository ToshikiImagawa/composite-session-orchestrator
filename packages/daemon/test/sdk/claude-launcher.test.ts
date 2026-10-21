import { describe, expect, it } from "vitest";
import type { HookOutcome, LaunchOptions } from "../../src/sdk/agent.js";
import { launcherWith } from "../../src/sdk/claude-launcher.js";

type Msg = Record<string, unknown>;

/** 実 SDK の `query()` の代わり。入力（prompt）と options を記録し、出力のメッセージを手動で流す。 */
function fakeQuery() {
  const calls: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }[] = [];
  const outbox: Msg[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let failure: unknown;
  let interrupts = 0;
  let interruptThrows = false;
  const wakeUp = (): void => {
    wake?.();
    wake = undefined;
  };
  const query = (params: { prompt: AsyncIterable<unknown>; options: Record<string, unknown> }) => {
    calls.push(params);
    const gen = (async function* () {
      for (;;) {
        const m = outbox.shift();
        if (m !== undefined) {
          yield m;
          continue;
        }
        if (failure !== undefined) throw failure;
        if (ended) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    })();
    return Object.assign(gen, {
      interrupt: async () => {
        interrupts += 1;
        if (interruptThrows) throw new Error("interrupt failed");
        return undefined;
      },
    });
  };
  return {
    query: query as never,
    calls,
    emit(m: Msg) {
      outbox.push(m);
      wakeUp();
    },
    end() {
      ended = true;
      wakeUp();
    },
    fail(e: unknown) {
      failure = e;
      wakeUp();
    },
    get interrupts() {
      return interrupts;
    },
    set interruptThrows(v: boolean) {
      interruptThrows = v;
    },
  };
}

const options = (over: Partial<LaunchOptions> = {}): LaunchOptions => ({
  cwd: "/wt/a",
  env: { PATH: "/bin", NODE_TOKEN_FILE: "/x" },
  settingSources: [],
  mcpServers: {
    node: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer t" } },
  },
  hooks: { preToolUse: async (): Promise<HookOutcome> => ({ allow: true }) },
  initialPrompt: "目的: x",
  ...over,
});

const tick = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

describe("createClaudeLauncher（実 SDK の query() への結線。フェイクで検証）", () => {
  it("作業ツリー・環境変数・設定の読み込みなし・MCP 接続・許可しないツールは拒否する設定で query を呼ぶ", () => {
    const f = fakeQuery();
    launcherWith(f.query).launch(options());
    const o = f.calls[0]?.options as Record<string, unknown>;
    expect(o.cwd).toBe("/wt/a");
    expect(o.env).toEqual({ PATH: "/bin", NODE_TOKEN_FILE: "/x" });
    expect(o.settingSources).toEqual([]);
    expect(o.mcpServers).toEqual({
      node: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer t" } },
    });
    // 事前に許可していない操作は、確認せずに拒否する（フックが許可したものだけが動く）。
    expect(o.permissionMode).toBe("dontAsk");
    expect(o.abortController).toBeInstanceOf(AbortController);
  });

  it("最初の指示は、入力（streaming input）の最初のメッセージとして届く。send は、その後に積まれる", async () => {
    const f = fakeQuery();
    const s = launcherWith(f.query).launch(options());
    const it = (f.calls[0] as { prompt: AsyncIterable<Msg> }).prompt[Symbol.asyncIterator]();
    const first = await it.next();
    expect(first.value).toEqual({
      type: "user",
      message: { role: "user", content: "目的: x" },
      parent_tool_use_id: null,
    });
    s.send("追加の指示");
    const second = await it.next();
    expect((second.value as Msg).message).toEqual({ role: "user", content: "追加の指示" });
  });

  it("close の後は、入力が終わり、send は例外になる", async () => {
    const f = fakeQuery();
    const s = launcherWith(f.query).launch(options());
    const it = (f.calls[0] as { prompt: AsyncIterable<Msg> }).prompt[Symbol.asyncIterator]();
    await it.next(); // 最初の指示
    s.close();
    expect((await it.next()).done).toBe(true);
    expect(() => s.send("x")).toThrow();
  });

  it("ready は、init メッセージのセッション ID で解決する", async () => {
    const f = fakeQuery();
    const s = launcherWith(f.query).launch(options());
    f.emit({ type: "system", subtype: "init", session_id: "sess-1" });
    await expect(s.ready()).resolves.toEqual({ sessionId: "sess-1" });
  });

  it("init の前に出力が終わる・例外になるなら、ready は reject する", async () => {
    const a = fakeQuery();
    const sa = launcherWith(a.query).launch(options());
    a.end();
    await expect(sa.ready()).rejects.toThrow();
    const b = fakeQuery();
    const sb = launcherWith(b.query).launch(options());
    b.fail(new Error("boom"));
    await expect(sb.ready()).rejects.toThrow("boom");
  });

  it("nextResult は、次の result メッセージで解決する（それより前の result では解決しない）", async () => {
    const f = fakeQuery();
    const s = launcherWith(f.query).launch(options());
    f.emit({ type: "system", subtype: "init", session_id: "s" });
    await tick();
    let done = false;
    void s.nextResult().then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    f.emit({ type: "assistant" });
    await tick();
    expect(done).toBe(false);
    f.emit({ type: "result", subtype: "success" });
    await tick();
    expect(done).toBe(true);
  });

  it("interrupt は query.interrupt に委ねる。失敗は呼び出し側へ伝える", async () => {
    const f = fakeQuery();
    const s = launcherWith(f.query).launch(options());
    await s.interrupt();
    expect(f.interrupts).toBe(1);
    f.interruptThrows = true;
    await expect(s.interrupt()).rejects.toThrow("interrupt failed");
  });

  it("abort は、AbortController を中断する。出力が例外で終われば、finished は reject する", async () => {
    const f = fakeQuery();
    const s = launcherWith(f.query).launch(options());
    const ac = f.calls[0]?.options.abortController as AbortController;
    s.abort();
    expect(ac.signal.aborted).toBe(true);
    f.fail(new Error("Claude Code process aborted by user"));
    await expect(s.finished()).rejects.toThrow("aborted");
  });

  it("出力が正常に終われば、finished は解決する", async () => {
    const f = fakeQuery();
    const s = launcherWith(f.query).launch(options());
    f.emit({ type: "system", subtype: "init", session_id: "s" });
    f.end();
    await expect(s.finished()).resolves.toBeUndefined();
  });

  describe("PreToolUse フック", () => {
    const hookOf = (f: ReturnType<typeof fakeQuery>) => {
      const hooks = (f.calls[0]?.options.hooks ?? {}) as Record<
        string,
        {
          hooks: ((
            i: unknown,
            id: string | undefined,
            o: { signal: AbortSignal },
          ) => Promise<Msg>)[];
        }[]
      >;
      expect(Object.keys(hooks)).toEqual(["PreToolUse"]);
      const cb = hooks.PreToolUse?.[0]?.hooks[0];
      if (cb === undefined) throw new Error("no hook");
      return (input: Msg) => cb(input, "id", { signal: new AbortController().signal });
    };
    const pre = (over: Msg = {}): Msg => ({
      hook_event_name: "PreToolUse",
      tool_name: "Write",
      tool_input: { file_path: "/wt/a/x" },
      cwd: "/wt/a",
      ...over,
    });

    it("許可なら、明示的に allow を返す（dontAsk と合わせて、許可したものだけが動く）。判定には、名前・入力・cwd を渡す", async () => {
      const f = fakeQuery();
      const seen: unknown[] = [];
      launcherWith(f.query).launch(
        options({
          hooks: {
            preToolUse: async (i) => {
              seen.push(i);
              return { allow: true };
            },
          },
        }),
      );
      const out = await hookOf(f)(pre());
      expect(out).toEqual({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
      });
      expect(seen).toEqual([
        { toolName: "Write", toolInput: { file_path: "/wt/a/x" }, cwd: "/wt/a" },
      ]);
    });

    it("拒否なら、理由つきで deny を返す", async () => {
      const f = fakeQuery();
      launcherWith(f.query).launch(
        options({ hooks: { preToolUse: async () => ({ allow: false, reason: "範囲外" }) } }),
      );
      const out = await hookOf(f)(pre());
      expect(out).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "範囲外",
        },
      });
    });

    it("判定が例外になる・入力の形が不正なら、拒否する（フェイルクローズ）", async () => {
      const f = fakeQuery();
      launcherWith(f.query).launch(
        options({
          hooks: {
            preToolUse: async () => {
              throw new Error("x");
            },
          },
        }),
      );
      const h = hookOf(f);
      const a = (await h(pre())) as { hookSpecificOutput: { permissionDecision: string } };
      expect(a.hookSpecificOutput.permissionDecision).toBe("deny");
      const b = (await h({ hook_event_name: "PreToolUse" })) as {
        hookSpecificOutput: { permissionDecision: string };
      };
      expect(b.hookSpecificOutput.permissionDecision).toBe("deny");
    });
  });
});
