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
const identity = async (p: string) => p;
const decide = (tool: string, input: unknown) => decideToolUse(scope, CWD, tool, input, identity);
type Decision = Awaited<ReturnType<typeof decide>>;
const denied = (d: Decision) => (d.allow ? null : (d.violation?.reason ?? "unknownTool"));

describe("読み込み系のツールは許可（FR_014: 読み込みは制限しない）", () => {
  it("Read・Glob・Grep・NotebookRead は、場所を問わず許可する", async () => {
    expect((await decide("Read", { file_path: "/etc/passwd" })).allow).toBe(true);
    expect((await decide("Glob", { pattern: "**/*.ts" })).allow).toBe(true);
    expect((await decide("Grep", { pattern: "x", path: "/" })).allow).toBe(true);
    expect((await decide("NotebookRead", { notebook_path: "/x.ipynb" })).allow).toBe(true);
  });

  it("Skill（子に渡した skill を読む。T22-c）は許可する", async () => {
    expect((await decide("Skill", { skill: "cso-child-skills:cso-child" })).allow).toBe(true);
  });
});

describe("書き込み系のツールは、作業範囲の場所で判定する", () => {
  it("Write・Edit・MultiEdit は file_path、NotebookEdit は notebook_path を判定する", async () => {
    expect((await decide("Write", { file_path: "src/a.ts", content: "x" })).allow).toBe(true);
    expect((await decide("Edit", { file_path: "/wt/a/docs/x.md" })).allow).toBe(true);
    expect((await decide("MultiEdit", { file_path: "src/b.ts", edits: [] })).allow).toBe(true);
    expect((await decide("NotebookEdit", { notebook_path: "src/n.ipynb" })).allow).toBe(true);
    expect(denied(await decide("Write", { file_path: "package.json" }))).toBe("outsideWritable");
    expect(denied(await decide("Edit", { file_path: "src/secret/k" }))).toBe("forbiddenLocation");
    expect(denied(await decide("NotebookEdit", { notebook_path: "/etc/x.ipynb" }))).toBe(
      "outsideWritable",
    );
    expect(denied(await decide("Write", { file_path: "src/../package.json" }))).toBe(
      "outsideWritable",
    );
  });

  it("対象のパスが無い・文字列でない書き込みは拒否する（フェイルクローズ）", async () => {
    for (const input of [{}, { file_path: 5 }, { file_path: "" }, null, undefined, "x", []]) {
      expect(denied(await decide("Write", input)), JSON.stringify(input)).not.toBeNull();
    }
  });
});

describe("Bash は、コマンドで判定し、バックグラウンド実行は拒否する", () => {
  it("許可されたコマンドは許可し、そうでなければ拒否する", async () => {
    expect((await decide("Bash", { command: "ls -la" })).allow).toBe(true);
    expect((await decide("Bash", { command: "git status && pnpm test" })).allow).toBe(true);
    expect(denied(await decide("Bash", { command: "rm -rf src" }))).toBe("commandNotAllowed");
    expect(denied(await decide("Bash", { command: "bash -c ls" }))).toBe("indirectExecution");
    expect(denied(await decide("Bash", { command: "ls > src/out" }))).toBe("unparsable");
  });

  it("run_in_background が真なら、コマンドが許可でも拒否する", async () => {
    const d = await decide("Bash", { command: "ls", run_in_background: true });
    expect(denied(d)).toBe("backgroundExecution");
    expect((await decide("Bash", { command: "ls", run_in_background: false })).allow).toBe(true);
  });

  it("command が文字列でなければ拒否する", async () => {
    for (const input of [{}, { command: 1 }, { command: "" }, null]) {
      expect(denied(await decide("Bash", input)), JSON.stringify(input)).not.toBeNull();
    }
  });
});

