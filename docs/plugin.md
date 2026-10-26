# plugin の使い方（T22。CLI の分）

`plugin/` は、Claude Code の plugin です。統合セッションと子のセッションに、役割の手順（skill）と、起動の案内（コマンド）を渡します。**リポジトリの場所は、plugin に埋め込みません**（NFR_012）。必要な値は、環境変数か、人間への質問で受けます。

## 中身

| 種類 | 名前 | 内容 |
|:--|:--|:--|
| skill | `cso-integrator` | 統合ノードの手順。子の作成・追加指示・受理と差し戻し・範囲拡張の判定・回収。使うツールは `mcp__node__*`（統合ロールの全ツールを説明している） |
| skill | `cso-child` | 子ノードの手順。進捗・判断・範囲外の申告・完了の報告・範囲拡張の要求（子ロールの全ツールを説明している） |
| コマンド | `start` | 接続の確認（`mcp__node__whoami`）と、daemon・`cso-mcp` の起動の案内。設定ファイルのパスと窓口の URL は、環境変数 `CSO_DAEMON_CONFIG`・`CSO_DAEMON_URL` か、人間への質問で決める。トークンは `CSO_ROOT_TOKEN` で渡す |
| コマンド | `status` | 木と受信箱の読み取りだけの要約 |

plugin の名前空間のため、コマンドは `/composite-session-orchestrator:start` のように呼ぶ。

## 使う順序

1. daemon を起動する（`cso-daemon --config <設定ファイル>`）。
2. `cso-mcp` を起動する（`cso-mcp --daemon-url <窓口の URL> --config <設定ファイル>`）。手順と確かめ方は `docs/manual-verification-sdk.md` の「MCP サーバーの起動」。
3. 統合ノードのトークンを、環境変数 `CSO_ROOT_TOKEN` に設定する（daemon の状態ディレクトリの `root-token` の中身。例: `export CSO_ROOT_TOKEN="$(cat <状態ディレクトリ>/root-token)"`）。次に、統合セッションを、この plugin つきで起動し（`claude --plugin-dir <plugin のパス>`）、MCP サーバー `node` を足す（種類 `http`、URL は設定の `mcpUrl`、ヘッダ `Authorization: Bearer ${CSO_ROOT_TOKEN}`。例: `.mcp.json` の `headers` に、この変数の参照を書く）。**トークンの値は、設定ファイルに書かない**（書くと、コミットすれば漏れる）。設定ファイルには変数の参照だけが残る。やむを得ず値を書いたファイルは、`.gitignore` に入れ、コミットしない。チャットにも貼らない。
4. `/composite-session-orchestrator:start` で接続を確かめ、`cso-integrator` の skill に沿って作業する。

daemon が SDK で起動する子は、MCP の設定を daemon が組み立てて渡す（`docs/manual-verification-sdk.md` の 4）。子が `cso-child` の skill を使うには、子の起動に plugin を渡す必要があるが、これはこの版の範囲外（子は、起動の指示に手順が入っている）。

## フック（T22-h）

`plugin/hooks/hooks.json` は、PreToolUse・PostToolUse・Stop で、`node "${CLAUDE_PLUGIN_ROOT}/hooks/cso-hook.mjs"` を呼ぶ（依存なしのスクリプト）。スクリプトは、フック入力（標準入力の JSON）を、daemon の受け口 `POST /v1/hook` にそのまま送り、判定を返す。

**CSO の子は、必ず `CSO_DAEMON_URL`（窓口の URL）と `CSO_NODE_TOKEN`（その子のノードのトークン）の両方を設定して起動する。どちらもない場合、フックは働かない**（CSO の子ではないセッションを壊さないため、素通しして、標準エラーに一言出す）。片方だけのときは、設定の誤りとして、拒否する。

| 場面 | PreToolUse | PostToolUse・Stop |
|:--|:--|:--|
| 環境変数が両方ない | 素通し（標準エラーに一言） | 素通し |
| 片方だけ | 拒否（終了コード 2） | 止めない（標準エラーに出す） |
| daemon に届かない・時間切れ（5 秒）・200 以外・応答の形が違う | **拒否**（フェイルクローズ） | 止めない（拒否すると、作業を止められなくなる） |
| 判定が許可・拒否 | 許可は終了コード 0、拒否は終了コード 2（理由がモデルに伝わる） | 判定しない（allow） |

