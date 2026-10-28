/**
 * 同梱の claude が、`--mcp-config` の http の headers の `${VAR}` を展開するかを、実際に起動して確かめる（T21-ce）。
 * CLI の子のトークンは、引数（`--mcp-config`）に値を置かず、環境変数 `CSO_MCP_TOKEN` の参照で渡している。claude の版を
 * 上げたときに、展開されなくなって黙って 401 になるのを、早く見つけるための確認（`ui-browser-check.mjs` と同じ位置づけ。
 * claude の起動と、API への失敗する接続を含むので、`pnpm check` には入れない）。
 *
 * 使い方: `node scripts/mcp-env-expansion-check.mjs`（終了コード 0: 展開された / 1: 展開されない・確かめられない）。
 * 出すのは、展開されたかどうかだけ（受けた値そのものは出さない）。API の鍵は、試験用の偽の値を使う。
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const store = join(root, "node_modules", ".pnpm");
const platformDir = readdirSync(store).find((d) =>
  d.startsWith(`@anthropic-ai+claude-agent-sdk-${process.platform}-${process.arch}@`),
);
if (platformDir === undefined) {
  console.error("同梱の claude が見つからない（pnpm install を先に行う）");
  process.exit(1);
}
const claude = join(
  store,
  platformDir,
  "node_modules",
  "@anthropic-ai",
  `claude-agent-sdk-${process.platform}-${process.arch}`,
  "claude",
);

// 参照の文字列（`${CSO_MCP_TOKEN}`。テンプレートの記法と取り違えないよう、つないで作る）
const REF = "$" + "{CSO_MCP_TOKEN}";
const probe = `probe-${randomBytes(12).toString("hex")}`;
const seen = [];
const server = createServer((req, res) => {
  seen.push(req.headers.authorization ?? "");
  req.resume();
  req.on("end", () => {
    res.writeHead(401);
    res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const home = mkdtempSync(join(tmpdir(), "cso-mcp-env-"));
const config = JSON.stringify({
  mcpServers: {
    node: {
      type: "http",
      url: `http://127.0.0.1:${port}/mcp`,
      headers: { Authorization: `Bearer ${REF}` },
    },
  },
});
const child = spawn(claude, ["-p", "hi", "--strict-mcp-config", "--mcp-config", config], {
  env: {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    ANTHROPIC_API_KEY: "sk-test-not-a-real-key",
    CSO_MCP_TOKEN: probe,
  },
  stdio: "ignore",
});
const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
await new Promise((r) => child.on("exit", r));
clearTimeout(timer);
server.close();
rmSync(home, { recursive: true, force: true });

const expanded = seen.some((a) => a === `Bearer ${probe}`);
const literal = seen.some((a) => a.includes(REF));
console.log(JSON.stringify({ requests: seen.length, expanded, literal }));
process.exit(expanded && !literal ? 0 : 1);
