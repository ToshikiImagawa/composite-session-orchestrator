import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { createLsofProbe, type Exec, nodeExec, parseLsofFields } from "../../src/sdk/lsof-probe.js";

const WT = "/wt/a";

/** lsof -nP -d cwd -F pcn の出力（抜粋）。 */
const CWD_OUT = [
  "p1",
  "cinit",
  "n/proc/1/cwd (readlink: Permission denied)",
  "p100",
  "cclaude",
  "n/wt/a",
  "p101",
  "cbash",
  "n/wt/a/src/deep",
  "p102",
  "cvim",
  "n/wt/ab",
  "p103",
  "cnode",
  "n/other",
  "p104",
  "cdaemon",
  "n/WT/A",
  "",
].join("\n");

/** lsof -nP -F pcfn +D /wt/a の出力（抜粋）。 */
const OPEN_OUT = [
  "p100",
  "cclaude",
  "fcwd",
  "n/wt/a",
  "p103",
  "cnode",
  "f12",
  "n/wt/a/src/file.ts",
  "ftxt",
  "n/wt/a/node_modules/.bin/tool",
  "p105",
  "cwriter",
  "f4",
  "n/wt/a/log.txt",
  "",
].join("\n");

const fakeExec =
  (cwdRes: Partial<Awaited<ReturnType<Exec>>>, openRes: Partial<Awaited<ReturnType<Exec>>>): Exec =>
  async (_file, args) => {
    const isCwd = args.includes("cwd");
    return { code: 0, stdout: "", ...(isCwd ? cwdRes : openRes) };
  };

describe("parseLsofFields（-F の出力の解析）", () => {
  it("プロセスごとに、コマンドとファイル（fd と名前）をまとめる", () => {
    const procs = parseLsofFields(OPEN_OUT);
    expect(procs.map((p) => p.pid)).toEqual([100, 103, 105]);
    expect(procs[1]).toEqual({
      pid: 103,
      command: "node",
      files: [
        { fd: "12", name: "/wt/a/src/file.ts" },
        { fd: "txt", name: "/wt/a/node_modules/.bin/tool" },
      ],
    });
  });

  it("f の行がない出力（-F pcn）では、名前をファイルとして扱う（fd は空）", () => {
    const procs = parseLsofFields("p7\ncsh\nn/x/y\n");
    expect(procs).toEqual([{ pid: 7, command: "sh", files: [{ fd: "", name: "/x/y" }] }]);
  });

  it("壊れた行・空の出力でも例外を出さず、読めた分だけ返す", () => {
    expect(parseLsofFields("")).toEqual([]);
    expect(parseLsofFields("garbage\n\np\npabc\nn/x\nfcwd\n")).toEqual([]);
    expect(parseLsofFields("p9\nn/a\nn/b\n")[0]?.files).toHaveLength(2);
  });

  it("性質: 任意の文字列で例外を出さない", () => {
    fc.assert(fc.property(fc.string(), (s) => void parseLsofFields(s)));
  });
});

describe("createLsofProbe（作業ツリー配下で動作中のプロセスの一覧）", () => {
  it("cwd が作業ツリー配下、または配下のファイルを開いているプロセスだけを返す", async () => {
    const probe = createLsofProbe(fakeExec({ stdout: CWD_OUT }, { stdout: OPEN_OUT }));
    const list = await probe(WT);
    expect(list).not.toBeNull();
    expect(list).toEqual([
      { pid: 100, cwd: "/wt/a", hasOpenFiles: false }, // cwd は配下。+D の cwd の行は「開いているファイル」に数えない
      { pid: 101, cwd: "/wt/a/src/deep", hasOpenFiles: false },
      { pid: 103, cwd: "/other", hasOpenFiles: true }, // cwd は外でも、配下のファイルを開いている
      { pid: 104, cwd: "/WT/A", hasOpenFiles: false }, // 大文字小文字を畳み込んで同一視
      { pid: 105, cwd: "", hasOpenFiles: true }, // cwd を取れなかったが、配下のファイルを開いている
    ]);
  });

  it("cwd を読めなかった他ユーザーのプロセス（readlink: Permission denied）は対象にしない", async () => {
    const probe = createLsofProbe(fakeExec({ stdout: CWD_OUT }, { stdout: "" }));
    const list = (await probe(WT)) ?? [];
    expect(list.map((p) => p.pid)).not.toContain(1);
  });

  it("lsof が一致なしで終了コード 1・出力が空なら、動作中のプロセスなし（空の一覧）", async () => {
    const probe = createLsofProbe(fakeExec({ code: 1, stdout: "" }, { code: 1, stdout: "" }));
    expect(await probe(WT)).toEqual([]);
  });

  it("+D の実行に失敗したら、開いているファイルは unknown（動作中として扱われる）。cwd の一覧は使う", async () => {
    const probe = createLsofProbe(
      fakeExec({ stdout: CWD_OUT }, { code: 2, stdout: "", error: "boom" }),
    );
    const list = (await probe(WT)) ?? [];
    expect(list.map((p) => [p.pid, p.hasOpenFiles])).toEqual([
      [100, "unknown"],
      [101, "unknown"],
      [104, "unknown"],
    ]);
  });

  it("cwd の一覧の取得に失敗したら null（確認できない。安全側で回収不可）", async () => {
    for (const bad of [
      { code: 127, error: "ENOENT" },
      { code: null, error: "timeout" },
      { code: 2 },
    ]) {
      const probe = createLsofProbe(fakeExec(bad, { stdout: OPEN_OUT }));
      expect(await probe(WT), JSON.stringify(bad)).toBeNull();
    }
  });

  it("作業ツリーが絶対パスでない・NUL を含むなら null（lsof を呼ばない）", async () => {
    let calls = 0;
    const probe = createLsofProbe(async () => {
      calls += 1;
      return { code: 0, stdout: "" };
    });
    for (const p of ["", "rel/x", "/wt/\0a"]) expect(await probe(p), p).toBeNull();
    expect(calls).toBe(0);
  });

  it("lsof へは、引数を配列で渡し（シェルを介さない）、作業ツリーのパスに空白や特殊文字があってもそのまま渡す", async () => {
    const seen: string[][] = [];
    const probe = createLsofProbe(async (_f, args) => {
      seen.push([...args]);
      return { code: 1, stdout: "" };
    });
    await probe("/wt/with space/$(x);a");
    expect(seen.some((a) => a.includes("/wt/with space/$(x);a"))).toBe(true);
    expect(seen.every((a) => a.includes("-nP"))).toBe(true);
  });
});

const hasLsof = spawnSync("lsof", ["-v"], { encoding: "utf8" }).error === undefined;

describe.skipIf(!hasLsof)("実際の lsof での確認", () => {
  const dirs: string[] = [];
  const kids: ReturnType<typeof spawn>[] = [];
  afterEach(() => {
    for (const k of kids.splice(0)) k.kill("SIGKILL");
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("作業ツリーを cwd にしたプロセスを検出し、止めると検出されなくなる", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "cso-lsof-")));
    dirs.push(dir);
    const child = spawn("sleep", ["30"], { cwd: dir, stdio: "ignore" });
    kids.push(child);
    await new Promise((r) => setTimeout(r, 300));
    const probe = createLsofProbe(nodeExec);
    const before = await probe(dir);
    expect(before?.some((p) => p.pid === child.pid)).toBe(true);

    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    await new Promise((r) => setTimeout(r, 200));
    const after = await probe(dir);
    expect(after?.some((p) => p.pid === child.pid)).toBe(false);
  });
});
