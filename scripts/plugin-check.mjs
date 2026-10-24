// plugin/ の検証（`validate-plugin.mjs` から使う。試験は plugin-check.test.mjs）。依存なし。
// - plugin.json の構文と必須項目・name・version
// - agents・hooks・skills のディレクトリ、skills・commands の frontmatter、hooks/hooks.json（あれば JSON として正しいこと）
// - skill・command に書いた MCP のツール名（mcp__node__*）が実在すること。skill は、そのロールの全ツールを書いていること
// - NFR_012: plugin に、リポジトリ・利用者の場所（絶対パス）を埋め込まないこと
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** 先頭の frontmatter（`---` で囲んだ `key: value` の行）を読む。なければ undefined。 */
const frontmatter = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (m === null) return undefined;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv !== null) out[kv[1]] = kv[2].trim();
  }
  return out;
};

const walk = (dir) => {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile()) out.push(p);
  }
  return out;
};

const TOOL_RE = /mcp__node__([A-Za-z_]*[A-Za-z])/g;
/** NFR_012: 絶対パス・ホームのパス・Windows のパス・file URL。URL のパス（/v1/ など）と `${CLAUDE_PLUGIN_ROOT}` は、対象外。 */
const PATH_RES = [
  /(?:^|[\s"'`(=])\/(?:home|Users|root|tmp|var|opt|usr|etc|mnt|srv|private)\//,
  /(?:^|[\s"'`(=])~\//,
  /\b[A-Za-z]:\\/,
  /file:\/\//,
];

export function checkPlugin({ pluginDir, tools, forbidden = [] }) {
  const errors = [];
  const rel = (p) => `plugin/${relative(pluginDir, p).split("\\").join("/")}`;

  // plugin.json
  const manifest = join(pluginDir, ".claude-plugin", "plugin.json");
  let json;
  try {
    json = JSON.parse(readFileSync(manifest, "utf8"));
  } catch (e) {
    errors.push(`plugin.json を読み込めません（JSON 構文を確認してください）: ${e.message}`);
  }
  if (json !== undefined) {
    if (json === null || typeof json !== "object" || Array.isArray(json)) {
      errors.push("plugin.json のトップレベルは JSON オブジェクトにしてください");
    } else {
      const missing = ["name", "version", "description"].filter(
        (k) => typeof json[k] !== "string" || json[k].trim() === "",
      );
      if (missing.length > 0) {
        errors.push(`plugin.json に必須項目がありません、または空です: ${missing.join(", ")}`);
      }
      if (typeof json.name === "string" && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(json.name)) {
        errors.push(`name は kebab-case にしてください: ${json.name}`);
      }
      if (
        typeof json.version === "string" &&
        !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(
          json.version,
        )
      ) {
        errors.push(`version は semver にしてください: ${json.version}`);
      }
    }
  }

  for (const dir of ["agents", "hooks", "skills"]) {
    if (!isDir(join(pluginDir, dir))) errors.push(`plugin/${dir}/ ディレクトリがありません`);
  }

  // hooks/hooks.json（なければ空。あれば、JSON として正しいこと）
  const hooksFile = join(pluginDir, "hooks", "hooks.json");
  if (existsSync(hooksFile)) {
    try {
      JSON.parse(readFileSync(hooksFile, "utf8"));
    } catch (e) {
      errors.push(`plugin/hooks/hooks.json を読み込めません: ${e.message}`);
    }
  }

  const known = new Set([...tools.integrator, ...tools.child, ...tools.common]);
  const roleTools = {
    "cso-integrator": new Set([...tools.integrator, ...tools.common]),
    "cso-child": new Set([...tools.child, ...tools.common]),
  };

  // skills
  const skillsDir = join(pluginDir, "skills");
  if (isDir(skillsDir)) {
    for (const e of readdirSync(skillsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const file = join(skillsDir, e.name, "SKILL.md");
      if (!existsSync(file)) {
        errors.push(`${rel(join(skillsDir, e.name))}/ に SKILL.md がありません`);
        continue;
      }
      const text = readFileSync(file, "utf8");
      const fm = frontmatter(text);
      if (fm === undefined) {
        errors.push(`${rel(file)}: frontmatter（---）がありません`);
        continue;
      }
      if (fm.name !== e.name) {
        errors.push(`${rel(file)}: name はディレクトリ名（${e.name}）と同じにしてください`);
      }
      if (!fm.description) errors.push(`${rel(file)}: description がありません`);
      // ロール別の skill: そのロールのツールだけを、すべて書く
      const allowed = roleTools[e.name];
      if (allowed !== undefined) {
        const used = new Set([...text.matchAll(TOOL_RE)].map((m) => m[1]));
        for (const t of used) {
          if (known.has(t) && !allowed.has(t)) {
            errors.push(`${rel(file)}: ${e.name} のロールに公開されていないツール mcp__node__${t}`);
          }
        }
        const roleOnly = e.name === "cso-child" ? tools.child : tools.integrator;
        for (const t of roleOnly) {
          if (!used.has(t)) errors.push(`${rel(file)}: ツール mcp__node__${t} の説明がありません`);
        }
      }
    }
  }

  // commands
  const commandsDir = join(pluginDir, "commands");
  if (isDir(commandsDir)) {
    for (const file of walk(commandsDir).filter((f) => f.endsWith(".md"))) {
      const fm = frontmatter(readFileSync(file, "utf8"));
      if (fm === undefined || !fm.description) {
        errors.push(`${rel(file)}: frontmatter の description がありません`);
      }
    }
  }

  // すべてのファイル: ツール名の実在、NFR_012
  const files = isDir(pluginDir) ? walk(pluginDir).filter((f) => !f.endsWith(".gitkeep")) : [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(TOOL_RE)) {
      if (!known.has(m[1])) errors.push(`${rel(file)}: 存在しないツール名 mcp__node__${m[1]}`);
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (PATH_RES.some((re) => re.test(line))) {
        errors.push(
          `${rel(file)}:${i + 1}: NFR_012 絶対パス・ホームのパスを埋め込まないでください（環境変数か引数で受けます）`,
        );
      }
      for (const word of forbidden) {
        if (word !== "" && line.includes(word)) {
          errors.push(
            `${rel(file)}:${i + 1}: NFR_012 リポジトリ・利用者の場所（${word}）を埋め込まないでください`,
          );
        }
      }
    });
  }
  return [...new Set(errors)];
}
