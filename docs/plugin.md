# plugin の使い方（T22。CLI の分）

`plugin/` は、Claude Code の plugin です。統合セッションと子のセッションに、役割の手順（skill）と、起動の案内（コマンド）を渡します。**リポジトリの場所は、plugin に埋め込みません**（NFR_012）。必要な値は、環境変数か、人間への質問で受けます。

## 中身

| 種類 | 名前 | 内容 |
|:--|:--|:--|
| skill | `cso-integrator` | 統合ノードの手順。子の作成・追加指示・受理と差し戻し・範囲拡張の判定・回収。使うツールは `mcp__node__*`（統合ロールの全ツールを説明している） |
| skill | `cso-child` | 子ノードの手順。進捗・判断・範囲外の申告・完了の報告・範囲拡張の要求（子ロールの全ツールを説明している） |
| コマンド | `start` | 接続の確認（`mcp__node__whoami`）と、daemon・`cso-mcp` の起動の案内。設定ファイルのパスと窓口の URL は、環境変数 `CSO_CONFIG`・`CSO_DAEMON_URL` か、人間への質問で決める |
| コマンド | `status` | 木と受信箱の読み取りだけの要約 |

plugin の名前空間のため、コマンドは `/composite-session-orchestrator:start` のように呼ぶ。

## 使う順序

1. daemon を起動する（`cso-daemon --config <設定ファイル>`）。
2. `cso-mcp` を起動する（`cso-mcp --daemon-url <窓口の URL> --config <設定ファイル>`）。手順と確かめ方は `docs/manual-verification-sdk.md` の「MCP サーバーの起動」。
3. 統合セッションを、この plugin つきで起動し（`claude --plugin-dir <plugin のパス>`）、MCP サーバー `node`（種類 `http`、URL は設定の `mcpUrl`、ヘッダ `Authorization: Bearer <統合ノードのトークン>`）を足す。トークンは、daemon の状態ディレクトリの中にあり、チャットやリポジトリに書かない。
4. `/composite-session-orchestrator:start` で接続を確かめ、`cso-integrator` の skill に沿って作業する。

daemon が SDK で起動する子は、MCP の設定を daemon が組み立てて渡す（`docs/manual-verification-sdk.md` の 4）。子が `cso-child` の skill を使うには、子の起動に plugin を渡す必要があるが、これはこの版の範囲外（子は、起動の指示に手順が入っている）。

## フック

この版の `plugin/hooks/` は、**空**（`.gitkeep` だけ）です。CLI の子の記録と拒否は、これまでどおり、daemon が SDK で起動するときに渡すコールバックで行われる（`options.hooks`。`docs/spikes/02-agent-sdk-headless.md` の 5）。ファイルで設定するフック（plugin の `hooks/hooks.json`）と、daemon の受け口（`POST /v1/hook`）は、**T22-h** で別に作る（受け口のない雛形は動作を確かめられず、契約が先に固まってしまうため）。

## Desktop

Desktop の子へのフックの継承と、接続設定の引き継ぎは、**実機での確認（`.sdd/` の要求の項目 4）のあと**に扱う。この版は、CLI の分だけ。

## 検証（`pnpm check` に入っている）

`node scripts/validate-plugin.mjs`（`pnpm validate:plugin`。先に `pnpm build` が要る）が、次を検査する。検査の中身は `scripts/plugin-check.mjs`、試験は `scripts/plugin-check.test.mjs`（`node --test scripts/*.test.mjs`）。

- plugin.json の必須項目・name（kebab-case）・version（semver）。`agents/`・`hooks/`・`skills/` がある。
- skill（`SKILL.md`）と command の frontmatter（`name` は、skill ではディレクトリ名と同じ。`description` は必須）。`hooks/hooks.json` があれば、JSON として正しい。
- skill・command に書いた `mcp__node__<ツール名>` が、実際に公開されているツール（`packages/mcp` の `toolsFor`・`whoami`）にある。skill は、そのロールのツールだけを書き、**そのロールの全ツールを説明している**（ツールが増えたのに skill が古い、を防ぐ）。
- NFR_012: plugin/ の中に、絶対パス（`/home/`・`/Users/`・`/tmp/` など）・`~/`・Windows のパス・`file://`・このリポジトリの絶対パスがない。URL のパス（`/v1/…`）と `${CLAUDE_PLUGIN_ROOT}` は可。
