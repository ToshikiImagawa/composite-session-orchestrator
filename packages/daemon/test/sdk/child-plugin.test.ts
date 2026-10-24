import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildChildPlugin,
  CHILD_PLUGIN_DIR,
  frontmatterName,
  qualifiedSkill,
  skillFor,
} from "../../src/sdk/child-plugin.js";

const skill = (name: string) => `---\nname: ${name}\ndescription: 説明\n---\n\n# ${name}\n本文\n`;

/** 元の plugin（skill 2 つ・hooks・commands・.mcp.json を持つ）と、stateDir を作る。 */
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), "cso-cp-"));
  const src = join(root, "plugin");
  for (const name of ["cso-child", "cso-integrator"]) {
    mkdirSync(join(src, "skills", name), { recursive: true });
    writeFileSync(join(src, "skills", name, "SKILL.md"), skill(name));
  }
  mkdirSync(join(src, "hooks"), { recursive: true });
  writeFileSync(join(src, "hooks", "hooks.json"), "{}");
  mkdirSync(join(src, "commands"), { recursive: true });
  writeFileSync(join(src, "commands", "start.md"), "x");
  writeFileSync(join(src, ".mcp.json"), "{}");
  const state = join(root, "state");
  mkdirSync(state);
  return { src, state, dest: join(state, CHILD_PLUGIN_DIR) };
};
const files = (dir: string, base = ""): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), `${base}${e.name}/`) : [`${base}${e.name}`],
  );

describe("buildChildPlugin（skill だけの plugin。T22-c）", () => {
  it("SKILL.md と plugin.json だけを写す（hooks・commands・.mcp.json は写さない）", () => {
    const { src, state, dest } = setup();
    const r = buildChildPlugin(src, dest, state);
    expect(r).toEqual({ ok: true, value: { path: dest } });
    expect(files(dest).sort()).toEqual([
      ".claude-plugin/plugin.json",
      "skills/cso-child/SKILL.md",
      "skills/cso-integrator/SKILL.md",
    ]);
    expect(readFileSync(join(dest, "skills", "cso-child", "SKILL.md"), "utf8")).toBe(
      skill("cso-child"),
    );
    expect(JSON.parse(readFileSync(join(dest, ".claude-plugin", "plugin.json"), "utf8")).name).toBe(
      "cso-child-skills",
    );
  });

  it("起動のたびに作り直す: 以前の内容（hooks.json など）は、写す前に消える", () => {
    const { src, state, dest } = setup();
    mkdirSync(join(dest, "hooks"), { recursive: true });
    writeFileSync(join(dest, "hooks", "hooks.json"), "{}");
    writeFileSync(join(dest, "stale.txt"), "old");
    expect(buildChildPlugin(src, dest, state).ok).toBe(true);
    expect(existsSync(join(dest, "hooks"))).toBe(false);
    expect(existsSync(join(dest, "stale.txt"))).toBe(false);
  });

  it("写す先が stateDir の下でなければ、何も消さず・作らずに失敗する", () => {
    const { src, state } = setup();
    const outside = join(state, "..", "elsewhere");
    mkdirSync(outside);
    writeFileSync(join(outside, "keep.txt"), "keep");
    for (const dest of [outside, state, "relative/child-plugin", join(state, "..")]) {
      const r = buildChildPlugin(src, dest, state);
      expect(r.ok, dest).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("childPluginOutsideState");
    }
    expect(readFileSync(join(outside, "keep.txt"), "utf8")).toBe("keep");
  });

  it("skill がない・シンボリックリンク・name の不一致は失敗する（フェイルクローズ）", () => {
    const a = setup();
    writeFileSync(join(a.src, "skills", "cso-child", "SKILL.md"), skill("other"));
    expect(buildChildPlugin(a.src, a.dest, a.state).ok).toBe(false);

    const b = setup();
    const real = join(b.src, "real.md");
    writeFileSync(real, skill("cso-child"));
    const link = join(b.src, "skills", "cso-child", "SKILL.md");
    rmSync(link);
    symlinkSync(real, link);
    expect(buildChildPlugin(b.src, b.dest, b.state).ok).toBe(false);

    const c = setup();
    expect(buildChildPlugin(join(c.src, "nothing"), c.dest, c.state).ok).toBe(false);
    expect(existsSync(c.dest)).toBe(false);
  });
});

describe("skill の選び分け・名前", () => {
  it("中間の統合ノードは cso-integrator、それ以外は cso-child。plugin で修飾する", () => {
    expect(skillFor("integrator")).toBe("cso-integrator");
    for (const role of ["implement", "review", "investigate", "merge"] as const) {
      expect(skillFor(role)).toBe("cso-child");
    }
    expect(qualifiedSkill("cso-child")).toBe("cso-child-skills:cso-child");
  });

  it("frontmatterName: 先頭の frontmatter の name だけを読む", () => {
    expect(frontmatterName(skill("cso-child"))).toBe("cso-child");
    expect(frontmatterName("name: x\n")).toBeUndefined();
    expect(frontmatterName("---\ndescription: d\n---\nname: x\n")).toBeUndefined();
  });
});
