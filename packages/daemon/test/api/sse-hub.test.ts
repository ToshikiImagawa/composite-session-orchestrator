import { describe, expect, it } from "vitest";
import { createSseHub, type SseHubSpec, type SseSink } from "../../src/api/sse-hub.js";

const SPEC: SseHubSpec = {
  maxConnections: 2,
  coalesceMs: 250,
  heartbeatMs: 1000,
  drainTimeoutMs: 500,
  maxLifetimeMs: 5000,
};

/** 偽の出力先。`block` なら、`write()` が false を返す（詰まっている）。 */
class FakeSink implements SseSink {
  written: string[] = [];
  ended = false;
  destroyedFlag = false;
  block = false;
  private drain: (() => void)[] = [];
  private close: (() => void)[] = [];
  write(chunk: string): boolean {
    this.written.push(chunk);
    return !this.block;
  }
  end(): void {
    this.ended = true;
  }
  destroy(): void {
    this.destroyedFlag = true;
  }
  get destroyed(): boolean {
    return this.destroyedFlag;
  }
  onDrain(cb: () => void): void {
    this.drain.push(cb);
  }
  onClose(cb: () => void): void {
    this.close.push(cb);
  }
  emitDrain(): void {
    this.block = false;
    for (const f of this.drain) f();
  }
  emitClose(): void {
    for (const f of this.close) f();
  }
  get text(): string {
    return this.written.join("");
  }
}

const rig = (spec: Partial<SseHubSpec> = {}) => {
  let seq = 10;
  let now = 0;
  let valid = true;
  let checks = 0;
  const hub = createSseHub({
    spec: { ...SPEC, ...spec },
    getSeq: () => seq,
    isTokenValid: () => {
      checks += 1;
      return valid;
    },
    nowMs: () => now,
    autoStart: false,
  });
  return {
    hub,
    advance: (ms: number) => {
      now += ms;
      hub.tick();
    },
    setSeq: (n: number) => {
      seq = n;
    },
    revoke: () => {
      valid = false;
    },
    checks: () => checks,
  };
};

describe("SSE の接続の管理（sse-hub）", () => {
  it("加えたら、今の lastSeq をすぐ送る。上限を超えたら加えない（何も書かない）。閉じたら空く", () => {
    const r = rig();
    const a = new FakeSink();
    const b = new FakeSink();
    const c = new FakeSink();
    expect(r.hub.add(a, "t")).toBe(true);
    expect(r.hub.add(b, "t")).toBe(true);
    expect(a.text).toContain('data: {"lastSeq":10}');
    expect(r.hub.add(c, "t")).toBe(false);
    expect(c.written).toEqual([]);
    a.emitClose();
    expect(r.hub.size).toBe(1);
    expect(r.hub.add(c, "t")).toBe(true);
  });

  it("変わっていれば通知し、変わっていなければ送らない（heartbeat の前）", () => {
    const r = rig();
    const a = new FakeSink();
    r.hub.add(a, "t");
    const n = a.written.length;
    r.advance(250);
    expect(a.written).toHaveLength(n);
    r.setSeq(12);
    r.advance(250);
    expect(a.text).toContain('"lastSeq":12');
  });

  it("背圧: write が false のあと、drain が来なければ、drainTimeoutMs で destroy する。その間は、何も書かない", () => {
    const r = rig();
    const a = new FakeSink();
    a.block = true; // 最初の書き込みから、詰まる
    r.hub.add(a, "t");
    const n = a.written.length;
    r.setSeq(11);
    r.advance(250);
    r.setSeq(12);
    r.advance(200); // 450ms: まだ待つ
    expect(a.destroyedFlag).toBe(false);
    expect(a.written).toHaveLength(n); // 詰まっている間は、溜めない
    r.advance(100); // 550ms: 上限（500ms）を超えた
    expect(a.destroyedFlag).toBe(true);
    expect(r.hub.size).toBe(0);
  });

  it("背圧: drain が来れば、待ちは解け、再び送る（切らない）", () => {
    const r = rig();
    const a = new FakeSink();
    a.block = true;
    r.hub.add(a, "t");
    r.advance(300);
    a.emitDrain();
    r.setSeq(20);
    r.advance(300);
    expect(a.destroyedFlag).toBe(false);
    expect(a.text).toContain('"lastSeq":20');
    r.advance(1000);
    expect(a.destroyedFlag).toBe(false);
  });

  it("寿命（maxLifetimeMs）で閉じる（end。画面は再接続する）", () => {
    const r = rig({ heartbeatMs: 60_000 });
    const a = new FakeSink();
    r.hub.add(a, "t");
    r.advance(4000);
    expect(a.ended).toBe(false);
    r.advance(1000);
    expect(a.ended).toBe(true);
    expect(r.hub.size).toBe(0);
  });

  it("失効の確認は、通知とは独立に、heartbeatMs ごとに呼ぶ（lastSeq が変わり続けていても、必ず）。使えなければ閉じる", () => {
    const r = rig();
    const a = new FakeSink();
    r.hub.add(a, "t");
    let seq = 10;
    for (let i = 0; i < 4; i++) {
      seq += 1;
      r.setSeq(seq);
      r.advance(250); // 通知は毎回送る（heartbeat は書かない）
    }
    expect(r.checks()).toBe(1); // 1000ms で 1 回
    r.revoke();
    for (let i = 0; i < 4; i++) {
      seq += 1;
      r.setSeq(seq);
      r.advance(250);
    }
    expect(a.ended).toBe(true);
    expect(r.hub.size).toBe(0);
  });

  it("変化がなくても heartbeat を書く（heartbeatMs ごと）", () => {
    const r = rig();
    const a = new FakeSink();
    r.hub.add(a, "t");
    r.advance(900);
    expect(a.text).not.toContain("heartbeat");
    r.advance(100);
    expect(a.text).toContain(": heartbeat");
  });

  it("destroy 済みの接続は、掃除する", () => {
    const r = rig();
    const a = new FakeSink();
    r.hub.add(a, "t");
    a.destroyedFlag = true;
    r.advance(250);
    expect(r.hub.size).toBe(0);
  });
});
