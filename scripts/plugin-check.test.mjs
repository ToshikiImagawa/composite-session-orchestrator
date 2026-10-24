// plugin-check.mjs の試験（node:test。依存なし）。`node --test scripts/*.test.mjs`
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { checkPlugin } from "./plugin-check.mjs";

const TOOLS = {
  integrator: ["node_spawn", "tree_list"],
  child: ["report_done", "scope_extend"],
  common: ["whoami"],
};

/** 説明の行（行頭の箇条書き。ツール名のあとに `:` と 10 文字以上の説明）。 */
const bullet = (t) => `- \`mcp__node__${t}\`: これは、十分に長い説明の文章です。\n`;
const skill = (name, description, tools) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n${tools.map(bullet).join("")}`;
const GOOD_INTEGRATOR = skill("cso-integrator", "統合ノードの手順", [
  "whoami",
  "node_spawn",
  "tree_list",
]);
const GOOD_CHILD = skill("cso-child", "子ノードの手順", ["whoami", "report_done", "scope_extend"]);
const GOOD_COMMAND = `---
description: 状態を見る
allowed-tools: mcp__node__tree_list
---
\`mcp__node__tree_list\` を呼ぶ。
`;

/** 正常な plugin を一時ディレクトリに作る。`files` で、ファイルを足す・置き換える（null は作らない）。 */
const build = (files = {}) => {
  const root = mkdtempSync(join(tmpdir(), "cso-plugin-"));
  const all = {
    ".claude-plugin/plugin.json": JSON.stringify({
      name: "composite-session-orchestrator",
      version: "0.0.0",
      description: "d",
    }),
    "agents/.gitkeep": "",
    "hooks/.gitkeep": "",
    "skills/cso-integrator/SKILL.md": GOOD_INTEGRATOR,
    "skills/cso-child/SKILL.md": GOOD_CHILD,
    "commands/status.md": GOOD_COMMAND,
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    if (body === null) continue;
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
  }
  return root;
};
const run = (files) => checkPlugin({ pluginDir: build(files), tools: TOOLS, forbidden: [] });
const text = (files) => run(files).join("\n");

test("正常な plugin は、エラーなし", () => {
  assert.deepEqual(run(), []);
});

test("plugin.json の必須項目・name・version を検査する", () => {
  assert.match(text({ ".claude-plugin/plugin.json": "{" }), /plugin\.json/);
  const bad = text({
    ".claude-plugin/plugin.json": JSON.stringify({
      name: "Bad_Name",
      version: "1",
      description: "d",
    }),
  });
  assert.match(bad, /kebab-case/);
  assert.match(bad, /semver/);
});

test("skill: name がディレクトリ名と違う・description がない・frontmatter がない、を検出する", () => {
  const bad = (body) => text({ "skills/cso-child/SKILL.md": body });
  assert.match(bad(GOOD_CHILD.replace("name: cso-child", "name: other")), /name.*cso-child/);
  assert.match(bad(GOOD_CHILD.replace("description: 子ノードの手順\n", "")), /description/);
  assert.match(bad("本文だけ"), /frontmatter/);
});

test("command: description がない、を検出する", () => {
  const e = text({ "commands/status.md": GOOD_COMMAND.replace("description: 状態を見る\n", "") });
  assert.match(e, /commands\/status\.md.*description/);
});

test("ツール名: 実在しない名前を検出する（綴り違い・ロール違い）", () => {
  const typo = text({ "commands/status.md": `${GOOD_COMMAND}\`mcp__node__tree_lst\`\n` });
  assert.match(typo, /mcp__node__tree_lst/);
  // 子の skill が、統合のツールを書く
  const wrongRole = text({ "skills/cso-child/SKILL.md": GOOD_CHILD + bullet("node_spawn") });
  assert.match(wrongRole, /cso-child[\s\S]*node_spawn/);
});

test("ツール名: skill が、そのロールの全ツールを書いていなければ、検出する（新しいツールの書き忘れ）", () => {
  const e = text({
    "skills/cso-integrator/SKILL.md": GOOD_INTEGRATOR.replace(bullet("tree_list"), ""),
  });
  assert.match(e, /cso-integrator[\s\S]*tree_list/);
});

test("ツールの説明: 否定の文脈の言及・説明が短い行・箇条書きでない行は、説明とみなさない", () => {
  const without = (extra) =>
    text({ "skills/cso-integrator/SKILL.md": GOOD_INTEGRATOR.replace(bullet("tree_list"), extra) });
  // 否定の文脈だけ
  assert.match(without("`mcp__node__tree_list` は使わないこと。\n"), /tree_list.*説明がありません/);
  // 箇条書きだが、説明が 10 文字に満たない
  assert.match(without("- `mcp__node__tree_list`: 短い説明\n"), /tree_list.*説明がありません/);
  // 箇条書きでない（本文の中）
  assert.match(
    without("木は `mcp__node__tree_list`: これは、十分に長い説明の文章です。\n"),
    /tree_list.*説明がありません/,
  );
  // `:` がない
  assert.match(
    without("- `mcp__node__tree_list` これは、十分に長い説明の文章です。\n"),
    /tree_list.*説明がありません/,
  );
  // 正しい形（`*` の箇条書き）は通る
  assert.equal(without("* `mcp__node__tree_list`: 十文字以上の説明がここにある。\n"), "");
});