### 受け口 `POST /v1/hook`

- **認証**: 子のノードのトークン（`Authorization: Bearer`）。人間・統合ノードのトークンは 403（範囲を持たない）。認証・主体の検査（失効・止まったノードは 401）・同時数・主体ごとの回数の制限は、`/v1/request` と同じ（`docs/rate-limit.md`。同じ bucket を使う。**重みは 0.5**〔ほかの要求は 1〕。フックはツール呼び出しのたびに来るので、子のほかの要求を締め出しにくくする）。要求の重複の扱い（`requestId`）はない（判定は冪等）。
- **判定**: PreToolUse だけを、SDK のコールバックと同じ判定（`packages/daemon/src/sdk/hook-policy.ts`）に流す。基準は、daemon が持つノードの範囲と作業ツリーで、入力の `cwd` は使わない。**記録も同じ**（範囲違反は `scope.violation` と受信箱〔同じ違反は 1 度だけ〕、未知のツールは `node.toolDenied`。数え上げも SDK と共有する）。daemon が作業ツリーを知らないノード（daemon が起動していないノード）は、拒否する。
- **`session_id` とノード**: ノードはトークンで決める。最初に来た `session_id` をノードに結び、別の値は 403 で拒否する（記録は `hookSessionMismatch`。ID は書かない）。**結び付けはメモリだけなので、daemon を再起動すると、結び直しになる**（再起動のあと、最初に来たセッションに結ぶ）。**同じノードで `session_id` が変わる操作（`/clear`・`--resume` など）をすると、結び付けを外すまで、そのノードのフックは拒否される**。外す手段（T22-hu）:
  - `node.hookUnbind`（人間は `cso hook-unbind <nodeId>`、祖先の統合ノードは `mcp__node__node_hookUnbind`）。外したあと、最初に来たセッションに結び直す。**本人の子は外せない**（盗まれたトークンで外して、別のセッションで結び直させない）。外した者は、記録 `node.hookUnbound`（`nodeId`・`hadBinding`・actor。session_id は書かない）に残る。同じ requestId の再送では、もう一度は外さない。
  - トークンの発行し直し・失効（bind など）でも、自動で外れる（daemon の記録 `hookUnbound`、`reason: tokenReissued`）。古いトークンを無効にしてから外すので、古いトークンのセッションが、間に結び直すことはない。
  - daemon の再起動でも外れる（メモリだけのため）。
  - トークンが漏れた疑いがあるときは、外さずに、子を止めてトークンを失効させる。
  - 受け口は、本文を読み終えたあと、結ぶ直前に、もう一度トークンを確かめる。本文を読んでいるあいだに発行し直されたら、その要求は 401 で、結び付けも作らない。
  - **互換**: 記録のイベント `node.hookUnbound` を書いたあとは、古い版の daemon に戻せない（ダウングレード不可。古い版は、未知のイベントとしてログを開けない）。状態の形は変えていないので、`STATE_VERSION` は上げていない。
- **本文の上限**: 1 MiB（窓口と同じ）。超えたら 413（「本文が大きすぎる」）で、フックは拒否として扱う。
- 応答: `{ ok: true, value: { decision: "allow" } }` か `{ ok: true, value: { decision: "deny", reason } }`。

## daemon が起動する子に渡す skill（T22-c）

daemon が SDK で起動する子（CLI の子）には、plugin の skill を渡せる。daemon の設定 `childPluginDir`（この plugin のディレクトリの絶対パス）を指定する。

