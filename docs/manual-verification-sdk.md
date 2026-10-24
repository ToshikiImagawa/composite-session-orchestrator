# 実 Agent SDK の手動確認手順（T10b ④）

`cso-daemon` が、実際の Claude（Agent SDK）で子を起動し、追加指示・停止・フック・回収まで動くことを確かめる手順。
自動テストはフェイクの `query` で行う（`packages/daemon/test/sdk/claude-launcher.test.ts`）。実 SDK の起動は認証情報が要るので、CI には入れない。
このファイルは手順書で、実 SDK での確認の結果は、下の「結果の記録」に日付つきで書く。

## 前提

- Node 22 以上、`git`、`lsof`。`pnpm install && pnpm build` 済み。
- Claude の認証が、実行する環境にあること（`ANTHROPIC_API_KEY` または、`claude` CLI のログイン）。認証情報は、設定ファイルにも、このリポジトリにも書かない。
- 依存: `@anthropic-ai/claude-agent-sdk` **0.3.292**（2026-10-06 公開。固定。ライセンスは `SEE LICENSE IN README.md`。ユーザーが確認・承認）。推移的な依存の公開日は `docs/dependency-release-ages.md`。
- MCP サーバー（`cso-mcp`）は、`packages/mcp` の bin（`pnpm build` で `packages/mcp/dist/bin.js` ができる）。手順 6〜7 は、これを起動して行う（下の「MCP サーバーの起動」）。

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

   注意: `retentionDays: 0` は、**使い捨てのリポジトリ専用**。実際の記録では、既定（90 日）のままにする（0 だと、アーカイブの直後に最終削除できてしまう）。`autoPurge` を有効にする設定では、`retentionDays` を 7 未満にできない（起動に失敗する。`docs/auto-purge.md`）。`maxTurns`・`maxBudgetUsd` を省略すると、子ごとに 100 ターン・5 USD が上限になる（確認のときは、小さい値を設定してよい）。

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

## MCP サーバーの起動（手順 6・7 の前提）

起動の順序は **daemon → `cso-mcp` → 子**。子は、daemon が起動のときに渡す `mcpUrl`（設定の値）と、ノードのトークンで `cso-mcp` に接続する。

1. daemon を起動する（準備の 3）。窓口の URL（`$URL`）が出る。
2. `cso-mcp` を起動する。**`--config`（daemon と同じ設定ファイル）が必須**。設定の `mcpUrl` のポートで待ち受け（`--port` を足すときは、同じ値。違えば起動を拒否する）、設定の `stateDir`（絶対パス。相対なら拒否）の `daemon-identity` で、**トークンつきの要求の直前に毎回**、daemon の身元を検証する（`docs/daemon-identity.md`。偽の窓口には、トークンを送らない）。

   ```sh
   node packages/mcp/dist/bin.js --daemon-url "$URL" --config "$W/config.json"
   ```

   起動のときに、daemon に届くか確かめる（届かなければ失敗する）。`{"event":"listening","url":"http://127.0.0.1:7777/mcp"}` が標準出力に出る。`--config` があるときは、起動時の身元の検証に失敗すると、標準エラーに `identityCheckFailed` が出て、起動しない（身元の失敗は、1 秒・2 秒の 2 回確かめ直したあと終了コード 3、到達確認・一時的な失敗が尽きたときは 1。既定の強制〔`--strict-start`〕。`--no-strict-start` なら、起動は続き、最初のトークンつきの要求が `daemon_identity_failed` で失敗する）。
   `--config` なしで動かせるのは、環境変数 `CSO_MCP_ALLOW_UNVERIFIED=1`（ちょうど `1`）を付けたときだけ（`--port` が必要。検証なし。起動のログ `identityUnverified` を 1 回と、すべての応答のヘッダー `x-cso-identity: unverified` で分かる）。標準の手順では使わない。
