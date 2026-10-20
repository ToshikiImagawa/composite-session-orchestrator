# Spike 02: Claude Agent SDK による headless 実行

CLI 環境の前提（FR_009, FR_010, FR_033, IR_001, IR_002）を確認する。

## 確認項目と結果

| # | 確認項目 | 影響する要求 | 結果 | メモ |
|:--|:--|:--|:--|:--|
| 1 | headless で起動できるか | FR_033 | 可 | 実機確認済み。TS SDK `query()`（`@anthropic-ai/claude-agent-sdk` 0.3.303 / CLI 2.1.303）と `claude -p --output-format json` の双方で非対話起動できた。認証は環境側の既存認証を利用。 |
| 2 | 稼働中のセッションに追加指示を送れるか（ストリーミング入力） | FR_009 | 可（ターン間・実行中） | 実機確認済み。`query({prompt: AsyncIterable<SDKUserMessage>})` で起動し、(a) result 後に同じ iterable へ push すると次ターンが実行された。(b) 実行中（Bash の `sleep 20` 中、push は 6 秒後）に push したメッセージは、assistant メッセージの出力時刻と result の回数で観測すると、即時には処理されず、実行中のツール完了後に同一ターン内で処理された（result は 1 回、応答 `MIDTURN` はツール完了直後）。つまり実行中の追記はキューされ、ツールの完了後に届く。実行中のツールを中断してから届けたい場合は `interrupt()` を併用する。CLI では `--input-format stream-json`（`--print` 時のみ）。 |
| 3 | 外部から停止できるか（穏当な停止・即時停止） | FR_010 | 条件付き | 穏当: `Query.interrupt()` を実機確認。実行中の Bash は打ち切られ（後続の `touch finished.txt` は未実行）、result は `error_during_execution`、プロセスは生存しセッションは `--resume` 可能。停止前に作業ツリーへ書かれたファイル（`partial.txt`）は残った。FR_010 の「実行中操作の完了後に成果を保存して止める」とは異なり、実行中ツールを待たずに打ち切る挙動のため、同定義に当たるかは未確認。`interrupt()` は streaming input モード限定（公式）で、CLI の `-p` 単発起動では使えない。即時: `abortController.abort()` を実機確認。プロセスが即座に終了し（`Claude Code process aborted by user` が throw される）、後続コマンドは実行されなかった。公式の記載は "Controller for cancelling operations" のみ。**孤児プロセス**: フォアグラウンドの Bash が起動した `sleep` は、`interrupt()` / `abort()` のいずれでも停止後に残らず、停止後に孤児が作業ツリーへ書き込むことも起きなかった（`ps` で PID / PGID を確認。Bash ごとに独立したプロセスグループで、停止時に終了する）。当初「孤児が残る」と記載したのは pgrep が自分自身のシェルを数えた計測誤りで、訂正済み。バックグラウンド起動（`run_in_background`、`nohup`、`setsid` 等）したプロセスは未検証。SIGTERM / SIGKILL も未検証。 |
| 4 | MCP 接続設定（ノード専用トークン付き HTTP）を注入できるか | IR_001, NFR_005 | 可 | 実機確認済み。`options.mcpServers = {node: {type:'http', url, headers:{Authorization:'Bearer …'}}}` を注入でき、init メッセージで `connected`、MCP ツール `mcp__node__ping` の呼び出し成功、サーバ側で Authorization ヘッダを受信した。ノード専用トークンをヘッダで渡せる（検証では `NODE-TOKEN-1` というダミー値を使用した）。CLI では `--mcp-config` / `--strict-mcp-config`。トークンの失効はサーバ側（Orchestrator）で実装する。 |
| 5 | hooks（PreToolUse / PostToolUse / Stop）を注入できるか | FR_014, IR_002 | 可 | 実機確認済み。`options.hooks` の PreToolUse / PostToolUse / Stop コールバックがすべて発火し、`settingSources: []` でも有効。PreToolUse で `permissionDecision:'deny'` を返すと実行が拒否され、モデルへ理由が伝わった。入力に `session_id` と `cwd` を含む。ファイル設定の hooks は `--settings` / `settingSources` で別途注入可能。 |
| 6 | セッション ID を取得でき、`--resume <id> --fork-session` で覗けるか | FR_035 | 条件付き | 実機確認済み。init / result の `session_id` で取得でき、`claude -p --resume <id> --fork-session` は新しいセッション ID を発行し、元の履歴を引き継いだ。fork は会話履歴のみ分岐し、ファイルシステムは共有される（公式）。**条件（実機確認のみ・確認した範囲の公式ドキュメントに記載なし）**: 親から継承される環境変数 `CLAUDE_CODE_SESSION_ID` があると、子のセッション ID が親と同一になった。影響: フック入力の `session_id` が親と同一になり子の操作記録が混ざる（NFR_011）。覗き見用 fork がどちらの履歴を指すか曖昧になる（FR_035）。対処: `options.env` は `process.env` を置き換えるため、`{...process.env}` から該当変数（実機で子の ID が親と同一になることを確認したのは `CLAUDE_CODE_SESSION_ID` のみ。検証では `CLAUDE_CODE_REMOTE_SESSION_ID` / `CLAUDE_CODE_REMOTE_SDK_URL` / `CLAUDE_CODE_CHILD_SESSION` / `CLAUDE_CODE_USE_CCR_V2` も併せて除いたが、個別の影響は未切り分け）を除いて渡す。なお typescript ページは先頭約 100k 文字のみ確認。 |
| 7 | 指定した作業ディレクトリ（worktree）で起動できるか | FR_006 | 可 | 実機確認済み。`options.cwd` に `git worktree add` で作った作業ツリーを指定し、init の `cwd`、Bash の `pwd`、フックの `cwd` がすべてその worktree だった。セッション保存先は cwd 由来（`~/.claude/projects/<encoded-cwd>/`）。 |

