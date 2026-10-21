import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { childEnv, DEFAULT_CHILD_ENV, isForbiddenChildEnvName } from "../../src/sdk/child-env.js";

const withoutNoProxy = (env: Readonly<Record<string, string>>): Record<string, string> => {
  const { NO_PROXY: _a, no_proxy: _b, ...rest } = env;
  return rest;
};

describe("childEnv（許可リスト方式。親の環境変数から、許可した名前だけを子に渡す）", () => {
  it("既定で渡す: PATH・HOME・LANG・TMPDIR など、実行に要る変数", () => {
    const keep = {
      PATH: "/usr/bin",
      HOME: "/home/u",
      LANG: "ja_JP.UTF-8",
      TMPDIR: "/tmp",
      TZ: "UTC",
    };
    const r = childEnv(keep);
    expect(withoutNoProxy(r.env)).toEqual(keep);
    expect(r.removed).toEqual([]);
  });

  it("既定で渡す: SDK の認証・接続に要る変数（ANTHROPIC_*、OAuth・Bedrock・Vertex の切り替え、プロキシ・証明書）", () => {
    const keep = {
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_BASE_URL: "u",
      CLAUDE_CODE_OAUTH_TOKEN: "t",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CONFIG_DIR: "/c",
      HTTPS_PROXY: "http://p",
      NO_PROXY: "localhost",
      NODE_EXTRA_CA_CERTS: "/ca.pem",
      SSL_CERT_FILE: "/ca.pem",
    };
    expect(withoutNoProxy(childEnv(keep).env)).toEqual(withoutNoProxy(keep));
  });

  it("許可していない変数は渡さない（GH_TOKEN・GITHUB_TOKEN・AWS_*・クラウドの認証など、秘密を含む）。除いた名前だけを返し、値は返さない", () => {
    const input = {
      PATH: "/usr/bin",
      GH_TOKEN: "secret-gh",
      GITHUB_TOKEN: "secret-gh2",
      CLOUDSDK_AUTH_ACCESS_TOKEN: "secret-g",
      AWS_SECRET_ACCESS_KEY: "secret-aws",
      DATABASE_URL: "postgres://u:p@h/db",
    };
    const r = childEnv(input);
    expect(withoutNoProxy(r.env)).toEqual({ PATH: "/usr/bin" });
    expect([...r.removed].sort()).toEqual(
      [
        "AWS_SECRET_ACCESS_KEY",
        "CLOUDSDK_AUTH_ACCESS_TOKEN",
        "DATABASE_URL",
        "GITHUB_TOKEN",
        "GH_TOKEN",
      ].sort(),
    );
    expect(JSON.stringify(r)).not.toContain("secret");
    expect(JSON.stringify(r)).not.toContain("postgres://");
  });

  it("設定で、名前を追加できる（完全一致の名前だけ）", () => {
    const r = childEnv({ PATH: "/bin", MY_TOOL_HOME: "/x", MY_TOOL_HOME2: "y", GH_TOKEN: "t" }, [
      "MY_TOOL_HOME",
    ]);
    expect(withoutNoProxy(r.env)).toEqual({ PATH: "/bin", MY_TOOL_HOME: "/x" });
    expect([...r.removed].sort()).toEqual(["GH_TOKEN", "MY_TOOL_HOME2"]);
  });

  it("セッション識別子に関わる変数は、既定でも、追加の指定でも、渡さない（子のセッション識別子が親と混ざるのを防ぐ。Spike 02 #6）", () => {
    const parent = {
      PATH: "/bin",
      CLAUDE_CODE_SESSION_ID: "parent-session",
      CLAUDE_CODE_REMOTE_SESSION_ID: "r",
      claude_code_session_dir: "z",
    };
    const r = childEnv(parent, ["CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_REMOTE_SESSION_ID"]);
    expect(withoutNoProxy(r.env)).toEqual({ PATH: "/bin" });
    expect(r.removed).toContain("CLAUDE_CODE_SESSION_ID");
    expect(r.removed).toContain("CLAUDE_CODE_REMOTE_SESSION_ID");
  });

  it("追加の指定で、SESSION を含んでも認証・接続に要る変数（*_TOKEN*・*_URL）は渡せる", () => {
    const keep = { CLAUDE_SESSION_INGRESS_TOKEN_FILE: "/f", CLAUDE_CODE_SESSION_URL: "https://x" };
    const r = childEnv({ ...keep, CLAUDE_CODE_SESSION_ID: "p" }, [
      ...Object.keys(keep),
      "CLAUDE_CODE_SESSION_ID",
    ]);
    expect(withoutNoProxy(r.env)).toEqual(keep);
    expect(r.removed).toEqual(["CLAUDE_CODE_SESSION_ID"]);
  });

  it("読み込みや実行に影響する名前（LD_*・DYLD_*・NODE_OPTIONS・BASH_ENV・ENV・PYTHONSTARTUP・GIT_SSH_COMMAND など）は、追加の指定でも渡さない", () => {
    const bad = [
      "LD_PRELOAD",
      "LD_LIBRARY_PATH",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
      "BASH_ENV",
      "ENV",
      "PYTHONSTARTUP",
      "PYTHONPATH",
      "GIT_SSH_COMMAND",
      "GIT_ASKPASS",
      "PERL5OPT",
      "RUBYOPT",
      "JAVA_TOOL_OPTIONS",
      "PROMPT_COMMAND",
      "SHELLOPTS",
    ];
    for (const name of bad) expect(isForbiddenChildEnvName(name), name).toBe(true);
    for (const name of ["PATH", "HOME", "AWS_PROFILE", "MY_VAR", "ANTHROPIC_API_KEY"]) {
      expect(isForbiddenChildEnvName(name), name).toBe(false);
    }
    const parent = Object.fromEntries(bad.map((n) => [n, "x"]));
    const r = childEnv({ ...parent, PATH: "/bin" }, bad);
    expect(withoutNoProxy(r.env)).toEqual({ PATH: "/bin" });
    expect([...r.removed].sort()).toEqual([...bad].sort());
  });

  it("値が undefined の項目は捨てる（env は文字列だけ）。入力を変更しない", () => {
    const input = { PATH: "/bin", B: undefined };
    const before = JSON.stringify(input);
    const r = childEnv(input);
    expect(withoutNoProxy(r.env)).toEqual({ PATH: "/bin" });
    expect(r.removed).toEqual([]);
    expect(JSON.stringify(input)).toBe(before);
  });

  it("既定の一覧は、秘密になりうる名前（GH_TOKEN など）を含まない", () => {
    for (const bad of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "CLAUDE_CODE_SESSION_ID",
    ]) {
      expect(DEFAULT_CHILD_ENV.names).not.toContain(bad);
    }
  });

  it("性質: 結果は、許可した名前だけで値を保ち、それ以外は removed に入る（決定的）", () => {
    const key = fc.oneof(
      fc.constantFrom(
        "PATH",
        "HOME",
        "GH_TOKEN",
        "ANTHROPIC_API_KEY",
        "CLAUDE_CODE_SESSION_ID",
        "X",
      ),
      fc.string({ minLength: 1, maxLength: 12 }),
    );
    fc.assert(
      fc.property(
        fc.dictionary(key, fc.string()),
        fc.array(key, { maxLength: 4 }),
        (env, extra) => {
          const r = childEnv(env, extra);
          for (const [k, v] of Object.entries(r.env)) {
            if (k === "NO_PROXY" || k === "no_proxy") continue; // loopback を足すので、親と同じとは限らない
            expect(env[k]).toBe(v);
          }
          for (const k of Object.keys(env))
            expect(k in r.env || r.removed.includes(k), k).toBe(true);
          expect("CLAUDE_CODE_SESSION_ID" in r.env).toBe(false);
          expect("GH_TOKEN" in r.env).toBe(extra.includes("GH_TOKEN") && "GH_TOKEN" in env);
          expect(childEnv(env, extra)).toEqual(r);
        },
      ),
    );
  });
});

describe("childEnv の NO_PROXY（loopback をプロキシに通さない）", () => {
  it("ない場合は、loopback だけを入れる", () => {
    const { env } = childEnv({ PATH: "/bin" });
    expect(env.NO_PROXY).toBe("127.0.0.1,localhost,[::1]");
    expect(env.no_proxy).toBe("127.0.0.1,localhost,[::1]");
  });
  it("既存の値があれば後ろに足し、すでにあるものは重ねない", () => {
    const { env } = childEnv({ NO_PROXY: "example.com, localhost", no_proxy: "a.b" });
    expect(env.NO_PROXY).toBe("example.com,localhost,127.0.0.1,[::1]");
    expect(env.no_proxy).toBe("a.b,127.0.0.1,localhost,[::1]");
  });
});
