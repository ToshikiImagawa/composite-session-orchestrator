import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHILDREN_DIR, CHILDREN_KEY_FILE, prepareChildrenDirs } from "../src/children-dir.js";

const made: string[] = [];
const state = () => {
  const d = mkdtempSync(join(tmpdir(), "cso-children-"));
  chmodSync(d, 0o700);
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});
const noExclude = async () => undefined;
const mode = (p: string) => lstatSync(p).mode & 0o777;

describe("子の引き出しの置き場（T21-d）", () => {
  it("置き場（0700）と鍵のファイル（0600）を作る。鍵は推測できない形で、再起動しても同じ", () => {
    const s = state();
    const a = prepareChildrenDirs(s, { exclude: noExclude });
    expect(mode(join(s, CHILDREN_DIR))).toBe(0o700);
    expect(mode(join(s, CHILDREN_KEY_FILE))).toBe(0o600);
    const k = a.keyOf("node-a");
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(k).not.toContain("node-a");
    expect(a.keyOf("node-b")).not.toBe(k);
    expect(prepareChildrenDirs(s, { exclude: noExclude }).keyOf("node-a")).toBe(k);
    // 別の置き場（別の秘密）では、同じノード ID でも鍵が違う
    expect(prepareChildrenDirs(state(), { exclude: noExclude }).keyOf("node-a")).not.toBe(k);
  });

  it("すでにある置き場が 0700 でない・リンクなら、直さずに失敗する", () => {
    const s = state();
    mkdirSync(join(s, CHILDREN_DIR), { mode: 0o755 });
    chmodSync(join(s, CHILDREN_DIR), 0o755);
    expect(() => prepareChildrenDirs(s, { exclude: noExclude })).toThrow("0700");
    expect(mode(join(s, CHILDREN_DIR))).toBe(0o755); // 直していない
    const s2 = state();
    const elsewhere = state();
    symlinkSync(elsewhere, join(s2, CHILDREN_DIR));
    expect(() => prepareChildrenDirs(s2, { exclude: noExclude })).toThrow("実のディレクトリでない");
  });

  it("鍵のファイルが緩い権限・リンク・壊れた中身なら、失敗する", () => {
    const s = state();
    writeFileSync(join(s, CHILDREN_KEY_FILE), `${"a".repeat(64)}\n`, { mode: 0o644 });
    chmodSync(join(s, CHILDREN_KEY_FILE), 0o644);
    expect(() => prepareChildrenDirs(s, { exclude: noExclude })).toThrow("0600");
    const s2 = state();
    writeFileSync(join(s2, "real"), `${"a".repeat(64)}\n`, { mode: 0o600 });
    symlinkSync(join(s2, "real"), join(s2, CHILDREN_KEY_FILE));
    expect(() => prepareChildrenDirs(s2, { exclude: noExclude })).toThrow();
    const s3 = state();
    writeFileSync(join(s3, CHILDREN_KEY_FILE), "broken\n", { mode: 0o600 });
    expect(() => prepareChildrenDirs(s3, { exclude: noExclude })).toThrow("壊れて");
  });

  it("子の引き出しを 0700 で作る。すでにある引き出しがリンクなら失敗する", () => {
    const s = state();
    const d = prepareChildrenDirs(s, { exclude: noExclude });
    const dir = d.create("node-a");
    expect(dir).toBe(join(s, CHILDREN_DIR, d.keyOf("node-a")));
    expect(mode(dir)).toBe(0o700);
    expect(d.create("node-a")).toBe(dir); // 2 回目は確かめるだけ
    const target = state();
    symlinkSync(target, join(d.root, d.keyOf("node-b")));
    expect(() => d.create("node-b")).toThrow("実のディレクトリでない");
  });

  it("消すときはリンクをたどらない（引き出しがリンクならリンクだけ、中のリンクの先も消さない）", () => {
    const s = state();
    const d = prepareChildrenDirs(s, { exclude: noExclude });
    const outside = state();
    writeFileSync(join(outside, "keep"), "x");
    const dir = d.create("node-a");
    symlinkSync(outside, join(dir, "link"));
    d.remove("node-a");
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(join(outside, "keep"))).toBe(true);
    symlinkSync(outside, join(d.root, d.keyOf("node-b")));
    d.remove("node-b");
    expect(existsSync(join(outside, "keep"))).toBe(true);
    d.remove("node-c"); // なければ何もしない
  });

  it("M9: 動いている子の鍵でない引き出し（止まった子・知らない名前・ファイル・リンク）を消す", () => {
    const s = state();
    const d = prepareChildrenDirs(s, { exclude: noExclude });
    const live = d.create("live");
    const stale = d.create("stopped");
    writeFileSync(join(d.root, "stray.txt"), "x");
    const outside = state();
    writeFileSync(join(outside, "keep"), "x");
    symlinkSync(outside, join(d.root, "link"));
    expect(d.sweep(["live"])).toBe(3);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(join(outside, "keep"))).toBe(true);
  });

  it("Time Machine から外す処理は、置き場のパスだけで呼ぶ。失敗は警告だけで続ける", async () => {
    const s = state();
    const calls: string[] = [];
    const warnings: string[] = [];
    prepareChildrenDirs(s, {
      exclude: async (p) => {
        calls.push(p);
        throw new Error("tmutil: not permitted");
      },
      onWarning: (c) => warnings.push(c),
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([join(s, CHILDREN_DIR)]);
    expect(warnings[0]).toContain("Time Machine");
  });
});
