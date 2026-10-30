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

0 成功 / 1 失敗・結果が確認できない / 2 引数・環境の誤り / 3 子のトークンの期限切れ（`cso child report` だけ）

**Desktop の木（設定 `childRuntime: "desktop"`）では、`cso purge`・`cso discarded-drop`・回収の指示（`node.reclaimInstruct`）は、すぐには実行されない**（T24-cf）。daemon は確認待ちにして `confirmationRequired` を返す（終了コード 1）。daemon の端末（`/dev/tty`）に出たコードを、画面（`/ui`）のいちばん上の「確認待ち」の欄に打つと、実行する。daemon が端末なしで動いているときは `confirmationUnavailable`（終了コード 1。端末から daemon を起動する）。CLI の子だけの木は、今までどおり。詳しくは [`docs/desktop-runtime.md`](desktop-runtime.md) の「取り消せない操作の確認」。

## Desktop の子が使う `cso child`（T21-cc）

`cso child bind`・`cso child report` は、Desktop の子が、daemon に紐付けて報告するためのコマンド。人間のトークン・環境変数（`CSO_DAEMON_URL` など）は使わない。使うのは、子の引き出し `<D>/<鍵>/`（daemon が 0700 で作る。`docs/desktop-runtime.md` の「子の引き出し」）のファイルと、引数の窓口の URL だけ。手順の文面は、`node.bindCode` が出す。

| コマンド | すること | 標準出力 |
| --- | --- | --- |
| `cso child bind --dir <引き出し> --url <窓口>` | 子が Write の道具で書いた `code` を確かめて読み、**送る前に消す**。`node`（daemon が書いたノード ID）と一緒に `POST /v1/bind` へ送る。受け取ったトークンを `token`、窓口を `url` に置く（一時ファイル〔O_EXCL・O_NOFOLLOW・0600〕に書いて rename） | `bound`、または失敗の記号 1 行 |
| `cso child report --dir <引き出し> --url <窓口> <種類>` | 本文（子が Write の道具で書いた引き出しの `report`。`code` と同じ確かめ方で読み、送る前に消す。64 KiB まで）を送る。種類は `progress`・`out-of-scope`（本文は文）、`decision`・`done`・`scope-extend`（本文は操作の params の JSON）の 5 つだけ（子のロールの操作） | 成功は `{ok, requestId, value}` の JSON。失敗は記号 1 行 |

- **コード・トークンは、引数にも、標準出力・標準エラーにも出さない。** 報告の本文は、引き出しの `report` から読む（コマンドの文字列に入らない）が、daemon の記録・受信箱・親の会話に残るので、秘密を書かない。
- ファイルは、lstat で種類（通常のファイル・リンクでない）・持ち主・リンクの数（1）・権限・大きさを確かめてから O_NOFOLLOW で開き、fstat で同じものかを確かめて読む。`code` は子が Write で書くので 0644 でよい（書き込みの権限がグループ・他者にないこと）。`token`・`url`・`node` は 0600 でなければ読まない。引き出しは、実のディレクトリ・持ち主が自分・0700。
- `--url` は、ループバックの http(s) の窓口だけ（パスなし。`127.0.0.1`・`localhost`・`[::1]`。`127.1` は `127.0.0.1` と同じに扱い、`localhost.`・`[::ffff:127.0.0.1]` は拒否する）。**`bind` と `report` には、同じ URL を書く**。`report` は、`--url` が `url` のファイル（紐付けた窓口）と違えば、トークンを送らない（`urlMismatch`）。
- **daemon の身元を確かめる**: `bind` はコードを送る前に、`report` はトークンを送る前に毎回、cso・cso-mcp と同じ仕組み（`/v1/identity`）で、窓口の相手が引き出しを作った daemon かを確かめる。秘密のファイルは、引き出しの場所から決まる `<stateDir>/daemon-identity`（引き出しは `<stateDir>/children.noindex/<鍵>`。ほかの場所の引き出しは `dirInvalid`）。確かめられなければ送らない（`daemonIdentityFailed`）。daemon が止まっている・起動し直している途中（秘密のファイルがない・接続の拒否・503）なら、cso-mcp と同じく最大 8 秒待ってかけ直し、尽きたら `daemonUnreachable`（daemon が戻ったら、同じコマンドをやり直す）。待ちの上限と、標準エラーの記録（`daemonRetry`・`daemonRecovered`・`daemonGaveUp`）の形は [`daemon-identity.md`](daemon-identity.md) の §3a。同じポートで別のプロセスが待ち受けていても、コード・トークンはそこへ送らない。
- `--dir` と値は、別の語にする（`--dir=値` の形は、作業範囲の判定で拒否される）。
- `bind` の順序: 引き出し → `node` を確かめる → `code` を読む（読めても読めなくても、すぐ消す）→ 身元を確かめる → 送る → `url` を置く → `token` を置く（`token` を置けなければ `url` も消す）。置いたあとに、ディレクトリを fsync する。
- daemon の失敗の文面は、コード・トークンを伏せ、制御文字を除き、長さを切ってから出す。`unauthenticated`（コードが使用済み・期限切れなど）のときも、会話で人（親）に `node.bindCode` での出し直しを頼むよう案内する。
- 期限切れ（`tokenExpired`）: 終了コード 3。`token` を消す。報告はもう通らないので、子は会話で人（親）に、`node.bindCode` で文面を出し直してもらう。届いた文面の手順（`code` を書く → `cso child bind`）で結び直す。
- 結果が分からない失敗（窓口から応答がない）は、同じ本文で `--request-id <出した ID>` を付けて送り直す（同じ要求として扱われる）。
- 終了コード: 0 成功・1 失敗・2 使い方の誤り・3 トークンの期限切れ。

