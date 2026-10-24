/**
 * 子に渡す「skill だけの plugin」（T22-c。IR_002, NFR_012）。
 *
 * SDK の `options.plugins` は、plugin の skills・hooks・agents・commands をまとめて読む（hooks だけを外す選択肢はない）。
 * plugin のディレクトリをそのまま渡すと、hooks.json も読まれ、SDK のフック（`hook-policy`）と二重の判定になる。そこで daemon が、
 * 状態の置き場（stateDir）の下に、skill（SKILL.md）と plugin.json だけを写した plugin を作り、それを子に渡す。
 *
 * - 起動のたびに作り直す（写す前に消す。以前の内容〔hooks.json など〕を残さない）。
 * - 写す先は stateDir の下だけ。写す元のシンボリックリンクは辿らない。SKILL.md の frontmatter の `name` が、ディレクトリ名と一致すること。
 * - パスはコードに書かない。写す元は設定（`childPluginDir`）、写す先は stateDir から決める。
 */

import { lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Failure, isPathUnder, type NodeRole, normalizePath, type Result } from "@cso/core";
import { fail } from "../api/handlers/context.js";

/** 作る plugin の名前（skill は `cso-child-skills:<skill>` で指す）。 */
export const CHILD_PLUGIN_NAME = "cso-child-skills";
/** 写す skill。中間の統合ノードは cso-integrator、それ以外は cso-child。 */
export const CHILD_SKILLS = ["cso-child", "cso-integrator"] as const;
export type ChildSkill = (typeof CHILD_SKILLS)[number];
/** 写す先（stateDir からの相対）。 */
export const CHILD_PLUGIN_DIR = "child-plugin";
/** SKILL.md の大きさの上限（バイト）。 */
const SKILL_MAX_BYTES = 64 * 1024;

export const skillFor = (role: NodeRole): ChildSkill =>
  role === "integrator" ? "cso-integrator" : "cso-child";

/** SDK の `skills` に渡す、plugin で修飾した名前。 */
export const qualifiedSkill = (skill: ChildSkill): string => `${CHILD_PLUGIN_NAME}:${skill}`;

/** frontmatter（先頭の `---` から次の `---` まで）の `name:` の値。なければ undefined。 */
export function frontmatterName(text: string): string | undefined {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== "---") return undefined;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (line === "---") return undefined;
    const m = /^name:\s*(.+?)\s*$/.exec(line);
    if (m) return m[1];
  }
  return undefined;
}

const isPlainFile = (path: string): boolean => {
  try {
    const s = lstatSync(path);
    return s.isFile() && !s.isSymbolicLink();
  } catch {
    return false;
  }
};
const isPlainDir = (path: string): boolean => {
  try {
    const s = lstatSync(path);
    return s.isDirectory() && !s.isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * `sourceDir`（plugin のディレクトリ）の skill だけを、`dest`（stateDir の下）に写した plugin を作る。`dest` は、先に消して作り直す。
 * 失敗したら、何も渡さずに起動を止められるよう、失敗を返す（フェイルクローズ）。
 */
export function buildChildPlugin(
  sourceDir: string,
  dest: string,
  stateDir: string,
): Result<{ readonly path: string }, Failure> {
  const d = normalizePath("/", dest);
  const s = normalizePath("/", stateDir);
  if (!dest.startsWith("/") || d === s || !isPathUnder(d, s)) {
    return fail(
      "childPluginOutsideState",
      `子に渡す plugin の写す先が、状態の置き場の下にない: ${dest}`,
      "設定の stateDir を確認する",
    );
  }
  const skills: { name: ChildSkill; text: string }[] = [];
  for (const name of CHILD_SKILLS) {
    const dir = join(sourceDir, "skills", name);
    const file = join(dir, "SKILL.md");
    if (!isPlainDir(join(sourceDir, "skills")) || !isPlainDir(dir) || !isPlainFile(file)) {
      return fail(
        "childPluginInvalid",
        `plugin の skill がない、またはシンボリックリンク: skills/${name}/SKILL.md`,
        "設定の childPluginDir が plugin のディレクトリを指しているか確認する",
      );
    }
    const text = readFileSync(file, "utf8");
    if (Buffer.byteLength(text) > SKILL_MAX_BYTES) {
      return fail(
        "childPluginInvalid",
        `skill が大きすぎる: skills/${name}/SKILL.md`,
        "skill を確認する",
      );
    }
    if (frontmatterName(text) !== name) {
      return fail(
        "childPluginInvalid",
        `skill の name がディレクトリ名と一致しない: skills/${name}/SKILL.md`,
        "skill の frontmatter を確認する",
      );
    }
    skills.push({ name, text });
  }
  try {
    // 作り直す（以前の内容〔hooks.json など〕を残さない）。
    rmSync(d, { recursive: true, force: true });
    mkdirSync(join(d, ".claude-plugin"), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(d, ".claude-plugin", "plugin.json"),
      `${JSON.stringify(
        {
          name: CHILD_PLUGIN_NAME,
          description:
            "composite-session-orchestrator の子に渡す skill（daemon が作る。hooks は含まない）",
          version: "0.0.0",
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    for (const { name, text } of skills) {
      mkdirSync(join(d, "skills", name), { recursive: true, mode: 0o700 });
      writeFileSync(join(d, "skills", name, "SKILL.md"), text, { mode: 0o600 });
    }
  } catch (e) {
    return fail(
      "childPluginFailed",
      `子に渡す plugin を作れない: ${String(e)}`,
      "状態の置き場の権限を確認する",
    );
  }
  return { ok: true, value: { path: d } };
}