## 結論

調査日: 2026-10-19。検証環境: cloud 環境（Linux）、`@anthropic-ai/claude-agent-sdk` 0.3.303、Claude Code CLI 2.1.303、Node 22。**Desktop 環境は対象外**（PRD 6 章の Desktop 側の前提は別途検証）。再検証時は SDK / CLI のバージョン差を確認すること。検証スクリプトはリポジトリ外で実施し、コミットしていない。

### 訂正履歴

- 初版で「`abort()` 後に `sleep` の孤児が残る」と記載したが、`pgrep` が自分自身のシェルを数えた計測誤りだった。`ps -eo pid,ppid,pgid,cmd` で停止の 3 秒後と、`sleep` の満了後（`orphan.txt` の有無）に確認し直し、残らないと訂正した。

### 総括

CLI 環境の前提は成立した。ただし項目 6 は条件付き（`CLAUDE_CODE_SESSION_ID` の除外が必要）、項目 3 は SIGTERM / SIGKILL とバックグラウンド起動プロセスの扱いが未検証、項目 2 は実行中ツールの完了後に届く（即時には届かない）。

### PRD への影響

| 要求 | 影響 |
|:--|:--|
| FR_033 | 満たせる。`query()` による headless 起動が可能。 |
| FR_009 | 満たせる。idle のセッションへも、実行中のセッションへも追記できる。実行中の追記はツール完了後に届く（即時には届かない）。 |
| FR_010 | `interrupt()` は FR_010 の穏当な停止の定義（実行中操作の完了後に保存して止める）とは異なる（実行中ツールを待たず打ち切る）。設計の選択肢（未検証）: 実行中の追記はツール完了後に届くため、停止指示をメッセージとして送る方式なら定義に近い穏当な停止にできる可能性がある。即時停止は `abort()` でプロセスが終了する。フォアグラウンド Bash の子プロセスは停止後に残らなかった（バックグラウンド起動は未検証）。SIGTERM / SIGKILL は未検証。設計制約: `interrupt()` は streaming input 限定のため、子は常に AsyncIterable 入力で起動する（`-p` 単発起動では穏当な停止ができない）。 |
| FR_026〜FR_029 | 停止後に作業ツリー配下でプロセスが動いていないことが、回収可能の判定（FR_026）と事前確認付きの回収（FR_029）の前提になる。検証したフォアグラウンド Bash では停止後にプロセスが残らなかったが、バックグラウンド起動や `setsid` / `nohup` されたプロセスは、停止後も cwd を保持して作業ツリーを書き換えうる（未検証）。その場合 FR_010 の「停止」とは言えず、回収の安全性の前提も崩れる。対処案: 停止後に作業ツリーを cwd またはオープンファイルとして保持するプロセスの生存確認（`lsof +D` / `/proc/*/cwd`）を回収可能の判定に含める、プロセスグループ単位での終了、バックグラウンド起動を hooks（PreToolUse）で拒否する。PRD 変更の要否は設計で判断する（FR_026 の判定条件に「配下プロセスの不在」を加える案）。 |
| FR_035 | 条件付き。`--resume <id> --fork-session` で履歴を覗ける。子の起動時に `CLAUDE_CODE_SESSION_ID` を env から除外すること。fork はファイルシステムを共有するため、覗き見側が書き換えると子の作業を妨げる。覗き見は読み取り専用（`permissionMode` / `allowedTools` の制限）で開く。 |
| IR_001 | 満たせる。HTTP MCP をプログラムから注入できる。 |
| IR_002 | 満たせる。SDK のコールバック hooks（Pre/PostToolUse, Stop）で記録と拒否ができる。FR_014 の範囲外操作の拒否にも使える。 |
| NFR_005 | ヘッダでノードごとのトークンを渡せる。ただし「ローカルからの接続のみ」と「ノード停止時の失効」はヘッダ注入では満たせず、MCP サーバ側の実装課題（bind 先を 127.0.0.1 にする、トークンの失効、トークンが子のログや init メッセージに出ないか）。 |
| NFR_011 | `CLAUDE_CODE_SESSION_ID` を除外しないと、フック入力の `session_id` が親と混ざる。除外すれば、子ごとに別の `session_id` がフックに渡る。 |
| FR_006 | 満たせる。`options.cwd` に worktree を指定できる。 |
| NFR_001 | 短時間のタスクを持つ 3 つの子を別 worktree・別 cwd で同時起動し、セッション ID・フックの `session_id` が混ざらないことを確認した。同一 cwd の共有、4 つ以上、長時間実行、`~/.claude/projects` の競合は未確認。 |

