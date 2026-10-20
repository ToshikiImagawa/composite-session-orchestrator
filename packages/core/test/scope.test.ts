import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateScope, type Scope } from "../src/index.js";

const CWD = "/work/node-a";
const scope: Scope = {
  writableLocations: ["src", "/work/node-a/docs"],
  forbiddenLocations: ["src/secret", ".git"],
  allowedCommands: ["pnpm test", "git status", "ls"],
};
const write = (path: string) => evaluateScope(scope, CWD, { kind: "write", path });
const cmd = (command: string) => evaluateScope(scope, CWD, { kind: "command", command });
const reasonOf = (d: ReturnType<typeof write>) => (d.allowed ? null : d.reason);

describe("読み込みは制限しない（FR_014）", () => {
  it("範囲外・禁止場所でも許可", () => {
    expect(evaluateScope(scope, CWD, { kind: "read", path: "/etc/passwd" }).allowed).toBe(true);
    expect(evaluateScope(scope, CWD, { kind: "read", path: "src/secret/k" }).allowed).toBe(true);
  });
});

describe("書き込みの場所", () => {
  it("許可場所の配下は許可（相対・絶対）", () => {
    expect(write("src/a.ts").allowed).toBe(true);
    expect(write("/work/node-a/src/deep/b.ts").allowed).toBe(true);
    expect(write("docs/x.md").allowed).toBe(true);
  });

  it("許可場所の外は拒否", () => {
    expect(reasonOf(write("package.json"))).toBe("outsideWritable");
    expect(reasonOf(write("/etc/hosts"))).toBe("outsideWritable");
  });

  it("接頭辞だけ一致する別ディレクトリは許可しない", () => {
    expect(reasonOf(write("src2/a.ts"))).toBe("outsideWritable");
  });

  it("禁止場所は許可場所の内側でも優先して拒否", () => {
    expect(reasonOf(write("src/secret/key"))).toBe("forbiddenLocation");
    expect(reasonOf(write("src/secret"))).toBe("forbiddenLocation");
  });

  it("`..` による迂回を正規化して拒否", () => {
    expect(reasonOf(write("src/../package.json"))).toBe("outsideWritable");
    expect(reasonOf(write("src/../.git/config"))).toBe("forbiddenLocation");
    expect(write("src/x/../a.ts").allowed).toBe(true);
  });

  it("許可場所が空なら何も書けない", () => {
    const d = evaluateScope({ ...scope, writableLocations: [] }, CWD, {
      kind: "write",
      path: "src/a",
    });
    expect(reasonOf(d)).toBe("outsideWritable");
  });
});

describe("コマンド（場所とコマンドの両方）", () => {
  it("許可コマンドは許可（先頭の語が一致）", () => {
    expect(cmd("ls").allowed).toBe(true);
    expect(cmd("ls -la src").allowed).toBe(true);
    expect(cmd("pnpm test --reporter=dot").allowed).toBe(true);
  });

  it("許可されていないコマンドは拒否", () => {
    expect(reasonOf(cmd("rm -rf src"))).toBe("commandNotAllowed");
    expect(reasonOf(cmd("pnpm install"))).toBe("commandNotAllowed");
    expect(reasonOf(cmd("lsof"))).toBe("commandNotAllowed");
  });

  it("連結・パイプは全部分が許可でなければ拒否", () => {
    expect(cmd("ls && git status").allowed).toBe(true);
    expect(reasonOf(cmd("ls; rm -rf /"))).toBe("commandNotAllowed");
    expect(reasonOf(cmd("ls | sh"))).toBe("commandNotAllowed");
    expect(reasonOf(cmd("ls || curl x"))).toBe("commandNotAllowed");
  });

  it("コマンド置換・プロセス置換は拒否", () => {
    expect(reasonOf(cmd("ls $(rm x)"))).toBe("unparsable");
    expect(reasonOf(cmd("ls `rm x`"))).toBe("unparsable");
    expect(reasonOf(cmd("ls <(rm x)"))).toBe("unparsable");
  });

  it("引用符内の区切りは区切りとみなさない", () => {
    expect(cmd("ls 'a;b'").allowed).toBe(true);
    expect(cmd('ls "a && b"').allowed).toBe(true);
  });

  it("バックグラウンド起動は既定で拒否", () => {
    expect(reasonOf(cmd("ls &"))).toBe("backgroundExecution");
    expect(reasonOf(cmd("nohup ls"))).toBe("backgroundExecution");
    expect(reasonOf(cmd("setsid ls"))).toBe("backgroundExecution");
  });

  it("リダイレクト・サブシェルは判定できないものとして拒否", () => {
    expect(reasonOf(cmd("ls > src/out.txt"))).toBe("unparsable");
    expect(reasonOf(cmd("ls >> src/out.txt"))).toBe("unparsable");
    expect(reasonOf(cmd("ls 2> /dev/null"))).toBe("unparsable");
    expect(reasonOf(cmd("ls < src/in"))).toBe("unparsable");
    expect(reasonOf(cmd("(ls)"))).toBe("unparsable");
    expect(cmd("ls 'a > b'").allowed).toBe(true);
  });

  it("空のコマンド・許可コマンドが空の範囲は拒否", () => {
    expect(reasonOf(cmd("   "))).toBe("commandNotAllowed");
    const d = evaluateScope({ ...scope, allowedCommands: [] }, CWD, {
      kind: "command",
      command: "ls",
    });
    expect(reasonOf(d)).toBe("commandNotAllowed");
  });
});

describe("性質（fast-check）", () => {
  const seg = fc.constantFrom("a", "b", "x.ts", "..", ".", "secret", "src", "docs");
  const pathArb = fc.array(seg, { minLength: 1, maxLength: 6 }).map((p) => p.join("/"));

  it("決定的で、読み込みは常に許可", () => {
    fc.assert(
      fc.property(pathArb, (p) => {
        expect(write(p)).toEqual(write(p));
        expect(evaluateScope(scope, CWD, { kind: "read", path: p }).allowed).toBe(true);
      }),
    );
  });

  it("許可された書き込みは、禁止場所の配下でも許可場所の外でもない", () => {
    fc.assert(
      fc.property(pathArb, (p) => {
        if (write(p).allowed) {
          const norm = new URL(p, "file:///work/node-a/").pathname;
          const under = (d: string) => norm === d || norm.startsWith(`${d}/`);
          expect(under("/work/node-a/src") || under("/work/node-a/docs")).toBe(true);
          expect(under("/work/node-a/src/secret")).toBe(false);
          expect(under("/work/node-a/.git")).toBe(false);
        }
      }),
    );
  });

  it("許可場所が空なら、どんな書き込みも拒否", () => {
    fc.assert(
      fc.property(pathArb, (p) => {
        expect(
          evaluateScope({ ...scope, writableLocations: [] }, CWD, { kind: "write", path: p })
            .allowed,
        ).toBe(false);
      }),
    );
  });
});
