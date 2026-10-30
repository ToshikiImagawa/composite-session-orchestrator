# 設定ファイル（daemon・cso-mcp）

daemon（`cso-daemon --config <設定ファイル>`）と `cso-mcp`（`cso-mcp --daemon-url <窓口の URL> --config <設定ファイル>`）は、**同じ設定ファイル**を読みます。正本は `packages/daemon/src/config.ts`（`DaemonConfig`）で、この文書はその要約です。食い違いがあれば、コードが正しいものとします。

- JSON。権限は **0600**、所有者は自分にします（緩いと起動しません）。
- 未知のキーは、設定の誤りとして起動を拒否します。
- パスは絶対パスで書きます（`rootScope` の場所だけは `rootCwd` からの相対パス）。
- **トークンの値は、設定ファイルに書きません**（トークンは daemon が `stateDir` に作ります）。

## 必須の項目

| キー | 内容 |
|:--|:--|
| `stateDir` | 状態（SQLite・トークン・ポートのファイル）の置き場。0700 のディレクトリ |
| `repoRoot` | 子の作業ツリーを作る git リポジトリ |
| `worktreeRoot` | 子の作業ツリーの置き場 |
| `rootCwd` | 根の作業ツリー（`repoRoot` 自身か、その配下） |
| `rootScope` | 根の範囲（子の権限の上限）。`writableLocations`・`forbiddenLocations`・`allowedCommands` |
| `mcpUrl` | `cso-mcp` の待ち受け（ループバックだけ）。子と統合セッションは、ここに接続する |

## 任意の項目と既定値

| キー | 既定 | 内容 |
|:--|:--|:--|
| `rootNodeId` | `root` | 根のノードの ID |
| `port` | `0` | 窓口のポート（127.0.0.1）。0 なら `--port` → 保存した前回のポート → 空いているポート（`docs/plugin.md` の「使う順序」） |
| `childRuntime` | `cli` | 子の実行環境。`cli` は daemon が SDK で起動する。`desktop` は実験的（[`desktop-runtime.md`](desktop-runtime.md)） |
| `childHome` | `isolated` | 子の `HOME`。`isolated` は子ごとの空のディレクトリ（認証の環境変数が要る）。`inherit` は daemon の `HOME` |
| `childPluginDir` | なし | 子に渡す skill を持つ plugin のディレクトリ（絶対パス）。省略すると skill を渡さない |
| `childEnvAllow` | `[]` | 子に渡す環境変数に足す名前（完全一致） |
| `maxTurns` | `100` | 子ごとのターン数の上限 |
| `maxBudgetUsd` | `5` | 子ごとの費用の上限（USD） |
| `startLimits` | `perParent: 4`・`total: 4` | スケジューラが同時に起動する数の上限（1〜64） |
| `tokenExpiryMinutes` | `sdkIdle: 360`・`bindAbsolute: 1440`・`bindIdle: 60`・`hookAbsolute: 1440` | トークンの期限（分）。`docs/plugin.md` の「トークンの期限」 |
| `retentionDays` | `90` | 最終削除の保持期間（日） |
| `purgeTombstone` | `true` | `node.purge` で墓標を残すか |
| `autoPurge` | 無効 | 自動の最終削除（[`auto-purge.md`](auto-purge.md)）。有効にするなら `retentionDays` は 7 以上 |
| `discardedRefsMax` | `200` | 保管する破棄した成果の数の上限（[`discarded-work.md`](discarded-work.md)） |
| `regenerableIgnored` | `node_modules`・`dist`・`.turbo` | 残っていても未保存の変更とみなさない gitignore の対象 |
| `digest` | 有効（`intervalSec: 30` など） | 配下の要約（[`digest.md`](digest.md)） |
| `wake` | 無効 | 中間統合ノードを起こす（[`digest.md`](digest.md)） |
| `rateLimit` | 常に有効（主体ごと容量 60・毎秒 20 など） | 窓口の回数の制限の調整（[`rate-limit.md`](rate-limit.md)） |
| `connection` | `requestTimeoutMs: 30000` など | 接続の上限とタイムアウト |
| `inProgress` | `waitMs: 20000` など | 同じ要求の重複の扱い（[`request-dedup.md`](request-dedup.md)） |
| `gitPath` | `/usr/bin/git` | daemon が使う git |
| `desktopRequireVerifiedHooks` | `true` | Desktop の子で、フックの確認前の起動を拒否する |
| `csoCommand` | なし | Desktop の子が `cso` を起動する語（Desktop の子で必要） |
| `hookFreshSeconds` | `30` | Desktop の子のフックの鮮度の窓（秒） |
| `hookSettingsCheckSeconds` | `2` | Desktop の子の見張りの間隔（秒） |
| `hookFirstSeenMinutes` | `5` | Desktop の子でフックが来ないときに知らせるまでの時間（分） |
| `claudeConfigDirs` | なし | 見張りが守る設定のディレクトリに足す場所（`~/.claude` と `CLAUDE_CONFIG_DIR` に加えて） |

範囲・下限の細かい値は、`packages/daemon/src/config.ts` の各項目のコメントにあります。

## 例

`<...>` は自分の環境の値に置き換えます。

```json
{
  "stateDir": "<状態の置き場>",
  "repoRoot": "<作業するリポジトリ>",
  "worktreeRoot": "<作業ツリーの置き場>",
  "rootCwd": "<作業するリポジトリ>",
  "rootScope": {
    "writableLocations": ["src", "docs"],
    "forbiddenLocations": [".git"],
    "allowedCommands": ["git status", "pnpm test"]
  },
  "mcpUrl": "http://127.0.0.1:7777/mcp",
  "childPluginDir": "<plugin のディレクトリ>",
  "maxTurns": 100,
  "maxBudgetUsd": 5
}
```

```sh
chmod 600 <設定ファイル>
mkdir -p <状態の置き場> && chmod 700 <状態の置き場>
```

## 環境変数

| 変数 | 使う側 | 内容 |
|:--|:--|:--|
| `CSO_DAEMON_URL` | `cso-mcp`・フック・`cso` | 窓口の URL（`--daemon-url` の代わり） |
| `CSO_DAEMON_CONFIG` | `cso-mcp`・`cso` | 設定ファイルのパス（`--config` の代わり） |
| `CSO_MCP_PORT` | `cso-mcp` | 待ち受けのポート（`mcpUrl` と同じ値にする） |
| `CSO_MCP_URL` | plugin の `.mcp.json` | 統合セッションの MCP の接続先（省略すると `http://127.0.0.1:7777/mcp`。`mcpUrl` と同じ値にする） |
| `CSO_ROOT_TOKEN` | plugin の `.mcp.json` | 統合ノードのトークン（`stateDir` の `root-token` の中身）。**値をファイルに書かない** |
| `CSO_NODE_TOKEN` | フック | 手動の CLI の子のフック専用のトークン（`cso hook-env`） |

手順の全体と確かめ方は [`manual-verification-sdk.md`](manual-verification-sdk.md) にあります。