**`cso child hook --dir <引き出し> --url <窓口>`（T21-ch）**: Desktop の子のフック（Claude Code の PreToolUse・PostToolUse・Stop）のコマンド。標準入力のフック入力を、引き出しの `hook-token`（daemon が spawn・`node.bindCode` のときに 0600 で置く。24 時間の絶対の期限）で `POST /v1/hook` へ送り、判定を返す（許可は終了コード 0、拒否は 2 で、標準エラーの文が拒否の理由としてモデルに伝わる）。送る前に、daemon の身元を確かめる。PreToolUse は、**cso が走り切ったときだけ**フェイルクローズ（届かない・形が違う・身元を確かめられない・`hook-token` がない・予期しない例外のときは、終了コード 2 で拒否）。429 で `Retry-After` が 2 秒以下なら、2 回まで送り直す。PostToolUse・Stop は判定しないので、失敗しても 0。トークンは出さない。
  - **守れないもの**: Claude Code は、フックが**終了コード 2 で終わったときだけ**拒否する。終了コード 1・cso が起動できない（127 など）・フックの時間切れは、**許可になる**。そのため、daemon が置く settings.json（T21-cs）では、PreToolUse のコマンドを `<cso> child hook … || exit 2`、PostToolUse・Stop を `… || true` にし、`timeout` を、cso の内側の時間の合計（身元の確認と、送る 8 秒）より十分長くする（必須の要件）。
  - Desktop の子の `/v1/hook` は、フック専用のトークンだけを受け付ける（ノードのトークンは 401）。
  - **daemon を再起動すると**、フック専用のトークンと、アダプタが持つ子の範囲（どちらもメモリだけ）が失われ、Desktop の子の道具は、すべて拒否される（拒否の文に「再起動」と出る）。人は、子を止めたと宣言して、作り直す。
  - **フック専用のトークンは、発行から 24 時間で切れ**、そのあと子の道具はすべて止まる。親か人が `node.bindCode` を出し直すと、フック専用のトークンと、ノードのトークン（結び直しのあと）の両方が新しくなる。起動したときに stopped だった子の引き出しの `hook-token` は、ほかのファイルと一緒に消す。daemon は、Desktop の子の bind・報告を、そのノードの PreToolUse のフックを直前（設定 `hookFreshSeconds`。既定 30 秒）に**許可していなければ** `hooksNotActive` で断る（拒否した呼び出しは数えない。`cso child bind`・`report` の Bash 自体がフックを通るので、フックが効いていれば、いつも通る）。**これは、設定の誤り（チップで作った子・フックのない子）を見つける検査で、敵対的な子は止められない**（子は、引き出しの `hook-token` を読んで、自分で `/v1/hook` を呼べる）。守りの本体は、フックの設定を書き換えさせない守り（T21-cs。[`docs/desktop-runtime.md`](desktop-runtime.md) の「見張り（FR_014 のフック）を Desktop の子に効かせる」）。

**子の作業範囲の判定（FR_014。`hook-policy.ts`）での扱い**: そのノード自身の引き出しだけ、禁じる場所（stateDir）の中のまま、次の 2 つを許す。(1) Bash の `cso child bind|report` の `--dir` の値（引き出しそのもの）。例外が効くのは、区切りの先頭の語が `csoCommand`（設定。なければ `cso` か末尾が `/cso` の語）と一致し、続く 2 語が `child` と `bind`・`report` の命令だけ。その命令の `--dir` が自分の引き出しそのものでなければ、拒否する。外すのは `--dir` の値だけで、ほかの語はふつうに判定する。(2) Write の道具で `<引き出し>/code`・`<引き出し>/report` を書くこと。引き出しの中のファイルの語（`token` とその一時ファイル `token.tmp-…` を含む）・グロブ・`cd`・読み取りの道具（Read・Glob・Grep など）は、禁じる場所のまま拒否する。ほかのノードの引き出しも拒否する。今これが効くのは CLI の子だけで、Desktop の子には、作業範囲外の拒否のフックが効くようになってから効く（`docs/desktop-runtime.md` の (a)）。

## 子の認証（daemon の起動の環境）

`cso` が使うのは人間のトークンだけだが、daemon が起動する子には、別に Claude の認証が要る。既定の `childHome: "isolated"` では、
`claude` CLI のログインだけの環境は、子の起動が `childAuthMissing` で拒否される。daemon を起動する環境に `ANTHROPIC_API_KEY`、または
`claude setup-token` で作った `CLAUDE_CODE_OAUTH_TOKEN` を入れる（または `childHome: "inherit"`）。詳しくは `docs/plugin.md` の「子の認証」。

