import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Scope } from "@cso/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideToolUse, resolveScope } from "../../src/sdk/hook-policy.js";
import { nodeFsOps, resolveForWrite } from "../../src/sdk/path-resolve.js";

// 実ファイルシステムのリンクで確認する（macOS の /tmp → /private/tmp も含む）。
let root: string;
let wt: string;
let outside: string;
const resolve = (p: string) => resolveForWrite(p, nodeFsOps);

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "cso-path-")));
  wt = join(root, "wt");
  outside = join(root, "outside");
  mkdirSync(join(wt, "src"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, "target.txt"), "x");
  symlinkSync(outside, join(wt, "src", "dirlink")); // ディレクトリへのリンク
  symlinkSync(join(outside, "target.txt"), join(wt, "src", "filelink")); // ファイルへのリンク
  symlinkSync(join(outside, "nothing"), join(wt, "src", "dangling")); // 先が無いリンク
  symlinkSync(wt, join(root, "wtlink")); // 作業ツリー自体へのリンク
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("resolveForWrite（最も深い既存の祖先を実パスにして、残りを結合する）", () => {
  it("存在するパス・存在しない末尾は、実パスにする", async () => {
    expect(await resolve(join(wt, "src"))).toBe(join(wt, "src"));
    expect(await resolve(join(root, "wtlink", "src", "new", "a.ts"))).toBe(
      join(wt, "src", "new", "a.ts"),
    );
  });

  it("リンク先の外へ出るパスは、外の実パスになる", async () => {
    expect(await resolve(join(wt, "src", "dirlink", "new.txt"))).toBe(join(outside, "new.txt"));
    expect(await resolve(join(wt, "src", "filelink"))).toBe(join(outside, "target.txt"));
  });

  it("先の無いリンク（dangling）と、存在しない部分に .. を含むパスは拒否する", async () => {
    await expect(resolve(join(wt, "src", "dangling"))).rejects.toThrow();
    await expect(resolve(join(wt, "src", "dangling", "x"))).rejects.toThrow();
    await expect(resolve(`${wt}/src/none/../../x`)).rejects.toThrow();
  });

  it("存在する部分の .. は、OS の解決に従う", async () => {
    expect(await resolve(`${wt}/src/dirlink/../x`)).toBe(join(root, "x"));
  });
});

describe("フック: リンク経由の書き込みを実ファイルシステムで拒否する", () => {
  const scope: Scope = {
    writableLocations: ["src"],
    forbiddenLocations: ["src/secret"],
    allowedCommands: [],
  };
  const decide = async (file: string, cwd = wt) =>
    decideToolUse(
      await resolveScope(scope, cwd, resolve),
      cwd,
      "Write",
      { file_path: file },
      resolve,
    );

  it("作業ツリー内のリンクでも、先が範囲外なら拒否する", async () => {
    for (const f of ["src/dirlink/new.txt", "src/filelink", join(wt, "src/dirlink/x/y")]) {
      const d = await decide(f);
      expect(d.allow, f).toBe(false);
    }
  });

  it("通常の書き込みは許可し、dangling は拒否する", async () => {
    expect((await decide("src/new/a.ts")).allow).toBe(true);
    expect((await decide("src/dangling")).allow).toBe(false);
  });

  it("scope の場所自体がリンクでも、実パスにして判定する（作業ツリーのリンク経由の cwd も同じ）", async () => {
    mkdirSync(join(wt, "linkedwritable"), { recursive: true });
    symlinkSync(join(wt, "src"), join(wt, "viasrc"));
    const s: Scope = { writableLocations: ["viasrc"], forbiddenLocations: [], allowedCommands: [] };
    const r = await resolveScope(s, wt, resolve);
    expect(r.writableLocations).toEqual([join(wt, "src")]);
    const d = await decideToolUse(r, wt, "Write", { file_path: "src/a.ts" }, resolve);
    expect(d.allow).toBe(true);
  });

  it("解決できない writable は落とし（許可を減らす）、解決できない forbidden は残す", async () => {
    const s: Scope = {
      writableLocations: ["src/dangling", "src"],
      forbiddenLocations: ["src/dangling"],
      allowedCommands: [],
    };
    const r = await resolveScope(s, wt, resolve);
    expect(r.writableLocations).toEqual([join(wt, "src")]);
    expect(r.forbiddenLocations).toEqual([join(wt, "src", "dangling")]);
  });
});
