import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { childEnv } from "../../src/sdk/child-env.js";

describe("childEnv（親の環境変数から、セッション識別子に関わる変数を除く）", () => {
  it("CLAUDE_CODE_SESSION_ID を除く（子のセッション識別子が親と混ざるのを防ぐ。Spike 02 #6）", () => {
    const r = childEnv({ PATH: "/usr/bin", CLAUDE_CODE_SESSION_ID: "parent-session" });
    expect(r.env).toEqual({ PATH: "/usr/bin" });
    expect(r.removed).toEqual(["CLAUDE_CODE_SESSION_ID"]);
  });

  it("名前に SESSION を含む CLAUDE_* を除く（大文字小文字を問わない）", () => {
    const r = childEnv({
      CLAUDE_CODE_REMOTE_SESSION_ID: "x",
      claude_code_session_dir: "z",
      CLAUDE_CODE_SESSIONS: "w",
      HOME: "/home/u",
    });
    expect(Object.keys(r.env)).toEqual(["HOME"]);
    expect([...r.removed].sort()).toEqual(
      ["CLAUDE_CODE_REMOTE_SESSION_ID", "CLAUDE_CODE_SESSIONS", "claude_code_session_dir"].sort(),
    );
  });

  it("認証用の変数は残す（ANTHROPIC_*、CLAUDE_CODE_OAUTH_TOKEN、CLAUDE_CODE_USE_BEDROCK など）", () => {
    const keep = {
      ANTHROPIC_API_KEY: "k",
      ANTHROPIC_BASE_URL: "u",
      CLAUDE_CODE_OAUTH_TOKEN: "t",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CONFIG_DIR: "/c",
    };
    expect(childEnv(keep).env).toEqual(keep);
    expect(childEnv(keep).removed).toEqual([]);
  });

  it("識別子系だけを除き、*_TOKEN* / *_TOKEN_FILE / *_URL は SESSION を含んでも残す（認証・接続に要る。規則は T10b の実機検証で調整）", () => {
    const keep = {
      CLAUDE_CODE_SESSION_ACCESS_TOKEN: "a",
      CLAUDE_CODE_WEBSOCKET_AUTH_FILE_DESCRIPTOR: "1",
      CLAUDE_SESSION_INGRESS_TOKEN_FILE: "/f",
      CLAUDE_CODE_SESSION_URL: "https://x",
      claude_session_token: "t",
    };
    const r = childEnv({ ...keep, CLAUDE_CODE_SESSION_ID: "p" });
    expect(r.env).toEqual(keep);
    expect(r.removed).toEqual(["CLAUDE_CODE_SESSION_ID"]);
  });

  it("SESSION を含んでも CLAUDE で始まらない変数は残す", () => {
    const keep = { TMUX_SESSION: "a", XDG_SESSION_ID: "b", SESSION_MANAGER: "c" };
    expect(childEnv(keep).env).toEqual(keep);
  });

  it("値が undefined の項目は捨てる（env は文字列だけ）", () => {
    const r = childEnv({ A: "1", B: undefined });
    expect(r.env).toEqual({ A: "1" });
    expect(r.removed).toEqual([]);
  });

  it("除いた変数の名前だけを返し、値は返さない。入力を変更しない", () => {
    const input = { CLAUDE_CODE_SESSION_ID: "secret-value", A: "1" };
    const before = JSON.stringify(input);
    const r = childEnv(input);
    expect(JSON.stringify(r)).not.toContain("secret-value");
    expect(JSON.stringify(input)).toBe(before);
  });

  it("性質: 結果に SESSION を含む CLAUDE_* は残らず、それ以外は値を保つ（決定的）", () => {
    const key = fc.oneof(
      fc.constantFrom(
        "CLAUDE_CODE_SESSION_ID",
        "CLAUDE_X_SESSION",
        "claude_session",
        "PATH",
        "HOME",
        "ANTHROPIC_API_KEY",
      ),
      fc.string({ minLength: 1, maxLength: 12 }),
    );
    fc.assert(
      fc.property(fc.dictionary(key, fc.string()), (env) => {
        const r = childEnv(env);
        for (const [k, v] of Object.entries(r.env)) {
          expect(/^claude.*session/i.test(k) && !/token|_url$/i.test(k), k).toBe(false);
          expect(env[k]).toBe(v);
        }
        for (const k of Object.keys(env)) expect(k in r.env || r.removed.includes(k), k).toBe(true);
        expect(childEnv(env)).toEqual(r);
      }),
    );
  });
});