describe("自ノードの MCP ツールは許可し、未知のツールは拒否する（フェイルクローズ）", () => {
  it("mcp__node__* は許可する（自ノードの窓口。権限は窓口側のロールで絞る）", async () => {
    expect((await decide("mcp__node__report_progress", { text: "x" })).allow).toBe(true);
    expect((await decide("mcp__node__whoami", {})).allow).toBe(true); // T10m-wh: 自分の nodeId・role を返すメタツール
  });

  it("読み取りのみで無害なツール（LS・TodoWrite・ToolSearch・BashOutput）は許可する", async () => {
    for (const tool of ["LS", "TodoWrite", "ToolSearch", "BashOutput"]) {
      expect((await decide(tool, {})).allow, tool).toBe(true);
    }
  });

  it("別の MCP サーバー、サブエージェント、ウェブ、未知のツールは拒否する。範囲違反ではなく unknownTool（記録先は別。受信箱に載せない）", async () => {
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
      const d = await decide(tool, {});
      expect(d.allow, tool).toBe(false);
      if (!d.allow) {
        expect(d.violation, tool).toBeUndefined();
        expect(d.unknownTool, tool).toBe(tool === "" ? "(ツール名が空)" : tool);
        expect(d.reason).toContain("使えない");
        expect(d.reason).not.toContain("作業範囲");
      }
    }
  });

  it("Bash の dangerouslyDisableSandbox: true は拒否する（false・省略は通常の判定）", async () => {
    expect(denied(await decide("Bash", { command: "ls", dangerouslyDisableSandbox: true }))).toBe(
      "commandNotAllowed",
    );
    expect((await decide("Bash", { command: "ls", dangerouslyDisableSandbox: false })).allow).toBe(
      true,
    );
  });

  it("拒否は、記録に使う違反（reason・subject）と、モデルへ伝える理由を持つ", async () => {
    const d = await decide("Write", { file_path: "package.json" });
    expect(d.allow).toBe(false);
    if (!d.allow) {
      expect(d.violation?.subject).toBe("/wt/a/package.json");
      expect(d.reason).toContain("範囲");
    }
  });
});

