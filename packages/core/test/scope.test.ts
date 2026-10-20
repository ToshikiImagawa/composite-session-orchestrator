import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluateScope, type Scope, validateScope } from "../src/index.js";

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

describe("書き込み（許可場所・禁止場所）", () => {
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

describe("コマンド（許可リストの前方一致）", () => {
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
    expect(reasonOf(cmd("ls | sh"))).toBe("indirectExecution");
    expect(reasonOf(cmd("ls | grep x"))).toBe("commandNotAllowed");
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

describe("書き込み: 回帰（迂回の試み）", () => {
  it("大文字小文字・Unicode 正規形の違いで禁止場所を迂回できない", () => {
    expect(reasonOf(write("src/SECRET/k"))).toBe("forbiddenLocation");
    expect(reasonOf(write("src/Secret"))).toBe("forbiddenLocation");
    expect(reasonOf(write(".GIT/config"))).toBe("forbiddenLocation");
    expect(reasonOf(write("SRC2/a"))).toBe("outsideWritable");
    expect(write("SRC/a.ts").allowed).toBe(true); // 区別する FS でも安全側（過剰拒否は許可側には起きない）
    const nfd = "e\u0301"; // é（分解形）
    const s2: Scope = { ...scope, forbiddenLocations: ["src/caf\u00e9"] };
    expect(reasonOf(evaluateScope(s2, CWD, { kind: "write", path: `src/caf${nfd}/x` }))).toBe(
      "forbiddenLocation",
    );
  });

  it("NUL・空のパスは拒否", () => {
    expect(reasonOf(write("src/a\0b"))).toBe("invalidPath");
    expect(reasonOf(write(""))).toBe("invalidPath");
    expect(reasonOf(write("   "))).toBe("invalidPath");
  });
});

describe("範囲の設定の検証（フェイルクローズ）", () => {
  const bad = (patch: Partial<Scope>) => ({ ...scope, ...patch });
  it("空文字・空白のエントリは不正", () => {
    expect(validateScope(bad({ writableLocations: [""] }), CWD)[0]?.problem).toBe("empty");
    expect(validateScope(bad({ forbiddenLocations: ["  "] }), CWD)[0]?.problem).toBe("empty");
    expect(validateScope(bad({ allowedCommands: [""] }), CWD)[0]?.problem).toBe("empty");
  });
  it("NUL を含むエントリは不正", () => {
    expect(validateScope(bad({ writableLocations: ["src\0"] }), CWD)[0]?.problem).toBe("nul");
    expect(validateScope(bad({ allowedCommands: ["ls\0"] }), CWD)[0]?.problem).toBe("nul");
  });
  it("許可場所が根や作業ツリーの外なら不正", () => {
    expect(validateScope(bad({ writableLocations: ["/"] }), CWD)[0]?.problem).toBe(
      "writableIsRoot",
    );
    expect(validateScope(bad({ writableLocations: ["../other"] }), CWD)[0]?.problem).toBe(
      "writableOutsideCwd",
    );
    expect(validateScope(bad({ writableLocations: ["/tmp"] }), CWD)[0]?.problem).toBe(
      "writableOutsideCwd",
    );
  });
  it("cwd が絶対パスでなければ不正", () => {
    expect(validateScope(scope, "work")[0]?.field).toBe("cwd");
  });
  it("妥当な設定には問題がない。空の一覧も妥当", () => {
    expect(validateScope(scope, CWD)).toEqual([]);
    expect(
      validateScope({ writableLocations: [], forbiddenLocations: [], allowedCommands: [] }, CWD),
    ).toEqual([]);
  });
  it("不正な設定では、書き込みとコマンドを拒否し、読み込みは許可", () => {
    const s = bad({ writableLocations: [""] });
    expect(reasonOf(evaluateScope(s, CWD, { kind: "write", path: "src/a" }))).toBe("invalidScope");
    expect(reasonOf(evaluateScope(s, CWD, { kind: "command", command: "ls" }))).toBe(
      "invalidScope",
    );
    expect(evaluateScope(s, CWD, { kind: "read", path: "src/a" }).allowed).toBe(true);
  });
});

describe("コマンド: 回帰（迂回の試み）", () => {
  it("別コマンドを実行するコマンドは、許可リストに入っていても拒否", () => {
    const all: Scope = {
      ...scope,
      allowedCommands: [
        "ls",
        "bash",
        "sh",
        "zsh",
        "eval",
        "exec",
        "xargs",
        "env",
        "command",
        "builtin",
        "sudo",
        "time",
        "find",
        "nohup",
        "timeout",
        "/bin/bash",
      ],
    };
    const run = (command: string) => evaluateScope(all, CWD, { kind: "command", command });
    for (const c of [
      "bash -c ls",
      "sh x",
      "zsh x",
      "eval ls",
      "exec ls",
      "xargs ls",
      "env ls",
      "command ls",
      "builtin cd",
      "sudo ls",
      "time ls",
      "timeout 1 ls",
      "/bin/bash x",
      "BASH x".toLowerCase(),
    ]) {
      expect(reasonOf(run(c)), c).toBe("indirectExecution");
    }
    expect(reasonOf(run("nohup ls"))).toBe("backgroundExecution");
    expect(reasonOf(run("find . -exec rm {} ;"))).toBe("indirectExecution");
    expect(reasonOf(run("find . -delete"))).toBe("indirectExecution");
    expect(run("find . -name x").allowed).toBe(true);
  });

  it("変数展開・ANSI-C 引用・履歴展開は拒否（単引用符内は文字として扱う）", () => {
    for (const c of [
      "ls $HOME",
      "ls ${IFS}x",
      "ls $'a\\nb'",
      "ls $((1+1))",
      "ls !!",
      'ls "$X"',
      'ls "a${X}"',
    ]) {
      expect(reasonOf(cmd(c)), c).toBe("unparsable");
    }
    expect(cmd("ls '$HOME'").allowed).toBe(true);
  });

  it("行継続・`|&`・`&>`・環境変数前置・波括弧・time・大文字小文字", () => {
    expect(cmd("l\\\ns").allowed).toBe(true); // 行継続は取り除かれ `ls` になる
    expect(cmd("ls\\\n -la").allowed).toBe(true);
    expect(reasonOf(cmd("ls |& sh"))).toBe("indirectExecution");
    expect(reasonOf(cmd("ls &> src/x"))).toBe("unparsable");
    expect(reasonOf(cmd("FOO=1 ls"))).toBe("commandNotAllowed");
    expect(reasonOf(cmd("PATH=/tmp ls"))).toBe("commandNotAllowed");
    expect(reasonOf(cmd("{ rm x; }"))).toBe("commandNotAllowed");
    expect(reasonOf(cmd("ls; { rm x; }"))).toBe("commandNotAllowed");
    expect(reasonOf(cmd("time ls"))).toBe("indirectExecution");
    expect(reasonOf(cmd("LS"))).toBe("commandNotAllowed");
    expect(reasonOf(cmd("git STATUS"))).toBe("commandNotAllowed");
  });

  it("NUL・CR などの制御文字は拒否", () => {
    expect(reasonOf(cmd("ls\0"))).toBe("unparsable");
    expect(reasonOf(cmd("ls\r"))).toBe("unparsable");
    expect(reasonOf(cmd("ls\u001b[0m"))).toBe("unparsable");
  });

  it("許可リストの空のエントリは設定不正として全拒否", () => {
    const d = evaluateScope({ ...scope, allowedCommands: ["ls", ""] }, CWD, {
      kind: "command",
      command: "ls",
    });
    expect(reasonOf(d)).toBe("invalidScope");
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

  // 独立した単純なオラクル。正規化は URL に任せ、大文字小文字は畳んで比較する。
  const oracleUnder = (norm: string, d: string): boolean => {
    const n = norm.toLowerCase();
    return n === d || n.startsWith(`${d}/`);
  };
  const oracleNorm = (p: string): string => new URL(p, "file:///work/node-a/").pathname;
  const mixedCase = (p: string): string =>
    p.replace(/[a-z]/g, (ch, i) => (i % 2 ? ch.toUpperCase() : ch));

  it("逆方向: 範囲内で拒否されるのは、禁止場所か許可場所の外のときだけ（大文字小文字を問わない）", () => {
    fc.assert(
      fc.property(pathArb, fc.boolean(), (p0, upper) => {
        const p = upper ? mixedCase(p0) : p0;
        const d = write(p);
        const norm = oracleNorm(p);
        const forbidden =
          oracleUnder(norm, "/work/node-a/src/secret") || oracleUnder(norm, "/work/node-a/.git");
        const writable =
          oracleUnder(norm, "/work/node-a/src") || oracleUnder(norm, "/work/node-a/docs");
        expect(d.allowed).toBe(!forbidden && writable);
      }),
    );
  });

  const allowedSeg = fc.constantFrom("ls", "ls -la src", "git status", "pnpm test --reporter=dot");
  const joiner = fc.constantFrom(" && ", " ; ", " | ", " || ", "\n");
  const cmdArb = fc
    .tuple(allowedSeg, fc.array(fc.tuple(joiner, allowedSeg), { maxLength: 4 }))
    .map(([h, rest]) => h + rest.map(([j, s]) => j + s).join(""));
  const meta = fc.constantFrom(
    "$(x)",
    "`x`",
    " > f",
    " < f",
    " (ls)",
    " $X",
    " ${X}",
    " !",
    " &",
    " &>f",
    "\0",
    " <(x)",
  );

  it("コマンド: 全部分が許可のときだけ許可（連結子で組んだ許可済みの列は常に許可）", () => {
    fc.assert(
      fc.property(cmdArb, (c) => {
        expect(cmd(c).allowed).toBe(true);
      }),
    );
  });

  it("コマンド: 引用符の外のメタ文字を含むと、許可済みの列でも拒否", () => {
    fc.assert(
      fc.property(cmdArb, meta, (c, m) => {
        expect(cmd(c + m).allowed).toBe(false);
      }),
    );
  });

  it("コマンド: 許可外の部分が一つでもあれば拒否", () => {
    fc.assert(
      fc.property(cmdArb, joiner, cmdArb, (a, j, b) => {
        expect(cmd(`${a}${j}rm -rf x${j}${b}`).allowed).toBe(false);
      }),
    );
  });
});