3. 単体で確かめる（トークンのファイルは `$W/state/` にある）。

   ```sh
   # 子のトークンで、子のツールだけが見える
   curl -s -X POST http://127.0.0.1:7777/mcp -H "authorization: Bearer $(cat <子のトークンのファイル>)" \
     -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
     -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
   ```

   期待する結果:
   - 子のトークン: 子のロールの 5 ツール＋固定のメタツール `whoami`（T10m-wh。自分の nodeId・role を返す。合わせて 6 個。統合は 14 個＋ `whoami` で 15 個）（`report_progress`・`report_decision`・`report_outOfScope`・`report_done`・`scope_extend`）だけ（`ROLE_OPERATIONS.child` の件数。統合のツールは見えない）。
   - 統合のトークン（`$ROOT`）: 統合のロールのツール（`node_spawn`・`node_send`・`node_stop`・`inbox_fetch` など）。
   - 人間のトークン（`$HUMAN`）: 403（MCP では、人間用の操作を公開しない）。トークンなし・無効なトークンは 401。
4. 子に渡す MCP の設定は、daemon が組み立てる（`mcpServers.node = { type: "http", url: <mcpUrl>, headers: { Authorization: "Bearer <ノードのトークン>" } }`）。手で試すときは、この形で書く。`.mcp.json` に書くトークンは、使い捨てのリポジトリでだけにする。

受信箱の不備のログ（T24-m2）: `inbox_fetch` で、形が不正な項目を除外したとき（応答の `excluded` が 0 でないとき）、標準エラーに `{"event":"inboxExcluded","count":N,"problems":[{"itemId":"…","reason":"badKind"},…],"at":"…"}` を出す。`reason` は固定の記号（`notObject`・`badId`・`badSeq`・`badKind`・`badDependsOn`・`badRef`・`digestWithoutSummary`・`priorityMisplaced`・`badPriority`）で、`itemId` は識別子の形式のときだけ入る。項目の内容（summary・ref の値・nodeId）は出さない。応答（`excluded` の件数）は変わらない。受信箱は LLM のターンごとに読まれるので、**同じ不備（項目 ID と理由）は、`cso-mcp` のプロセスの間に 1 回だけ**出す（覚える数は 1000 まで。超えたら古いものから忘れ、忘れたものはまた 1 回出る）。**`cso-mcp` を再起動すると、覚えたものは消え、同じ不備がまた 1 回出る**。1 行に出すのは 20 件まで（超えたら `"truncated":true`）。

停止するときは、`cso-mcp` に SIGINT・SIGTERM を送る（処理中の呼び出しが終わるのを最大 8 秒待ってから止まる）。

## 確認する項目

| # | 操作 | 期待 | 確認すること |
|:--|:--|:--|:--|
| 1 | `req $ROOT node.spawn '{"parentId":"root","role":"implement","objective":"README.md に 1 行足す","acceptanceCriteria":["README.md が変わる"],"scope":{"writableLocations":["src"],"forbiddenLocations":[".git"],"allowedCommands":[]}}'` | `{"ok":true,"value":{"nodeId":"…","status":"running"}}`。`$W/worktrees/` に作業ツリー、`git branch` に `cso/…` | 子が起動する。`tree.list` で `running`。daemon のログ（標準エラー）に `unexpectedExit` が出ない |
| 2 | 子のセッションの init | セッション ID が記録される | init の `session_id` が、親（この確認を動かしている Claude）と**別**であること。`removed`（除いた環境変数の名前）に、`CLAUDE…SESSION…` が含まれる |
| 3 | フック: 子が `src/` の外（例: `README.md`）を書こうとする | 拒否される（`scope.violation` が受信箱に出る）。`src/` の中への書き込みは通る | **`permissionMode: "dontAsk"` のもとで、フックが `allow` を返したツールが、確認なしに実行される**こと（実行されなければ、`claude-launcher.ts` の権限の設定を見直す） |
| 4 | フックが許可するツール名 | `LS`・`TodoWrite`・`ToolSearch`・`BashOutput` などが拒否されない | 実際に使われたツール名を記録し、`hook-policy.ts` の許可の一覧と合わせる（足りなければ足す） |
| 5 | 追加指示: `req $ROOT node.send '{"nodeId":"<id>","text":"途中経過を 1 行で答えて"}'` | `{"status":"queued"}`。子が（実行中ならツール完了後に）応答する | 配送の記録（`node.instructionDelivered`）が出る |
| 6 | 子の報告（`cso-mcp` を起動して）: 子が `report_done` を呼ぶ（`mcp__node__report_done`） | `report.done` → 受信箱に `done`。init の MCP の状態が `connected` で、`mcp__node__*` のツールが見える | 完了報告の根拠が、受け入れ基準ごとに付く。子のトークンで統合のツール（`node_spawn` など）は見えない／呼べない |
| 7 | 判断（`cso-mcp` を起動して）: 子が `report_decision` を呼ぶ | 受信箱に判断要求 → `req $HUMAN decision.answer …` で回答 → 子が再開 | `pauseNodeIds` の子が止まり、回答で再開する |
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

