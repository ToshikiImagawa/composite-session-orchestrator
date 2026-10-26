import { describe, expect, it } from "vitest";
import {
  CHILD_AUTH_VARIABLES,
  CHILD_CLOUD_VARIABLES,
  childAuthProblem,
} from "../../src/sdk/child-auth.js";
import { childEnv } from "../../src/sdk/child-env.js";

describe("childAuthProblem（子の認証の有無。T22-auth）", () => {
  it("認証の変数がない・空・空白だけなら childAuthMissing（理由と 3 つの対処）", () => {
    for (const env of [
      {},
      { ANTHROPIC_API_KEY: "" },
      { CLAUDE_CODE_OAUTH_TOKEN: "  " },
      { PATH: "/bin" },
    ]) {
      const f = childAuthProblem(env);
      expect(f?.code).toBe("childAuthMissing");
      expect(f?.nextActions).toHaveLength(4);
      expect(f?.nextActions.at(-1)).toContain("解決済み");
      expect(f?.nextActions.join()).toContain("claude setup-token");
      expect(f?.nextActions.join()).toContain("inherit");
    }
  });

  it("どれか 1 つでもあれば通る。クラウドの経路は、変数があることだけで通す", () => {
    for (const n of [...CHILD_AUTH_VARIABLES, ...CHILD_CLOUD_VARIABLES]) {
      expect(childAuthProblem({ [n]: "1" }), n).toBeUndefined();
    }
  });

  it("クラウドの経路の切り替えが 0・false・no・off（大文字小文字を問わない）なら、なしとみなす", () => {
    for (const v of ["0", "false", "FALSE", "no", "Off", " off "]) {
      expect(childAuthProblem({ CLAUDE_CODE_USE_BEDROCK: v })?.code, v).toBe("childAuthMissing");
    }
    expect(childAuthProblem({ CLAUDE_CODE_USE_VERTEX: "true" })).toBeUndefined();
    // API キー・トークンは、空かどうかだけで見る（"0" でも、あるとみなす）
    expect(childAuthProblem({ ANTHROPIC_API_KEY: "0" })).toBeUndefined();
  });

  it("失敗の文面に、値を出さない（名前だけ）", () => {
    const f = childAuthProblem({ ANTHROPIC_API_KEY: "", OTHER_SECRET: "sk-secret-value" });
    expect(JSON.stringify(f)).not.toContain("sk-secret-value");
  });

  it("判定する名前は、すべて子の環境の許可リスト（既定）を通る", () => {
    const parent = Object.fromEntries(
      [...CHILD_AUTH_VARIABLES, ...CHILD_CLOUD_VARIABLES].map((n) => [n, "x"]),
    );
    const { env, removed } = childEnv(parent, []);
    for (const n of Object.keys(parent)) expect(env[n], n).toBe("x");
    expect(removed).toEqual([]);
  });
});
