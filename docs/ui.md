# HTML 画面（T23。FR_021・IR_003・NFR_008）

daemon の窓口が、状態を見るための HTML 画面を配る。**状態を見る（PR1・PR2）と、判断への回答（PR3）。** 拡張要求の判定（T23-b）・回収の指示（T23-c）・破壊的な操作（T23-d）は、まだ画面にない（`tasks.md`）。依存は増やさない（素の JavaScript。資産は TS の文字列として埋め込む）。

## 入口

| パス | 認証 | 内容 |
| --- | --- | --- |
| `GET /ui` | なし | HTML（状態を含まない） |
| `GET /ui/app.js`・`GET /ui/app.css` | なし | 画面の JS・CSS |
| `GET /v1/ui/state` | 人間のトークンだけ（それ以外は 403） | 表示モデル（`uiViewOf`。`{ok:true,value}`） |
| `GET /v1/events` | 人間のトークンだけ（それ以外は 403） | SSE（変更の通知。下の「更新（SSE）」） |

**静的な資産（`/ui`・`/ui/app.js`・`/ui/app.css`）には、回数の制限をかけない**（状態を含まず、認証もないため。`/v1/ui/state` は、主体ごとの回数の制限（T10l）の対象）。

どれも、既存の Host・Origin の検査（`127.0.0.1:<port>`・`localhost:<port>` だけ。DNS rebinding 対策）を通る。待ち受けは 127.0.0.1 だけ（変更なし）。

## 認証（人間のトークン）

- **推奨: ページに貼り付ける。** 人間のトークンのファイルの中身を、`/ui` を開いて出る入力欄に貼る。トークンはページのメモリにだけ置く（localStorage・sessionStorage・cookie には置かない）。リロードすると、また貼る。
- **代わりの方法: `/ui#token=…`。** フラグメントはサーバーへ送られず、ログにも残らない。ページは、読み込んだ**最初に**取り出して `history.replaceState` でアドレスから消す（試験で、最初の通信より前にあることを確かめている）。**ただし、ブラウザの履歴・ブックマーク・同期・拡張機能・シェルの履歴（`open` のコマンドなど）に、トークンを含む URL が残ることがある。** 共有の端末・同期するブラウザでは使わない。
- 以後の通信は `Authorization: Bearer` の header だけ。cookie を使わないので、CSRF の経路はない（操作も同じ）。

## 表示モデル（`uiViewOf`）

- 含める: ノード（`id`・役割・親・状態・依存・未解決の項目の数）、未解決の受信箱の項目（優先度の降順）、未回答の判断（質問・選択肢）、未判定の拡張要求（理由）。
- **含めない: トークン・秘密・パス（作業ツリーの絶対パス・最終コミット）・ブリーフ（目的・受け入れ基準）。** 試験で、これらの文字列が出ないことを確かめている。
- 子が書いた文字列（要約・質問・選択肢・理由）は、制御文字を除いて 200 文字に切る。識別子の形でないものは空にする。件数の上限（ノード 500・項目 200・判断 100・拡張要求 100）を超えたら切って、`truncated` に種類を入れる。画面は、`truncated` があるか、木に描けなかったノード（深さの打ち切り・親をたどれないもの）がある場合も、「一部省略」と表示する。人間のトークンでないもの（403）は、「人間のトークンが必要です」と表示し、401（トークンが正しくない）と分ける。

## 更新の効率（ETag）

`/v1/ui/state` は、`lastSeq` を鍵に、直近の 1 件の表示モデル（JSON）を使い回す（同じ `lastSeq` なら、作り直さない）。`ETag: "<lastSeq>"` を付け、`If-None-Match` が一致すれば 304（本文なし）。認証・ロールの検査は、304 の前に行う。画面は、前回の ETag を送り、304 なら描き直さない。

## 操作（T23 PR3）

画面から、**判断への回答だけ**ができる。人間のトークンで、既存の `POST /v1/request` に送る（新しい入口はない。`decision.answer`。認可は、daemon の既存の検査〔人間のロール〕に任せる。画面の出し分けは、表示上のもの）。

選択肢のボタン、または自由入力。自由入力は、画面で、空・空白だけ・4,000 文字超・制御文字（タブ・改行以外）・書式制御文字（U+202E・ゼロ幅など）を拒む（サーバーの検証〔`isBoundedText`〕と同じ規則。サーバーは 64 KiB まで許すが、子に渡る文なので、画面は厳しめ）。複数行は使える。入力中の文は、状態が更新されて再描画されても残る。

**確認と二重送信。**
- 押すと、すぐには送らず、「確認」の表示になる。判断の内容（ノード・質問）と、これから送る回答（選んだ選択肢・入力した全文）を、もう一度見せて、「この内容で送る」「戻る」を出す。
- 確認を出すたびに、`requestId`（`crypto.randomUUID()`）を新しく作る。その確認の間は、同じ ID で再送する（既存の重複排除で、同じ要求は、二重には実行されない）。送っている間は、ボタンを無効にする（二重クリックでも、要求は 1 回）。
- 失敗したら、`code: cause` を表示して、確認に戻る（同じ内容で再送できる）。429 は、`Retry-After` の秒数を表示する（自動の再送はしない）。成功したら、確認を閉じて、状態をすぐに取り直す。

