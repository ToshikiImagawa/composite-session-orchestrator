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
      expect(f?.nextActions).toHaveLength(3);
      expect(f?.nextActions.join()).toContain("claude setup-token");
      expect(f?.nextActions.join()).toContain("inherit");
    }
  });

  it("どれか 1 つでもあれば通る。クラウドの経路は、変数があることだけで通す", () => {
    for (const n of [...CHILD_AUTH_VARIABLES, ...CHILD_CLOUD_VARIABLES]) {
      expect(childAuthProblem({ [n]: "1" }), n).toBeUndefined();
    }
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
