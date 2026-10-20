import type { EventBody, Failure, Result } from "@cso/core";
import { failure, ok, type ProcessInfo } from "@cso/core";
import type { AgentLauncher, AgentSession, LaunchOptions } from "../../src/sdk/agent.js";
import type { EventSink, SinkRequest, Timers } from "../../src/sdk/runtime.js";

export const settle = async (n = 30): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

/** 手動で進める時計。`advance` で期限の来たタイマーを発火する。 */
export class FakeTimers implements Timers {
  now = 0;
  private readonly pending: { at: number; fire: () => void; id: number }[] = [];
  private nextId = 1;

  after(ms: number): { promise: Promise<void>; cancel(): void } {
    const id = this.nextId++;
    let fire!: () => void;
    const promise = new Promise<void>((r) => {
      fire = r;
    });
    this.pending.push({ at: this.now + ms, fire, id });
    return {
      promise,
      cancel: () => {
        const i = this.pending.findIndex((p) => p.id === id);
        if (i >= 0) this.pending.splice(i, 1);
      },
    };
  }

  sleep(ms: number): Promise<void> {
    return this.after(ms).promise;
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  /** 時間を進め、期限の来たタイマーを順に発火する（発火のたびに非同期の続きを実行させる）。 */
  async advance(ms: number): Promise<void> {
    const target = this.now + ms;
    for (;;) {
      this.pending.sort((a, b) => a.at - b.at);
      const next = this.pending[0];
      if (next === undefined || next.at > target) break;
      this.pending.shift();
      this.now = next.at;
      next.fire();
      await settle();
    }
    this.now = target;
    await settle();
  }
}

export class FakeSession implements AgentSession {
  readonly sent: string[] = [];
  calls: string[] = [];
  private readyResolve!: (v: { sessionId: string }) => void;
  private readyReject!: (e: Error) => void;
  private readonly readyPromise: Promise<{ sessionId: string }>;
  private resultWaiters: (() => void)[] = [];

  constructor(public readonly options: LaunchOptions) {
    this.readyPromise = new Promise((res, rej) => {
      this.readyResolve = res;
      this.readyReject = rej;
    });
    this.readyPromise.catch(() => undefined);
  }

  ready(): Promise<{ sessionId: string }> {
    return this.readyPromise;
  }
  send(text: string): void {
    this.calls.push("send");
    this.sent.push(text);
  }
  nextResult(): Promise<void> {
    return new Promise((r) => this.resultWaiters.push(r));
  }
  async interrupt(): Promise<void> {
    this.calls.push("interrupt");
    this.emitResult(); // interrupt の後には error_during_execution の result が来る
  }
  abort(): void {
    this.calls.push("abort");
  }
  close(): void {
    this.calls.push("close");
  }
  finished(): Promise<void> {
    return Promise.resolve();
  }

  // --- テストからの操作 ---
  init(sessionId = "session-1"): void {
    this.readyResolve({ sessionId });
  }
  failToStart(message = "boom"): void {
    this.readyReject(new Error(message));
  }
  emitResult(): void {
    const w = this.resultWaiters;
    this.resultWaiters = [];
    for (const r of w) r();
  }
}

export class FakeLauncher implements AgentLauncher {
  readonly sessions: FakeSession[] = [];
  /** 起動と同時に init を返す（既定）。 */
  autoInit = true;
  launch(options: LaunchOptions): AgentSession {
    const s = new FakeSession(options);
    this.sessions.push(s);
    if (this.autoInit) s.init();
    return s;
  }
}

export class FakeSink implements EventSink {
  readonly records: { requestId: string; body: EventBody; actor: SinkRequest["actor"] }[] = [];
  /** 次の n 回の記録を失敗させる。 */
  failNext = 0;
  record(req: SinkRequest): Result<unknown, Failure> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return { ok: false, error: failure("storeError", "disk full", "再試行する") };
    }
    this.records.push({ requestId: req.requestId, body: req.body, actor: req.actor });
    return ok(undefined);
  }
  get types(): string[] {
    return this.records.map((r) =>
      r.body.type === "node.stateChanged"
        ? `${r.body.type}:${r.body.payload.event.type}`
        : r.body.type === "node.stopObserved"
          ? `${r.body.type}:${r.body.payload.outcome}`
          : r.body.type,
    );
  }
}

/** プロセス一覧の列。呼ばれるたびに次の値を返し、尽きたら最後の値を返し続ける。 */
export const probeSequence = (...seq: (readonly ProcessInfo[] | null)[]) => {
  let i = 0;
  const calls: string[] = [];
  const probe = async (worktree: string): Promise<readonly ProcessInfo[] | null> => {
    calls.push(worktree);
    const v = seq[Math.min(i, seq.length - 1)];
    i += 1;
    return v === undefined ? [] : v;
  };
  return { probe, calls };
};
