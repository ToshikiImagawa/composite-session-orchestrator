# composite-session-orchestrator

複数の Claude セッションを「統合セッション 1 対 作業セッション n」の木構造（Composite パターン）で束ね、
人間が最上位の統合セッションとだけ対話すれば、並列に進む実装・レビュー・調査を依頼・把握・判断できるようにするシステム。

版は 0.1.0-beta.1（ベータ）。変更は [`CHANGELOG.md`](CHANGELOG.md)。要求は [`.sdd/requirement/composite-session-orchestrator.md`](.sdd/requirement/composite-session-orchestrator.md) を参照。

## はじめかた

社内の人向けの手順です。daemon・`cso-mcp`・`cso` は、plugin とは**別に**入れます（plugin には入っていません）。

### 1. daemon・cso-mcp・cso を入れる

Node 22 以上と pnpm 10.28.0 が要ります。

```sh
corepack enable    # pnpm 10.28.0（packageManager で固定）を使う
pnpm setup         # pnpm link --global の置き場を PATH に入れる（初回だけ。シェルを開き直す）
```

```sh
git clone https://github.com/comcreate/composite-session-orchestrator.git
cd composite-session-orchestrator
pnpm install --frozen-lockfile
pnpm build
for p in daemon mcp cli; do (cd packages/$p && pnpm link --global); done
```

`cso-daemon`・`cso-mcp`・`cso` が PATH に入ります。`cso-daemon --help` が使い方を出せば、入っています。版を上げたら、`git pull` → `pnpm install --frozen-lockfile` → `pnpm build` をやり直します（daemon と `cso-mcp` は同じ版にそろえます）。

### 2. 設定を書く

設定ファイル（JSON、権限 0600）を 1 つ書きます。daemon と `cso-mcp` が同じものを読みます。項目と既定値は [`docs/config.md`](docs/config.md)。

```json
{
  "stateDir": "<状態の置き場（0700）>",
  "repoRoot": "<作業するリポジトリ>",
  "worktreeRoot": "<作業ツリーの置き場>",
  "rootCwd": "<作業するリポジトリ>",
  "rootScope": { "writableLocations": ["src"], "forbiddenLocations": [".git"], "allowedCommands": ["git status"] },
  "mcpUrl": "http://127.0.0.1:7777/mcp"
}
```

### 3. 起動する

```sh
cso-daemon --config <設定ファイル>                       # 窓口の URL が出る
cso-mcp --daemon-url <窓口の URL> --config <設定ファイル>  # 別の端末で
```

子の認証には、daemon の環境に `CLAUDE_CODE_OAUTH_TOKEN`（`claude setup-token`）などが要ります（`docs/plugin.md` の「子の認証」）。

### 4. plugin を付ける

社内マーケットプレイスを足して、plugin を入れます。

```sh
claude plugin marketplace add comcreate/comcreate-marketplace
claude plugin install composite-session-orchestrator@comcreate-marketplace
```

plugin の `.mcp.json` が、統合セッションの MCP サーバー `node`（種類 http）を足します。接続先とトークンは環境変数で渡します（**値をファイルに書かない**）。

```sh
export CSO_MCP_URL=http://127.0.0.1:7777/mcp            # 設定の mcpUrl と同じ（省略するとこの値）
export CSO_ROOT_TOKEN="$(cat <状態の置き場>/root-token)"
claude
```

統合セッションで `/composite-session-orchestrator:start` を実行して、接続を確かめます。`CSO_ROOT_TOKEN` が未設定だと、ヘッダーが `Bearer ${CSO_ROOT_TOKEN}` の文字のまま送られ、`cso-mcp` が 401 で拒否します（`/mcp` で `plugin:composite-session-orchestrator:node` が失敗と出て、`mcp__…node__*` のツールが見えません）。このとき `/composite-session-orchestrator:start` は、ツールが見えないので、起動とトークンの設定の手順を案内します。以降は skill `cso-integrator` に沿って進めます。くわしくは [`docs/plugin.md`](docs/plugin.md)。