## ファイルで設定するフック（T22-h。CLI のセッション）

前提: daemon が起動していて、範囲を持つ子（例: `writableLocations: ["src"]`）が daemon の管理下にある（受け口は、daemon が作業ツリーを知っているノードだけを判定する。ほかは拒否）。その子のトークン（bind で取得したもの）を使い、**その子の作業ツリーで**、plugin つきの CLI のセッションを起動する: `CSO_DAEMON_URL=<窓口の URL> CSO_NODE_TOKEN=<子のトークン> claude --plugin-dir <plugin のパス>`。トークンは、チャット・設定ファイルに書かない。

| # | 確認 | 期待 | 確認の方法 |
|:--|:--|:--|:--|
| H1 | フックが発火する | PreToolUse・PostToolUse・Stop で `cso-hook.mjs` が動く | `claude --debug` の出力に、フックの実行が出る。範囲内の `Write`（`src/a.txt`）は許可される |
| H2 | 範囲外の書き込みの拒否と記録 | `Write`（`b.txt`）が拒否され、理由がモデルに伝わる。`scope.violation` が記録され、親の受信箱に violation が 1 件載る | 子に `b.txt` を書くよう頼み、`cso inbox` と記録を見る。未知のツール（例: `WebFetch`）は `node.toolDenied` |
| H3 | `settingSources` の混入がない | daemon が SDK で起動する子（`settingSources: []`）には、利用者が入れた plugin のフックが混ざらない（受け口に、その子からの要求が来ない） | 子を SDK で起動し、受け口の記録（`hookSessionMismatch` が出ない、受け口への要求がない）を見る。H1 の CLI セッションを止めてから確かめる。**api のカウンタでも確かめる**: 窓口の件数のまとめ（daemon の記録の `apiSummary`。窓は 1 分）で、子のトークンの `/v1/hook` の要求が増えないこと、`authFailed`・`rateLimited` が増えないこと |
| H4 | daemon 停止のときのフェイルクローズ | daemon を止めると、PreToolUse はすべて拒否される（「届かない」）。Stop は止めない（セッションを終えられる） | daemon を止めて、`Read` と `Write` を頼む。ツールが実行されないこと |
| H5 | 環境変数 | 両方なし: 素通しし、標準エラーに一言出る（CSO のフックは働かない）。片方だけ: 拒否 | `CSO_NODE_TOKEN` だけを外して起動し、ツールが拒否されること |
| H6 | `session_id` の結び付け | 同じトークンで別のセッションを起動すると、403 で拒否される（`hookSessionMismatch`）。daemon を再起動すると、最初に来たセッションに結び直す | 2 つ目の CLI セッションを、同じ環境変数で起動する。同じセッションで `/clear`・`--resume` をして `session_id` が変わると拒否され、`cso hook-unbind <nodeId>`（または親の `node_hookUnbind`）のあと、新しいセッションが通ることも確かめる（記録に `node.hookUnbound` が残る） |

注: 本文の上限（1 MiB）を超えた要求の 413 は、daemon が本文を読まずに接続を閉じるため、スクリプトからは「届かない」扱いになることがある（どちらでも PreToolUse は拒否）。

Desktop の子への継承は、項目 4 の結果のあと（T22 の Desktop の分）。

## 結果の記録

実施するたびに、次の形で追記する（日付・SDK の版・CLI の版・OS・確認した項目と結果・見つかった問題）。

