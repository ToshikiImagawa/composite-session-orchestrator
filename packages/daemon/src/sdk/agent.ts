/**
 * 子のエージェント（Claude Code CLI）の起動と操作の抽象。外部のプロセスをこのインターフェースに隠し、
 * アダプタの本体ロジックはフェイクでテストする（実際の Agent SDK との接続は別ファイル）。
 */

export interface HookInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly cwd: string;
}

export type HookOutcome =
  | { readonly allow: true }
  /** `reason` はモデルへ伝える拒否の理由。 */
  | { readonly allow: false; readonly reason: string };

export interface McpServerConfig {
  readonly type: "http";
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

export interface LaunchOptions {
  /** 作業ツリー（実パス）。 */
  readonly cwd: string;
  /** 子に渡す環境変数（親のセッション識別子に関わる変数を除いたもの）。 */
  readonly env: Readonly<Record<string, string>>;
  /** 利用者設定のフックの混入を防ぐため、常に空。 */
  readonly settingSources: readonly [];
  readonly mcpServers?: Readonly<Record<string, McpServerConfig>>;
  readonly hooks: { readonly preToolUse: (input: HookInput) => Promise<HookOutcome> };
  /** 最初の指示（ブリーフ）。 */
  readonly initialPrompt: string;
}

/** 起動した子の 1 セッション。 */
export interface AgentSession {
  /** init を受けたら解決する。起動に失敗したら reject する。 */
  ready(): Promise<{ readonly sessionId: string }>;
  /** 追加の指示を入力へ積む（実行中はツール完了後に届く）。 */
  send(text: string): void;
  /** 呼ばれた後の、次の result まで待つ。 */
  nextResult(): Promise<void>;
  /** 実行中の処理を打ち切る（セッションは再開できる）。 */
  interrupt(): Promise<void>;
  /** 即時にプロセスを終了する。 */
  abort(): void;
  /** 入力を閉じる（これ以上の指示を送らない）。 */
  close(): void;
  /** セッションが終了したら解決する。 */
  finished(): Promise<void>;
}

export interface AgentLauncher {
  launch(options: LaunchOptions): AgentSession;
}