test("NFR_012: 一般の絶対パスを拒否する。例外は、URL のパスと CLAUDE_PLUGIN_ROOT の変数だけ", () => {
  const ok = run({
    "commands/status.md": `${GOOD_COMMAND}http://127.0.0.1:7777/v1/whoami \${CLAUDE_PLUGIN_ROOT}/x\n`,
  });
  assert.deepEqual(ok, []);
  for (const bad of [
    "/home/user/repo/x",
    "/Users/me/repo",
    "/workspace/proj/x",
    "/app/src/x",
    "/Volumes/disk/x",
    "/c/Users/me/x",
    "C:\\Users\\me",
    "~/work/repo",
    "file:///tmp/x",
    "/tmp/cso",
  ]) {
    for (const wrap of [bad, `"${bad}"`, `(${bad})`, `x=${bad}`, `\`${bad}\``, `見る ${bad} を`]) {
      assert.match(text({ "commands/status.md": `${GOOD_COMMAND}${wrap}\n` }), /NFR_012/, wrap);
    }
  }
  // URL の例は、どの区切りの直後でも通る
  for (const url of [
    "`https://example.com/a/b/`",
    '"http://localhost:7777/mcp/x/"',
    "(http://127.0.0.1/v1/x/y)",
  ]) {
    assert.deepEqual(run({ "commands/status.md": `${GOOD_COMMAND}${url}\n` }), [], url);
  }
  const named = checkPlugin({
    pluginDir: build({ "commands/status.md": `${GOOD_COMMAND}リポジトリは secret-repo にある\n` }),
    tools: TOOLS,
    forbidden: ["secret-repo"],
  });
  assert.match(named.join("\n"), /NFR_012[\s\S]*secret-repo/);
});

// biome-ignore lint/suspicious/noTemplateCurlyInString: hooks.json に書く、Claude Code が展開する変数の参照
const CMD = 'node "${CLAUDE_PLUGIN_ROOT}/hooks/cso-hook.mjs"';
const entry = (extra = {}) => ({
  hooks: [{ type: "command", command: CMD, timeout: 10 }],
  ...extra,
});
const hooksJson = (h) => JSON.stringify({ hooks: h });
const withScript = (h) => ({ "hooks/hooks.json": hooksJson(h), "hooks/cso-hook.mjs": "" });

test("hooks.json: ない（空）ならよい。あれば、JSON として正しいこと", () => {
  assert.deepEqual(run({ "hooks/hooks.json": hooksJson({}) }), []);
  assert.match(text({ "hooks/hooks.json": "{" }), /hooks\.json/);
});

test("hooks.json の形: 正しい形（PreToolUse・PostToolUse・Stop、command は CLAUDE_PLUGIN_ROOT 起点で、実在するファイル）", () => {
  assert.deepEqual(
    run(
      withScript({
        PreToolUse: [entry({ matcher: "*" })],
        PostToolUse: [entry({ matcher: "*" })],
        Stop: [entry()],
      }),
    ),
    [],
  );
});

test("hooks.json の形の誤りを検出する", () => {
  const bad = [
    [{ "hooks/hooks.json": "[]" }, /オブジェクト/],
    [{ "hooks/hooks.json": JSON.stringify({ hooks: [] }) }, /hooks/],
    [withScript({ SessionStart: [entry()] }), /SessionStart/],
    [withScript({ PreToolUse: entry() }), /配列/],
    [withScript({ PreToolUse: [{ matcher: 1, hooks: [] }] }), /matcher/],
    [withScript({ PreToolUse: [{ hooks: [] }] }), /1 つ以上/],
    [withScript({ PreToolUse: [{ hooks: [{ type: "http", command: CMD }] }] }), /command/],
    [
      withScript({ PreToolUse: [{ hooks: [{ type: "command", command: "node hook.mjs" }] }] }),
      /CLAUDE_PLUGIN_ROOT/,
    ],
    [
      withScript({
        PreToolUse: [entry({ hooks: [{ type: "command", command: CMD, timeout: 0 }] })],
      }),
      /timeout/,
    ],
    [
      withScript({
        PreToolUse: [entry({ hooks: [{ type: "command", command: CMD, timeout: 600 }] })],
      }),
      /timeout/,
    ],
    [withScript({ Stop: [entry({ matcher: "*" })] }), /Stop/],
    [{ "hooks/hooks.json": hooksJson({ PreToolUse: [entry()] }) }, /cso-hook\.mjs/],
  ];
  for (const [files, re] of bad) assert.match(text(files), re, JSON.stringify(files));
});

test("agents・hooks・skills のディレクトリがない、を検出する", () => {
  const e = text({ "hooks/.gitkeep": null, "agents/.gitkeep": null });
  assert.match(e, /plugin\/hooks/);
  assert.match(e, /plugin\/agents/);
});

test("frontmatter: 複数行の値（> | と、字下げの続き）は、検出できないので、エラーにする", () => {
  for (const desc of [
    "description: >\n  子ノードの\n  手順",
    "description: |-\n  子ノードの手順",
    "description: 子ノードの\n  手順",
  ]) {
    const e = text({
      "skills/cso-child/SKILL.md": GOOD_CHILD.replace("description: 子ノードの手順", desc),
    });
    assert.match(e, /複数行/, desc);
  }
});
