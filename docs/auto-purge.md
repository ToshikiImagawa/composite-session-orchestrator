# 自動の最終削除（`autoPurge`）

daemon の設定ファイルの `autoPurge` で、保持期間を過ぎた木を自動的に最終削除できる。**既定はオフ**（省略するとオフ）。

## 有効にすると何が起こるか

**保持期間（`retentionDays`。既定 90 日）を過ぎた、アーカイブ済みの最上位の木が、取り返しのつかない形で消える。**
木のノードに関するイベントの行（本文を含む）が、ログのファイルから物理的に削除される（`secure_delete`・`wal_checkpoint`）。
バックアップ・OS のコピーには残りうる。墓標（タイトル・結果・最終コミットの SHA・日付）は、`purgeTombstone`（既定は残す）に従って標識に残る。
最終コミットの SHA は、成果の保管ではなく、取り戻すための手がかりにすぎない（git が掃除するまでの間だけ、`git branch <名前> <SHA>` で戻せることがある）。

人間のコマンド（`cso purge`）と同じ関数・同じ検査を通る（最上位の木・木全体がアーカイブ済み・木の外から依存されていない・保持期間・
残りのログを畳み込めること）。違いは、操作の主体が `system` で、監査の記録に `origin: "auto"` が付くことだけ。

## 設定

```json
{
  "retentionDays": 90,
  "purgeTombstone": true,
  "autoPurge": { "enabled": true, "intervalMinutes": 60, "maxTreesPerRun": 5 }
}
```

| 項目 | 意味 | 既定 |
| --- | --- | --- |
| `enabled` | 自動の最終削除を有効にする（必須） | （`autoPurge` ごと省略するとオフ） |
| `intervalMinutes` | 実行の周期（分。1〜1440） | 60 |
| `maxTreesPerRun` | 1 回の実行で消す木の数の上限（1〜100）。アーカイブが古い順 | 5 |

- 最初の実行は、daemon の起動から 1 周期後（起動直後は消さない）。
- 1 回の実行が前の実行と重ならない（実行中なら次は飛ばす）。1 本が失敗しても、記録（`autoPurge.failed`）に残して次の木へ進み、次の周期で再試行する。
- ログの整合が壊れた（`fatal`）後は動かさない。daemon の停止で止まる。
- 記録の名前: `autoPurge.purged`・`autoPurge.failed`・`autoPurge.skipped`・`autoPurge.error`、監査は `purge.purgeStarting`・`purge.purged`・`purge.purgeFailed`（`origin: "auto"`）。
- 事前の通知（受信箱に「N 日後に削除する」）は、まだない（T13f-n）。
