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

1. daemon を起動する（`cso-daemon --config <設定ファイル> [--port <1〜65535>]`）。窓口のポートは、`--port` → 設定の `port`（0 以外）→ stateDir の `port` のファイル（前回のポート。0600）→ 空いているポート（そのファイルに保存する）の順で決まり、再起動しても変わらない。保存したポートが使われていれば、別のポートには移らず、起動しない（理由と直し方を出す）。起動の記録（`started`）の `portSource` に、どこから決まったか（`option`・`config`・`saved`・`new`）が出る。OS が選ぶポートは一時的なポートの範囲なので、まれにほかの接続が使う。止まったら `--port` で範囲外の番号を指定する。ファイルが壊れている・権限が緩い・リンクのときは `portFileInvalid` で起動しない（権限を 0600 にするか、ファイルを消す）。新規のポートを保存できないとき、Desktop の子（`childRuntime: "desktop"`）では `portSaveFailed` で起動しない。同じ stateDir で、2 つの daemon を動かさない。
2. `cso-mcp` を起動する（`cso-mcp --daemon-url <窓口の URL> --config <設定ファイル>`）。手順と確かめ方は `docs/manual-verification-sdk.md` の「MCP サーバーの起動」。
3. 統合ノードのトークンを、環境変数 `CSO_ROOT_TOKEN` に設定する（daemon の状態ディレクトリの `root-token` の中身。例: `export CSO_ROOT_TOKEN="$(cat <状態ディレクトリ>/root-token)"`）。次に、統合セッションを、この plugin つきで起動し（`claude --plugin-dir <plugin のパス>`）、MCP サーバー `node` を足す（種類 `http`、URL は設定の `mcpUrl`、ヘッダ `Authorization: Bearer ${CSO_ROOT_TOKEN}`。例: `.mcp.json` の `headers` に、この変数の参照を書く）。**トークンの値は、設定ファイルに書かない**（書くと、コミットすれば漏れる）。設定ファイルには変数の参照だけが残る。やむを得ず値を書いたファイルは、`.gitignore` に入れ、コミットしない。チャットにも貼らない。
4. `/composite-session-orchestrator:start` で接続を確かめ、`cso-integrator` の skill に沿って作業する。

daemon が SDK で起動する子は、MCP の設定を daemon が組み立てて渡す（`docs/manual-verification-sdk.md` の 4）。子が `cso-child` の skill を使うには、子の起動に plugin を渡す必要があるが、これはこの版の範囲外（子は、起動の指示に手順が入っている）。

## フック（T22-h）

`plugin/hooks/hooks.json` は、PreToolUse・PostToolUse・Stop で、`node "${CLAUDE_PLUGIN_ROOT}/hooks/cso-hook.mjs"` を呼ぶ（依存なしのスクリプト）。スクリプトは、フック入力（標準入力の JSON）を、daemon の受け口 `POST /v1/hook` にそのまま送り、判定を返す。

手動の CLI セッション（daemon が SDK で起動する子とは別に、人が起動する `claude`）では、人間が `eval "$(cso hook-env <nodeId>)"` で、その子の**フック専用のトークン**（T22-ht）を発行して環境変数に入れる。このトークンは `POST /v1/hook` だけで使え（ほかの入口は 401）、ノードのトークン（SDK の子の MCP の接続）は変わらない。発行し直すと、古いものは無効になり、フックの結び付けも外れる。daemon を再起動すると無効（発行し直す）。`cso hook-env` は、標準出力が端末なら、トークンを出さずに失敗する（`eval` で使うときだけ）。

**フック専用のトークンが無効になるとき**: ノードのトークンが発行し直される・失効すると、フック専用のトークンも一緒に無効になる。発行し直されるのは、**子が止められて再開したとき**（判断要求の `pauseNodeIds` で止め、回答で再開）・子の作り直し・bind のとき（CLI の子（`childRuntime: "cli"`）で実際に起こるのは、このうち**再開だけ**（作り直しは新しいノードになり、bind は Desktop の子だけ）。）。**子を止めない判断（`pauseNodeIds` なし、子が自分で出した判断など）に回答しても、子は動いたまま（回答は指示として届く）で、トークンは変わらない。手動のセッションは、そのまま使える**。手動のセッションのフックは拒否されるようになるので、`eval "$(cso hook-env <nodeId>)"` から起動し直す。daemon の再起動でも無効になる。**`cso hook-env` の出力を、パイプやファイルに出さない**（`eval` 以外に渡すと、トークンがそこに残る）。**互換**: 記録のイベント `node.hookTokenIssued` を書いたあとは、古い版の daemon に戻せない（ダウングレード不可）。

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

