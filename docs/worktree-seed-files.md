# 作業ツリーに写す設定ファイル

子の作業ツリー（`git worktree add` で作る素のチェックアウト）には、gitignore の対象のファイル（`.envrc`・`.env`・`.claude/settings.local.json` など）は来ない。
子に必要なものは、メインのリポジトリ（`repoRoot`）の `.claude/cso-worktree-files.json` に、ユーザーが明記する。daemon は、作業ツリーを作るときに、**コピー**する（リンクにしない。子が書き換えても、元は変わらない）。

```json
{ "files": [".envrc", ".claude/settings.local.json"] }
```

- 一覧は `repoRoot` からの相対パス（50 件以下・重複なし）。ファイルがなければ、何も写さない。
- 作業ツリーを作る**前**に確かめる。次は、作業ツリーを作らずに子の起動を失敗させる（`seedListInvalid`・`seedOutsideRepo`・`seedNotFile`）:
  形が不正・`..` や絶対パス・`.git` の中・`repoRoot` の外を指す（リンク経由を含む）・通常のファイルでない。
- 元のファイルがないものは、スキップする。作業ツリー側にすでにあるもの（追跡されているファイル）は、上書きしない。
- 結果は、標準エラーに `{"event":"worktreeSeeded","nodeId":…,"copied":[…],"skipped":[…],"missing":[…]}` で出る（内容は出さない）。
- 写したファイルは、回収の判定（きれいか・失われるもの）で、未保存・未追跡に数えない。一覧にない gitignore の対象は、従来どおり回収を拒否する（[`reclaim-loss.md`](reclaim-loss.md)）。
- **秘密を含みうる**ので、一覧は最小にする。`.env` を写すと、子（と、その孫プロセス）から読める（`childEnvAllow` と同じ扱いで考える）。
