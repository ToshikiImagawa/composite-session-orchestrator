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
| T10b | daemon: Agent SDK `query()` による `AgentLauncher` の実バインディング（依存 `@anthropic-ai/claude-agent-sdk` のバージョン・ライセンス・Node 22/24 を確認、手動検証）。実機確認で固定する項目: (1) フックが許可するツール名（LS・TodoWrite・ToolSearch・BashOutput など）、(2) 子の環境変数の除去規則（識別子系のみ除去し `*_TOKEN*`・`*_TOKEN_FILE`・`*_URL` は残す、の調整）、(3) 子の予期しない終了（`AgentSession.finished()`）の扱い（T10c で `node.exited` を記録し `onUnexpectedExit` で通知する。状態遷移への反映は daemon の窓口で決める） | 一部あり（実 SDK での起動・停止の手動確認） | T10 | 未 | FR_005, FR_009, FR_010, IR_002 |
| T10c | core/daemon: 記録専用イベントの追加（`node.toolDenied`・`node.exited`・`report.added`、受信箱の `summary`・`ref`、`decision.get`・`report.get`、`node.purgePreview`・墓標の選択を含む）。`node.toolDenied{nodeId, tool}`（未知のツールの拒否。範囲違反ではなく受信箱に載せない）と `node.exited{nodeId, reason}`（子の予期しない終了。T10 は `onUnexpectedExit` で通知のみ）を core に足し、アダプタから記録する。T10b とは別の小タスクで、T10b より先に実施できる | なし | T10 | 完了（本 PR） | NFR_011, FR_009, FR_011, FR_012, FR_031 |
| T11 | mcp: ロール別ツール定義と公開一覧のテスト固定（NFR_004）。FR_012 の「次に取るべき操作の候補」を受信箱の応答へ添える部分もここで扱う | なし | T08 | 完了（本 PR） | FR_004, NFR_004, NFR_009, FR_012 |
| T12 | cli: 人間用コマンド（purge、回収の指示） | なし | T08 | 完了（本 PR）。purge の事前確認・墓標の選択・再実行（requestId）を含む。実行ファイルと HTTP クライアント、人間の認証の結線は daemon の窓口の実装後 | FR_029, FR_031, NFR_006 |
| T13 | daemon: 窓口（HTTP API・認証・読める範囲の判定）。ハンドラの実体（spawn・send・stop など）は別タスク | なし | T08, T10c | 完了（本 PR。入口・認証・認可〔部分木の規則・主体の検査〕・`decision.get`・`report.get` まで） | NFR_003, NFR_004, DC_003 |
| T13b | daemon: トークンの永続化（ハッシュ・ロール・nodeId・発行日時。人間のトークンは 0600 のファイル。子は再起動時に再発行）と、`node.bind` 専用の認証経路（紐付けコード。一度きり・短い有効期限） | あり（Desktop の紐付け手順は項目 4 で確定） | T13 | 完了（本 PR。子の紐付けは `POST /v1/bind`。Desktop 側の手順は T21） | NFR_002, NFR_004, FR_032 |
| T13c | core/mcp: 契約から `node.bind`（`OperationMap`・`ROLE_OPERATIONS` の子）を外す。紐付けは `POST /v1/bind` に移ったため。#23（core・mcp を変更中）の後に、別 PR で行う | なし | T13b, #23 | 未 | FR_032, NFR_004 |
| T13d | core: `decision.requested` に任意の `pauseNodeIds`（一時停止した子の記録。回答時に再開する）と、拡張要求のイベント `scope.extensionRequested{extensionId, nodeId, target, reason}`・`scope.extensionDecided{extensionId, decision}` を追加する（`scope.extend`・`scope.decide` の実体と、`decision.present` の `pauseNodeIds` に必要）。#23 のマージ後に、別の小さな PR で行う。担当は #23 の後に決める | なし | T10c, #23 | 未 | FR_015, FR_018, FR_019 |
| T14 | daemon: 窓口のハンドラ。②の後続（契約の変更〔実装 2〕の後に PR②b）: `node.send` の結果を `{ status: "queued" }` にする、追加指示の記録イベント `node.instructed` と requestId による冪等性、`node.stop` の `graceMs`。T10b の前提: アダプタが子を管理しているか（`has(nodeId)`）と、daemon の再起動時に `stopping` のまま残るノードの整合（再起動後の孤児。design 9.2）。暫定: `report.done` の根拠は 1 件以上必須（基準ごとの網羅の確認は、契約の拡張〔`node.created` に `acceptanceCriteria`。実装 2〕の後に PR②b で行う）。`node.review` の差し戻しの feedback も、契約の変更（実装 2）を待つ。`tree.list` の分割取得と、中間の統合ノードが親へ要約を報告する件は、T24 の前提。①イベントログだけで完結する操作（tree.list・inbox.fetch・report.*・decision.present・decision.answer・node.review）、②アダプタを伴う操作（node.spawn・send・stop・split・capabilities）、③回収・削除（reclaimPreview・reclaim・reclaimInstruct・purge・purgePreview）。`pauseNodeIds` の再開と `scope.extend`・`scope.decide` は、core の記録イベントが要る（T13d） | なし | T13, T13b, T13d（pauseNodeIds・scope.* のみ） | ①完了（#25）、②`node.send`・`node.stop`・`node.capabilities` 完了（#26。停止の結果の受信箱への反映・capabilities の絞り込みを含む）、`node.spawn`・`node.split` は契約（Brief）の拡張後〔PR②b〕、③`node.reclaimPreview`・`node.reclaim` 完了（回収の判定・実行。`node.reclaimInstruct`〔破棄の判断。core の `node.discardDecided`＝T13e 待ち〕・`purge`・`purgePreview`〔T13f 待ち〕は notSupported）| FR_005, FR_009〜FR_012, FR_018, FR_019, FR_024, FR_029, FR_031 |
| T13e | core: 破棄の判断の記録（`node.discardDecided{nodeId, actor}` イベント。fold で `NodeRecord.discarded` を保持し、回収の再判定でも使う）。完了後に daemon の `node.reclaimInstruct` と、停止したノードの回収の `discarded` を実装する（実装 2。#27 のマージ後） | なし | T13 | 未 | FR_026 |
| T13f | 設計: 最終削除（`node.purge`・`node.purgePreview`）。`NodeRecord.archivedAt`（木全体のアーカイブ日）の記録と、イベントログの最終削除の経路（追記専用ログと墓標の扱い。#21 の `purgePreview` の型・墓標の既定は使える見込み）。設計後に daemon のハンドラを実装する | なし | T13e | 未 | FR_031 |
| T23 | daemon: HTML 画面、SSE による反映 | なし（能力表の表示値のみ確定待ちだが、画面の骨格は先行可能のためこちらに配置） | T09 | 未 | FR_021, IR_003, NFR_008 |
| T24 | core/daemon: 中間統合ノードの配下の要約報告（上位の受信箱へ優先度付きで送る） | なし | T04, T07 | 未 | FR_013 |
| T25 | mcp: MCP 境界の入力検証（zod）。ツール入力と daemon からの応答の形を検査する。依存追加は着手時点の最新版を確認して固定する。**daemon への結線の前提** | なし | T11 | 未 | NFR_010, NFR_004 |

