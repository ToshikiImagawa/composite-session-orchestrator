/**
 * plugin の `.mcp.json` から足した MCP サーバー `node` のツールが、Claude Code でどの名前になるかを、実際に起動して確かめる（T25-rel）。
 * 期待する名前は `mcp__plugin_composite-session-orchestrator_node__<ツール>`（skill・コマンドは、これと `mcp__node__<ツール>` の
 * 両方で動くように書いてある。`plugin-check.mjs` の PLUGIN_TOOL_PREFIX）。Claude Code の版を上げたら実行する。
 * claude の起動と、API への失敗する接続を含むので、`pnpm check` には入れない（`mcp-env-expansion-check.mjs` と同じ位置づけ）。
 *
 * 使い方: `node scripts/plugin-mcp-name-check.mjs [--installed]`（claude は環境変数 `CLAUDE_BIN`、なければ PATH の `claude`）。
 * 既定は `--plugin-dir plugin` で読む。`--installed` は `--plugin-dir` を付けず、marketplace から入れた plugin で確かめる
 * （先に `claude plugin install composite-session-orchestrator@<marketplace>` をしておく）。
 * 終了コード 0: 期待どおり / 1: 違う・確かめられない。手元に偽の MCP サーバー（ツール whoami だけ）を立て、`CSO_MCP_URL` で向ける。
 * 2026-10-30 に Claude Code 2.1.308 で、両方の経路（`--plugin-dir`、手元の marketplace から install）で、期待どおりの名前を確かめた。
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_TOOL_PREFIX } from "./plugin-check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const claude = process.env.CLAUDE_BIN ?? "claude";
const expected = `${PLUGIN_TOOL_PREFIX}whoami`;
const installed = process.argv.includes("--installed");

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => {
    body += c;
  });
  req.on("end", () => {
    if (req.method !== "POST") return void res.writeHead(405).end();
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      return void res.writeHead(400).end();
    }
    if (msg.id === undefined) return void res.writeHead(202).end();
    let result = {};
    if (msg.method === "initialize") {
      result = {
        protocolVersion: msg.params?.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fake-node", version: "0" },
      };
    } else if (msg.method === "tools/list") {
      result = {
        tools: [{ name: "whoami", description: "test", inputSchema: { type: "object" } }],
      };
    }
    res
      .writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const { port } = server.address();

const child = spawn(
  claude,
  [
    ...(installed ? [] : ["--plugin-dir", join(root, "plugin")]),
    "-p",
    "hi",
    "--output-format",
    "stream-json",
    "--verbose",
    "--max-turns",
    "1",
  ],
  {
    env: {
      ...process.env,
      CSO_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      CSO_ROOT_TOKEN: "test-token",
      ANTHROPIC_API_KEY: "test-key-not-real",
    },
    stdio: ["ignore", "pipe", "ignore"],
  },
);
let tools;
let buf = "";
const timer = setTimeout(() => child.kill(), 60_000);
child.stdout.on("data", (c) => {
  buf += c;
  let i = buf.indexOf("\n");
  while (i >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      const ev = JSON.parse(line);
      if (ev.type === "system" && ev.subtype === "init" && Array.isArray(ev.tools)) {
        tools = ev.tools.filter((t) => t.includes("whoami"));
        child.kill();
      }
    } catch {}
    i = buf.indexOf("\n");
  }
});
await new Promise((r) => child.on("close", r));
clearTimeout(timer);
server.close();

if (tools === undefined) {
  console.error("NG: claude の init を受けられなかった（claude があるか、CLAUDE_BIN を確かめる）");
  process.exit(1);
}
if (!tools.includes(expected)) {
  console.error(`NG: ${expected} がない（見えた名前: ${tools.join(", ") || "なし"}）`);
  process.exit(1);
}
console.log(`OK: plugin の MCP のツールは ${expected} の名前で見える`);