describe("性質（fast-check）", () => {
  it("決定的で、ツール名・入力が何であっても例外を出さない", async () => {
    await fc.assert(
      fc.asyncProperty(fc.anything(), fc.anything(), async (tool, input) => {
        const a = await decide(tool as never, input);
        expect(await decide(tool as never, input)).toEqual(a);
        expect(typeof a.allow).toBe("boolean");
      }),
    );
  });

  it("許可された書き込みの対象は、必ず許可場所の配下で、禁止場所の外", async () => {
    const seg = fc.constantFrom("a", "b", "..", ".", "secret", "src", "docs", "X");
    await fc.assert(
      fc.asyncProperty(fc.array(seg, { minLength: 1, maxLength: 5 }), async (p) => {
        const path = p.join("/");
        const d = await decide("Write", { file_path: path });
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

describe("書き込み先の解決（シンボリックリンク対策）", () => {
  it("解決した実パスで判定する。解決に失敗したら拒否する", async () => {
    const link = async (p: string) => (p === "/wt/a/src/link/x" ? "/etc/x" : p);
    const d = await decideToolUse(scope, CWD, "Write", { file_path: "src/link/x" }, link);
    expect(denied(d)).toBe("outsideWritable");
    const boom = async () => {
      throw new Error("EACCES");
    };
    expect(denied(await decideToolUse(scope, CWD, "Write", { file_path: "src/a" }, boom))).toBe(
      "invalidPath",
    );
  });
});

describe("読み取りも禁じる場所（FR_014 の例外。T21-pr）", () => {
  const S = "/home/u/state";
  const prot = {
    roots: [
      { path: S, kind: "stateDir" as const },
      { path: "/home/u/cso.json", kind: "daemonConfig" as const },
    ],
    allow: [`${S}/child-plugin`, `${S}/homes/a`],
    home: `${S}/homes/a`,
  };
  // 実パスにする（.. を畳み、/link を stateDir へのリンクとして解決する）
  const resolve = async (p: string) => {
    const { posix } = await import("node:path");
    const n = posix.resolve(p);
    if (n === "/link" || n.startsWith("/link/")) return S + n.slice("/link".length);
    const esc = `${S}/homes/a/escape`; // 自分の HOME の中の、stateDir の直下を指すリンク
    if (n === esc || n.startsWith(`${esc}/`)) return S + n.slice(esc.length);
    return n;
  };
  const d = (tool: string, input: unknown) =>
    decideToolUse(scope, "/home/u/wt/a", tool, input, resolve, prot);
  const reasonOf = async (tool: string, input: unknown) => {
    const r = await d(tool, input);
    return r.allow ? null : (r.violation?.subject ?? r.violation?.reason ?? "unknownTool");
  };

  it("Read・NotebookRead・LS: stateDir と設定ファイルの中は拒否。ほかの場所は今までどおり許可", async () => {
    expect(await reasonOf("Read", { file_path: `${S}/human-token` })).toBe("protected:stateDir");
    expect(await reasonOf("Read", { file_path: "/home/u/cso.json" })).toBe(
      "protected:daemonConfig",
    );
    expect(await reasonOf("NotebookRead", { notebook_path: `${S}/x.ipynb` })).toBe(
      "protected:stateDir",
    );
    expect(await reasonOf("LS", { path: `${S}/children.noindex` })).toBe("protected:stateDir");
    expect(await reasonOf("Read", { file_path: "/etc/hosts" })).toBeNull();
    expect(await reasonOf("LS", { path: "/home/u" })).toBeNull(); // 一覧だけ（再帰しない）の祖先は許す
  });

  it("リンク・.. を通っても、実パスで判定する", async () => {
    expect(await reasonOf("Read", { file_path: "/link/root-token" })).toBe("protected:stateDir");
    expect(await reasonOf("Read", { file_path: "/home/u/wt/a/../../state/human-token" })).toBe(
      "protected:stateDir",
    );
  });

  it("自分の HOME と、子に渡す skill の写しは読める。ほかのノードの HOME は拒否", async () => {
    expect(await reasonOf("Read", { file_path: `${S}/homes/a/.claude/settings.json` })).toBeNull();
    expect(await reasonOf("Read", { file_path: `${S}/child-plugin/skills/x/SKILL.md` })).toBeNull();
    expect(await reasonOf("Read", { file_path: `${S}/homes/b/x` })).toBe("protected:stateDir");
  });

  it("Glob・Grep: 中も、禁じる場所を含む祖先（再帰で読まれる）も拒否。作業ツリーは許可", async () => {
    expect(await reasonOf("Grep", { pattern: "x", path: S })).toBe("protected:stateDir");
    expect(await reasonOf("Grep", { pattern: "x", path: "/home/u" })).toBe("protected:stateDir");
    expect(await reasonOf("Glob", { pattern: "/home/*/state/**" })).toBe("protected:stateDir");
    expect(await reasonOf("Glob", { pattern: "**/*", path: "/" })).toBe("protected:stateDir");
    expect(await reasonOf("Glob", { pattern: "**/*.ts" })).toBeNull();
    expect(await reasonOf("Grep", { pattern: "x" })).toBeNull();
  });

  it("書き込みの道具は、今の範囲の決まりのまま（禁じる場所の判定では見ない）", async () => {
    const r = await d("Write", { file_path: `${S}/x`, content: "y" });
    expect(r.allow ? null : r.violation?.reason).toBe("outsideWritable");
  });

  it("許す場所の判定も実パスで行う（自分の HOME の中のリンクで、ほかの場所を指しても通らない）", async () => {
    expect(await reasonOf("Read", { file_path: `${S}/homes/a/escape/human-token` })).toBe(
      "protected:stateDir",
    );
  });

  it("Bash: パスに見える語（絶対・相対・~・--opt=値・グロブ）を実パスで判定する", async () => {
    expect(await reasonOf("Bash", { command: `ls ${S}/human-token` })).toBe("protected:stateDir");
    expect(await reasonOf("Bash", { command: "pnpm test ../../state/human-token" })).toBe(
      "protected:stateDir",
    );
    expect(await reasonOf("Bash", { command: "pnpm test --config=/home/u/cso.json" })).toBe(
      "protected:daemonConfig",
    );
    expect(await reasonOf("Bash", { command: "ls ~/../b" })).toBe("protected:stateDir"); // 自分の HOME の外（別のノードの HOME）
    expect(await reasonOf("Bash", { command: "ls ~/.claude" })).toBeNull(); // 自分の HOME
    expect(await reasonOf("Bash", { command: "ls /home/*/state" })).toBe("protected:stateDir");
    expect(await reasonOf("Bash", { command: "ls /link" })).toBe("protected:stateDir");
    expect(await reasonOf("Bash", { command: "ls src" })).toBeNull();
    expect(await reasonOf("Bash", { command: "git status" })).toBeNull();
  });

  it("Bash: 変数・置換を含む命令は、もともと解析できないので拒否される", async () => {
    expect((await d("Bash", { command: 'ls "$HOME"/x' })).allow).toBe(false);
    expect((await d("Bash", { command: "ls $(echo /home/u/state)" })).allow).toBe(false);
  });

  it("拒否の文面に、禁じる場所の実パスを出さない（種類だけ）", async () => {
    const r = await d("Read", { file_path: `${S}/human-token` });
    expect(r.allow).toBe(false);
    if (!r.allow) {
      expect(r.reason).not.toContain(S);
      expect(r.violation?.subject).not.toContain(S);
      expect(r.reason).toContain("daemon の状態の置き場");
    }
  });

  it("禁じる場所を渡さなければ、今までどおり（読み込みは場所を問わず許可）", async () => {
    expect(
      (await decideToolUse(scope, CWD, "Read", { file_path: `${S}/human-token` }, identity)).allow,
    ).toBe(true);
  });
});