**CSRF。** cookie を使わず、`Authorization: Bearer`（メモリのトークン）と `Content-Type: application/json` で送る。別のオリジンのページからは、Origin の検査（403）で拒まれ、フォームから送れる形（`text/plain` など）は 415 で拒まれる（`ui-operations.test.ts`）。操作は、主体ごとの回数の制限（T10l）の 1 要求として数える。`<form>` は使わない（トークンの入力欄だけ。`form-action 'none'` の CSP がある）。

## XSS・CSP

- 画面は、`textContent` と `createElement`（タグは `div`・`span`・`p` の許可リストだけ。実行時にも拒む）だけで描く。`innerHTML`・`outerHTML`・`insertAdjacentHTML`・`document.write`・`eval`・`new Function`・`setAttribute`・`on*` への代入・`location` への代入・`srcdoc`・storage・cookie・`postMessage`・`window.open`・動的 import は使わない（`ui-assets.test.ts` が走査で守らせる）。ブラケット記法の文字列キー、HTML を解釈する API（`setHTMLUnsafe`・`parseHTMLUnsafe`・`setHTML`・`createContextualFragment`・`DOMParser`）、`.href`・`.src`・`.action`・`.formAction` への代入、危ないタグ（`script`・`iframe`・`a`・`img`・`link`・`object`・`embed`・`form` など）の生成も禁じる。さらに、**許可リスト**として、`.` の後ろのプロパティ名を抜き出し、安全な集合にあるものだけを許す（新しい API を使うと、試験が落ちるので、意識して足す）。HTML にインラインの script・style・イベント属性を置かない。
- 応答のヘッダー: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`、`X-Frame-Options: DENY`、`Cross-Origin-Resource-Policy: same-origin`（資産と `/v1/ui/state`）。HTML には、さらに `Cross-Origin-Opener-Policy: same-origin` と `Permissions-Policy`（カメラ・マイクなどを許さない）。

## 更新（SSE。T23 PR2。NFR_008）

- **通知だけを送る。** `GET /v1/events`（人間のトークンだけ。`Authorization: Bearer`）は、`text/event-stream` で、`event: seq`・`data: {"lastSeq":N}` だけを送る（状態の中身は送らない）。画面が、通知を受けたら `/v1/ui/state` を取り直す（権限の判定・ETag・304 は、そこの 1 か所）。接続した直後に、今の `lastSeq` を 1 件送る（再接続の間の変化も、これで拾う）。
- **周期でまとめる。** daemon は、1 つの周期（既定 250ms）で、全ての接続を見て、`lastSeq` が変わっていれば通知する（短い間の連続した変化は、最新の 1 件）。接続がなければ、周期は止まる。変化から画面が変わるまでは、手元で約 0.2 秒（目標 2 秒以内）。
- **heartbeat と失効の確認。** 変化がなくても、15 秒ごとに、コメント行（`: heartbeat`）を送る（接続の維持と、切れた相手の検知）。トークンが今も使えるかの確認は、通知とは独立に、`heartbeatMs` ごとに必ず行う（通知が続いていても飛ばさない）。使えなければ、接続を閉じる。
- **背圧（遅い・止まった相手）。** `write()` が `false` を返したら、`drain` が来るまで、その接続には何も書かない（溜めない）。`drain` が 10 秒（`drainTimeoutMs`）来なければ、`destroy()` で切る。試験は、本物のソケット（読まない相手）で、`write()` が `false` になって切られること、読んでいる相手は切られないことを確かめている（`sse-backpressure.test.ts`。1 回の書き込みを大きくして詰まらせる）。
- **寿命。** 1 つの接続は、最大 1 時間（`maxLifetimeMs`）で閉じる。画面は、再接続する。なお、通知は小さく、カーネルのバッファは大きい（loopback で数 MB）ので、**通知だけでは、止まった相手でも、実際にはバッファが埋まらない**。そのため、止まっている接続は、背圧ではなく、**この寿命（1 時間）で切れる**ことになる（背圧の仕組みは、書き込みが大きい・多い場合の備え）。
- **上限。** 同時の接続は **4 本まで**（超えたら 429・`Retry-After`）。**それを超えたタブは、自動でポーリングに切り替わる**（画面は、`Retry-After` の秒数より前には、SSE に再接続しない。その間は、ETag つきのポーリングで取る）。接続の開始は、主体ごとの回数の制限（T10l）の 1 要求として数える。認証の失敗は、既存の失敗の回数制限に数える。通知そのものは数えない。
- **画面（fetch の ReadableStream。EventSource は header を付けられないので使わない）。** 切れたら、1 秒から 30 秒の指数バックオフ（揺らぎつき）で再接続する。再接続のたびに状態を取り直す（Last-Event-ID は要らない）。通知が続いても、状態を取り直すのは、最短 1 秒ごと（先頭で 1 回、間に来たものは末尾で 1 回にまとめる。サーバーの周期は 250ms のまま）。
- **SSE が使えない間は、ポーリングに切り替わる。** 接続できない・429・未対応のときは、2 秒ごとに `/v1/ui/state` を ETag つきで取る（変化がなければ 304）。SSE が上がっている間も、安全のために、30 秒ごとに取り直す。表示は「SSE」か「ポーリング」。

## 確かめ方

`docs/manual-verification-ui.md`。
