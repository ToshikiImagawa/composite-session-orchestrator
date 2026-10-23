import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSseHub, responseSink, type SseSink } from "../../src/api/sse-hub.js";

/**
 * 実際の背圧（T23 PR2 のレビュー）。1 件の通知は小さく、カーネルのバッファを埋めるのに時間がかかるので、
 * 試験の側で、1 回の書き込みを大きくして（詰め物）、本物のソケットで、`write()` が false を返す状況を作る。
 * 管理（`createSseHub`）と、出力先（`responseSink`）は、本物をそのまま使う。
 */
const PAD = "x".repeat(512 * 1024);
const padded = (sink: SseSink): SseSink => ({
  write: (c) => sink.write(`: ${PAD}\n${c}`),
  end: () => sink.end(),
  destroy: () => sink.destroy(),
  get destroyed() {
    return sink.destroyed;
  },
  onDrain: (cb) => sink.onDrain(cb),
  onClose: (cb) => sink.onClose(cb),
});

let server: Server | undefined;
const sockets: Socket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  server?.closeAllConnections();
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

const start = async (drainTimeoutMs: number) => {
  let n = 0;
  const hub = createSseHub({
    spec: {
      maxConnections: 4,
      coalesceMs: 5,
      heartbeatMs: 60_000,
      drainTimeoutMs,
      maxLifetimeMs: 3_600_000,
    },
    getSeq: () => ++n, // 周期ごとに変わる（毎回、通知を送る）
    isTokenValid: () => true,
    nowMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  });
  server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    hub.add(padded(responseSink(res)), "t");
    req.on("error", () => {});
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  const client = (paused: boolean): Socket => {
    const s = connect(port, "127.0.0.1");
    sockets.push(s);
    s.on("error", () => {});
    if (paused) s.pause();
    else s.resume();
    s.write("GET /v1/events HTTP/1.1\r\nHost: x\r\n\r\n");
    return s;
  };
  return { hub, client };
};
const until = async (f: () => boolean, ms: number): Promise<boolean> => {
  const t0 = Date.now();
  while (!f()) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 10));
  }
  return true;
};

describe("SSE の背圧（本物のソケット）", () => {
  it("読まない相手（socket を pause）には、write が false になり、drain が来ないので、drainTimeoutMs で切られる", async () => {
    const { hub, client } = await start(300);
    client(true);
    expect(await until(() => hub.size === 1, 2000)).toBe(true);
    expect(await until(() => hub.size === 0, 10_000)).toBe(true); // 切られて、掃除された
  }, 20_000);

  it("対照: 読んでいる相手は、同じ量を書いても、切られない（drain が来る）", async () => {
    const { hub, client } = await start(300);
    client(false);
    expect(await until(() => hub.size === 1, 2000)).toBe(true);
    await new Promise((r) => setTimeout(r, 1500)); // 上限（300ms）を十分に超える
    expect(hub.size).toBe(1);
  }, 20_000);

  it("詰まってから、相手が読み始めれば（drain が間に合えば）、切られない", async () => {
    const { hub, client } = await start(5000);
    const s = client(true);
    expect(await until(() => hub.size === 1, 2000)).toBe(true);
    await new Promise((r) => setTimeout(r, 300)); // 詰まらせる
    s.resume(); // 読み始める
    await new Promise((r) => setTimeout(r, 800));
    expect(hub.size).toBe(1);
  }, 20_000);
});
