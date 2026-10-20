/**
 * 子のエージェント（Claude Code CLI）の起動と操作の抽象。外部のプロセスをこのインターフェースに隠し、
 * アダプタの本体ロジックはフェイクでテストする（実際の Agent SDK との接続は別ファイル）。
 */

export interface HookInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  /** SDK が渡す cwd。判定には使わない（基準は、起動時に実パスにした作業ツリー。子が cwd を変えても基準は動かさない）。 */
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

/**
 * 起動した子の 1 セッション。
 *
 * Spike 02 の制約: `interrupt()` はストリーミング入力のときだけ使える（単発の起動では使えない）。`abort()` は、
 * 待っている `for await` を例外で終わらせる。`finished()` や `nextResult()` が reject する場合がある。
 * どの操作も例外を投げうる（呼び出し側は try/catch で受け、手段を切り替える）。`interrupt()` は戻らないことがあり、
 * 戻っても後続の result が来る保証はない（呼び出し側が時間で制限する）。
 */
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