| 日付 | SDK / CLI | 環境 | 確認した項目 | 結果・問題 |
|:--|:--|:--|:--|:--|
| 2026-10-21 | 0.3.292 / 2.1.x（cloud 環境の `claude`） | Linux（Claude Code Remote）、Node 22.22 | 1, 2, 3（`src/` の外の拒否・`src/` の中は許可）, 5, 8, 9, 11, 12, 10（拒否のみ） | 下の「2026-10-21 の結果」 |
| 2026-10-22 | 0.3.292 / 2.1.292（cloud 環境の `claude`） | Linux（Claude Code Remote）、Node 22 | 6, 7（`cso-mcp` 経由） | 下の「2026-10-22 の結果」。6 は合格、7 は不合格（回答が子に届かない）→ T10b-a で修正し、再確認で合格 |
| 2026-10-22（再確認） | 0.3.292 / 2.1.292 | Linux（Claude Code Remote）、Node 22 | 7（T10b-a の後） | 合格。回答が子に届き、`src/b.txt`（YAML）が作られ、`report_done` で完了。下の「2026-10-22 の再確認」 |

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
実 SDK（0.3.292）で、子の `HOME` を空の 0700 のディレクトリに分けて、項目 16 をやり直した（2026-10-21）: 認証は通り（`ready`、約 7 秒で結果）、
`src/a.txt` への Write は許可されて書けた。範囲の外（`outside.txt`）への Write は、フックが拒否して書かれなかった。分けた HOME には、SDK が
`.claude`・`.claude.json` を作った（親の設定・資格情報は持ち込まれていない）。`NO_PROXY` に loopback が足されても、接続に影響はなかった。

### 2026-10-22 の結果（手順 6・7。`cso-mcp` 経由）

使い捨てのリポジトリで、daemon（窓口は自動のポート）→ `cso-mcp`（`--config` で 7777）→ 子の順に起動した。`maxTurns: 12`・`maxBudgetUsd: 1`。

| # | 結果 | 観測 |
|:--|:--|:--|
| 6 | 合格 | 子が `mcp__node__report_done` を呼び（`{"accepted":true}`）、受信箱に `done`（「完了報告（根拠 1 件）」）、ノードは `done`。根拠は受け入れ基準ごと（`criterion` と `evidence`）に付いた。子は `mcp__node__*` を ToolSearch で読み込んでから呼んだ（`ToolSearch` はフックが許可している）。`cso-mcp` の認証: トークンなし・無効は 401、人間のトークンは 403、統合のトークンは統合のツール 14 個（`node_spawn`・`node_send`・`node_stop`・`inbox_fetch` など）。子のトークンのツール一覧は、実 SDK の子に `ToolSearch`（`mcp__node__`）で列挙させて確認した: **5 ツールだけ**（当時。T10m-wh 以降は `whoami` が加わり、子 6・統合 15。`report_decision`・`report_done`・`report_outOfScope`・`report_progress`・`scope_extend`）で、統合のツールは見えない |
| 7 | **不合格** → T10b-a（2026-10-22）で修正し、再確認で**合格**（下の「2026-10-22 の再確認」） | 子が `report_decision` を呼び、受信箱に `decision`、ノードは `waiting`。`decision.answer`（人間のトークン、`choice: "YAML"`）は `accepted`、受信箱に `answer`、ノードは `running` に戻った。**ただし、回答の内容は子に届かない**: 子のセッションは「回答がないので何もしない」と述べて 1 ターンで終わっており、再開後に新しいターンが始まらない（約 75 秒待っても `src/b.txt` はできず、`node.instructionDelivered` もない）。`decision.answer` は状態を `running` にするだけで、回答を子へ配送する経路がない（子のロールには `decision.get` もない） |

見つかった問題（項目 7 → T10b-a で修正）: 判断の回答が子に届かないため、子が `report_decision` で待つ使い方が成立しない。回答を子へ配送するか（追加指示として送る等）、子に回答を読ませる経路が要る。

### 2026-10-22 の再確認（項目 7。T10b-a の後）

