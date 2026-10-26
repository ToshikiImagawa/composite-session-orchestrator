import { describe, expect, it } from "vitest";
import {
  assessReclaim,
  findRunningProcesses,
  formatProcesses,
  type ProcessInfo,
  processCommandName,
} from "../src/index.js";

describe("processCommandName（T24-sp）", () => {
  it("制御文字・書式文字を取り除き、前後の空白を落とす", () => {
    expect(processCommandName(" zsh\n")).toBe("zsh");
    expect(processCommandName("a\u001b[31mb")).toBe("a[31mb");
    expect(processCommandName("ev‮il​")).toBe("evil");
    expect(processCommandName("x\u0000y\u007f")).toBe("xy");
  });
  it("空・文字列でないものは undefined", () => {
    expect(processCommandName("")).toBeUndefined();
    expect(processCommandName(" \t​ ")).toBeUndefined();
    expect(processCommandName(undefined)).toBeUndefined();
    expect(processCommandName(42)).toBeUndefined();
  });
  it("32 文字（符号位置）までにし、サロゲートペアを分けない", () => {
    expect(processCommandName("a".repeat(32))).toBe("a".repeat(32));
    expect(processCommandName("a".repeat(40))).toBe(`${"a".repeat(32)}…`);
    const emoji = "😀".repeat(40);
    const out = processCommandName(emoji) ?? "";
    expect([...out]).toHaveLength(33);
    expect(out).toBe(`${"😀".repeat(32)}…`);
  });
});

describe("formatProcesses（T24-sp）", () => {
  it("名前があれば括弧で添える", () => {
    expect(formatProcesses([{ pid: 123, command: "zsh" }, { pid: 456 }])).toBe(
      "pid 123（zsh）、456",
    );
  });
  it("表示の前にも名前を整える", () => {
    expect(
      formatProcesses([
        { pid: 1, command: "a\nb" },
        { pid: 2, command: "\u0007" },
      ]),
    ).toBe("pid 1（ab）、2");
  });
  it("空は「不明」、11 件以上は「ほか N 件」", () => {
    expect(formatProcesses([])).toBe("不明");
    const many = Array.from({ length: 12 }, (_, i) => ({ pid: i + 1 }));
    expect(formatProcesses(many)).toBe("pid 1、2、3、4、5、6、7、8、9、10、ほか 2 件");
  });
});

describe("回収の原因に名前を添える（T24-sp）", () => {
  const nodes = [
    {
      id: "root",
      role: "integrator" as const,
      parentId: null,
      dependsOn: [],
      state: "running" as const,
    },
    {
      id: "a",
      role: "implement" as const,
      parentId: "root",
      dependsOn: [],
      state: "verified" as const,
    },
  ];
  const facts = { a: { merged: true, clean: true, discarded: false, worktreePath: "/wt/a" } };
  it("整えた名前が blocker に入り、名前の無い古い記録は従来どおり", () => {
    const processes: ProcessInfo[] = [
      { pid: 7, cwd: "/wt/a", hasOpenFiles: false, command: "vim\u001b" },
      { pid: 3, cwd: "/wt/a", hasOpenFiles: false },
    ];
    const r = assessReclaim({ nodes, facts, openDecisionNodeIds: [], processes }, "a");
    if (!r.ok) throw new Error("failed");
    expect(r.value.blockers).toEqual([
      { kind: "process", reason: "processesRunning", pid: 3 },
      { kind: "process", reason: "processesRunning", pid: 7, command: "vim" },
    ]);
    expect(findRunningProcesses("/wt/a", processes)).toEqual([3, 7]);
  });
});
