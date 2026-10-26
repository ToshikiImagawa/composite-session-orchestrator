/**
 * 子の認証の有無の判定（T22-auth）。既定の `childHome: "isolated"` では、子の HOME がノードごとの空のディレクトリなので、
 * `claude` CLI のログイン（HOME の下の資格情報）は使えない。認証の環境変数もなければ、子はエラーも出さずに止まる
 * （手動確認 A1 で、約 5 分 running のまま）。起動の前に確かめ、なければ理由と対処を示して失敗させる。
 *
 * - 認証とみなすのは、空でない値の `ANTHROPIC_API_KEY`・`ANTHROPIC_AUTH_TOKEN`・`CLAUDE_CODE_OAUTH_TOKEN`、またはクラウドの経路の
 *   切り替え（`CLAUDE_CODE_USE_BEDROCK`・`_VERTEX`・`_FOUNDRY`）。クラウドの経路は、変数があることだけで通す（その資格情報
 *   〔AWS・GCP など〕は `childEnvAllow` で渡す前提で、中身までは見ない）。
 * - 名前は、子の環境の許可リスト（`child-env.ts` の `DEFAULT_CHILD_ENV`）を通るものだけ（試験で確かめる）。
 * - 値は、記録・失敗の文面に出さない（名前だけ）。
 */

import { type Failure, failure } from "@cso/core";

export const CHILD_AUTH_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;
export const CHILD_CLOUD_VARIABLES = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const;

const present = (v: string | undefined): boolean => v !== undefined && v.trim() !== "";

/** 子に渡す環境（許可リストを通した後）に、認証があるか。なければ、理由と対処つきの失敗。 */
export function childAuthProblem(
  env: Readonly<Record<string, string | undefined>>,
): Failure | undefined {
  const names = [...CHILD_AUTH_VARIABLES, ...CHILD_CLOUD_VARIABLES];
  if (names.some((n) => present(env[n]))) return undefined;
  return failure(
    "childAuthMissing",
    `子に渡す環境変数に、認証（${CHILD_AUTH_VARIABLES.join("・")}、またはクラウドの経路 ${CHILD_CLOUD_VARIABLES.join("・")}）がない。子の HOME を分けている（childHome: "isolated"）ので、claude CLI のログインは使えない`,
    "claude setup-token で作った値を、daemon の環境変数 CLAUDE_CODE_OAUTH_TOKEN に入れて、daemon を起動し直す",
    "daemon の環境変数 ANTHROPIC_API_KEY を設定して、daemon を起動し直す",
    'daemon の設定 childHome を "inherit" にする（親の HOME と CLI のログインを共有する。分離は弱まる）',
  );
}
