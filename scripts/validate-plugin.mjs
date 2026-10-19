// plugin/.claude-plugin/plugin.json の JSON 構文と必須項目を検証する。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const file = join(root, "plugin", ".claude-plugin", "plugin.json");
const required = ["name", "version", "description"];

let json;
try {
  json = JSON.parse(readFileSync(file, "utf8"));
} catch (e) {
  console.error(`NG: ${file} を読み込めません（JSON 構文を確認してください）: ${e.message}`);
  process.exit(1);
}

const missing = required.filter((k) => typeof json[k] !== "string" || json[k].trim() === "");
if (missing.length > 0) {
  console.error(`NG: plugin.json に必須項目がありません、または空です: ${missing.join(", ")}`);
  process.exit(1);
}
console.log(`OK: plugin.json (${json.name}@${json.version})`);
