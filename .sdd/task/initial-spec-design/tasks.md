---
id: "tasks-initial-spec-design"
title: "Composite セッション・オーケストレーター タスク分解"
type: "tasks"
status: "draft"
sdd-phase: "tasks"
sdd-version: "5.1.0"
created: "2026-10-20"
updated: "2026-10-20"
depends-on: ["design-initial-spec-design"]
---

# タスク分解

**関連 Design:** [design-draft.md](./design-draft.md)
**関連 Spec:** [composite-session-orchestrator_spec.md](../../specification/composite-session-orchestrator_spec.md)

> 一時ドラフト。実装完了後に削除する（AI-SDD）。テストは先に書く（憲法 D-001: Test-First）。型安全性は憲法 T-001。

**手動確認依存:** Desktop の手動確認（docs/spikes/01 の項目 1〜7）の結果に依存するか。「なし」を先行可能とする。「あり」は仮置きで進め、結果で確定する。

## 先行可能（手動確認に依存しない）

| ID | タスク | 手動確認依存 | 依存 | 状態 | 対応要求 |
|:--|:--|:--|:--|:--|:--|
| T01 | core: `NodeStatus`/`Priority` を spec の `NodeState`/`InboxKind` に整合（名称統一、`stopping`/`stopIncomplete` 追加、`InboxKind`→`Priority` 対応） | なし | - | 完了（本 PR） | FR_012, FR_026, FR_010 |
| T02 | core: 木の構造と親子の不変条件（純粋関数、fast-check） | なし | T01 | 完了（本 PR） | FR_001, FR_002, FR_028, NFR_007 |
| T03 | core: 状態遷移（停止要求を受け付ける元状態は design 9.1 で確定） | なし | T01 | 完了（本 PR） | FR_010, FR_018, FR_024 |
| T04 | core: 受信箱の整列（優先度・依存関係・時刻、決定的） | なし | T01 | 完了（本 PR） | FR_012, NFR_007 |
| T05 | core: 回収可能判定（条件 1〜6、プロセス一覧を入力にとる純粋関数） | なし | T03 | 完了（本 PR） | FR_026, FR_027, FR_028, NFR_007 |
| T06 | core: 範囲違反の判定（作業範囲と操作を入力にする純粋関数） | なし | T01 | 完了（本 PR） | FR_014, FR_015, IR_002 |
| T07 | core: イベント型（`OrchEvent`）と畳み込みによる状態導出、`requestId` の冪等性 | なし | T02, T03 | 完了（本 PR） | NFR_002, NFR_003, NFR_011 |
| T08 | core: daemon 窓口の契約型、Result 型（原因と次の操作） | なし | T01 | 完了（本 PR） | NFR_003, NFR_004, NFR_010 |
| T09 | daemon: イベントログ（SQLite）と復元。ドライバは着手時点の最新版を確認して決定 | なし | T07 | 完了（本 PR） | NFR_002, NFR_011 |
| T10 | daemon: `sdk` ランタイムアダプタ（CLI の子の起動・指示・2 段階停止・フック） | なし（Spike 02 で確認済み。プロセス確認の OS 差は実装前に検証） | T05, T06, T08, T09 | 完了（本 PR） | FR_005, FR_009, FR_010, FR_033, IR_002 |
| T10b | （①組み立てと起動は完了〔`createDaemon`・`config`・`cso-daemon`〕。②実ポート＝T10b-r、③起動時の整合〔`reconcileOnStartup`・`createDaemon` への配線（T10b-w）まで完了〕、④Agent SDK の実バインディング〔ライセンス確認済み（ユーザー承認）。`@anthropic-ai/claude-agent-sdk` 0.3.292（2026-10-06 公開）を固定で追加。`claude-launcher.ts`（`launcherWith`・`createClaudeLauncher`）と手動確認の手順書（`docs/manual-verification-sdk.md`）は済。実 SDK での手動確認は未実施〕が残り）daemon: Agent SDK `query()` による `AgentLauncher` の実バインディング（依存 `@anthropic-ai/claude-agent-sdk` のバージョン・ライセンス・Node 22/24 を確認、手動検証）。実機確認で固定する項目: (1) フックが許可するツール名（LS・TodoWrite・ToolSearch・BashOutput など）、(2) 子の環境変数の除去規則（識別子系のみ除去し `*_TOKEN*`・`*_TOKEN_FILE`・`*_URL` は残す、の調整）、(3) 子の予期しない終了（`AgentSession.finished()`）の扱い（T10c で `node.exited` を記録し `onUnexpectedExit` で通知する。状態遷移への反映は daemon の窓口で決める） | 一部あり（実 SDK での起動・停止の手動確認） | T10 | 未 | FR_005, FR_009, FR_010, IR_002 |
| T10c | core/daemon: 記録専用イベントの追加（`node.toolDenied`・`node.exited`・`report.added`、受信箱の `summary`・`ref`、`decision.get`・`report.get`、`node.purgePreview`・墓標の選択を含む）。`node.toolDenied{nodeId, tool}`（未知のツールの拒否。範囲違反ではなく受信箱に載せない）と `node.exited{nodeId, reason}`（子の予期しない終了。T10 は `onUnexpectedExit` で通知のみ）を core に足し、アダプタから記録する。T10b とは別の小タスクで、T10b より先に実施できる | なし | T10 | 完了（本 PR） | NFR_011, FR_009, FR_011, FR_012, FR_031 |
| T11 | mcp: ロール別ツール定義と公開一覧のテスト固定（NFR_004）。FR_012 の「次に取るべき操作の候補」を受信箱の応答へ添える部分もここで扱う | なし | T08 | 完了（本 PR） | FR_004, NFR_004, NFR_009, FR_012 |
| T12 | cli: 人間用コマンド（purge、回収の指示） | なし | T08 | 完了（本 PR）。purge の事前確認・墓標の選択・再実行（requestId）を含む。実行ファイルと HTTP クライアント、人間の認証の結線は daemon の窓口の実装後 | FR_029, FR_031, NFR_006 |
| T13 | daemon: 窓口（HTTP API・認証・読める範囲の判定）。ハンドラの実体（spawn・send・stop など）は別タスク | なし | T08, T10c | 完了（本 PR。入口・認証・認可〔部分木の規則・主体の検査〕・`decision.get`・`report.get` まで） | NFR_003, NFR_004, DC_003 |
| T13b | daemon: トークンの永続化（ハッシュ・ロール・nodeId・発行日時。人間のトークンは 0600 のファイル。子は再起動時に再発行）と、`node.bind` 専用の認証経路（紐付けコード。一度きり・短い有効期限） | あり（Desktop の紐付け手順は項目 4 で確定） | T13 | 完了（本 PR。子の紐付けは `POST /v1/bind`。Desktop 側の手順は T21） | NFR_002, NFR_004, FR_032 |
| T13c | core/mcp: 契約から `node.bind`（`OperationMap`・`ROLE_OPERATIONS` の子）を外す。紐付けは `POST /v1/bind` に移ったため。#23（core・mcp を変更中）の後に、別 PR で行う | なし | T13b, #23 | 完了（本 PR） | FR_032, NFR_004 |
| T13d | core/mcp/daemon（validate のみ）: 契約の追加。`node.spawn`・`node.split` をブリーフ（spec 5.2）にし、`node.created` に `objective`・`acceptanceCriteria`・`scope` を保持、`node.review` に `feedback`、`decision.requested` に `pauseNodeIds`、`scope.extensionRequested`・`scope.extensionDecided` とその fold。拡張要求の対象の構造化（`{ kind: write | command, value }`）と、承認の `granted`・有効な範囲 `effectiveScope`、未判定の要求のノードごとの上限（10 件）、`node.instructed`、`node.send` の結果（`{ status: "queued" }`）、`node.stop` の `graceMs`。ハンドラの実体（spawn・split など）は別タスク | なし | T13c | 完了（本 PR） | FR_005, FR_015, FR_016, FR_018, FR_022, FR_024 |
| T13e | core（契約・fold）/mcp/daemon（型と認可の追従のみ）: `node.discardDecided`・`NodeRecord.discarded`・`archivedAt`・`discardedNodeIds`、`markReclaimable` の `discarded` を記録から判定、`node.instructionDelivered`（指示ごとの配送済み）、`REPORT_KINDS` に `review`、完了報告の根拠の空白だけを拒否、`violation` の `ref` から拡張要求を指す、`scope.decide` を人間と統合（発生元が部分木）に開放、`node.send`・`node.spawn`・`node.reclaimPreview` の結果の形、ブリーフの絶対パスの拒否（範囲の場所は、作業ツリー〔cwd〕を基準にした相対パスだけを使う前提。`isScopeSubset` も同じ前提で、絶対パスが混じる範囲は収まらないとする）、`node.spawn` のハンドラの結果の組み立て（`status`・`waitingFor`）、`inbox.resolved`（受信箱の項目を解決済みにする。`inbox.fetch` は解決済みを返さない）、`node.send` の記録・配送・`duplicate`、`scope.decide` の人間の扱い、完了報告の `criterion` の空白の拒否。daemon のハンドラの実体（結果の組み立て・認可の適用の続き）は実装 3 | なし | T13d | 完了（本 PR） | FR_015, FR_022, FR_024, FR_026, FR_028, NFR_004, NFR_011 |
| T13f | 最終削除（`node.purge`・`node.purgePreview`）。設計は承認済み（統括）。core: `planPurge`・`purgeEventSeqs`（`purge.ts`）・`node.purged`（標識。fold・`OrchState.tombstones`。墓標を残さないときも標識は残る）。daemon: `EventStore.purgeRows`（トリガーの付け外しと復旧の確認〔`StoreIntegrityError`〕）・`EventLog.purgeTree`（残りのログの再畳み込みの検証・標識の追記・fail closed。`STATE_VERSION` 7）・`createPurgeHandlers`（人間のみ・保持期間・墓標・監査・トークン失効）・設定（`retentionDays`・`purgeTombstone`）・`createDaemon` への配線（`onFatal` → `cso-daemon` が止まる）。実 HTTP の結合テストあり | あり | T13e | 済 | FR_031 |
| T13g | daemon（実装 3）: 判断待ちからの再開（`pauseNodeIds` の再開）で、破棄の判断を経た（`discarded`）ノードを再開の対象から外す | なし | T13e | 未 | FR_018, FR_028 |
| T14 | daemon: 窓口のハンドラ。②の後続（契約の変更〔実装 2〕の後に PR②b）: `node.send` の結果を `{ status: "queued" }` にする、追加指示の記録イベント `node.instructed` と requestId による冪等性、`node.stop` の `graceMs`。T10b の前提: アダプタが子を管理しているか（`has(nodeId)`）と、daemon の再起動時に `stopping` のまま残るノードの整合（再起動後の孤児。design 9.2）。暫定: `report.done` の根拠は 1 件以上必須（基準ごとの網羅の確認は、契約の拡張〔`node.created` に `acceptanceCriteria`。実装 2〕の後に PR②b で行う）。`node.review` の差し戻しの feedback も、契約の変更（実装 2）を待つ。`tree.list` の分割取得と、中間の統合ノードが親へ要約を報告する件は、T24 の前提。①イベントログだけで完結する操作（tree.list・inbox.fetch・report.*・decision.present・decision.answer・node.review）、②アダプタを伴う操作（node.spawn・send・stop・split・capabilities）、③回収・削除（reclaimPreview・reclaim・reclaimInstruct・purge・purgePreview）。**②c-1（#31）**: `pauseNodeIds` の止める・再開（`createPauseHandlers`）。人間が止めた子は再開しない。`createHandlers` への配線は #30〔spawn〕のマージ後。`scope.extend`・`scope.decide` は②c-2（#32。`createScopeHandlers`。`createHandlers` への配線〔pause・scope・spawn で `cwdOf`・`rootScope` を共有〕も #32 に含める） **契約の変更（#27）の反映**: `node.spawn`・`node.split` のハンドラは、子の範囲を `isScopeSubset(child, parent, cwds)` で検査し（親の範囲に収まらなければ拒否）、作業ツリー（cwd）の確定後に `validateScope(scope, cwd)` を必ず行う（`briefProblem` は形・重複・`..`・`/` だけで、パスの中身は保証しない）。`node.review` の accept の `feedback` は `report.added`（kind: `review`）として記録する。範囲の拡張の承認（`scope.extensionDecided` の `granted`）を受けたら、`effectiveScope` を導いてアダプタの `updateScope` を呼ぶ（契機は `scope.extensionDecided`）。 | なし | T13, T13b, T13d（pauseNodeIds・scope.* のみ） | ①完了（#25）、②`node.send`・`node.stop`・`node.capabilities` 完了（#26。停止の結果の受信箱への反映・capabilities の絞り込みを含む）、`node.spawn`・`node.split` 完了（PR②b-2。ブリーフ・範囲の検査〔相対パスのみ。根の範囲は daemon の設定の `rootScope`。daemon の設定の読み込みと `rootScope` の配線は組み立て側の別タスク〕・トークン発行・後始末。**未**: 依存の完了時に pending の子を起動するスケジューラ〔作業ツリー・範囲は spawn で検査済み。トークン発行と start は未〕、応答に pending と待っている `dependsOn` を出す〔core の結果型の変更〕、`worktreePath` を `NodeRecord` に記録する案〔再起動時の整合 T10b とまとめて検討〕、「start を記録したがプロセスがない」ノードの再起動時の整合）、③`node.reclaimPreview`・`node.reclaim` 完了（#28。`reclaimPreview` の結果を `{ reclaimable, unmet, blockers }` の構造にする件は、core の契約変更〔実装 2 の T13e〕のマージ後に追従する。それまでは不可を `notReclaimable` の失敗で返す）。`node.reclaimInstruct`〔破棄の判断。core の `node.discardDecided`＝T13e 待ち〕・`purge`・`purgePreview`〔T13f 待ち〕は notSupported | FR_005, FR_009〜FR_012, FR_018, FR_019, FR_024, FR_029, FR_031 |
| T10b-r | daemon（T10b の前提）: 回収の実ポート（`ReclaimPorts`）。`git worktree remove` は `--force` なし、ブランチは `-d`（`-D` は使わない）、`expectedPath` の照合。実ポートが強制削除をしないことを確かめるテスト（`--force` なし・ブランチは `-d`・`expectedPath` の不一致で何も消さない）を書き、**このテストが通ることを T10b-r の完了条件にする**。手動の回収の途中で失敗して `reclaimable` のまま残ったノードを、通常の回収可能（判定済み・未実行）と区別して扱う（FR_030） | なし | T14 ③ | 完了（`createGitPorts`。ポート契約のテストは実際の git で確認）。`cso-daemon` への配線〔`bin` が `createGitPorts` の結果を取り出す〕は、組み立て（T10b ①）のマージ後 | FR_026, FR_030 |
| T10b-w | daemon（T10b ③ の追従）: `createDaemon` で、根を用意した後で、待ち受けを始める前に `reconcileOnStartup` を呼ぶ（`worktreeRoot`・`cwdOf`・`probe`・`has` を渡す）。#37 に含めて完了 | あり（`compose.test.ts`） | T10b ①, T10b ③ | 済 | FR_010, NFR_003 |
| T10s | daemon: スケジューラ（依存が揃った pending の子の起動）。`createSpawner` の `tick`（`startPending`）。契機は、`report.done`・`node.review` の成功後と、daemon の起動時（待ち受けの後）。起動は spawn と共通の経路（`startGuarded`）で、ノード単位の排他により二重に起動しない。起動の入力は記録したブリーフから作る。失敗は spawn と同じ後始末をして、受信箱（`failure`）に残し、再試行しない。破棄された（アーカイブ済みの）依存先は完了とみなさず、依存する子（連鎖を含む）について、受信箱に失敗を 1 度だけ出す（`node.stop` で取り消すか、別の依存先で作り直す）。破棄済みの依存先を指定した spawn は `dependencyDiscarded` で失敗させ、`tree.list` は `(破棄済み)` と示す。`decision.answer` の成功後にも `tick`。同時に起動する数の上限（親ごと・全体。設定の `startLimits`。既定 4）。起動できない事情は、最初の 1 度だけ受信箱に出す。停止時は実行中の `tick` を待つ（`close`）。起動の記録の行為者は system | あり（`scheduler.test.ts`・`create-handlers.test.ts`・`compose.test.ts`） | T10b | 済 | FR_001, FR_005 |
| T10b-d | 前提（T21）: Desktop の子は、アダプタが管理しないので、起動時の整合（`reconcileOnStartup`）の対象から外す（Desktop の子のプロセスは、daemon が持たない）。T21 で、Desktop の子の整合の方針を決める | なし | T21 | 未 | FR_036 |
| T10m | （②窓口の `GET /v1/whoami`〔認証したロールだけを返す〕は済。残りは MCP サーバーの起動口）mcp: MCP サーバーの起動口（待ち受けるプロセスと、`cso-mcp` の bin）。いまの `packages/mcp` はツールの定義と入力の検証だけで、`mcpUrl` に待ち受けるものがない。子は `mcp__node__*`（`report.*`・`scope.extend`）に接続できず、手動確認（`docs/manual-verification-sdk.md` の 6・7）が行えない。daemon の窓口へ結線する（T25 の入力検証を使う） | あり | T25, T10b | 未 | IR_001, NFR_004, NFR_005 |
| T10r2 | daemon（T10b-r の追従。実 SDK の確認で発覚）: 破棄の判断（`node.discardDecided`）を経た停止ノードの回収で、作業ツリーを強制して消す（`git worktree remove --force`。未追跡のファイルがあると、いまは `removeFailed` で回収できない）。ブランチの削除（`-d` → 未統合なら `-D`）も、同じ判断のあるときだけ。仕様 5.8 の「強制的な削除は破棄判断を経た停止ノードに限る」に合わせる。ポートの契約（`ReclaimPorts.removeWorktree` に `force`）と、`createGitPorts` の変更。設計の判断が要る（安全側の原則との整理） | あり | T10b-r, T13e | 未 | FR_026, FR_028, NFR_006 |
| T10v | daemon（実 SDK の確認で発覚）: 範囲違反（`scope.violation`）を、親の受信箱に出す（`inbox.added` の `violation` の項目。同じ子・同じ対象は、まとめるか上限を設ける）。いまはログに記録されるだけで、`inbox.fetch` に出ない | あり | T10 | 未 | FR_014, NFR_011 |
| T10e | daemon（実 SDK の確認で発覚。T10v・T10c の PR に含める）: 子の環境変数を、許可リスト方式にする。既定は `PATH`・`HOME`・`LANG`・`TMPDIR` と、SDK の認証に必要な変数。daemon の設定で追加できる。いまの `child-env.ts` は、セッション識別子だけを除くので、`GH_TOKEN` などの秘密も子に渡る | あり | T10b | 未 | NFR_005, NFR_011 |
| T10x | 設定（2026-10-29 以降）: `pnpm-workspace.yaml` の `minimumReleaseAgeExclude`（vitest・vite・rolldown などの、既存の開発用ツールの版指定の除外）を削除する。公開から 14 日をすぎるので、除外なしでも `pnpm install` が通ることを確かめる | なし | #42 | 未 | NFR_010 |
| T13e | core: 破棄の判断の記録（`node.discardDecided{nodeId, actor}` イベント。fold で `NodeRecord.discarded` を保持し、回収の再判定でも使う）。完了後に daemon の `node.reclaimInstruct` と、停止したノードの回収の `discarded` を実装する（実装 2。#27 のマージ後） | なし | T13 | 未 | FR_026 |
| T13f | 最終削除（`node.purge`・`node.purgePreview`）。設計は承認済み（統括）。core: `planPurge`・`purgeEventSeqs`（`purge.ts`。済）。daemon: `EventStore.purgeRows`（トリガーの付け外しと復旧の確認〔`StoreIntegrityError`〕。済）・`EventLog.purgeTree`（残りのログの再畳み込みの検証・標識の追記・fail closed。済）・`createPurgeHandlers`（人間のみ・保持期間・墓標・監査・トークン失効。済）・設定（`retentionDays`・`purgeTombstone`。済）。残り: core の `node.purged`（fold・`OrchState.tombstones`・STATE_VERSION。T26 のマージ後に最小の差分で）と、`createDaemon` への配線（標識の組み立て・`onFatal` で daemon を止める） | あり | T13e | 一部済 | FR_031 |
| T13f-c | core/daemon（T13f の第 2 段階）: 最終コミットの記録。回収のときに `node.lastCommit`（記録のみ）を記録し（`WorktreeFacts` に headCommit を足す）、墓標の `lastCommit` に載せる | あり | T13f | 未 | FR_031 |
| T13f-a | daemon（T13f の別タスク）: 保持ポリシーによる自動の最終削除。取り返しがつかないので、既定はオフの設定（`autoPurge`）。人間用コマンドと同じ経路・同じ検査を通す | あり | T13f | 未 | FR_031 |
| T13f-p | core（T13f の別タスク）: `decision.requested` の `pauseNodeIds` に、最終削除で消えたノードが残っていても畳み込めるようにする（今は、木の外の祖先の判断要求が止める対象にしていると、`purgeUnsafe` で最終削除が拒否される）。fold の検証の変更なので、実装 2 と調整する | あり | T13f | 未 | FR_031 |
| T14d | daemon（T13e の後）: 失敗した spawn・split の後始末のあと、作業ツリーを消せたら、システムによる破棄の判断（`node.discardDecided`）→ `markReclaimable{discarded}` → `archive` まで自動で進める。消せなかったら停止のまま残す | なし | T13e, T14 | 完了（T13e 追従 PR） | FR_026 |
| T23 | daemon: HTML 画面、SSE による反映 | なし（能力表の表示値のみ確定待ちだが、画面の骨格は先行可能のためこちらに配置） | T09 | 未 | FR_021, IR_003, NFR_008 |
| T24 | core/daemon: 中間統合ノードの配下の要約報告（上位の受信箱へ優先度付きで送る） | なし | T04, T07 | 未 | FR_013 |
| T25 | mcp: MCP 境界の入力検証（zod）。ツール入力と daemon からの応答の形を検査する。依存追加は着手時点の最新版を確認して固定する。**daemon への結線の前提**（ツール入力を zod 4.6.5 で検証。`parseToolInput`。daemon 応答の検査は結線時） | なし | T11 | 済 | NFR_010, NFR_004 |
| T26 | core/daemon: 未回答の判断（`decision.requested` の open）にも、ノードごとの上限を設ける（拡張要求の未判定の上限〔10 件〕と同じ考え方。上限は 10 件（`LIMITS.openDecisionsPerNode`）、超えたら `tooManyOpenDecisions`。受信箱の未解決の件数には上限を設けない〔項目は daemon・core が生成し、上限で落とすと信号を失うため。子が入れる分は判断・拡張・報告の各上限で抑える〕） | なし | T13d | 済 | FR_018, NFR_011 |
| T27 | core/daemon: 子が入れる報告（`report.added`）の件数とレート制限。1 件あたりの長さは `LIMITS` で抑えているが、件数・頻度の上限は未定（T26 のレビューで起票。受信箱の未解決の件数にノードごとの上限を設けない代わりの対策として検討する。**core の fold で、`progress`・`outOfScope` の件数をノードごとに `LIMITS.reportsPerNode`〔200 件〕まで〔直近の start・restart より後だけを数える。超えたら `tooManyReports`〕。レート〔頻度〕は daemon の窓口の将来課題**） | なし | T13d | 済（件数のみ） | NFR_011 |

