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
  "version": "<版>",
  "strict": false,
  "source": {
    "source": "archive",
    "url": "https://api.github.com/repos/comcreate/composite-session-orchestrator/releases/assets/<asset の ID>",
    "sha256": "<zip の sha256>",
    "headersHelper": "<qiita-mcp と同じもの（`gh auth token` で Bearer のヘッダーを作る）>"
  }
}
```

このリポジトリは私有なので、asset の取得に認証が要ります。`headersHelper` は qiita-mcp の項目と同じものを使います（形は marketplace の README と qiita-mcp の項目を正とします）。

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

ジョブは、marketplace.json の `name` が `composite-session-orchestrator` の項目の `source.url`・`source.sha256`・`version` を書き換え、draft の PR を出します。**項目がまだないときは何もしない**ので、最初の 1 回は手で足します。
