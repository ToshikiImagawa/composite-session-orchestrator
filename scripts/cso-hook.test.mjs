// plugin/hooks/cso-hook.mjs の試験（node:test。依存なし）。`node --test scripts/*.test.mjs`
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runHook } from "../plugin/hooks/cso-hook.mjs";

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
  "cso-hook.mjs",
);
const ENV = { CSO_DAEMON_URL: "http://127.0.0.1:1", CSO_NODE_TOKEN: "t".repeat(32) };
const pre = JSON.stringify({
  hook_event_name: "PreToolUse",
  session_id: "s",
  tool_name: "Write",
  tool_input: {},
});
const stop = JSON.stringify({ hook_event_name: "Stop", session_id: "s" });
const reply = (status, json) => async () => ({ status, json: async () => json });

test("環境変数が両方ないときは、素通しし、標準エラーに一言出す", async () => {
  const r = await runHook({ env: {}, input: pre, fetchImpl: () => assert.fail("送らない") });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /CSO_DAEMON_URL と CSO_NODE_TOKEN がない/);
});

test("片方だけのときは、拒否する（終了コード 2）", async () => {
  for (const env of [
    { CSO_DAEMON_URL: ENV.CSO_DAEMON_URL },
    { CSO_NODE_TOKEN: ENV.CSO_NODE_TOKEN },
  ]) {
    const r = await runHook({ env, input: pre, fetchImpl: () => assert.fail("送らない") });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /片方だけ/);
  }
});

test("許可は終了コード 0、拒否は終了コード 2 と理由。URL とトークンを使って送る", async () => {
  let seen;
  const allow = await runHook({
    env: { ...ENV, CSO_DAEMON_URL: "http://127.0.0.1:9/" },
    input: pre,
    fetchImpl: async (url, init) => {
      seen = { url, auth: init.headers.authorization, body: init.body };
      return { status: 200, json: async () => ({ ok: true, value: { decision: "allow" } }) };
    },
  });
  assert.deepEqual(allow, { code: 0, stderr: "" });
  assert.deepEqual(seen, {
    url: "http://127.0.0.1:9/v1/hook",
    auth: `Bearer ${ENV.CSO_NODE_TOKEN}`,
    body: pre,
  });
  const deny = await runHook({
    env: ENV,
    input: pre,
    fetchImpl: reply(200, { ok: true, value: { decision: "deny", reason: "範囲外です" } }),
  });
  assert.deepEqual(deny, { code: 2, stderr: "範囲外です" });
});

test("PreToolUse はフェイルクローズ: 届かない・200 以外・形の違う応答・JSON でない入力は、拒否", async () => {
  const cases = [
    () => Promise.reject(new TypeError("fetch failed")),
    reply(413, { ok: false, error: { cause: "本文が大きすぎる" } }),
    reply(500, undefined),
    reply(200, { ok: true, value: { decision: "maybe" } }),
  ];
  for (const fetchImpl of cases) {
    const r = await runHook({ env: ENV, input: pre, fetchImpl });
    assert.equal(r.code, 2, r.stderr);
  }
  const big = await runHook({ env: ENV, input: pre, fetchImpl: cases[1] });
  assert.match(big.stderr, /本文が大きすぎる/);
  assert.equal((await runHook({ env: ENV, input: "{", fetchImpl: cases[0] })).code, 2);
});

test("Stop・PostToolUse は、失敗しても止めない（終了コード 0。標準エラーに出す）", async () => {
  const r = await runHook({
    env: ENV,
    input: stop,
    fetchImpl: () => Promise.reject(new Error("x")),
  });
  assert.equal(r.code, 0);
  assert.match(r.stderr, /Stop/);
});

test("実プロセス: daemon が止まっている（接続できない）と、PreToolUse は終了コード 2", () => {
  const p = spawnSync(process.execPath, [SCRIPT], {
    input: pre,
    env: { ...process.env, ...ENV },
    encoding: "utf8",
  });
  assert.equal(p.status, 2);
  assert.match(p.stderr, /届かない/);
});

test("実プロセス: 時間切れも拒否（応答しない受け口）", async () => {
  const server = createServer(() => {});
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  try {
    const r = await runHook({
      env: { ...ENV, CSO_DAEMON_URL: `http://127.0.0.1:${server.address().port}` },
      input: pre,
      timeoutMs: 100,
    });
    assert.equal(r.code, 2);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
