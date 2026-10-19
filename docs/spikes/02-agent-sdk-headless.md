# Spike 02: Claude Agent SDK による headless 実行

CLI 環境の前提（FR_009, FR_010, FR_033, IR_001, IR_002）を確認する。

## 確認項目と結果

| # | 確認項目 | 影響する要求 | 結果 | メモ |
|:--|:--|:--|:--|:--|
| 1 | headless で起動できるか | FR_033 | 可 | 実機確認済み。TS SDK `query()`（`@anthropic-ai/claude-agent-sdk` 0.3.303 / CLI 2.1.303）と `claude -p --output-format json` の双方で非対話起動できた。認証は環境側の既存認証を利用。 |
| 2 | 稼働中のセッションに追加指示を送れるか（ストリーミング入力） | FR_009 | 可 | 実機確認済み。`query({prompt: AsyncIterable<SDKUserMessage>})` で起動し、ターン終了（result）後に同じ iterable へ追加メッセージを push すると、同一セッションで次ターンが実行された。CLI では `--input-format stream-json`（`--print` 時のみ）。実行中ターンへの割り込み追記は未検証（`interrupt()` 後に送る運用を想定）。 |
| 3 | 外部から停止できるか（穏当な停止・即時停止） | FR_010 | 可 | 実機確認済み（穏当）: `Query.interrupt()` で実行中ターンが中断され、result は `error_during_execution`。プロセスは生存し、セッションは `--resume` 可能。即時停止は `abortController.abort()`（SDK）またはプロセス終了で可能とされる（ドキュメント根拠。abort の実機確認は未実施）。`interrupt()` はストリーミング入力モード限定。 |
| 4 | MCP 接続設定（ノード専用トークン付き HTTP）を注入できるか | IR_001, NFR_005 | 可 | 実機確認済み。`options.mcpServers = {node: {type:'http', url, headers:{Authorization:'Bearer …'}}}` を注入でき、init メッセージで `connected`、MCP ツール `mcp__node__ping` の呼び出し成功、サーバ側で Authorization ヘッダを受信した。ノード専用トークンをヘッダで渡せる。CLI では `--mcp-config` / `--strict-mcp-config`。トークンの失効はサーバ側（Orchestrator）で実装する。 |
| 5 | hooks（PreToolUse / PostToolUse / Stop）を注入できるか | FR_014, IR_002 | 可 | 実機確認済み。`options.hooks` の PreToolUse / PostToolUse / Stop コールバックがすべて発火し、`settingSources: []` でも有効。PreToolUse で `permissionDecision:'deny'` を返すと実行が拒否され、モデルへ理由が伝わった。入力に `session_id` と `cwd` を含む。ファイル設定の hooks は `--settings` / `settingSources` で別途注入可能。 |
| 6 | セッション ID を取得でき、`--resume <id> --fork-session` で覗けるか | FR_035 | 条件付き | 実機確認済み。init / result メッセージの `session_id` で取得でき、`claude -p --resume <id> --fork-session` は新しいセッション ID を発行し、元の履歴を引き継いだ。条件: 親から継承される環境変数 `CLAUDE_CODE_SESSION_ID` があると子のセッション ID が親と同一になるため、子の起動時に env から除外すること。fork は会話履歴のみ分岐し、ファイルシステムは共有される（公式ドキュメント）。 |
| 7 | 指定した作業ディレクトリ（worktree）で起動できるか | FR_006 | 可 | 実機確認済み。`options.cwd` に `git worktree add` で作った作業ツリーを指定し、init の `cwd`、Bash の `pwd`、フックの `cwd` がすべてその worktree だった。セッション保存先は cwd 由来（`~/.claude/projects/<encoded-cwd>/`）。 |

## 結論

調査日: 2026-10-19。使用: `@anthropic-ai/claude-agent-sdk` 0.3.303、Claude Code CLI 2.1.303、Node 22。検証スクリプトはリポジトリ外で実施し、コミットしていない。

### 総括

7 項目すべてで、CLI 環境の前提は成立した。ただし本検証は 1 つの cloud 環境で行ったもので、Desktop 環境は対象外（PRD 6 章の Desktop 側の前提は別途検証）。

### PRD への影響

| 要求 | 影響 |
|:--|:--|
| FR_033 | 満たせる。`query()` による headless 起動が可能。 |
| FR_009 | 満たせる。ストリーミング入力（AsyncIterable）で稼働中セッションへ追加指示できる。ターン実行中の割り込み追記の挙動は未検証。 |
| FR_010 | 満たせる。穏当な停止は `interrupt()`、即時停止は `abortController.abort()` / プロセス終了。 |
| FR_035 | 条件付きで満たせる。`--resume <id> --fork-session` で履歴を覗ける。子の起動時に `CLAUDE_CODE_SESSION_ID` を env から除外すること。 |
| IR_001 | 満たせる。HTTP MCP をプログラムから注入できる。 |
| IR_002 | 満たせる。SDK のコールバック hooks（Pre/PostToolUse, Stop）で記録と拒否ができる。FR_014 の範囲外操作の拒否にも使える。 |
| NFR_005 | 満たせる。`headers.Authorization` でノードごとのトークンを渡せる。接続元の識別とノード停止時の失効は MCP サーバ側の実装課題。 |
| FR_006 | 満たせる。`options.cwd` に worktree を指定できる。 |

PRD・憲法の変更は不要。

### 採用する API の候補

- 起動と追加指示: `query({ prompt: AsyncIterable<SDKUserMessage>, options })`
- 停止: `Query.interrupt()`（穏当）、`options.abortController`（即時）
- 接続設定: `options.mcpServers`（`type: 'http'`, `headers`）
- フック: `options.hooks`（`PreToolUse` / `PostToolUse` / `Stop`）、`settingSources: []` で利用者設定の混入を防ぐ
- 作業ディレクトリ: `options.cwd`
- セッション識別と覗き見: init / result の `session_id`、`claude -p --resume <id> --fork-session`

### 未確認事項・注意点

- `abortController.abort()` による即時停止、実行中ターンへの追記、複数の子の同時起動は実機未確認。
- `CLAUDE_CODE_SESSION_ID` など親セッション由来の環境変数は、子の起動時に除外する（`options.env` で制御）。
- 人間が手元で再確認する手順: `npm i @anthropic-ai/claude-agent-sdk` を作業用ディレクトリで実行し、`query()` に AsyncIterable を渡して上記を再現する。

### 根拠

- https://code.claude.com/docs/en/agent-sdk/typescript （Options, Query.interrupt / streamInput）
- https://code.claude.com/docs/en/agent-sdk/hooks
- https://code.claude.com/docs/en/agent-sdk/sessions
- `claude --help`（`--input-format`, `--mcp-config`, `--settings`, `--resume`, `--fork-session`）
