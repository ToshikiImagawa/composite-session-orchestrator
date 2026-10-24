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

const GOOD_INTEGRATOR = `---
name: cso-integrator
description: 統合ノードの手順
---
\`mcp__node__whoami\` \`mcp__node__node_spawn\` \`mcp__node__tree_list\`
`;
const GOOD_CHILD = `---
name: cso-child
description: 子ノードの手順
---
\`mcp__node__whoami\` \`mcp__node__report_done\` \`mcp__node__scope_extend\`
`;
const GOOD_COMMAND = `---
description: 状態を見る
allowed-tools: mcp__node__tree_list
---
\`mcp__node__tree_list\` を呼ぶ。
`;

/** 正常な plugin を一時ディレクトリに作る。`files` で、ファイルを足す・置き換える。 */
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

test("正常な plugin は、エラーなし", () => {
  assert.deepEqual(run(), []);
});

test("plugin.json の必須項目・name・version を検査する", () => {
  assert.match(run({ ".claude-plugin/plugin.json": "{" }).join("\n"), /plugin\.json/);
  assert.match(
    run({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "Bad_Name",
        version: "1",
        description: "d",
      }),
    }).join("\n"),
    /kebab-case[\s\S]*semver|semver[\s\S]*kebab-case/,
  );
});

test("skill: name がディレクトリ名と違う・description がない・frontmatter がない、を検出する", () => {
  const bad = (body) => run({ "skills/cso-child/SKILL.md": body }).join("\n");
  assert.match(bad(GOOD_CHILD.replace("name: cso-child", "name: other")), /name.*cso-child/);
  assert.match(bad(GOOD_CHILD.replace("description: 子ノードの手順\n", "")), /description/);
  assert.match(bad("本文だけ"), /frontmatter/);
});

test("command: description がない、を検出する", () => {
  const e = run({ "commands/status.md": GOOD_COMMAND.replace("description: 状態を見る\n", "") });
  assert.match(e.join("\n"), /commands\/status\.md.*description/);
});

test("ツール名: 実在しない名前を検出する（綴り違い・ロール違い）", () => {
  const typo = run({ "commands/status.md": `${GOOD_COMMAND}\`mcp__node__tree_lst\`\n` });
  assert.match(typo.join("\n"), /mcp__node__tree_lst/);
  // 子の skill が、統合のツールを書く
  const wrongRole = run({
    "skills/cso-child/SKILL.md": `${GOOD_CHILD}\`mcp__node__node_spawn\`\n`,
  });
  assert.match(wrongRole.join("\n"), /cso-child[\s\S]*node_spawn/);
});

test("ツール名: skill が、そのロールの全ツールを書いていなければ、検出する（新しいツールの書き忘れ）", () => {
  const e = run({
    "skills/cso-integrator/SKILL.md": GOOD_INTEGRATOR.replace("`mcp__node__tree_list`", ""),
  });
  assert.match(e.join("\n"), /cso-integrator[\s\S]*tree_list/);
});

test("NFR_012: 絶対パス・ホームのパス・禁止の文字列を検出する。URL のパス（/v1/）と CLAUDE_PLUGIN_ROOT の変数は可", () => {
  const ok = run({
    "commands/status.md": `${GOOD_COMMAND}http://127.0.0.1:7777/v1/whoami \${CLAUDE_PLUGIN_ROOT}/x\n`,
  });
  assert.deepEqual(ok, []);
  for (const bad of [
    "/home/user/repo/x",
    "/Users/me/repo",
    "C:\\Users\\me",
    "~/work/repo",
    "file:///tmp/x",
    "/tmp/cso",
  ]) {
    const e = run({ "commands/status.md": `${GOOD_COMMAND}${bad}\n` });
    assert.match(e.join("\n"), /NFR_012/, bad);
  }
  const named = checkPlugin({
    pluginDir: build({ "commands/status.md": `${GOOD_COMMAND}リポジトリは secret-repo にある\n` }),
    tools: TOOLS,
    forbidden: ["secret-repo"],
  });
  assert.match(named.join("\n"), /NFR_012[\s\S]*secret-repo/);
});

test("hooks.json: ない（空）ならよい。あれば、JSON として正しいこと", () => {
  assert.deepEqual(run({ "hooks/hooks.json": "{}" }), []);
  assert.match(run({ "hooks/hooks.json": "{" }).join("\n"), /hooks\.json/);
});

test("agents・hooks・skills のディレクトリがない、を検出する", () => {
  const e = run({ "hooks/.gitkeep": null, "agents/.gitkeep": null });
  assert.match(e.join("\n"), /plugin\/hooks/);
  assert.match(e.join("\n"), /plugin\/agents/);
});
