// plugin/.claude-plugin/plugin.json の JSON 構文と必須項目を検証する。
import { readFileSync, statSync } from "node:fs";
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

if (json === null || typeof json !== "object" || Array.isArray(json)) {
  console.error("NG: plugin.json のトップレベルは JSON オブジェクトにしてください");
  process.exit(1);
}

const missing = required.filter((k) => typeof json[k] !== "string" || json[k].trim() === "");
if (missing.length > 0) {
  console.error(`NG: plugin.json に必須項目がありません、または空です: ${missing.join(", ")}`);
  process.exit(1);
}
const errors = [];
if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(json.name)) {
  errors.push(`name は kebab-case にしてください: ${json.name}`);
}
if (
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(
    json.version,
  )
) {
  errors.push(`version は semver にしてください: ${json.version}`);
}
for (const dir of ["agents", "hooks", "skills"]) {
  try {
    if (!statSync(join(root, "plugin", dir)).isDirectory()) throw new Error("not a directory");
  } catch {
    errors.push(`plugin/${dir}/ ディレクトリがありません`);
  }
}
if (errors.length > 0) {
  for (const e of errors) console.error(`NG: ${e}`);
  process.exit(1);
}
console.log(`OK: plugin.json (${json.name}@${json.version})`);
