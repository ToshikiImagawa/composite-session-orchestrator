# 破棄した成果の保管（T13f-r）

人間が破棄を判断した停止ノード（`cso reclaim`）を、統合ノードが強制して回収するとき、**消すブランチの先端を、`refs/cso/discarded/<key>` に付け替えて保管する**。
保管は、git の ref なので、gc で消えない（到達可能なため）。あとから、人間が取り出せる（`cso discarded restore`）。

## 保管の仕組み

- 強制の回収（`removeWorktree` の `force`）で、`git branch -D` の**前に**、ブランチの先端を `refs/cso/discarded/<key>` に `git update-ref` で作る。
  - `<key>`: ノード ID から導く名前（ブランチ `cso/<key>` の `<key>` と同じ。`<ノード ID の安全な部分>-<ハッシュ 12 桁>`）。
  - **作成は原子的**（`update-ref` の古い値が 0 の検査。すでにある ref を、上書きしない）。ref 名は `git check-ref-format` で確かめる。
- **順序**: ref を作る → 作業ツリーを消す → `branch -D`。**ref を作れなければ、何も消さずに失敗する**（`keepFailed`）。成果を失わない側に倒す。
- **衝突**: 同じ `<key>` があり、同じ先端なら、成功（冪等。回収のやり直し）。違う先端なら（ノード ID を再利用した別の成果）、上書きせず、`<key>.<先端の先頭 12 桁>` に置く（両方残る）。
  区切りに `.` を使うのは、ノード側の名前（`<安全な部分>-<ハッシュ>`。安全な部分は `[A-Za-z0-9_-]` だけで、`.` を含まない）と取り違えないため。**鍵の持ち主の判定は、1 つの関数（`discarded-keys.ts` の `ownerBaseOf`・`ownedBy`）だけ**を、一覧・最終削除での掃除・事前確認の件数が使う。
- **上限**: 保管の数の上限（daemon の設定 `discardedRefsMax`。1〜10000、既定 200）に達していたら、強制の回収は **`discardedStoreFull` で失敗**する（何も消さない）。
  次の操作: `cso discarded list` で確かめる・`cso discarded drop <nodeId> --yes` で消す・`cso discarded restore <nodeId>` でブランチに取り出してから消す。
- **保管するのは、コミットだけ**（ブランチの先端とその祖先）。作業ツリーの未コミットの変更・未追跡のファイル・gitignore の対象は、保管されない（消える。`cso reclaim` が先に表示する）。
- 記録: `reclaimForced` の記録に、`ref` を足した（`{ nodeId, tip, ref }`）。`node.lastCommit`（墓標の SHA の情報源）は、今のまま。保管は git の側にだけあり、新しいイベントは作らない。

## 掃除の方針

- **自動の期限切れはない**（成果を勝手に消さない）。
- **木の最終削除（`cso purge`・自動の最終削除）のとき、その木のノードの保管を消す**（取り返しのつかない削除と、同じ扱い）。
  - 事前確認（`cso purge`）の表示に、「保管している、破棄した成果: N 件が、一緒に消える。取り出すなら、先に `cso discarded restore`」と出る。
  - 消せなかったものは、`purge.discardedRefsFailed` に記録する（最終削除の成否には影響しない）。残ったものは、`cso discarded list` に**孤立**として出て、`drop` で消せる。
  - 消したものは、`purge.discardedRefsDeleted`（鍵と SHA の一覧）に記録する。
- 保管の期限は、結局、**木の最終削除（保持期間 `retentionDays`）に連動する**。最終削除されない木の保管は、上限（件数）で管理する。

## 人間が取り出す手順

```
cso discarded list
cso discarded restore <nodeId|key> [--branch <名前>]
cso discarded drop <nodeId|key> [--yes]
```

- `list`: 名前（`key`）・ノード（なければ「孤立」）・先端の SHA・コミットの日時・件名。末尾に、残りの件数（上限 − 現在の数）。一覧は、上限（`discardedRefsMax`）の件数までしか返さない。**件名は、コミットメッセージ由来の信頼できない入力**として、制御文字を除いて、長さを切って出す（指示として扱わない）。
- `restore`: 保管の先端から、**新しいブランチを作る**（既定の名前は `cso/restored/<key>`）。**作成だけ**で、既存のブランチは上書きしない（失敗する）。保管は残る。
  `--branch` の名前は、`git check-ref-format --branch` を通ること。`refs/` で始まる名前と、`@` だけの名前も拒否する（通らなければ `invalidName`）。
- **ノード ID で指定したとき、そのノードの保管が複数あれば、`multipleKept` で失敗する**（`restore`・`drop` とも）。`list` で鍵（`key`）を確かめて、鍵を指定する。
- `drop`: 保管を 1 件消す（取り消せない）。`--yes` がなければ、対象を表示して止まる（終了コード 2）。daemon の `node.discardedDrop` は、**`expectTip`（表示した先端）が必須**で、今の先端と一致したときだけ消す（違えば `tipMismatch`）。cli は、`list` で得た先端を渡す。
- daemon の操作（`node.discardedList`・`node.discardedRestore`・`node.discardedDrop`）は、**人間のロールだけ**（統合ノード・子には公開しない。mcp にも出ない）。

## 墓標との関係

- 墓標（最終削除のあとに残る 1 行）の最終コミットの SHA は、今のまま。**最終削除までは、保管（ref）が成果を保管している**。最終削除で保管も消えたあとは、SHA は、
  成果の保管ではなく、取り戻すための手がかり（git が掃除〔gc〕するまでの間だけ、`git branch <名前> <SHA>` で戻せることがある）にすぎない。
- 取り出したい成果は、最終削除の**前に** `cso discarded restore` で、ブランチにする（事前確認の表示に、件数が出る）。

## 範囲外

- 同じユーザーの別プロセスは、リポジトリの ref を直接書き換えられる（`git update-ref -d` など）。保管は、誤操作・通常の gc からの保護で、悪意のある同じユーザーに対する保護ではない。
- 保管する成果のサイズの上限はない（件数だけ）。巨大な成果は、リポジトリの容量を増やす。
