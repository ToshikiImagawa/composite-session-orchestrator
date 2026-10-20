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

> 一時ドラフト。実装完了後に削除する（AI-SDD）。テストは先に書く（憲法 T-001 / 設計 D-001）。

**手動確認依存:** Desktop の手動確認（docs/spikes/01 の項目 1〜7）の結果に依存するか。「なし」を先行可能とする。「あり」は仮置きで進め、結果で確定する。

## 先行可能（手動確認に依存しない）

| ID | タスク | 手動確認依存 | 依存 | 状態 |
|:--|:--|:--|:--|:--|
| T01 | core: `NodeStatus`/`Priority` を spec の `NodeState`/`InboxKind` に整合（名称統一、`stopping`/`stopIncomplete` 追加、`InboxKind`→`Priority` 対応） | なし | - | 着手（本 PR） |
| T02 | core: 木の構造と親子の不変条件（純粋関数、fast-check） | なし | T01 | 未 |
| T03 | core: 状態遷移（停止要求の元状態の受け付け可否は設計の未解決事項。決定後に確定） | なし（元状態の方針は要決定） | T01 | 未 |
| T04 | core: 受信箱の整列（優先度・依存関係・時刻、決定的） | なし | T01 | 未 |
| T05 | core: 回収可能判定（条件 1〜6、プロセス一覧を入力にとる純粋関数） | なし | T03 | 未 |
| T06 | core: 範囲違反の判定（作業範囲と操作を入力にする純粋関数） | なし | T01 | 未 |
| T07 | core: イベント型（`OrchEvent`）と畳み込みによる状態導出、`requestId` の冪等性 | なし | T02, T03 | 未 |
| T08 | core: daemon 窓口の契約型、Result 型（原因と次の操作） | なし | T01 | 未 |
| T09 | daemon: イベントログ（SQLite）と復元。ドライバは着手時点の最新版を確認して決定 | なし | T07 | 未 |
| T10 | daemon: `sdk` ランタイムアダプタ（CLI の子の起動・指示・2 段階停止・フック） | なし（Spike 02 で確認済み。プロセス確認の OS 差は実装前に検証） | T05, T06, T08, T09 | 未 |
| T11 | mcp: ロール別ツール定義と公開一覧のテスト固定（NFR_004） | なし | T08 | 未 |
| T12 | cli: 人間用コマンド（purge、回収の指示） | なし | T08 | 未 |

## 手動確認の結果に依存（仮置きで進め、結果で確定）

| ID | タスク | 手動確認依存 | 依存 | 状態 |
|:--|:--|:--|:--|:--|
| T20 | daemon: `desktop` ランタイムアダプタ（能力表は保守的な値 `unverified`/`unreliable`。`stop` は代行依頼を受信箱へ） | あり（項目 1〜7 で能力表を確定） | T08, T09 | 未 |
| T21 | Desktop の子の紐付け手順（暫定は初回メッセージ後） | あり（項目 4） | T20 | 未 |
| T22 | plugin: フック設定・skill・起動コマンド（Desktop の子へのフック継承部分） | 一部あり（フック継承は未確認） | T10, T20 | 未 |
| T23 | daemon: HTML 画面、SSE による反映 | なし（表示する能力表の値のみ確定待ち） | T09 | 未 |

## 実装前に決める未解決事項（設計 9.2 より）

- `stopping`→`stopIncomplete` の所定の時間、再試行方式、復帰操作、停止要求を受け付ける元状態（T03, T05 の前提）
- `mcp`/`cli`→daemon の契約の型を置く場所（`core` に置く案で着手し ADR に残す）
- 木あたりの同時実行数と費用の上限
- 停止後に残るプロセス・`lsof` の OS 差の検証（T10 の前提）