## 手動確認の結果に依存（仮置きで進め、結果で確定）

| ID | タスク | 手動確認依存 | 依存 | 状態 | 対応要求 |
|:--|:--|:--|:--|:--|:--|
| T20 | daemon: `desktop` ランタイムアダプタ（能力表は保守的な値 `unverified`/`unreliable`。`stop` は代行依頼を受信箱へ） | あり（項目 1〜7 で能力表を確定） | T08, T09 | 未 | FR_032, FR_034, FR_036 |
| T21 | Desktop の子の紐付け手順（暫定は初回メッセージ後） | あり（項目 4） | T20 | 未 | FR_032 |
| T22 | plugin: フック設定・skill・起動コマンド（Desktop の子へのフック継承部分） | 一部あり（フック継承は未確認） | T10, T20 | 未 | IR_001, IR_002, NFR_012 |

## 実装前に決める未解決事項（設計 9.2 より）

- `stopping`→`stopIncomplete` の所定の時間、再試行方式（自動か手動か）（T05 の前提。遷移自体と停止要求を受け付ける元状態は design 9.1 で確定済み）
- 木あたりの同時実行数と費用の上限
- バックグラウンド起動（`&`、`nohup`、`setsid` など）の扱い（T06 は既定で拒否として実装。ADR で確定する）
- 停止後に残るプロセス・`lsof` の OS 差の検証（T10 の前提）
