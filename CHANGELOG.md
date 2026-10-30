# 変更履歴

## 0.1.0-beta.1（未リリース）

社内マーケットプレイスに載せる最初の版。

- daemon（`cso-daemon`）: イベントログ（SQLite）、子の起動（CLI の子は Agent SDK、Desktop の子は実験的）、作業範囲の判定（フック）、受信箱、回収、HTML の画面、トークンの期限
- MCP サーバー（`cso-mcp`）: 統合・子のロール別のツール（`mcp__node__*`）、daemon の身元の検証
- 人間用のコマンド（`cso`）: `purge`・`hook-env`・`hook-unbind`・`child` など
- plugin: skill `cso-integrator`・`cso-child`、コマンド `start`・`status`、フック（PreToolUse・PostToolUse・Stop）、統合セッションの MCP の設定（`.mcp.json`）
- ライセンスを MIT にした
- skill・コマンドは、MCP のツールの名前が `mcp__node__*` でも、plugin から入れたときの `mcp__plugin_composite-session-orchestrator_node__*` でも動く（`scripts/plugin-mcp-name-check.mjs` で 2.1.308 の名前を確認）
- 設定の説明（`docs/config.md`）とリリースの手順（`docs/release.md`）を足した
- daemon の再起動の途中（`daemon-identity` がない・接続の拒否・503）は、`cso-mcp`・`cso` が要求の中で待ってかけ直す（0.5・1・2・4 秒。1 回の身元の確認あたり、経過時間で 8 秒以内。トークンは、身元を確かめてから送る）。尽きたら `daemon_unreachable`。`cso-mcp` を起動し直さなくてよい

## 既知の問題

- daemon の再起動だけでよい（`cso-mcp` は起動し直さなくてよい。daemon が戻るまでの間の呼び出しは、1 回の身元の確認あたり最大 8 秒（確認を始めてからの経過時間。操作の締め切りの残りが短ければ、そちら）待ってかけ直し、尽きたら `daemon_unreachable`）。`cso-mcp` が落ちた・起動し直したときだけ、Claude Code の `/mcp` でつなぎ直す。トークンを取り消した・期限が切れたときは、設定し直して起動し直す。
- `--strict-start`（`--config` があるときの既定）で daemon より先に `cso-mcp` を起動すると、daemon を待ったあと、終了コード 1 で終わる。待つ時間は、起動時の待ち（`STARTUP_RETRY_MS` = 1・2・4・8 秒、5 回試す。1 回の確認は最大 5 秒）から、接続を拒否されるなら約 15 秒、応答がないなら約 40 秒、届いたあと身元の確認も一時的に失敗し続けると、さらに約 40 秒（合わせて最悪約 80 秒。429 が続くと 1 回あたり最大約 10 秒延びる）。daemon → `cso-mcp` の順に起動する。
- 手動確認 (a) の 4（チップから始めた子）・7（cd）・9a（Desktop の `transcript_path`。`CLAUDE_CONFIG_DIR` が違うとき）は、未確認。
- Desktop の子（`childRuntime: "desktop"`）は実験的。作業範囲外の拒否が十分に効かないので、信頼できない入力（他人のリポジトリ・Issue・Web の内容など）を読ませない（[`docs/desktop-runtime.md`](docs/desktop-runtime.md)）。
- 1 人で使う機械だけで使う（同じユーザーのプロセスは、状態の置き場のトークンを読める）。
- 画面の課題が残っている（T23-ux。確認の欄が見えにくい、Desktop の子の停止の代行依頼が「失敗」と出る、など）。
- 人間用の受信箱の一覧 `cso inbox` がない（T24-i）。受信箱は画面か、統合セッションの `inbox_fetch` で見る。
- 子 → `cso-mcp` の方向の身元確認がない（T10m-j。子は、`mcpUrl` の偽物にトークンを送りうる）。