- SDK の `options.plugins` は、plugin の skills・hooks・agents・commands をまとめて読む（hooks だけを外せない）。そのまま渡すと `hooks/hooks.json` も読まれ、SDK のフックと二重の判定になる。そこで daemon は、起動のたびに、状態の置き場の下の `child-plugin/` を消して作り直し、**`skills/cso-child/SKILL.md`・`skills/cso-integrator/SKILL.md` と `plugin.json`（名前 `cso-child-skills`）だけ**を写す。hooks・commands・agents・`.mcp.json` は写さない。写す先は状態の置き場の下だけ、写す元のシンボリックリンクは辿らない、SKILL.md の `name` はディレクトリ名と一致すること。満たさなければ、daemon は起動しない。
- 子には `plugins: [{ type: "local", path: <child-plugin>, skipMcpDiscovery: true }]` と `skills: ["cso-child-skills:<skill>"]` を渡す。中間の統合ノード（role が integrator）は `cso-integrator`、それ以外は `cso-child`。`settingSources: []`・`strictMcpConfig: true` は変わらない（利用者の設定・MCP は混ざらない）。
- 起動の指示には手順の本文を書かず、末尾に「作業の手順は、skill「…」に従う」の 1 行だけを足す。
- 制約: 写すのは `SKILL.md` だけなので、skill からほかのファイル（`references/`・スクリプトなど）は参照できない。skill は 1 つのファイルで完結させる。
- 作り直すのは daemon の起動時だけ。daemon を再起動すると、その daemon が起動した子も止まるので、実行中の子が使っている plugin を消すことはない。
- 子のフック（`hook-policy`）は、`Skill` ツール（skill を読む）を許可する。SDK のコールバックとファイルのフックの受け口（`POST /v1/hook`）で同じ判定。
- `childPluginDir` を省略すると、子に skill を渡さない（起動時に `childPluginSkipped` を記録する）。
- パス（NFR_012）: plugin のパスは、コード・skill に書かない。写す元は設定、写す先は状態の置き場から決める。

手動確認（実 SDK。2026-10-26。Claude Code 2.1.308・Agent SDK 0.3.292・macOS 26.5）: 子が `Skill` ツールで `cso-child` を読めた（子の報告による自己申告。`node.toolDenied` は 0 件・`childPluginSkipped` なし）。**フックが二重にならないことは、未確認**: 認証（CLI のログイン）を引き継ぐため `childHome: "inherit"` で行い（既定の `isolated` では、子が認証できず止まった）、子が `~/.claude` の設定を読めた。`isolated` で認証できる環境（`ANTHROPIC_API_KEY`）で、受け口 `POST /v1/hook` に子の要求が来ないことを確かめる。

## Desktop

Desktop の子へのフックの継承と、接続設定の引き継ぎは、**実機での確認（`.sdd/` の要求の項目 4）のあと**に扱う。この版は、CLI の分だけ。

## 検証（`pnpm check` に入っている）

`node scripts/validate-plugin.mjs`（`pnpm validate:plugin`。先に `pnpm build` が要る）が、次を検査する。検査の中身は `scripts/plugin-check.mjs`、試験は `scripts/plugin-check.test.mjs`（`node --test scripts/*.test.mjs`）。

- plugin.json の必須項目・name（kebab-case）・version（semver）。`agents/`・`hooks/`・`skills/` がある。
- skill（`SKILL.md`）と command の frontmatter（`name` は、skill ではディレクトリ名と同じ。`description` は必須）。`hooks/hooks.json` があれば、JSON として正しく、形が正しい（イベントは PreToolUse・PostToolUse・Stop だけ、Stop に matcher を書かない、`type: "command"`、command は `node "${CLAUDE_PLUGIN_ROOT}/<plugin の中の .mjs>"` でそのファイルがある、timeout は 1〜60 秒）。スクリプトの試験は `scripts/cso-hook.test.mjs`。
- skill・command に書いた `mcp__node__<ツール名>` が、実際に公開されているツール（`packages/mcp` の `toolsFor`・`whoami`）にある。skill は、そのロールのツールだけを書き、**そのロールの全ツールを説明している**（ツールが増えたのに skill が古い、を防ぐ）。「説明している」とみなすのは、**行頭の箇条書きで、ツール名のあとに `:` と 10 文字以上の説明が続く行**（`- ` `` `mcp__node__<名前>` `` `: 説明…`）がある場合だけ。「使わない」と書いただけの言及は、説明にならない。
- NFR_012: plugin/ の中に、絶対パスがない。行頭・空白・引用符・`(`・`=` の直後の `/<英数字>/…` は、すべて拒否する（`/home/`・`/workspace/`・`/app/`・`/Volumes/`・`/c/Users/` など。`~/`・Windows のパス・`file://`・このリポジトリの絶対パスも）。**例外は、URL のパス（`://host` の後。例: `http://127.0.0.1:7777/v1/whoami`）と `${CLAUDE_PLUGIN_ROOT}`（とそれに続く plugin の中のパス）だけ**。
- frontmatter は、1 行の `key: value` だけ。複数行の値（`>`・`|`）は、検出できないので、エラーにする。
- `packages/mcp/dist/tools.js` が `src/tools.ts` より古ければ、「先に `pnpm build`」と表示して失敗する。
