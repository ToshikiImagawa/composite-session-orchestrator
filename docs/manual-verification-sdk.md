# 実 Agent SDK の手動確認手順（T10b ④）

`cso-daemon` が、実際の Claude（Agent SDK）で子を起動し、追加指示・停止・フック・回収まで動くことを確かめる手順。
自動テストはフェイクの `query` で行う（`packages/daemon/test/sdk/claude-launcher.test.ts`）。実 SDK の起動は認証情報が要るので、CI には入れない。
このファイルは手順書で、実 SDK での確認の結果は、下の「結果の記録」に日付つきで書く。

## 前提

- Node 22 以上、`git`、`lsof`。`pnpm install && pnpm build` 済み。
- Claude の認証が、実行する環境にあること（`ANTHROPIC_API_KEY` または、`claude` CLI のログイン）。認証情報は、設定ファイルにも、このリポジトリにも書かない。
- 依存: `@anthropic-ai/claude-agent-sdk` **0.3.292**（2026-10-06 公開。固定。ライセンスは `SEE LICENSE IN README.md`。ユーザーが確認・承認）。推移的な依存の公開日は `docs/dependency-release-ages.md`。
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

   注意: `retentionDays: 0` は、**使い捨てのリポジトリ専用**。実際の記録では、既定（90 日）のままにする（0 だと、アーカイブの直後に最終削除できてしまう）。`maxTurns`・`maxBudgetUsd` を省略すると、子ごとに 100 ターン・5 USD が上限になる（確認のときは、小さい値を設定してよい）。

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
| 9 | 即時の停止: 別の子で `mode":"immediate"` | プロセスが終了し、`stopped` | **子のプロセスが残らないこと**: `lsof +D <作業ツリー>` が空で、`ps -eo pid,ppid,args` に、その作業ツリーを cwd とする `claude` のプロセスがない（孫のプロセス〔`sleep` など〕も含む）。残っていれば、`stopIncomplete` になっているはず |
| 10 | 回収: 受理（`node.review`）の後に `node.reclaimPreview` → `node.reclaim` | 作業ツリーが消え、ブランチが `-d` で消える（統合済みのときだけ） | 未統合・未保存の変更があるときは、拒否される（強制しない） |
| 11 | 予期しない終了: 子のプロセスを `kill` する | `node.exited` が記録され、`unexpectedExit` がログに出る | 状態の扱い（T10c）が、設計どおりか |
| 12 | 再起動: daemon を止めて起動し直す | 動作中だった子が、`reconcileOnStartup` で整合する | プロセスが残っていれば `stopIncomplete`、なければ停止になる |

## 追加で確認する項目（セキュリティの境界）

| # | 確認 | 期待 | 確認の方法 |
|:--|:--|:--|:--|
| 13 | フックの例外・タイムアウト | 拒否される（フェイルクローズ）。ツールは実行されない | `hook-policy.ts` に、一時的に例外を投げる細工を入れて（コミットしない）、子に `Write` を頼む。フックが重い（数十秒かかる）ときも、ツールが実行されないこと |
| 14 | `Agent`・`Skill`（サブエージェント・スキル）の拒否 | 拒否される（`node.toolDenied` が記録される）。サブエージェントを介した迂回ができない | 子に「`Agent` ツールでサブエージェントを起動して」と頼む |
| 15 | `.mcp.json`・`settings.json` が読まれない | 子の作業ツリーに `.mcp.json`（別の MCP サーバーを書いたもの）と `.claude/settings.json`（フック・許可を書いたもの）を置いても、使われない（`strictMcpConfig`・`settingSources: []`） | 作業ツリーに置いて子を起動し、init の MCP サーバーの一覧に `node` 以外がないこと、置いた設定のフックが動かないこと |
| 16 | 環境変数の漏れ（T10e で許可リスト方式になった） | 子のプロセスの環境に、許可していない秘密（例: `GH_TOKEN`・`GITHUB_TOKEN`・`ANTHROPIC_API_KEY`）が、必要以上に渡っていないこと | 子の環境変数を、`/proc/<子の pid>/environ` で確認する（値は表示せず、名前だけ）。除く規則は `child-env.ts`（セッション識別子だけ）なので、**ほかの秘密は、そのまま渡る**。必要なら、許可リスト方式への変更を検討する |

## 結果の記録

実施するたびに、次の形で追記する（日付・SDK の版・CLI の版・OS・確認した項目と結果・見つかった問題）。

| 日付 | SDK / CLI | 環境 | 確認した項目 | 結果・問題 |
|:--|:--|:--|:--|:--|
| 2026-10-21 | 0.3.292 / 2.1.x（cloud 環境の `claude`） | Linux（Claude Code Remote）、Node 22.22 | 1, 2, 3（`src/` の外の拒否・`src/` の中は許可）, 5, 8, 9, 11, 12, 10（拒否のみ） | 下の「2026-10-21 の結果」 |

