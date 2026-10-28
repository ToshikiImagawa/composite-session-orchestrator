import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_STATES } from "@cso/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  CHILD_DIR_NEEDED,
  CHILDREN_DIR,
  CHILDREN_KEY_FILE,
  ChildrenDirError,
  drawerActionFor,
  prepareChildrenDirs,
} from "../src/children-dir.js";

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

  it("M9: 要る子の鍵でない引き出し（片付いた子・知らない名前・ファイル・リンク）を消す", () => {
    const s = state();
    prepareChildrenDirs(s, { exclude: noExclude }); // 1 回目（秘密を作る起動）
    const d = prepareChildrenDirs(s, { exclude: noExclude });
    const live = d.create("live");
    const stale = d.create("stopped");
    writeFileSync(join(d.root, "stray.txt"), "x");
    const outside = state();
    writeFileSync(join(outside, "keep"), "x");
    symlinkSync(outside, join(d.root, "link"));
    expect(d.sweep(["live"])).toEqual({ removed: 3, failed: 0 });
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

  it("M1: 鍵のファイルが消えても、鍵の形の引き出しが残っていれば、黙って作り直さずに止める（復旧の手順つき）", () => {
    const s = state();
    const d = prepareChildrenDirs(s, { exclude: noExclude });
    d.create("live");
    rmSync(join(s, CHILDREN_KEY_FILE));
    let err: unknown;
    try {
      prepareChildrenDirs(s, { exclude: noExclude });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ChildrenDirError);
    expect((err as ChildrenDirError).recovery.join("")).toContain("空にして");
    expect((err as Error).message).not.toContain(s);
    expect(existsSync(join(s, CHILDREN_KEY_FILE))).toBe(false); // 作り直していない
    expect(existsSync(join(d.root, d.keyOf("live")))).toBe(true);
  });

  it("M1: 鍵の形の引き出しがなければ、鍵を作る。その起動では掃除しない", () => {
    const s = state();
    mkdirSync(join(s, CHILDREN_DIR), { mode: 0o700 });
    chmodSync(join(s, CHILDREN_DIR), 0o700);
    writeFileSync(join(s, CHILDREN_DIR, "stray"), "x");
    const d = prepareChildrenDirs(s, { exclude: noExclude });
    expect(d.createdKey).toBe(true);
    expect(d.sweep([])).toEqual({ removed: 0, failed: 0 });
    expect(existsSync(join(s, CHILDREN_DIR, "stray"))).toBe(true);
    const again = prepareChildrenDirs(s, { exclude: noExclude });
    expect(again.createdKey).toBe(false);
    expect(again.sweep([]).removed).toBe(1);
  });

  it("R1: 置き場が起動のあとで差し替えられたら、消す前に止める", () => {
    const s = state();
    prepareChildrenDirs(s, { exclude: noExclude });
    const d = prepareChildrenDirs(s, { exclude: noExclude });
    renameSync(join(s, CHILDREN_DIR), join(s, "moved"));
    mkdirSync(join(s, CHILDREN_DIR), { mode: 0o700 });
    chmodSync(join(s, CHILDREN_DIR), 0o700);
    expect(() => d.sweep([])).toThrow("差し替えられた");
    expect(() => d.remove("a")).toThrow("差し替えられた");
    expect(() => d.create("a")).toThrow("差し替えられた");
  });

  it("R3: すべての状態を、引き出しが要る／要らないに分ける（done・stopped は要る。pending・verified・reclaimable・archived は要らない）", () => {
    expect(Object.keys(CHILD_DIR_NEEDED).sort()).toEqual([...NODE_STATES].sort());
    const needed = NODE_STATES.filter((x) => CHILD_DIR_NEEDED[x]);
    expect(needed.sort()).toEqual(
      ["done", "running", "stopIncomplete", "stopped", "stopping", "waiting"].sort(),
    );
  });

  it("失敗の文に、実パスを入れない", () => {
    const s = state();
    mkdirSync(join(s, CHILDREN_DIR), { mode: 0o755 });
    chmodSync(join(s, CHILDREN_DIR), 0o755);
    try {
      prepareChildrenDirs(s, { exclude: noExclude });
    } catch (e) {
      expect((e as Error).message).not.toContain(s);
    }
  });
});

describe("引き出しの中身と、状態の移り変わり（T21-cc N3・N4）", () => {
  it("reset は前の中身を消して作り直す（ノード ID の再利用）。writeFile は 0600 で置き、一時ファイルを残さない", () => {
    const s = state();
    prepareChildrenDirs(s, { exclude: noExclude });
    const d = prepareChildrenDirs(s, { exclude: noExclude });
    const dir = d.create("a");
    writeFileSync(join(dir, "token"), "old");
    expect(d.reset("a")).toBe(dir);
    expect(readdirSync(dir)).toEqual([]);
    expect(mode(dir)).toBe(0o700);
    d.writeFile("a", "node", "a");
    expect(readFileSync(join(dir, "node"), "utf8")).toBe("a\n");
    expect(mode(join(dir, "node"))).toBe(0o600);
    expect(readdirSync(dir)).toEqual(["node"]);
    expect(d.pathOf("a")).toBe(dir);
  });

  it("removeFiles は指定の名前とその一時ファイルだけを消す（引き出しと node は残す。リンクはリンクだけ）", () => {
    const s = state();
    prepareChildrenDirs(s, { exclude: noExclude });
    const d = prepareChildrenDirs(s, { exclude: noExclude });
    const dir = d.create("a");
    d.writeFile("a", "node", "a");
    const outside = state();
    writeFileSync(join(outside, "keep"), "x");
    for (const f of ["token", "url", "token.tmp-1234"]) writeFileSync(join(dir, f), "x");
    symlinkSync(join(outside, "keep"), join(dir, "code"));
    d.removeFiles("a", ["token", "url", "code"]);
    expect(readdirSync(dir)).toEqual(["node"]);
    expect(existsSync(join(outside, "keep"))).toBe(true);
    d.removeFiles("zz", ["token"]); // 引き出しがなければ何もしない
  });

  it("drawerActionFor の表: spawn で作る（起動時に初めて見るノードは作らない）、stopped で中を消す、verified・reclaimable・archived で消す、done は何もしない", () => {
    expect(drawerActionFor(undefined, "pending", false)).toBe("create");
    expect(drawerActionFor(undefined, "running", true)).toBeUndefined();
    expect(drawerActionFor("running", "stopped", false)).toBe("clearSecrets");
    expect(drawerActionFor(undefined, "stopped", true)).toBeUndefined();
    for (const x of ["verified", "reclaimable", "archived"]) {
      expect(drawerActionFor("done", x, false), x).toBe("remove");
    }
    expect(drawerActionFor("running", "done", false)).toBeUndefined();
    expect(drawerActionFor("stopped", "running", false)).toBeUndefined();
    expect(drawerActionFor("running", "running", false)).toBeUndefined();
  });
});
