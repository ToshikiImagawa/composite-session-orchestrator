# 手動確認のチェックリスト（人が実施する項目のまとめ）

残りの作業は、人の手での確認待ちである。手順は、いくつかの文書に分かれているので、この文書で **確認の項目・実施の順序・結果を書く欄・結果によって変わるタスク** を 1 つにまとめる。

- 手順の詳細は、各項目の「手順」のリンク先にある（この文書では書き写さない。食い違ったら、リンク先を正とする）。
- 秘密（トークン・紐付けコード）とパスは書かない（NFR_012）。結果の欄にも書かない。パスは `<作業ツリー>`・`<plugin のディレクトリ>` のように置き換える。
- 結果を書いたら、リンク先の文書の「結果の記録」にも、同じ内容を追記する（日付・版・環境）。
- 判定は「可」「不可」「条件付き」のいずれか。**条件付き**は、期待の一部だけを確かめられた、または確かめ方に制約があったときに使う。何が確かめられ、何が残ったかを、結果に分けて書く。条件付きの項目は、結果のまとめの表で、残りを「備考」に書く。

## 実施の順序（おすすめ）

| 順 | 区分 | 項目 | 必要なもの | 理由 |
|:--|:--|:--|:--|:--|
| 1 | CLI（実 SDK） | [A1. 子が skill を使える（T22-c）](#a1-子が-skill-を使えるt22-c) | Claude Code CLI・Agent SDK | Desktop が要らない。ほかの CLI の確認の土台（daemon・`cso-mcp` の起動）を兼ねる |
| 2 | CLI（plugin のフック） | [A2. ファイルで設定するフック（H1〜H6。T22-h・T22-hu）](#a2-ファイルで設定するフックh1h6t22-ht22-hu) | A1 と同じ環境 ＋ plugin | A1 で動かした daemon と子を、そのまま使える |
| 3 | Desktop（Spike 01） | [B1. 項目 4: MCP・フックの継承（最重要）](#b1-項目-4-mcpフックの継承最重要) | Claude Desktop | 結果で、T21（紐付けの手順）と T22 の Desktop の分が決まる。最初に行う |
| 4 | Desktop（Spike 01） | [B2. 項目 6: 子のセッション ID](#b2-項目-6-子のセッション-id) | B1 と同じ | B1 の子を、そのまま観察できる |
| 5 | Desktop（Spike 01） | [B3. 項目 5: 子の作業ディレクトリ](#b3-項目-5-子の作業ディレクトリ) | B1 と同じ | 起動の仕方だけを変えて試せる |
| 6 | Desktop（Spike 01） | [B4. 項目 1・2: 送信・停止の操作](#b4-項目-12-送信停止の操作) | B1 と同じ | 権限モードの組み合わせで時間がかかる |
| 7 | Desktop（Spike 01） | [B5. 項目 3: 完了と結果の取得](#b5-項目-3-完了と結果の取得) | B1 と同じ | B4 の子を完了させて確かめる |
| 8 | Desktop（Spike 01） | [B6. 項目 7: 親を閉じたときの子](#b6-項目-7-親を閉じたときの子) | B1 と同じ | 親を閉じる・アプリを再起動するので、最後に行う |
| 9 | Desktop（配線） | [C1. Desktop の子の紐付けと報告（T21）](#c1-desktop-の子の紐付けと報告t21) | B1 のうち 2 点（子が `curl` を実行できる〔`-H @-`・`-d @-`〕・prompt が人間のメッセージとして扱われる）が可 | B1 の結果を前提にする |
| 10 | Desktop（配線） | [C2. 停止の宣言を cli・画面から（T22d）](#c2-停止の宣言を-cli画面からt22d) | C1 の子 | C1 で作った子を止めて確かめる |

B1〜B6 は、Spike 01 の項目の番号と対応する（[`docs/spikes/01-desktop-spawn-task.md`](spikes/01-desktop-spawn-task.md) の「確認項目と結果」）。

## 共通の記録欄

版の書き方: 項目ごとに区切って追記する（例: `2.1.308（A1）／2.1.310（B）／…（C）`）。前の値は消さない。

| 欄 | 値 |
|:--|:--|
| 実施日 | 2026-10-26（A1） |
| 実施者 | Claude Code（人の依頼で実行。A1） |
| OS | macOS 26.5（A1） |
| Claude Code の版 | 2.1.308（A1） |
| Agent SDK の版 | 0.3.292（A1） |
| Claude Desktop の版（B・C） | |
| 権限モード（親・子。B・C） | |
| 権限モード（A） | `dontAsk`（daemon が SDK で起動する子の固定値。記録だけ） |

---

## A. CLI（Desktop が要らない）

### A1. 子が skill を使える（T22-c）

- **前提**: T22-c の `Skill` ツールの許可を含む版の daemon で行う。daemon の設定に `childPluginDir`（この plugin のディレクトリ）を指定する（[`docs/plugin.md`](plugin.md) の「daemon が起動する子に渡す skill」）。daemon と `cso-mcp` の起動は [`docs/manual-verification-sdk.md`](manual-verification-sdk.md) の「準備」「MCP サーバーの起動」。
- **手順**: 子を 1 つ作り（`node_spawn`）、子に作業させる。子の記録（トランスクリプト）と daemon の記録を見る。
- **期待する結果**（二重フックは、受け口に要求が来ないことでは確かめられない。下の注）:
  - 子が `Skill` ツールで `cso-child`（中間の統合ノードは `cso-integrator`）を読み、その手順に従って報告する（`report_progress`・`report_done` など）。
  - `Skill` ツールの呼び出しが、フックで拒否されない（`node.toolDenied` に出ない）。
  - フックが二重にならない: (1) `<状態の置き場>/child-plugin/` に `hooks/`・`commands/`・`.mcp.json` がない。(2) 子の標準エラーに、フックのスクリプトの一言 `[cso-hook]` が出ない（**見方**: daemon は、SDK の子の標準エラーを記録しない〔daemon の記録＝daemon の標準エラーの JSON の行には出ない〕。フックの一言は、子のセッションの記録〔子の HOME の下の `.claude/projects/<作業ツリーを表す名前>/<セッション ID>.jsonl`。`childHome: inherit` なら利用者の HOME、`isolated` なら daemon が子に用意した HOME〕に残るので、そのファイルを、フックの一言そのもの（`[cso-hook] CSO_DAEMON_URL と CSO_NODE_TOKEN がない…`）で調べる: `grep -c 'cso-hook\] CSO_DAEMON_URL と CSO_NODE_TOKEN がない'`〔0 なら出ていない。`cso-hook` だけで探すと、plugin の名前・パスに当たって誤検知する〕。記録に残らない版の Claude Code では、(1) だけで判定し、結果の欄にそう書く）（受け口の要求数では見分けられない: SDK の子には `CSO_DAEMON_URL`・`CSO_NODE_TOKEN` が渡らず、混ざってもスクリプトは素通しして受け口を呼ばないため）。
  - 起動時に `childPluginSkipped` が記録されない（設定したとき）。
- **結果**: **条件付き**（2026-10-26。Claude Code 2.1.308・Agent SDK 0.3.292・macOS 26.5）。
  - 可: 子が `Skill` ツールで `cso-child` を読めたと報告した（自己申告。子の記録〔トランスクリプト〕は残らないので、ツール呼び出しは見えない）。`node.toolDenied` は 0 件。`childPluginSkipped` なし。子は `report_done` で完了を報告した。
  - 可（フックが二重にならない）: daemon が子に渡す plugin（`<stateDir>/child-plugin/`）の中身は、`.claude-plugin/plugin.json` と `skills/`（`cso-child`・`cso-integrator` の `SKILL.md`）だけで、`hooks/`・`commands/`・`.mcp.json` がない。コードでも、子の環境に `CSO_DAEMON_URL`・`CSO_NODE_TOKEN` は渡らない。**「受け口 `POST /v1/hook` に子の要求が来ない」ことは、二重フックの有無を見分けられない**（環境変数がなければ、フックのスクリプトは何もせずに通すため）。中身を見る方法で確かめる。
  - 未確認: `Skill` ツールの呼び出しの記録による裏付け。子のセッションの記録（トランスクリプト）は、`~/.claude/projects` にも `~/Library/Caches/claude-cli-nodejs` にも残っておらず（MCP の接続ログだけ）、自己申告のまま。
  - 制約: 認証のため `childHome: "inherit"` で行った。既定の `isolated` では、`ANTHROPIC_API_KEY` なしでは、子が認証できず止まった（`claude` CLI のログインは引き継げない）。
  - その他の観察: `<repoRoot>/.claude/cso-worktree-files.json` で、作業ツリーに `.envrc` などが写り、子が読めた（[`worktree-seed-files.md`](worktree-seed-files.md)。A1 の期待とは別の確認）。
- **結果によって変わるタスク**: 不可なら T22-c を差し戻す（`options.plugins` の渡し方・`skills` の名前）。合格なら [`docs/plugin.md`](plugin.md) の「手動確認（未。実 SDK）」を「済」に、tasks.md の T22-c の状態を更新する。

### A2. ファイルで設定するフック（H1〜H6。T22-h・T22-hu）

- **前提**: [`docs/manual-verification-sdk.md`](manual-verification-sdk.md) の「ファイルで設定するフック（T22-h。CLI のセッション）」の前提（daemon が範囲を持つ子を管理している。人間が `eval "$(cso hook-env <nodeId>)"` でその子のフック専用のトークン〔T22-ht〕を環境変数に入れ、その子の作業ツリーで、同じシェルから plugin つきの CLI のセッションを起動する）。仕組みは [`docs/plugin.md`](plugin.md) の「フック」。`cso` の実行ファイル（T22-cli）は、`CSO_DAEMON_URL`・`CSO_HUMAN_TOKEN` を設定して使う。
- **手順**: 同じ節の表の H1〜H6。

| # | 確認 | 期待する結果（要約。詳細はリンク先） | 結果 |
|:--|:--|:--|:--|
| H1 | フックが発火する | PreToolUse・PostToolUse・Stop で動く。範囲内の書き込みは許可 | |
| H2 | 範囲外の書き込みの拒否と記録 | 拒否され、理由がモデルに伝わる。`scope.violation` と受信箱の violation 1 件。未知のツールは `node.toolDenied` | |
| H3 | `settingSources` の混入がない | SDK で起動する子に、plugin のフックが混ざらない。**受け口の要求数では見分けられない**: SDK の子には `CSO_DAEMON_URL`・`CSO_NODE_TOKEN` が渡らないので、plugin の hooks.json が混ざっても、フックのスクリプトは素通しして、受け口を呼ばない（`apiSummary` の `hook` は 0 のまま）。代わりに次の 2 つで確かめる。(1) `<状態の置き場>/child-plugin/` に `hooks/`・`commands/`・`.mcp.json` がない（`skills/` と `.claude-plugin/plugin.json` だけ）。(2) SDK の子の標準エラーに、フックのスクリプトの一言 `[cso-hook]` が出ない（**見方**: daemon は、SDK の子の標準エラーを記録しない〔daemon の記録＝daemon の標準エラーの JSON の行には出ない〕。フックの一言は、子のセッションの記録〔子の HOME の下の `.claude/projects/<作業ツリーを表す名前>/<セッション ID>.jsonl`。`childHome: inherit` なら利用者の HOME、`isolated` なら daemon が子に用意した HOME〕に残るので、そのファイルを、フックの一言そのもの（`[cso-hook] CSO_DAEMON_URL と CSO_NODE_TOKEN がない…`）で調べる: `grep -c 'cso-hook\] CSO_DAEMON_URL と CSO_NODE_TOKEN がない'`〔0 なら出ていない。`cso-hook` だけで探すと、plugin の名前・パスに当たって誤検知する〕。記録に残らない版の Claude Code では、(1) だけで判定し、結果の欄にそう書く）（混ざっていれば、環境変数がないことを知らせる一言が、ツールの呼び出しのたびに出る） | |
| H4 | daemon 停止のときのフェイルクローズ | PreToolUse はすべて拒否。Stop は止めない | |
| H5 | 環境変数 | 両方なし: 素通し（標準エラーに一言）。片方だけ: 拒否 | |
| H6 | `session_id` の結び付け | 別のセッションは 403。`/clear`・`--resume` で変わると拒否され、`cso hook-unbind <nodeId>`（または画面のボタン・親の `node_hookUnbind`）のあと通る。記録に `node.hookUnbound`。子が止められて再開したあと（判断要求の `pauseNodeIds` で止め、回答で再開。画面の木で `stopped` → `running`、親の受信箱に回答）、手動のセッションは拒否され、`cso hook-env` から起動し直すと通る。子を止めない判断（`pauseNodeIds` なし）に回答したあとは、子は動作中のまま（停止の表示なし）で、手動のセッションがそのまま通る | |

- **結果によって変わるタスク**: H1〜H3 が不可なら T22-h を差し戻す（hooks.json の形・受け口）。H6 が不可なら T22-hu・T22-hub。合格なら tasks.md の T22-h の「手動確認は未」を更新する。

---

## B. Desktop（Spike 01 の項目 1〜7）

- **前提（B 全体）**: [`docs/spikes/01-desktop-spawn-task.md`](spikes/01-desktop-spawn-task.md) の「手動確認の手順」の「準備と記録」（ダミーのリポジトリ、3 種類の MCP サーバー、PreToolUse フックで Write を拒否してログに 1 行ずつ書く plugin）。親子とも、Desktop の Code タブで起動する。
- **手順**: 同じ文書の「手順と判定基準」。判定（可・条件付き・不可）の基準も、同じ文書にある。
- 結果は、同じ文書の「確認項目と結果」の表の判定の欄と、下の各欄に書く。

### B1. 項目 4: MCP・フックの継承（最重要）

- **期待する結果（可）**: 子が、最初の人間のメッセージの前から、3 種類の MCP ツールが見え、フックのログに行が出て、書き込みが拒否される。「ワークツリーで開始」「ローカルで開始」の両方で。
- **あわせて見る点**:
  - spawn_task の `prompt` が「人間のメッセージ」として扱われるか。
  - 子が `curl` を実行できるか。**トークンが `ps` に出ない形（`printf` から標準入力で `-H @-`・`-d @-`）で送れるか**（[`docs/desktop-runtime.md`](desktop-runtime.md) の「仮置きの一覧」の項目 4）。
- **結果**: （判定。ワークツリー／ローカルそれぞれ。最初のメッセージの前と後）
- **結果によって変わるタスク**:
  - 可・条件付き（MCP・フックが継承される）: 能力表の `hooks` を見直す（[`docs/desktop-runtime.md`](desktop-runtime.md) の「能力表」。`DESKTOP_CAPABILITIES` の 1 か所）。T22 の Desktop の分（子へのフックの継承）に進む。受け口が Desktop の子に許可を返さない仮置きを見直す。
  - `curl` が使える: T21 の案 A（子が `curl` で bind・報告する）を確定する。使えない: T21 の紐付けの手順を作り直す（MCP をあとから足すなど）。
  - 不可: 能力表は控えめな値のまま。フックのゲート（`desktopRequireVerifiedHooks`）は有効のまま。T21・T22 の Desktop の分の方針を、統括と決め直す。

### B2. 項目 6: 子のセッション ID

- **期待する結果（可）**: 一覧・読み取りの結果か画面に出る ID が、トランスクリプトのファイル名と一致する。
- **結果**:
- **結果によって変わるタスク**: 可なら、Desktop のアダプタが `sessionId` にノード ID を入れている仮置きを、本物の ID に差し替える（T21。[`docs/desktop-runtime.md`](desktop-runtime.md) の「配線」）。不可なら仮置きのまま（記録の対応づけはノード ID で行う）。

### B3. 項目 5: 子の作業ディレクトリ

- **期待する結果（可）**: 別ディレクトリの `cwd` を渡すと、`git worktree list` に新しいワークツリーが出て、子の `pwd` がその中にある。
- **結果**:
- **結果によって変わるタスク**: 条件付き（主チェックアウトで始まる）・不可なら、Desktop の子の作業ツリーの用意の仕方（FR_006）を、統括と決め直す。

### B4. 項目 1・2: 送信・停止の操作

結果は、spike の文書の「確認項目と結果」の表の **項目 1 の行**（送信・停止以外の操作があるか）と **項目 2 の行**（送信できるか・停止できるか）の判定の欄に、それぞれ書く。

- **期待する結果**: 使えた操作名とエラー文。停止は「使えた／使えなかった／保留された」、メッセージは「合間に読んだ／作業の後に読んだ／届かなかった」で判定。権限モードの組み合わせと、5 分以上の放置も。配信経路（Desktop 内蔵 / SendMessage）をメッセージごとに書く。
- **結果**:
- **結果によって変わるタスク**: 停止・送信が使えるなら、能力表の `send`・停止の代行（`stopDelegated`）を見直す（T20）。使えないなら、停止は親への代行依頼と、停止の宣言（C2）のまま。

### B5. 項目 3: 完了と結果の取得

- **期待する結果（可）**: 完了と結果の両方を、親が人の操作なしで取得できる。`notify_when_idle` の通知が届くか。
- **結果**:
- **結果によって変わるタスク**: 条件付き（読みに行く必要がある）なら、子の完了の報告は `report.done`（`curl`。C1）に頼る方針のまま。

### B6. 項目 7: 親を閉じたときの子

- **期待する結果**: 子が存続する（最後まで走る）か、止まるか。アプリの再起動のあとも。ワークツリーの有無も記録する。
- **結果**:
- **結果によって変わるタスク**: [`docs/desktop-runtime.md`](desktop-runtime.md) の「再起動のあと」の仮置き（親を閉じても、記録では子は動作中のまま。人が確かめて止めたと宣言する）を、結果に合わせて確定する。

---

## C. Desktop の配線（T21・T22d。B1 のあと）

- **前提（C 全体）**: B1 のうち 2 点（子が `curl` を実行できる〔`-H @-`・`-d @-` が使える〕こと、spawn_task の prompt が人間のメッセージとして扱われること）が可。daemon の設定 `childRuntime: "desktop"`。フックのゲートは既定で有効なので、B1 の結果で能力表を見直すまでは、確認のためだけに `desktopRequireVerifiedHooks: false` にする（確認のあとで戻す）。仕組みは [`docs/desktop-runtime.md`](desktop-runtime.md) の「配線と紐付け（T21。仮置き）」。

### C1. Desktop の子の紐付けと報告（T21）

- **手順**: [`docs/desktop-runtime.md`](desktop-runtime.md) の「紐付けの手順（案 A）」の 1〜4（親が `node_spawn` → `node_bindCode` → `instruction` を spawn_task に渡す → 子が `curl` で bind・報告）。
- **期待する結果**:
  - 子が bind でき、`report_progress`・`report_done` が受信箱に届く。
  - トークン・紐付けコードが、`ps` のプロセス一覧に出ない。
  - 紐付けコードが、イベントログ・受信箱・記録に残らない。使ったコードは、もう使えない。
  - 中間の統合ノードは紐付けできない（`integratorNotSupported`）。
- **結果**:
- **結果によって変わるタスク**: 不可なら T21 の案 A を作り直す（B1 の結果と合わせて）。合格なら T21 の「仮置き」を外す（[`docs/desktop-runtime.md`](desktop-runtime.md) の「仮置きの一覧」と tasks.md の T21）。

### C2. 停止の宣言を cli・画面から（T22d）

- **前提**: C1 の子。daemon は、その子を直接止められない（能力表 `stopDelegated`）。
- **手順**:
  1. 親（または `cso` の停止）で子を止める → 受信箱に停止の代行依頼が出て、子は停止未完了（stopIncomplete）になる。
  2. Desktop の画面で、その子のタスクを止める（またはアーカイブする）。
  3. `cso confirm-stopped <nodeId> --note <根拠>` で宣言する。別の子で、HTML 画面の「止めたと宣言…」（ノード ID の打ち込み）でも宣言する（画面の確かめ方は [`docs/manual-verification-ui.md`](manual-verification-ui.md) の「停止の宣言（T22d）」）。
  4. daemon を再起動したあとも、同じことができるか（[`docs/desktop-runtime.md`](desktop-runtime.md) の「再起動のあと」）。
  5. 動いている Desktop の子がある状態で、daemon を再起動する。根の受信箱を見る。もう一度再起動して、また見る。そのあと、その子を止めたと宣言する。
- **期待する結果**: 停止済み（stopped）になり、宣言した者と根拠が記録に残り、代行依頼が解決済みになる。打ち込みが違えば送れない。再起動のあと、根の受信箱に（停止未完了の帯で）1 件出る。もう一度再起動しても増えない。止めたと宣言すると、その項目は解決済みになる。
- **結果**:
- **結果によって変わるタスク**: 不可なら T22d（cli・画面）か T20（`node.confirmStopped`）を差し戻す。合格なら tasks.md の T22d・T21 の手動確認を「済」にする。

---

## 結果のまとめ（統括に報告する表）

| 項目 | 判定 | 変わるタスク | 備考 |
|:--|:--|:--|:--|
| A1（T22-c） | 条件付き | T22-c は、skill の使用の裏付け（記録）が残る | 二重フックなし（plugin の中身で確認）。skill を読めた（自己申告。記録なし）。`inherit` で実施。`isolated` は認証で止まった |
| A2（H1〜H6） | | | |
| B1（項目 4） | | | |
| B2（項目 6） | | | |
| B3（項目 5） | | | |
| B4（項目 1・2） | | | |
| B5（項目 3） | | | |
| B6（項目 7） | | | |
| C1（T21） | | | |
| C2（T22d） | | | |
