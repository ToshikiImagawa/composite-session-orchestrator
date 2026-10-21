/**
 * 子（CLI）に渡す環境変数。許可リスト方式: 許可した名前だけを、親の環境変数から写す（`GH_TOKEN` などの秘密を、
 * 子に渡さない。NFR_005, NFR_011）。実機の確認（T10b ④）で、全部を渡すと秘密が子に渡ると分かったため。
 *
 * - 既定: 実行に要る変数（`PATH`・`HOME`・`LANG`・`TMPDIR` など）と、SDK の認証・接続に要る変数（`ANTHROPIC_*`・
 *   `CLAUDE_CODE_OAUTH_TOKEN`・`CLAUDE_CODE_USE_*`・`CLAUDE_CONFIG_DIR`・プロキシ・証明書）。
 * - daemon の設定（`childEnvAllow`）で、完全一致の名前を追加できる（Bedrock・Vertex の認証、遠隔の環境の認証など）。
 * - セッション識別子に関わる変数（名前が `CLAUDE` で始まり `SESSION` を含む。ただし `*_TOKEN*`・`*_URL` は除く）は、
 *   既定でも追加でも渡さない。渡すと、子のセッション識別子が親と同一になり、記録（NFR_011）と覗き見（FR_035）に影響する
 *   （Spike 02 #6）。`*_TOKEN*`・`*_URL` を含む名前は、追加の指定があれば渡せる。
 * 除いた変数の名前は、呼び出し側が起動の記録に残す（値は返さない）。
 */

/** 既定で渡す名前（完全一致）と、名前の先頭（前方一致）。 */
export const DEFAULT_CHILD_ENV = {
  names: [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "TERM",
    "TMPDIR",
    "TMP",
    "TEMP",
    // 認証・接続（SDK）
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CONFIG_DIR",
    // ネットワーク（プロキシ・証明書）
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "NODE_EXTRA_CA_CERTS",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
  ],
  prefixes: ["ANTHROPIC_"],
} as const;

const SESSION_VARIABLE = /^claude.*session/i;
const KEEP_VARIABLE = /token|_url$/i;
const isSessionIdentifier = (name: string): boolean =>
  SESSION_VARIABLE.test(name) && !KEEP_VARIABLE.test(name);

/**
 * 追加の許可（`childEnvAllow`）でも渡さない名前。子の実行を乗っ取れる（ライブラリ・スクリプトの読み込み、
 * シェルの起動時の実行、Git の外部コマンド）変数。
 */
const FORBIDDEN_PREFIXES = ["LD_", "DYLD_", "GIT_CONFIG"] as const;
const FORBIDDEN_NAMES = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "PYTHONSTARTUP",
  "PYTHONPATH",
  "PYTHONHOME",
  "PERL5OPT",
  "PERL5LIB",
  "RUBYOPT",
  "RUBYLIB",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_ASKPASS",
  "GIT_EXEC_PATH",
  "PROMPT_COMMAND",
  "SHELLOPTS",
  "BASHOPTS",
  "PS4",
  "IFS",
]);
export const isForbiddenChildEnvName = (name: string): boolean =>
  FORBIDDEN_NAMES.has(name) || FORBIDDEN_PREFIXES.some((p) => name.startsWith(p));

export interface ChildEnv {
  readonly env: Record<string, string>;
  /** 渡さなかった変数の名前（値は含めない）。 */
  readonly removed: readonly string[];
}

export function childEnv(
  parent: Readonly<Record<string, string | undefined>>,
  extraAllow: readonly string[] = [],
): ChildEnv {
  const allowed = new Set<string>([
    ...DEFAULT_CHILD_ENV.names,
    ...extraAllow.filter((n) => !isForbiddenChildEnvName(n)),
  ]);
  const env: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    const pass =
      !isSessionIdentifier(name) &&
      (allowed.has(name) || DEFAULT_CHILD_ENV.prefixes.some((p) => name.startsWith(p)));
    if (pass) env[name] = value;
    else removed.push(name);
  }
  return { env, removed };
}
