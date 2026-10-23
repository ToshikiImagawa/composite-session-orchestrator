/**
 * SSE の接続の管理（T23 PR2。`docs/ui.md`）。`ServerResponse` から切り離してあるので、背圧・寿命・失効の確認を、偽の出力先（`SseSink`）で確かめられる。
 *
 * - 送るのは `lastSeq` の通知だけ。1 つの周期（`coalesceMs`）で、全ての接続を見る。変わっていれば通知（連続した変化は最新の 1 件にまとまる）。
 * - **背圧**: `write()` が `false` を返したら、`drain` が来るまで、その接続には何も送らない。`drainTimeoutMs` 来なければ、切る（遅い・止まった相手）。
 * - **寿命**: 接続は、`maxLifetimeMs` で閉じる（画面は、再接続する）。
 * - **失効の確認**: トークンが使えるかを、通知とは独立に、`heartbeatMs` ごとに確かめる（使えなければ閉じる）。
 * - **heartbeat**: `heartbeatMs` の間、何も書かなければ、コメント行を書く。
 */

import type { ServerResponse } from "node:http";

export interface SseSink {
  /** `false` は、書き込みが詰まったこと（`drain` が来るまで、待つ）。 */
  write(chunk: string): boolean;
  end(): void;
  destroy(): void;
  readonly destroyed: boolean;
  onDrain(callback: () => void): void;
  onClose(callback: () => void): void;
}

export interface SseHubSpec {
  readonly maxConnections: number;
  readonly coalesceMs: number;
  readonly heartbeatMs: number;
  /** `write()` が `false` を返してから、`drain` を待つ上限。 */
  readonly drainTimeoutMs: number;
  /** 1 つの接続の最大の寿命。 */
  readonly maxLifetimeMs: number;
}

export interface SseHubDeps {
  readonly spec: SseHubSpec;
  /** 今の `lastSeq`。 */
  readonly getSeq: () => number;
  /** トークンが、今も使えるか。 */
  readonly isTokenValid: (token: string) => boolean;
  /** 単調時計（ミリ秒）。 */
  readonly nowMs: () => number;
  /** `false` なら、周期を自動で回さない（試験が `tick()` を呼ぶ）。 */
  readonly autoStart?: boolean;
}

export interface SseHub {
  readonly size: number;
  /** 接続を加える。上限なら `false`（何も書かない）。加えたら、今の `lastSeq` をすぐ送る。 */
  add(sink: SseSink, token: string): boolean;
  tick(): void;
}

interface Conn {
  readonly sink: SseSink;
  readonly token: string;
  readonly startedMs: number;
  sentSeq: number;
  lastWriteMs: number;
  lastAuthMs: number;
  /** `write()` が `false` を返した時刻（`drain` で消える）。 */
  blockedSinceMs: number | undefined;
}

/** `ServerResponse` を、出力先にする（`write()` の戻り値と `drain` を、そのまま使う）。 */
export const responseSink = (res: ServerResponse): SseSink => ({
  write: (chunk) => res.write(chunk),
  end: () => res.end(),
  destroy: () => res.destroy(),
  get destroyed() {
    return res.destroyed;
  },
  onDrain: (cb) => res.on("drain", cb),
  onClose: (cb) => res.once("close", cb),
});

export const sseEvent = (seq: number): string =>
  `id: ${seq}\nevent: seq\ndata: ${JSON.stringify({ lastSeq: seq })}\n\n`;

export function createSseHub(deps: SseHubDeps): SseHub {
  const { spec } = deps;
  const conns = new Set<Conn>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopTimerIfIdle = (): void => {
    if (conns.size === 0 && timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const drop = (c: Conn): void => {
    conns.delete(c);
    stopTimerIfIdle();
  };
  const send = (c: Conn, chunk: string): void => {
    const now = deps.nowMs();
    const ok = c.sink.write(chunk);
    c.lastWriteMs = now;
    if (!ok && c.blockedSinceMs === undefined) c.blockedSinceMs = now;
  };

  function tick(): void {
    const seq = deps.getSeq();
    const now = deps.nowMs();
    for (const c of [...conns]) {
      if (c.sink.destroyed) {
        drop(c);
        continue;
      }
      if (now - c.startedMs >= spec.maxLifetimeMs) {
        c.sink.end(); // 寿命。画面は再接続する
        drop(c);
        continue;
      }
      // 失効の確認は、通知とは独立に、heartbeatMs ごと
      if (now - c.lastAuthMs >= spec.heartbeatMs) {
        c.lastAuthMs = now;
        if (!deps.isTokenValid(c.token)) {
          c.sink.end();
          drop(c);
          continue;
        }
      }
      if (c.blockedSinceMs !== undefined) {
        // 詰まっている間は、何も書かない（溜めない）。`drain` が来なければ、切る
        if (now - c.blockedSinceMs >= spec.drainTimeoutMs) {
          c.sink.destroy();
          drop(c);
        }
        continue;
      }
      if (c.sentSeq !== seq) {
        send(c, sseEvent(seq));
        c.sentSeq = seq;
      } else if (now - c.lastWriteMs >= spec.heartbeatMs) {
        send(c, ": heartbeat\n\n");
      }
    }
  }

  return {
    get size(): number {
      return conns.size;
    },
    add(sink, token) {
      if (conns.size >= spec.maxConnections) return false;
      const now = deps.nowMs();
      const seq = deps.getSeq();
      const c: Conn = {
        sink,
        token,
        startedMs: now,
        sentSeq: seq,
        lastWriteMs: now,
        lastAuthMs: now,
        blockedSinceMs: undefined,
      };
      conns.add(c);
      sink.onDrain(() => {
        c.blockedSinceMs = undefined;
      });
      sink.onClose(() => drop(c));
      // 最初に、今の `lastSeq` を送る（画面は、これで状態を取る。再接続の間の変化も、これで拾う）
      send(c, `retry: 3000\n${sseEvent(seq)}`);
      if (timer === undefined && deps.autoStart !== false) {
        timer = setInterval(tick, spec.coalesceMs);
        timer.unref();
      }
      return true;
    },
    tick,
  };
}