憲法の変更は不要。PRD は、この結果と Spike 01 を受けて更新した（FR_010 の穏当な停止を 2 段階に、FR_026 に条件 6「作業ツリー配下で動作中のプロセスがない」を追加）。バックグラウンド起動されたプロセスの扱いは未検証のまま残る。

### CLI 環境で可能な操作（FR_034 への入力）

| 操作 | 可否 | 備考 |
|:--|:--|:--|
| headless 起動 | ○ | `query()` / `claude -p` |
| 追加指示（ターン間） | ○ | streaming input |
| 追加指示（実行中） | ○（遅延） | 実行中ツールの完了後に届く |
| 停止（穏当） | ○ | `interrupt()`。streaming input 限定。実行中ツールは打ち切られる |
| 停止（即時） | △ | `abort()` でプロセス終了。フォアグラウンド Bash の子は残らない。バックグラウンド起動と SIGTERM / SIGKILL は未検証 |
| MCP 接続設定の注入 | ○ | `mcpServers`（http + headers） |
| フックの注入 | ○ | `hooks`（Pre/PostToolUse, Stop）。deny も可 |
| セッション ID の取得 | ○ | init / result の `session_id`。env の除外が必要 |
| 覗き見（fork） | △ | `--resume <id> --fork-session`。ファイルシステム共有のため読み取り専用で開く |
| 作業ディレクトリ指定 | ○ | `options.cwd` |
| 複数の子の同時起動 | ○ | 3 並列で確認 |

### 採用する API の候補

- 起動と追加指示: `query({ prompt: AsyncIterable<SDKUserMessage>, options })`
- 停止: `Query.interrupt()`（穏当）、`options.abortController`（即時）
- 接続設定: `options.mcpServers`（`type: 'http'`, `headers`）
- フック: `options.hooks`（`PreToolUse` / `PostToolUse` / `Stop`）。`settingSources` は省略時に user / project / local をすべて読み込むため、`[]` を指定して利用者設定の hooks の混入を防ぐ
- 作業ディレクトリ: `options.cwd`
- セッション識別と覗き見: init / result の `session_id`、`claude -p --resume <id> --fork-session`
- 環境変数: `options.env` は `process.env` を置き換える。`{...process.env}` から `CLAUDE_CODE_SESSION_ID` などを除いて渡す

