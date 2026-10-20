import type { Scope } from "@cso/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decideToolUse } from "../../src/sdk/hook-policy.js";

const CWD = "/wt/a";
const scope: Scope = {
  writableLocations: ["src", "docs"],
  forbiddenLocations: ["src/secret"],
  allowedCommands: ["ls", "git status", "pnpm test"],
};
const decide = (tool: string, input: unknown) => decideToolUse(scope, CWD, tool, input);
const denied = (d: ReturnType<typeof decide>) => (d.allow ? null : d.violation.reason);

describe("読み込み系のツールは許可（FR_014: 読み込みは制限しない）", () => {
  it("Read・Glob・Grep・NotebookRead は、場所を問わず許可する", () => {
    expect(decide("Read", { file_path: "/etc/passwd" }).allow).toBe(true);
    expect(decide("Glob", { pattern: "**/*.ts" }).allow).toBe(true);
    expect(decide("Grep", { pattern: "x", path: "/" }).allow).toBe(true);
    expect(decide("NotebookRead", { notebook_path: "/x.ipynb" }).allow).toBe(true);
  });
});

describe("書き込み系のツールは、作業範囲の場所で判定する", () => {
  it("Write・Edit・MultiEdit は file_path、NotebookEdit は notebook_path を判定する", () => {
    expect(decide("Write", { file_path: "src/a.ts", content: "x" }).allow).toBe(true);
    expect(decide("Edit", { file_path: "/wt/a/docs/x.md" }).allow).toBe(true);
    expect(decide("MultiEdit", { file_path: "src/b.ts", edits: [] }).allow).toBe(true);
    expect(decide("NotebookEdit", { notebook_path: "src/n.ipynb" }).allow).toBe(true);
    expect(denied(decide("Write", { file_path: "package.json" }))).toBe("outsideWritable");
    expect(denied(decide("Edit", { file_path: "src/secret/k" }))).toBe("forbiddenLocation");
    expect(denied(decide("NotebookEdit", { notebook_path: "/etc/x.ipynb" }))).toBe(
      "outsideWritable",
    );
    expect(denied(decide("Write", { file_path: "src/../package.json" }))).toBe("outsideWritable");
  });

  it("対象のパスが無い・文字列でない書き込みは拒否する（フェイルクローズ）", () => {
    for (const input of [{}, { file_path: 5 }, { file_path: "" }, null, undefined, "x", []]) {
      expect(denied(decide("Write", input)), JSON.stringify(input)).not.toBeNull();
    }
  });
});

describe("Bash は、コマンドで判定し、バックグラウンド実行は拒否する", () => {
  it("許可されたコマンドは許可し、そうでなければ拒否する", () => {
    expect(decide("Bash", { command: "ls -la" }).allow).toBe(true);
    expect(decide("Bash", { command: "git status && pnpm test" }).allow).toBe(true);
    expect(denied(decide("Bash", { command: "rm -rf src" }))).toBe("commandNotAllowed");
    expect(denied(decide("Bash", { command: "bash -c ls" }))).toBe("indirectExecution");
    expect(denied(decide("Bash", { command: "ls > src/out" }))).toBe("unparsable");
  });

  it("run_in_background が真なら、コマンドが許可でも拒否する", () => {
    const d = decide("Bash", { command: "ls", run_in_background: true });
    expect(denied(d)).toBe("backgroundExecution");
    expect(decide("Bash", { command: "ls", run_in_background: false }).allow).toBe(true);
  });

  it("command が文字列でなければ拒否する", () => {
    for (const input of [{}, { command: 1 }, { command: "" }, null]) {
      expect(denied(decide("Bash", input)), JSON.stringify(input)).not.toBeNull();
    }
  });
});

describe("自ノードの MCP ツールは許可し、未知のツールは拒否する（フェイルクローズ）", () => {
  it("mcp__node__* は許可する（自ノードの窓口。権限は窓口側のロールで絞る）", () => {
    expect(decide("mcp__node__report_progress", { text: "x" }).allow).toBe(true);
  });

  it("別の MCP サーバーのツール、サブエージェント、ウェブ、未知のツールは拒否する", () => {
    for (const tool of [
      "mcp__other__do",
      "Task",
      "Agent",
      "WebFetch",
      "WebSearch",
      "KillShell",
      "Unknown",
      "",
      "mcp__node",
      "mcp__nodex__a",
    ]) {
      const d = decide(tool, {});
      expect(denied(d), tool).toBe("commandNotAllowed");
    }
  });

  it("拒否は、記録に使う違反（reason・subject）と、モデルへ伝える理由を持つ", () => {
    const d = decide("Write", { file_path: "package.json" });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.violation.subject).toBe("/wt/a/package.json");
      expect(d.reason).toContain("範囲");
    }
  });
});

describe("性質（fast-check）", () => {
  it("決定的で、ツール名・入力が何であっても例外を出さない", () => {
    fc.assert(
      fc.property(fc.anything(), fc.anything(), (tool, input) => {
        const a = decide(tool as never, input);
        expect(decide(tool as never, input)).toEqual(a);
        expect(typeof a.allow).toBe("boolean");
      }),
    );
  });

  it("許可された書き込みの対象は、必ず許可場所の配下で、禁止場所の外", () => {
    const seg = fc.constantFrom("a", "b", "..", ".", "secret", "src", "docs", "X");
    fc.assert(
      fc.property(fc.array(seg, { minLength: 1, maxLength: 5 }), (p) => {
        const path = p.join("/");
        const d = decide("Write", { file_path: path });
        const norm = new URL(path, "file:///wt/a/").pathname.toLowerCase();
        const inside = (dir: string) => norm === dir || norm.startsWith(`${dir}/`);
        if (d.allow) {
          expect(inside("/wt/a/src") || inside("/wt/a/docs")).toBe(true);
          expect(inside("/wt/a/src/secret")).toBe(false);
        }
      }),
    );
  });
});