手動確認（実 SDK。2026-10-26。Claude Code 2.1.308・Agent SDK 0.3.292・macOS 26.5）: 子が `Skill` ツールで `cso-child` を読めた（子の報告による自己申告。`node.toolDenied` は 0 件・`childPluginSkipped` なし）。フックが二重にならないことは、子に渡す plugin の中身（`plugin.json` と `skills/` だけ。`hooks/` なし）で確認した（「受け口に要求が来ない」は、環境変数が渡らないので根拠にならない）。認証（CLI のログイン）を引き継ぐため `childHome: "inherit"` で行い（既定の `isolated` では、子が認証できず止まった）、`Skill` の呼び出しの記録による裏付けは得られていない。

## 子の認証（T22-auth）

子の認証（T22-auth）: 既定の `childHome: "isolated"` では、子の HOME が空のディレクトリなので、`claude` CLI のログインは使えない。daemon を起動する環境に、認証の環境変数（`ANTHROPIC_API_KEY`・`ANTHROPIC_AUTH_TOKEN`・`CLAUDE_CODE_OAUTH_TOKEN` のどれか。`claude setup-token` で作った値を `CLAUDE_CODE_OAUTH_TOKEN` に入れる）が要る。**CLI のログインだけの環境は、子の起動が `childAuthMissing` で拒否される**（理由と対処が、親に返る。spawn・判断の回答による再開・スケジューラのどれでも同じ。受信箱の項目は、同じ子の同じ失敗では増えない）。Bedrock・Vertex・Foundry の経路は、切り替えの変数（`CLAUDE_CODE_USE_BEDROCK`・`_VERTEX`・`_FOUNDRY`）が**あることだけで通す**（ただし `0`・`false`・`no`・`off`〔大文字小文字を問わない〕は、なしとみなす。API キー・トークンの 3 変数は、空かどうかだけで見る）（その資格情報は `childEnvAllow` で渡す前提で、中身までは確かめない）。`childHome: "inherit"` では確かめない（親の HOME と CLI のログインを共有する。分離は弱まる）。値は、記録・失敗の文面に出さない。直して再開できたら（daemon を起動し直して、再開・作り直しが通ったら）、その失敗の受信箱の項目を解決済みにする（未解決のあいだ、同じ子の同じ失敗の項目は増えない）。

## 子の MCP のトークン（T21-ce）

daemon が起動する CLI の子は、自分のノードのトークンで cso-mcp（`mcp__node__*`）に接続する。**トークンの値は、SDK の MCP の設定（`--mcp-config` の引数として claude に渡され、`ps` に出る）には置かない**。設定には `Authorization: Bearer ${CSO_MCP_TOKEN}` と参照だけを書き、値は子の環境変数 `CSO_MCP_TOKEN` で渡す（claude は `--mcp-config` の headers の `${VAR}` を展開する）。名前は、手動のセッションのフック用の `CSO_NODE_TOKEN`（`cso hook-env`）とは分けた。どちらの名前も、親の環境から子に通さない（`childEnvAllow` に書くと、設定の誤りとして起動しない）。

- **展開の確認**: `node scripts/mcp-env-expansion-check.mjs`（同梱の claude を、参照入りの `--mcp-config` で起動し、手元の受け口で受けた Authorization が展開されているかを確かめる。claude の版を上げたら実行する。API への失敗する接続を含むので、`pnpm check` には入れていない）。
- **展開されなかったとき**: claude の init の `mcp_servers` で、渡した MCP（`node`）がない・`failed`・`needs-auth` なら、子の起動を失敗にする（黙って 401 のまま作業させない。途中の状態〔`pending` など〕は失敗にしない）。

