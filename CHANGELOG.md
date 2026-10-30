# 変更履歴

## 0.1.0-beta.1（未リリース）

社内マーケットプレイスに載せる最初の版。

- daemon（`cso-daemon`）: イベントログ（SQLite）、子の起動（CLI の子は Agent SDK、Desktop の子は実験的）、作業範囲の判定（フック）、受信箱、回収、HTML の画面、トークンの期限
- MCP サーバー（`cso-mcp`）: 統合・子のロール別のツール（`mcp__node__*`）、daemon の身元の検証
- 人間用のコマンド（`cso`）: `purge`・`hook-env`・`hook-unbind`・`child` など
- plugin: skill `cso-integrator`・`cso-child`、コマンド `start`・`status`、フック（PreToolUse・PostToolUse・Stop）、統合セッションの MCP の設定（`.mcp.json`）
- ライセンスを MIT（COMCREATE）にした
- skill・コマンドは、MCP のツールの名前が `mcp__node__*` でも、plugin から入れたときの `mcp__plugin_composite-session-orchestrator_node__*` でも動く（`scripts/plugin-mcp-name-check.mjs` で 2.1.308 の名前を確認）
- 設定の説明（`docs/config.md`）とリリースの手順（`docs/release.md`）を足した

## 既知の問題

- daemon を再起動したら、`cso-mcp` も起動し直す。統合セッションも MCP をつなぎ直す（`/mcp` から再接続）。
- 手動確認 (a) の 4（チップから始めた子）・7（cd）・9a（Desktop の `transcript_path`。`CLAUDE_CONFIG_DIR` が違うとき）は、未確認。
- Desktop の子（`childRuntime: "desktop"`）は実験的。作業範囲外の拒否が十分に効かないので、信頼できない入力（他人のリポジトリ・Issue・Web の内容など）を読ませない（`docs/desktop-runtime.md`）。
- 1 人で使う機械だけで使う（同じユーザーのプロセスは、状態の置き場のトークンを読める）。
- 画面の課題が残っている（T23-ux。確認の欄が見えにくい、Desktop の子の停止の代行依頼が「失敗」と出る、など）。
- 人間用の受信箱の一覧 `cso inbox` がない（T24-i）。受信箱は画面か、統合セッションの `inbox_fetch` で見る。
- 子 → `cso-mcp` の方向の身元確認がない（T10m-j。子は、`mcpUrl` の偽物にトークンを送りうる）。
