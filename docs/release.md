# リリースと marketplace への載せ方

plugin は、社内マーケットプレイス（`comcreate/comcreate-marketplace`）から配ります。配り方は、Release に付けた `plugin/` の zip を、marketplace.json の `source`（`"source": "archive"`）で指す形です。

## リリースの手順

1. 版をそろえる: `plugin/.claude-plugin/plugin.json`・ルートと `packages/*` の `package.json` の `version`、`CHANGELOG.md` の節。
2. `bash scripts/check.sh` と `claude plugin validate plugin` が通ることを確かめる（marketplace の CI と同じ Claude Code の版で）。
3. main にマージしたあと、タグを付けて push する（タグは `v` + plugin.json の `version`。違うと失敗する）。

   ```sh
   git tag v0.1.0-beta.1 && git push origin v0.1.0-beta.1
   ```

4. `.github/workflows/release.yml` が、`plugin/` の中身を根にした zip（`composite-session-orchestrator-<版>.zip`）と、その `.sha256` を Release に付ける（版に `-` があれば pre-release）。sha256 と asset の API URL は、実行の Summary に出る。
5. marketplace への PR（下）が出なければ、Summary の値で、marketplace.json を手で直して PR を出す。

## marketplace.json の項目

```json
{
  "name": "composite-session-orchestrator",
  "description": "統合セッション 1 対 作業セッション n の木構造で Claude セッションを束ねるオーケストレーター（daemon・cso-mcp は別に入れる）",
  "version": "<版>",
  "strict": false,
  "source": {
    "source": "archive",
    "url": "https://api.github.com/repos/comcreate/composite-session-orchestrator/releases/assets/<asset の ID>",
    "sha256": "<zip の sha256>"
  }
}
```

- `source` の中は `source`・`url`・`sha256` だけ。
- リポジトリは public なので、asset の取得に認証（`headersHelper`）は要らない。

## 最初の 1 回（手で出す）

自動化のジョブは、既存の項目を書き換えるだけです。最初の 1 回は、marketplace に手で PR を出します。

1. 題は `[add] composite-session-orchestrator を marketplace.json に追加`。
2. `.claude-plugin/marketplace.json` に、上の項目を足す（`url`・`sha256` は Release の実行の Summary の値）。
3. marketplace の README の表に行を足す（プラグイン: `composite-session-orchestrator`／内容: 上の description／本体リポジトリ: `comcreate/composite-session-orchestrator`／配布方法: archive）。
4. marketplace の `SECURITY.md` のサポート表にも行を足す。

## marketplace への PR の自動化（任意）

`release.yml` の `marketplace` のジョブは、次の secrets があるときだけ動きます。**ないときは、何もせずに成功します**（Summary に一言出る）。

| secrets の名前 | 内容 |
|:--|:--|
| `MARKETPLACE_APP_ID` | GitHub App の App ID |
| `MARKETPLACE_APP_PRIVATE_KEY` | その App の秘密鍵（PEM） |

設定の手順（値は、この文書・コミット・チャットに書かない）:

1. comcreate の組織で GitHub App を作る（または既存のものを使う）。権限は `comcreate-marketplace` への Contents: Read and write と Pull requests: Read and write。
2. App を `comcreate/comcreate-marketplace` にだけインストールする。
3. App の秘密鍵を作り、このリポジトリの Settings → Secrets and variables → Actions に、上の 2 つを登録する。

ジョブは、marketplace.json の `name` が `composite-session-orchestrator` の項目の `source`（`source`・`url`・`sha256`）と `version` を書き換え、ブランチ `release/composite-session-orchestrator-<版>` から `main` へ、題 `[update] composite-session-orchestrator <版> を marketplace.json に反映` の draft の PR を出します（本文に Release の URL）。**項目がまだないとき・version がすでに同じときは何もしません**。ほかのキーは変えません。

タグとの照合: `release` のジョブは、タグと plugin.json・ルートと `packages/*` の `package.json` の version が全部同じでなければ失敗します。zip の中身は許可リスト（plugin.json・.mcp.json・hooks・skills・commands・agents の決まったファイル）と比べ、ほかのファイル（`.env`・`node_modules` など）があれば失敗します。同じタグで再実行すると、Release の asset を付け直します（`--clobber`）。
