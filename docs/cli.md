# 人間用コマンド `cso`（T22-cli）

`cso` は、人間が daemon の窓口（`POST /v1/request`）を呼ぶコマンド（`packages/cli`。`pnpm build` のあと `packages/cli/dist/bin.js`、
workspace では `pnpm --filter @cso/cli exec cso …`）。使い方は `cso --help`。

## 窓口と人間のトークンの渡し方

**窓口・トークン・設定は、環境変数だけで渡す**（コマンドの引数には置かない。`ps` のプロセス一覧・シェルの履歴に出さない）。`--token` のような引数はない。

| 環境変数 | 内容 |
|:--|:--|
| `CSO_DAEMON_URL` | daemon の窓口（例: `http://127.0.0.1:7777`。ループバックだけ） |
| `CSO_HUMAN_TOKEN` | 人間のトークン（`<stateDir>/human-token` の中身） |
| `CSO_DAEMON_CONFIG` | daemon の設定ファイル。`stateDir` の `daemon-identity` で、トークンつきの要求の直前に毎回、daemon の身元を確かめる（`cso-mcp` と同じ。`docs/daemon-identity.md`） |
| `CSO_CLI_ALLOW_UNVERIFIED` | **ちょうど `1`** のときだけ、`CSO_DAEMON_CONFIG` なしで、身元の確認なしで動く（試験用。ふだんは使わない） |

```sh
export CSO_DAEMON_URL=http://127.0.0.1:7777
export CSO_DAEMON_CONFIG=/path/to/daemon-config.json
export CSO_HUMAN_TOKEN="$(cat /path/to/state/human-token)"   # トークンを、コマンドの行に直接書かない
cso reclaim <nodeId>
```

- `CSO_DAEMON_URL`・`CSO_HUMAN_TOKEN` がない、または `CSO_DAEMON_CONFIG` がない（`CSO_CLI_ALLOW_UNVERIFIED=1` でない）ときは、何も送らずに終了コード 2。
- daemon の身元を確かめられないとき（`daemon_identity_failed`）は、トークンを送らずに終了コード 1（操作は実行されていない）。
- 出力・エラーを出す直前に、文字列の中の `CSO_HUMAN_TOKEN` の値を `***` に置き換える（daemon や偽の窓口が、応答にトークンを入れても出さない）。中継（relay）も、トークンと本文を、失敗の文面・記録に入れない。
- 置き換えるのは、トークンの値と完全に一致する部分だけ（一部だけを含む文字列は、そのまま出る）。

## 中継の振る舞い（mcp の relay と同じ）

窓口の呼び出しは、`cso-mcp` の中継（`@cso/mcp/relay`）をそのまま使う。ループバックだけの URL、身元の確認、本文・応答の上限 1 MiB、
操作ごとのタイムアウト、429・409 `inProgress` の再送（`Retry-After`〔上限 10 秒〕＋ジッターだけ待って 1 度。同じ `requestId`）、
接続の失敗の再送（1 度。同じ `requestId`）。

- `--request-id <id>` を付けると、その識別子で要求する（前回の結果が確認できなかったときの再実行。daemon が重複を防ぐ）。付けなければ、新しく作る。
- 応答を受け取れなかった・不正な応答のときは「結果が確認できない」として、同じ `requestId` で再実行するコマンドを出す（終了コード 1）。

## 入れるもの

`@cso/cli` は、中継のために `@cso/mcp` に依存する。そのため、`@cso/cli` を入れると、mcp の依存（MCP SDK・zod）も一緒に入る。ただし、`cso` は
`@cso/mcp/relay`（relay・identity だけ）しか読まないので、実行時に MCP SDK・zod は読み込まない（試験で確かめている）。

## 終了コード

0 成功 / 1 失敗・結果が確認できない / 2 引数・環境の誤り

## 子の認証（daemon の起動の環境）

`cso` が使うのは人間のトークンだけだが、daemon が起動する子には、別に Claude の認証が要る。既定の `childHome: "isolated"` では、
`claude` CLI のログインだけの環境は、子の起動が `childAuthMissing` で拒否される。daemon を起動する環境に `ANTHROPIC_API_KEY`、または
`claude setup-token` で作った `CLAUDE_CODE_OAUTH_TOKEN` を入れる（または `childHome: "inherit"`）。詳しくは `docs/plugin.md` の「子の認証」。