- plugin から足した MCP のツールは、`mcp__plugin_composite-session-orchestrator_node__*` という名前で出ます。skill・コマンドは、この名前と `mcp__node__*`（daemon が起動する子・手で足した MCP）のどちらでも動くように書いてあります。Claude Code の版を上げたら `node scripts/plugin-mcp-name-check.mjs` で名前を確かめます（2.1.308 で確認済み）。
- `CSO_ROOT_TOKEN` は、統合セッションだけに設定します。手で起動する子のセッションの環境に入れないでください（plugin を付けた子が、統合ノードの権限で接続してしまいます）。

## 既知の問題

- daemon の再起動だけでよい（`cso-mcp` は起動し直さなくてよい。daemon が戻るまでの間の呼び出しは、要求の中で最大 8 秒待ってかけ直し、尽きたら `daemon_unreachable`）。`cso-mcp` が落ちた・起動し直したときだけ、Claude Code の `/mcp` でつなぎ直す。トークンを取り消した・期限が切れたときは、設定し直して起動し直す。
- `--strict-start`（`--config` があるときの既定）で daemon より先に `cso-mcp` を起動すると、daemon を待ったあと、約 2 分半で終了する（終了コード 1）。daemon → `cso-mcp` の順に起動する。
- 手動確認 (a) の 4（チップから始めた子）・7（cd）・9a（Desktop の `transcript_path`。`CLAUDE_CONFIG_DIR` が違うとき）は、未確認。
- Desktop の子（`childRuntime: "desktop"`）は実験的。作業範囲外の拒否が十分に効かないので、信頼できない入力（他人のリポジトリ・Issue・Web の内容など）を読ませない（[`docs/desktop-runtime.md`](docs/desktop-runtime.md)）。
- 1 人で使う機械だけで使う（同じユーザーのプロセスは、状態の置き場のトークンを読める）。
- 画面の課題が残っている（T23-ux。確認の欄が見えにくい、Desktop の子の停止の代行依頼が「失敗」と出る、など）。
- 人間用の受信箱の一覧 `cso inbox` がない（T24-i）。受信箱は画面か、統合セッションの `inbox_fetch` で見る。
- 子 → `cso-mcp` の方向の身元確認がない（T10m-j。子は、`mcpUrl` の偽物にトークンを送りうる）。

一覧は [`CHANGELOG.md`](CHANGELOG.md) にもあります。

## 構成

| パス | 役割 |
|:--|:--|
| `packages/core` | 木構造、状態遷移、回収判定、受信箱の整列。純粋関数のみで I/O を持たない |
| `packages/daemon` | イベントログ、ランタイムアダプタ（sdk / desktop）、フック受付、HTML 画面 |
| `packages/mcp` | MCP ツール定義、ロール別の公開、エラー設計 |
| `packages/cli` | 人間用コマンド（`orch purge` など） |
| `plugin` | Claude Code plugin（役割定義 skill、hooks、MCP 設定、起動コマンド） |
| `docs` | 設計の補足・手動確認の手順（設定は [`docs/config.md`](docs/config.md)、リリースは [`docs/release.md`](docs/release.md)） |

## 開発

Node 22 以上と pnpm 10.28.0（`packageManager` で固定）が必要です。

```bash
pnpm install --frozen-lockfile
pnpm check   # lint、typecheck、build、test、plugin 検証をまとめて実行（CI と同じ）
```

`pnpm validate:plugin` は `plugin/.claude-plugin/plugin.json` の JSON 構文、必須項目（name、version、description）、name の kebab-case、version の semver、`plugin/{agents,hooks,skills}` の存在を確認します。

`pnpm install` に「Ignored build scripts: better-sqlite3」という警告が出ますが、無害です。better-sqlite3 13 系はビルド済みのバイナリを同梱しており、ビルドスクリプトを実行しなくても動きます（許可すると、不要なコンパイルが走りうるため許可していません）。

個別に実行する場合は `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm validate:plugin` を使います。整形は `pnpm format` です。

パッケージ単体の `typecheck`・`test`（例: `pnpm --filter @cso/daemon test`）は、`@cso/core` を core のソースに別名解決するため、先にビルドしなくても動きます。本番の解決（core の `dist`）は、`pnpm check` の中の `scripts/check-core-resolution.mjs` が確かめます（`pnpm build` の後に実行）。

テストは Vitest と fast-check、lint と format は Biome を使います。

## ライセンス

MIT（[`LICENSE`](LICENSE)）。