判断の回答を子へ届ける変更（T10b-a）の後、同じ手順で項目 7 をやり直した（実 SDK 0.3.292）: 子が `report_decision`（「JSON か YAML か」）を呼び、人間が `decision.answer`（`choice: "YAML"`）を送ると、受信箱に `answer` が出て、子が**回答を受け取って**新しいターンを始め、`src/b.txt`（`format: yaml`）を作り、`report_done` で完了を報告した（約 45 秒）。**合格**。

### 2026-10-23 の結果（T24-w。中間統合ノードを起こす。実 SDK 0.3.292）

設定 `wake: { enabled: true, intervalSec: 5, minIntervalSec: 10 }`・`maxTurns: 12`・`maxBudgetUsd: 1`・`digest.enabled: false`（`wake` は既定で無効なので、有効にした）。daemon → `cso-mcp`（`--config`）の順に起動し、根の下に統合ノード（中間統合ノード）を 1 つ立てた。

| 手順 | 結果 | 観測 |
|:--|:--|:--|
| 統合ノードが `node_spawn` で実装の子を 1 つ作り、「待機する」と言ってターンを終える | 合格 | 子の作成は、最初の 2 回は `parentId`（自分のノード ID）の取り違えで `forbidden` になったが、`tree_list` で自分の ID を調べて、3 回目に成功した（木の規則の検査が効いている。起こす機能とは無関係） |
| 子が `src/a.txt` を作り、`report_done` を出す | 合格 | 受信箱に `done`（「完了報告（根拠 1 件）」） |
| daemon が、統合ノードを起こす | 合格 | ログに `wake.woken`（1 回だけ）。統合ノードのセッションに、固定の 1 行（「受信箱に、配下の新しい項目が届いた。inbox_fetch で確かめて、必要な操作をしてください。」）が届き、**新しいターンが始まった** |
| 統合ノードが `inbox_fetch` を呼ぶ | 合格 | `mcp__node__inbox_fetch` を呼び、`done` の項目 1 件を読んで、1 行で述べて終えた |

起こした指示の本文は定数で、子の文字列・ID・件数を含まない。`node.instructed`（system）と配送の記録が残った。

#### 再確認（束ねる・`maxPerHour` を足したあと。2026-10-23）

#69 のレビュー対応（束ねる・全体の上限 `maxPerHour`）のあと、同じ手順を、`wake: { enabled: true, intervalSec: 5, minIntervalSec: 10, maxPerHour: 5 }`・`maxTurns: 12`・`maxBudgetUsd: 1` でもう一度行った（実 SDK 0.3.292）: 統合ノードが `tree_list` で自分の ID を調べて `node_spawn`（今回は、1 回で成功）→ 「待機する」→ 子が `report_done` → `wake.woken` が 1 回 → 統合ノードに固定の 1 行が届き、新しいターンで `inbox_fetch` を呼んだ。**合格**。束ねる・全体の上限は、実 SDK では確かめていない（自動テストで確かめた）。

### 2026-10-23 の結果（T10m-id。統合ノードが自分のノード ID を使えるか。実 SDK 0.3.292）

T24-w の確認（2026-10-23）で、統合ノードが、最初の 2 回、`node_spawn` の `parentId` に、切り詰めた ID（作業ツリーのディレクトリ名から推測したもの）を使って、`forbidden` になった。原因は、起動の指示にも、ツールの説明にも、自分の ID がなかったこと。
起動の指示の先頭に、自分のノード ID・role・親を書くようにしたあと（`maxTurns: 10`・`maxBudgetUsd: 1`）、同じ状況（統合ノードが、目的に ID の手がかりなしで「`node_spawn` で子を 1 つ作る」）をやり直した: 統合ノードの指示の先頭は「あなたのノード ID: node-399b…（role: integrator、親: root）」。**最初の `node_spawn` で、`parentId` に完全な ID を使い、成功した**（`{"nodeId":"node-c0f0…","status":"running"}`）。`tree_list` の `self` 列は、根の呼び出しで根の行に「あなた」が付いた。**合格**。

**注意（文脈の圧縮）**: 長く動くセッションで、文脈が圧縮されて、起動の指示（先頭の自分の ID）が失われることがある。そのときは、`tree_list` の `self` 列が「あなた」の行のほうが確実（根を含め、どのノードでも使える）。ツールの説明にも、そう書いてある。