**弱点（E）**: 値は、子の環境変数にある。
- 止められるもの: `echo $CSO_MCP_TOKEN` など、単一引用符の外に `$` を含む命令（作業範囲の判定が、命令ごと拒否する）。
- 止められないもの: `printenv`・`env`（許可リストにある場合）、許可されたコマンドが起こす子のプロセスの中（テスト・`postinstall` など）、macOS の `ps eww`・`ps -E`（同じユーザーなら、ほかのプロセスの環境変数を読める）。値が会話・ログに入るおそれがある。Linux の `/proc/self/environ`・`/proc/*/environ` は、読み取りも禁じる場所に入れた（T21-pr の仕組み）。
- **別のユーザーからは見えない**（macOS では、別のユーザーのプロセスの環境変数を `ps` で読めない。V2 で見えていた、引数の中のトークンの値は、なくなる）。
- 禁じる場所（T21-pr。ファイルを読ませない）と、この環境変数の守り（引数に値を置かない）は、別の仕組みである。同じユーザーの子から値を守るのは、作業範囲外の拒否（FR_014）と、トークンの期限・失効の役目。
- **`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`**: 同梱の claude（0.3.292）にあることは確かめた。ただし、Linux では bubblewrap が要り、`allowedTools` を明示しないと権限モードが default に強められ、消す名前は既知の秘密の名前の一覧が中心で、`CSO_MCP_TOKEN` が消えるかは確かめられなかった。**今回は、子に設定しない**（効くと確かめられなかった）。

## トークンの期限（T21-te）

漏れたトークンが長く使われないよう、ノードのトークンとフック専用のトークンに期限を付ける。値は設定 `tokenExpiryMinutes`（分。1〜525600 の整数。どれも任意）で変えられる。

| トークン | 期限（既定） | 設定のキー | 「使った」に数えるもの |
| --- | --- | --- | --- |
| CLI の子（daemon が起動する子） | 使わなければ 6 時間で切れる（絶対の期限はない） | `sdkIdle` | 窓口の呼び出し・道具の使用（フック） |
| Desktop の子（bind） | 発行から 24 時間、または使わなければ 1 時間 | `bindAbsolute`・`bindIdle` | 窓口の呼び出し |
| フック専用（`cso hook-env`） | 発行から 24 時間（使っていても延びない） | `hookAbsolute` | — |
| 根（統合）・人間 | 期限なし | — | — |

| 子の状態 | ノードのトークン |
| --- | --- |
| running・stopping・stopIncomplete・pending | 期限どおりに数える |
| waiting（判断待ち）・done | 使わなければ切れる時計を止める（bind の 24 時間は進む）。done は失効させない（差し戻しで動き直す） |
| stopped・verified・reclaimable・archived（記録にないノードも） | 種類を問わず、その状態になったその場で失効させる（見回りを待たない）。再開のときは、CLI の子は daemon が発行し直し、Desktop の子は結び直す |

- **再開の途中で daemon が再起動したとき**: 再開は、止まったまま新しいトークンを発行し、起動を待ってから running を記録する。その途中で daemon が止まると、子は stopped のまま残り、起動を待っていたトークンも残る。daemon は起動時に、止まっている子のトークンを失効させるので、このトークンも使えなくなる（子のプロセスは、daemon と一緒に終わっている）。再開をやり直すには、同じ回答をもう一度送る（新しいトークンを発行して起動する）。動いているあいだの再開（daemon が止まらない場合）では、起動を待つあいだに、ほかのコミットや見回りがあっても、新しいトークンは消えない（stopped は、その状態に移ったときにだけ見るため）。
- 期限切れのトークンでの呼び出しは 401 で、失敗の記号は `tokenExpired`（ほかの不正なトークンは `unauthenticated`）。対処: Desktop の子は、親か人が `node.bindCode` でコードを出し直し、子が結び直す。CLI の子は、親か人が子を再開するか、作り直す。フック専用のトークンは、`eval "$(cso hook-env <nodeId>)"` で出し直す。
- 期限で切れたとき、その子が running なら、受信箱に知らせを 1 件出す（同じトークンについては 1 回だけ）。止まった・役目の終わった子には出さない。daemon は 5 分ごとに見回り、使われていないトークンも失効させる。期限切れでの失敗は、窓口の警告（認証の失敗の件数）の閾値に数えない。
- 動いているあいだの経過は、単調時計で数える（壁時計を巻き戻しても、期限は延びない）。再起動をまたぐときだけ、保存した時刻と壁時計で比べる。
- **ノート PC を閉じてスリープさせると、そのあいだも時間がたったものとして数える**（壁時計はスリープのあいだも進む）。閉じていた時間が長いと、開いたときに、Desktop の子のトークンが切れている（結び直す）。
- 最後に使った時刻は、トークンのファイル（`node-tokens.json`、版 2）に、ノードごとに 1 分に 1 回まで書く。daemon を再起動しても、期限は続く。記録には、ノード ID・理由・種類だけを書く（トークン・ハッシュは書かない）。
- **版 1 のファイル**（種類・最後に使った時刻がない）を読んだときは、厳しい側の bind とみなす（発行から 24 時間。使わなければ切れる時計は、読んだ時から数える）。どの子のトークンかが分からないため、長い側（CLI の子）には倒さない。CLI の子は、切れても再開のときに発行し直されるので、困らない。

