# 実 Agent SDK の手動確認手順（T10b ④）

`cso-daemon` が、実際の Claude（Agent SDK）で子を起動し、追加指示・停止・フック・回収まで動くことを確かめる手順。
自動テストはフェイクの `query` で行う（`packages/daemon/test/sdk/claude-launcher.test.ts`）。実 SDK の起動は認証情報が要るので、CI には入れない。
このファイルは手順書で、**実 SDK での確認は、まだ行っていない**（確認した項目は、下の「結果の記録」に日付つきで書く）。

## 前提

- Node 22 以上、`git`、`lsof`。`pnpm install && pnpm build` 済み。
- Claude の認証が、実行する環境にあること（`ANTHROPIC_API_KEY` または、`claude` CLI のログイン）。認証情報は、設定ファイルにも、このリポジトリにも書かない。
- 依存: `@anthropic-ai/claude-agent-sdk` **0.3.292**（2026-10-06 公開。固定。ライセンスは `SEE LICENSE IN README.md`。ユーザーが確認・承認）。
- **MCP サーバーの起動口は、まだない**（`packages/mcp` はツールの定義だけで、待ち受けるプロセスがない）。このため、子が使う `mcp__node__*`
  （`report.progress`・`report.done` など）は、いまは接続できない（init の MCP の状態が `failed` になる）。手順 6〜7 は、MCP の起動口ができてから行う。

## 準備

1. 使い捨ての git リポジトリを作る（`main` に 1 コミット）。作業ツリーの置き場も作る。

   ```sh
   export W=$(mktemp -d); git -C "$W" init -q -b main repo && git -C "$W/repo" commit -q --allow-empty -m init
   mkdir "$W/worktrees" "$W/state"; chmod 700 "$W/state"
   ```

2. 設定ファイル（権限 0600、所有者は自分）を書く。

   ```sh
   cat > "$W/config.json" <<EOF
   {
     "stateDir": "$W/state",
     "repoRoot": "$W/repo",
     "worktreeRoot": "$W/worktrees",
     "rootCwd": "$W/repo",
     "rootScope": { "writableLocations": ["src"], "forbiddenLocations": [".git"], "allowedCommands": ["git status"] },
     "mcpUrl": "http://127.0.0.1:7777/mcp",
     "retentionDays": 0
   }
   EOF
   chmod 600 "$W/config.json"
   ```

3. daemon を起動する（出力に、窓口の URL・人間のトークンのファイル・根のトークンのファイルが出る）。

   ```sh
   node packages/daemon/dist/bin.js --config "$W/config.json"
   ```

   以降、別の端末で、次の関数を使う（`URL` は、起動した窓口の URL）。

   ```sh
   req() { # req <token-file> <operation> <json-params>
     curl -s -X POST "$URL/v1/request" -H "authorization: Bearer $(cat "$1")" -H 'content-type: application/json' \
       -d "{\"requestId\":\"r-$RANDOM$RANDOM\",\"operation\":\"$2\",\"params\":$3}"
   }
   ROOT=$W/state/root-token; HUMAN=$W/state/human-token
   ```

## 確認する項目

| # | 操作 | 期待 | 確認すること |
|:--|:--|:--|:--|
| 1 | `req $ROOT node.spawn '{"parentId":"root","role":"implement","objective":"README.md に 1 行足す","acceptanceCriteria":["README.md が変わる"],"scope":{"writableLocations":["src"],"forbiddenLocations":[".git"],"allowedCommands":[]}}'` | `{"ok":true,"value":{"nodeId":"…","status":"running"}}`。`$W/worktrees/` に作業ツリー、`git branch` に `cso/…` | 子が起動する。`tree.list` で `running`。daemon のログ（標準エラー）に `unexpectedExit` が出ない |
| 2 | 子のセッションの init | セッション ID が記録される | init の `session_id` が、親（この確認を動かしている Claude）と**別**であること。`removed`（除いた環境変数の名前）に、`CLAUDE…SESSION…` が含まれる |
| 3 | フック: 子が `src/` の外（例: `README.md`）を書こうとする | 拒否される（`scope.violation` が受信箱に出る）。`src/` の中への書き込みは通る | **`permissionMode: "dontAsk"` のもとで、フックが `allow` を返したツールが、確認なしに実行される**こと（実行されなければ、`claude-launcher.ts` の権限の設定を見直す） |
| 4 | フックが許可するツール名 | `LS`・`TodoWrite`・`ToolSearch`・`BashOutput` などが拒否されない | 実際に使われたツール名を記録し、`hook-policy.ts` の許可の一覧と合わせる（足りなければ足す） |
| 5 | 追加指示: `req $ROOT node.send '{"nodeId":"<id>","text":"途中経過を 1 行で答えて"}'` | `{"status":"queued"}`。子が（実行中ならツール完了後に）応答する | 配送の記録（`node.instructionDelivered`）が出る |
| 6 | 子の報告（MCP の起動口ができてから） | `report.done` → 受信箱に `done` | 完了報告の根拠が、受け入れ基準ごとに付く |
| 7 | 判断（MCP の起動口ができてから）: 子が `report.decision` | 受信箱に判断要求 → `req $HUMAN decision.answer …` で回答 → 子が再開 | `pauseNodeIds` の子が止まり、回答で再開する |
| 8 | 穏当な停止: `req $ROOT node.stop '{"nodeId":"<id>","mode":"graceful"}'` | `stopping` → `stopped` | 実行中のツールが打ち切られ、`stopObserved` が `withinGrace` か `interrupted` で記録される |
| 9 | 即時の停止: 別の子で `mode":"immediate"` | プロセスが終了し、`stopped` | `lsof +D <作業ツリー>` に、子のプロセスが残らない |
| 10 | 回収: 受理（`node.review`）の後に `node.reclaimPreview` → `node.reclaim` | 作業ツリーが消え、ブランチが `-d` で消える（統合済みのときだけ） | 未統合・未保存の変更があるときは、拒否される（強制しない） |
| 11 | 予期しない終了: 子のプロセスを `kill` する | `node.exited` が記録され、`unexpectedExit` がログに出る | 状態の扱い（T10c）が、設計どおりか |
| 12 | 再起動: daemon を止めて起動し直す | 動作中だった子が、`reconcileOnStartup` で整合する | プロセスが残っていれば `stopIncomplete`、なければ停止になる |

## 結果の記録

実施するたびに、次の形で追記する（日付・SDK の版・CLI の版・OS・確認した項目と結果・見つかった問題）。

| 日付 | SDK / CLI | 環境 | 確認した項目 | 結果・問題 |
|:--|:--|:--|:--|:--|
| （未実施） | 0.3.292 / — | — | — | — |