## 手動確認の結果に依存（仮置きで進め、結果で確定）

| ID | タスク | 手動確認依存 | 依存 | 状態 | 対応要求 |
|:--|:--|:--|:--|:--|:--|
| T20 | daemon: `desktop` ランタイムアダプタ（能力表は保守的な値 `unverified`/`unreliable`。`stop` は代行依頼を受信箱へ） | あり（項目 1〜7 で能力表を確定） | T08, T09 | 未 | FR_032, FR_034, FR_036 |
| T21 | Desktop の子の紐付け手順（暫定は初回メッセージ後） | あり（項目 4） | T20 | 未 ※ Desktop の子が紐付けの入口（`POST /v1/bind`）を呼ぶ手段（`curl` など）を実行できるかも、ここで確かめる | FR_032 |
| T22 | plugin: フック設定・skill・起動コマンド（Desktop の子へのフック継承部分） | 一部あり（フック継承は未確認） | T10, T20 | 未 | IR_001, IR_002, NFR_012 |

## 実装前に決める未解決事項（設計 9.2 より）

- `stopping`→`stopIncomplete` の所定の時間、再試行方式（自動か手動か）（T05 の前提。遷移自体と停止要求を受け付ける元状態は design 9.1 で確定済み）
- 木あたりの同時実行数と費用の上限
- バックグラウンド起動（`&`、`nohup`、`setsid` など）の扱い（T06 は既定で拒否として実装。ADR で確定する）
- 停止後に残るプロセス・`lsof` の OS 差の検証（T10 の前提）