## Desktop

Desktop の子へのフックの継承と、接続設定の引き継ぎは、**実機での確認（`.sdd/` の要求の項目 4）のあと**に扱う。この版は、CLI の分だけ。

**注意（未解決）**: Desktop の子には、CSO の作業範囲外の拒否（FR_014）が、まだ効かない（フックの受け口は Desktop の子に許可を返さず、プロジェクトのフックは確認用の deny だけ）。子は同じユーザーとして、stateDir の人間のトークン・根のトークンのファイルを読める（stateDir のパスは、`ps` に出る daemon の `--config` から分かる）。人間のトークンを使えば、`node.purge` など取り消せない操作もできる。**今は、Desktop の子を、信頼できない文章（他人のリポジトリ・Issue・Web の内容など）を読む作業に使わない。** 直し方は未決定（計画）。詳しくは [`docs/desktop-runtime.md`](desktop-runtime.md) の冒頭の注意。

**訂正と対策（2026-10-28。T21-pr）**: CLI の子も、Read の道具で stateDir のトークンを読めていた（FR_014 のフックは読み込みを制限しなかった）。いまは、stateDir と daemon の設定ファイルを、読み取りも範囲外にしている（自分の HOME と skill の写しは除く。拒否の文面には場所の種類だけを出す）。Bash は書かれたパスに見える語だけを見る歯止めで、確実ではない。詳しくは [`docs/desktop-runtime.md`](desktop-runtime.md) の冒頭の注意。

## 検証（`pnpm check` に入っている）

`node scripts/validate-plugin.mjs`（`pnpm validate:plugin`。先に `pnpm build` が要る）が、次を検査する。検査の中身は `scripts/plugin-check.mjs`、試験は `scripts/plugin-check.test.mjs`（`node --test scripts/*.test.mjs`）。

- plugin.json の必須項目・name（kebab-case）・version（semver）。`agents/`・`hooks/`・`skills/` がある。
- skill（`SKILL.md`）と command の frontmatter（`name` は、skill ではディレクトリ名と同じ。`description` は必須）。`hooks/hooks.json` があれば、JSON として正しく、形が正しい（イベントは PreToolUse・PostToolUse・Stop だけ、Stop に matcher を書かない、`type: "command"`、command は `node "${CLAUDE_PLUGIN_ROOT}/<plugin の中の .mjs>"` でそのファイルがある、timeout は 1〜60 秒）。スクリプトの試験は `scripts/cso-hook.test.mjs`。
- skill・command に書いた `mcp__node__<ツール名>` が、実際に公開されているツール（`packages/mcp` の `toolsFor`・`whoami`）にある。skill は、そのロールのツールだけを書き、**そのロールの全ツールを説明している**（ツールが増えたのに skill が古い、を防ぐ）。「説明している」とみなすのは、**行頭の箇条書きで、ツール名のあとに `:` と 10 文字以上の説明が続く行**（`- ` `` `mcp__node__<名前>` `` `: 説明…`）がある場合だけ。「使わない」と書いただけの言及は、説明にならない。
- NFR_012: plugin/ の中に、絶対パスがない。行頭・空白・引用符・`(`・`=` の直後の `/<英数字>/…` は、すべて拒否する（`/home/`・`/workspace/`・`/app/`・`/Volumes/`・`/c/Users/` など。`~/`・Windows のパス・`file://`・このリポジトリの絶対パスも）。**例外は、URL のパス（`://host` の後。例: `http://127.0.0.1:7777/v1/whoami`）と `${CLAUDE_PLUGIN_ROOT}`（とそれに続く plugin の中のパス）だけ**。
- frontmatter は、1 行の `key: value` だけ。複数行の値（`>`・`|`）は、検出できないので、エラーにする。
- `packages/mcp/dist/tools.js` が `src/tools.ts` より古ければ、「先に `pnpm build`」と表示して失敗する。
