// plugin/ の検証（`validate-plugin.mjs` から使う。試験は plugin-check.test.mjs）。依存なし。
// - plugin.json の構文と必須項目・name・version
// - agents・hooks・skills のディレクトリ、skills・commands の frontmatter、hooks/hooks.json（あれば JSON として正しく、形が正しいこと。T22-h）
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

/**
 * 先頭の frontmatter（`---` で囲んだ、1 行の `key: value`）を読む。なければ undefined。
 * 複数行の値（`>`・`|`、字下げの続きの行）は、読めないので、`multiline` に key を入れる（呼び出し側が、エラーにする）。
 */
const frontmatter = (text) => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (m === null) return undefined;
  const out = {};
  const multiline = [];
  let last = "";
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (kv !== null) {
      last = kv[1];
      const value = kv[2].trim();
      if (/^[>|][+-]?\d*$/.test(value)) multiline.push(last);
      out[last] = value;
    } else if (/^\s+\S/.test(line)) {
      multiline.push(last);
    }
  }
  return { values: out, multiline: [...new Set(multiline)] };
};
/** 説明の行: 行頭の箇条書きで、ツール名のあとに `:` と 10 文字以上の説明が続く。 */
const DESCRIBED_RE = /^\s*[-*]\s+`?mcp__node__([A-Za-z_]*[A-Za-z])`?\s*:\s*(\S.*)$/;
const describedTools = (text) => {
  const out = new Set();
  for (const line of text.split(/\r?\n/)) {
    const m = DESCRIBED_RE.exec(line);
    if (m !== null && Array.from(m[2].trim()).length >= 10) out.add(m[1]);
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

/**
 * plugin の `.mcp.json` から足した MCP のツールは、Claude Code が `mcp__plugin_<plugin 名>_<サーバー名>__<ツール>` の名前で出す
 * （2.1.308 で確認。`scripts/plugin-mcp-name-check.mjs`）。daemon が起動する子・手で足した MCP は `mcp__node__<ツール>`。両方を検査する。
 */
export const PLUGIN_TOOL_PREFIX = "mcp__plugin_composite-session-orchestrator_node__";
const TOOL_RE = /mcp__(?:node|plugin_composite-session-orchestrator_node)__([A-Za-z_]*[A-Za-z])/g;
/**
 * NFR_012: 一般の絶対パス（行頭・空白・引用符・`(`・`=` の直後の `/<英数字>/…`）・ホームのパス・Windows のパス・file URL を拒否する。
 * 例外は、URL のパス（`://host` の後）と `${CLAUDE_PLUGIN_ROOT}`（とそれに続く plugin の中のパス。`..` を含むものは除く）だけ（先に取り除いてから、検査する）。
 */
const URL_RE = /\b(?!file:)[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'`)\]>]*/g;
const PATH_RES = [
  /(?:^|[\s"'`(=])\/[A-Za-z0-9_.-]+\//,
  /(?:^|[\s"'`(=])~\//,
  /\b[A-Za-z]:\\/,
  /file:\/\//,
];
const pathViolation = (line) => {
  // `${CLAUDE_PLUGIN_ROOT}` のあとに `..` が続くもの（plugin の外へ出るパス）は、例外にしない（hooks.json の command と対称）。
  if (/\$\{CLAUDE_PLUGIN_ROOT\}[^\s"'`]*(?:^|\/)\.\.(?:\/|[\s"'`]|$)/.test(line)) return true;
  const rest = line.replaceAll(URL_RE, " ").replaceAll(/\$\{CLAUDE_PLUGIN_ROOT\}[^\s"'`]*/g, " ");
  return PATH_RES.some((re) => re.test(rest));
};

const HOOK_EVENTS = new Set(["PreToolUse", "PostToolUse", "Stop"]);
/** `node "${CLAUDE_PLUGIN_ROOT}/<相対パス>"`（引用符は任意）。NFR_012: パスは plugin の中だけ。 */
const HOOK_COMMAND_RE = /^node "?\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9_./-]+\.mjs)"?$/;
const isObj = (x) => typeof x === "object" && x !== null && !Array.isArray(x);

/** hooks.json の形（T22-h）。イベントは PreToolUse・PostToolUse・Stop だけ。command は plugin の中のスクリプトを node で起動する。 */
const checkHooks = (json, pluginDir) => {
  const errors = [];
  const at = "plugin/hooks/hooks.json";
  if (!isObj(json)) return [`${at}: 全体がオブジェクトではありません`];
  if (!isObj(json.hooks)) return [`${at}: hooks（オブジェクト）がありません`];
  for (const [event, entries] of Object.entries(json.hooks)) {
    if (!HOOK_EVENTS.has(event)) {
      errors.push(`${at}: 未知のイベント ${event}（PreToolUse・PostToolUse・Stop だけ）`);
      continue;
    }
    if (!Array.isArray(entries)) {
      errors.push(`${at}: ${event} が配列ではありません`);
      continue;
    }
    for (const [i, e] of entries.entries()) {
      const where = `${at}: ${event}[${i}]`;
      if (!isObj(e)) {
        errors.push(`${where} がオブジェクトではありません`);
        continue;
      }
      if (event === "Stop" && e.matcher !== undefined) {
        errors.push(`${where}: Stop には matcher を書きません`);
      } else if (e.matcher !== undefined && (typeof e.matcher !== "string" || e.matcher === "")) {
        errors.push(`${where}: matcher は空でない文字列です`);
      }
      if (!Array.isArray(e.hooks) || e.hooks.length === 0) {
        errors.push(`${where}: hooks（1 つ以上）がありません`);
        continue;
      }
      for (const [j, h] of e.hooks.entries()) {
        const w = `${where}.hooks[${j}]`;
        if (!isObj(h) || h.type !== "command" || typeof h.command !== "string") {
          errors.push(`${w}: type は "command"、command は文字列です`);
          continue;
        }
        const m = HOOK_COMMAND_RE.exec(h.command);
        if (m === null || m[1].split("/").includes("..")) {
          errors.push(
            `${w}: command は node "\${CLAUDE_PLUGIN_ROOT}/<plugin の中の .mjs>" の形です`,
          );
        } else if (!existsSync(join(pluginDir, m[1]))) {
          errors.push(`${w}: command のファイル ${m[1]} が plugin の中にありません`);
        }
        if (
          h.timeout !== undefined &&
          !(Number.isInteger(h.timeout) && h.timeout >= 1 && h.timeout <= 60)
        ) {
          errors.push(`${w}: timeout は 1〜60 の整数（秒）です`);
        }
      }
    }
  }
  return errors;
};

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
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(hooksFile, "utf8"));
    } catch (e) {
      errors.push(`plugin/hooks/hooks.json を読み込めません: ${e.message}`);
    }
    if (parsed !== undefined) errors.push(...checkHooks(parsed, pluginDir));
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
      const parsed = frontmatter(text);
      if (parsed === undefined) {
        errors.push(`${rel(file)}: frontmatter（---）がありません`);
        continue;
      }
      const fm = parsed.values;
      for (const key of parsed.multiline) {
        errors.push(
          `${rel(file)}: frontmatter の ${key} は複数行の値です（検出できないので、1 行で書いてください）`,
        );
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
        const described = describedTools(text);
        const roleOnly = [
          ...(e.name === "cso-child" ? tools.child : tools.integrator),
          ...tools.common,
        ];
        for (const t of roleOnly) {
          if (!described.has(t)) {
            errors.push(
              `${rel(file)}: ツール mcp__node__${t} の説明がありません（行頭の箇条書きで「- \`mcp__node__名前\`: 説明（10 文字以上）」の形）`,
            );
          }
        }
      }
    }
  }

  // commands
  const commandsDir = join(pluginDir, "commands");
  if (isDir(commandsDir)) {
    for (const file of walk(commandsDir).filter((f) => f.endsWith(".md"))) {
      const parsed = frontmatter(readFileSync(file, "utf8"));
      if (parsed === undefined || !parsed.values.description) {
        errors.push(`${rel(file)}: frontmatter の description がありません`);
      }
      for (const key of parsed?.multiline ?? []) {
        errors.push(
          `${rel(file)}: frontmatter の ${key} は複数行の値です（検出できないので、1 行で書いてください）`,
        );
      }
      // allowed-tools: どちらの名前で入れても動くよう、mcp__node__X と plugin の名前を対にして書く
      const allowedTools = (parsed?.values["allowed-tools"] ?? "").split(",").map((t) => t.trim());
      const set = new Set(allowedTools);
      for (const t of allowedTools) {
        const m = /^mcp__node__(.+)$/.exec(t);
        const pm = t.startsWith(PLUGIN_TOOL_PREFIX)
          ? t.slice(PLUGIN_TOOL_PREFIX.length)
          : undefined;
        if (m !== null && !set.has(`${PLUGIN_TOOL_PREFIX}${m[1]}`)) {
          errors.push(
            `${rel(file)}: allowed-tools に ${PLUGIN_TOOL_PREFIX}${m[1]} がありません（plugin から入れたときの名前）`,
          );
        }
        if (pm !== undefined && !set.has(`mcp__node__${pm}`)) {
          errors.push(`${rel(file)}: allowed-tools に mcp__node__${pm} がありません`);
        }
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
      if (pathViolation(line)) {
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
