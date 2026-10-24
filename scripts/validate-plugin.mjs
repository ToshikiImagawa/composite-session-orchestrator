// plugin/ を検証する（`pnpm check` の最後の段階。`pnpm build` が済んでいること: MCP のツール名を packages/mcp/dist から読む）。
// 検査の中身は plugin-check.mjs（試験: plugin-check.test.mjs）。
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { checkPlugin } from "./plugin-check.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolsModule = join(root, "packages", "mcp", "dist", "tools.js");
if (!existsSync(toolsModule)) {
  console.error(
    "NG: packages/mcp/dist/tools.js がありません（先に pnpm build を実行してください）",
  );
  process.exit(1);
}
const { toolsFor, WHOAMI_TOOL } = await import(pathToFileURL(toolsModule).href);
const names = (role) => toolsFor(role).map((t) => t.name);
const errors = checkPlugin({
  pluginDir: join(root, "plugin"),
  tools: { integrator: names("integrator"), child: names("child"), common: [WHOAMI_TOOL] },
  forbidden: [root],
});
if (errors.length > 0) {
  for (const e of errors) console.error(`NG: ${e}`);
  process.exit(1);
}
const json = JSON.parse(
  readFileSync(join(root, "plugin", ".claude-plugin", "plugin.json"), "utf8"),
);
console.log(`OK: plugin.json (${json.name}@${json.version})・skills・commands・ツール名・NFR_012`);