### 2026-10-21 の結果（実 SDK 0.3.292）

使い捨ての git リポジトリと作業ツリーで、`cso-daemon` と実 SDK の子を動かした（`createClaudeLauncher` を直接と、daemon 経由の両方）。

| # | 結果 | 観測 |
|:--|:--|:--|
| 1 | 合格 | `node.spawn` で子が起動（`running`）。作業ツリー（`worktrees/node-…`）と `cso/node-…` のブランチができ、子が `src/hello.txt` を作った |
| 2 | 合格 | 子のセッション ID が、親（この確認を動かした Claude）と別。除いた環境変数（6 件）: `CLAUDE_CODE_CHILD_SESSION`・`CLAUDE_CODE_SESSION_ID`・`CLAUDE_CODE_SESSION_ATTENDED`・`CLAUDE_CODE_REMOTE_SESSION_ID`・`CLAUDE_CODE_SYNC_SESSION_REFS`・`CLAUDE_CODE_POST_FOR_SESSION_INGRESS_V2` |
| 3 | 合格 | **`permissionMode: "dontAsk"` のもとで、フックが `allow` を返した `src/` の中への `Write` は、確認なしに実行された**。`src/` の外（`outside.txt`・`README.md`）への `Write` は、フックの `deny` で実行されず、daemon 経由では `scope.violation`（`outsideWritable`）が記録された |
| 4 | **未確認** | 子が使ったツールは `Write` だけ（`LS`・`TodoWrite`・`Glob` を使わせる指示では、子が範囲外を理由に実行しなかった）。許可するツール名の確認は、別の指示で行う |
| 5 | 合格 | 実行が終わって待っている子に `node.send` した指示が、次のターンで実行された（`src/second.txt`）。`node.instructed` と `node.instructionDelivered` が記録された |
| 6, 7 | **未実施** | MCP サーバーの起動口がない（T10m）。報告・判断は確認できない |
| 8 | 合格 | 穏当な停止: `stopping` → 約 15 秒で `stopped`。`stopObserved` は `withinGrace`。受信箱に「停止を確認した」 |
| 9 | 合格 | 即時の停止（子が 30 個のファイルを作る途中）: 3 ファイルで打ち切られ、`stopped`。受信箱は「停止を確認した（aborted）」。`lsof +D` に残るプロセスなし |
| 10 | **不合格（要判断）** | 破棄の判断（`node.reclaimInstruct`）の後、`reclaimPreview` は `reclaimable: true` になったが、`node.reclaim` が `removeFailed`。原因は、`git worktree remove`（`--force` なし）が、未追跡のファイル（`src/`）を理由に拒否したこと。仕様（5.8）は「強制的な削除は破棄判断を経た停止ノードに限る」としているが、`createGitPorts` は常に `--force` なし・ブランチは `-d`。破棄判断のあるノードだけ強制する変更が要る（T10r2） |
| 11 | 合格 | 子のプロセスを `kill -9`: ログに `unexpectedExit`、受信箱に `failure`（子が予期せず終了した）。**ただしノードの状態は `running` のまま**（再起動まで。T10c の「状態への反映」は未決） |
| 12 | 合格 | daemon を `SIGTERM` で止め、起動し直した: `reconciled running → stopped`（プロセスなし）。受信箱に「daemon の再起動で、子のセッションが失われた」 |

そのほかの発見:

- **範囲違反が受信箱に出ない**: `scope.violation` はログに記録されるが、受信箱の項目（`inbox.added`）が作られず、`inbox.fetch` に出ない（`sdk-adapter.ts` の記述は「受信箱に載る」）。統合ノードが、子の範囲違反に気づけない（T10v）。

### 2026-10-21 の結果（追加の項目）

項目 13〜15 は、**未実施**。項目 16 は、許可リスト方式（T10e）に変えたあと、実 SDK で、許可リストの環境でも子が認証でき（`ANTHROPIC_*` とプロキシが既定に入っている）、`GH_TOKEN` などの秘密は子に渡らない（`removed` に名前だけが出る）ことを確かめた。

### HOME の分離（#45 のレビュー対応）

子の `HOME` は、既定で `<stateDir>/homes/<nodeId>`（0700）に分ける（設定 `childHome: "inherit"` で、daemon の `HOME` を渡す）。
`childEnvAllow` に、`LD_*`・`NODE_OPTIONS`・`BASH_ENV`・`GIT_SSH_COMMAND` など、子の実行を乗っ取れる名前は指定できない。
実 SDK で、分けた HOME でも、認証（`ANTHROPIC_*`・`CLAUDE_CODE_OAUTH_TOKEN`）が通り、Write が動くかは、手動確認の項目 16 を、`childHome` の既定のまま再実行して確かめる。