### 注記

- `CLAUDE_CODE_SESSION_ID` などの環境変数名は、検証した cloud 環境（Claude Code Remote）に固有の可能性が高い。ローカルや Desktop 環境では別の変数が継承される可能性があるため、子の起動時は継承された `CLAUDE_CODE_*` を一覧して確認すること。

### 未確認事項

- 優先度高（FR_010 / FR_026〜FR_029）: SIGTERM / SIGKILL による停止、バックグラウンド起動（`run_in_background`、`nohup`、`setsid`）したプロセスが停止後も残り作業ツリーを書き換えるか。
- 多数（4 以上）の子の同時起動、同一 cwd を共有した場合の挙動。
- 覗き見 fork を読み取り専用で開いたときの実際の挙動。
- typescript ページは先頭約 100k 文字のみ確認し、残りは未確認。

### 再確認の手順

作業用ディレクトリで `npm i @anthropic-ai/claude-agent-sdk` を実行し、次の要点で再現する。認証は実行環境の既存認証を使い、認証情報はコードに含めない。

```ts
// 要点のみ（型・import は省略、全文の実行確認済みコードではない）。
// `permissionMode: 'bypassPermissions'` は使い捨ての検証環境専用で、製品の子の起動設定ではない。
// 親由来の env を除外（セッション ID の混入防止）
const env = { ...process.env };
delete env.CLAUDE_CODE_SESSION_ID;

// streaming input（AsyncIterable）。push した順に子へ届く
const queue: SDKUserMessage[] = []; let wake: (() => void) | undefined;
async function* input() {
  while (true) { while (queue.length) yield queue.shift()!; await new Promise<void>(r => (wake = r)); }
}
const send = (t: string) => { queue.push({ type: 'user', message: { role: 'user', content: t }, parent_tool_use_id: null, session_id: '' }); wake?.(); };

const ac = new AbortController();
const q = query({ prompt: input(), options: {
  cwd: worktreePath, env, abortController: ac, settingSources: [],
  permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true,
  mcpServers: { node: { type: 'http', url: 'http://127.0.0.1:PORT/mcp', headers: { Authorization: 'Bearer <dummy>' } } },
  hooks: { PreToolUse: [{ hooks: [async i => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'out of scope' } })] }] },
} });
// await q.interrupt()  -> 穏当な停止
// ac.abort()           -> 即時停止（for await が throw する）
// セッション ID: init メッセージ (type 'system', subtype 'init') の session_id
```

観測結果の要点:

| 確認 | 手順 | 観測 |
|:--|:--|:--|
| 実行中の追記 | Bash `sleep 20` 中に 6 秒後に push | ツール完了後に応答。result は 1 回 |
| `interrupt()` | Bash `echo work > partial.txt; sleep 25; touch finished.txt` の 10 秒後 | `partial.txt` あり、`finished.txt` なし、result は `error_during_execution` |
| `abort()` | Bash 実行中に呼ぶ | `Claude Code process aborted by user` が throw、`finished.txt` なし、停止 3 秒後に `sleep` は存在せず、`orphan.txt` も書かれない |
| 子プロセスの残存 | `(sleep N; echo > orphan.txt)` の実行中に `interrupt()` / `abort()`、`ps -eo pid,ppid,pgid,cmd` で確認 | いずれも残らない（注意: プロセス名での検索 `pgrep -f` などは検索コマンド自身のシェルも数えるため誤判定する。PID / PGID と親子関係で追跡し、バックグラウンド起動の検証でも同じ方法を使う） |
| 同時起動 | 3 つの worktree で並列 | セッション ID 3 種、フックの `session_id` も混ざらない |
| fork | `claude -p --resume <id> --fork-session` | 新しいセッション ID が発行され、履歴を引き継ぐ |
| env の継承 | `CLAUDE_CODE_SESSION_ID` を残したまま起動 | 子のセッション ID が親と同一 |

### 根拠

- https://code.claude.com/docs/en/agent-sdk/typescript （Options, Query.interrupt / streamInput）
- https://code.claude.com/docs/en/agent-sdk/hooks
- https://code.claude.com/docs/en/agent-sdk/sessions
- `claude --help`（`--input-format`, `--mcp-config`, `--settings`, `--resume`, `--fork-session`）
