# HTML 画面（T23。FR_021・IR_003・NFR_008）

daemon の窓口が、状態を見るための HTML 画面を配る。**PR1 は読み取りだけ**（操作は T23 の PR3 で、PR1・PR2 のあとに決める）。依存は増やさない（素の JavaScript。資産は TS の文字列として埋め込む）。

## 入口

| パス | 認証 | 内容 |
| --- | --- | --- |
| `GET /ui` | なし | HTML（状態を含まない） |
| `GET /ui/app.js`・`GET /ui/app.css` | なし | 画面の JS・CSS |
| `GET /v1/ui/state` | 人間のトークンだけ（それ以外は 403） | 表示モデル（`uiViewOf`。`{ok:true,value}`） |

どれも、既存の Host・Origin の検査（`127.0.0.1:<port>`・`localhost:<port>` だけ。DNS rebinding 対策）を通る。待ち受けは 127.0.0.1 だけ（変更なし）。

## 認証（人間のトークン）

- **推奨: ページに貼り付ける。** 人間のトークンのファイルの中身を、`/ui` を開いて出る入力欄に貼る。トークンはページのメモリにだけ置く（localStorage・sessionStorage・cookie には置かない）。リロードすると、また貼る。
- **代わりの方法: `/ui#token=…`。** フラグメントはサーバーへ送られず、ログにも残らない。ページは、読み込んだ**最初に**取り出して `history.replaceState` でアドレスから消す（試験で、最初の通信より前にあることを確かめている）。**ただし、ブラウザの履歴・ブックマーク・同期・拡張機能・シェルの履歴（`open` のコマンドなど）に、トークンを含む URL が残ることがある。** 共有の端末・同期するブラウザでは使わない。
- 以後の通信は `Authorization: Bearer` の header だけ。cookie を使わないので、CSRF の経路はない（PR3 で操作を足すときも同じ）。

## 表示モデル（`uiViewOf`）

- 含める: ノード（`id`・役割・親・状態・依存・未解決の項目の数）、未解決の受信箱の項目（優先度の降順）、未回答の判断（質問・選択肢）、未判定の拡張要求（理由）。
- **含めない: トークン・秘密・パス（作業ツリー・作業範囲の場所・最終コミット）・ブリーフ（目的・受け入れ基準）。** 試験で、これらの文字列が出ないことを確かめている。
- 子が書いた文字列（要約・質問・選択肢・理由）は、制御文字を除いて 200 文字に切る。識別子の形でないものは空にする。件数の上限（ノード 500・項目 200・判断 100・拡張要求 100）を超えたら切って、`truncated` に種類を入れる。

## XSS・CSP

- 画面は、`textContent` と `createElement` だけで描く。`innerHTML`・`outerHTML`・`insertAdjacentHTML`・`document.write`・`eval`・`new Function`・`setAttribute`・`on*` への代入・`location` への代入・`srcdoc`・storage・cookie・`postMessage`・`window.open`・動的 import は使わない（`ui-assets.test.ts` が走査で守らせる）。HTML にインラインの script・style・イベント属性を置かない。
- 応答のヘッダー: `Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Cache-Control: no-store`、`X-Frame-Options: DENY`。

## 更新（PR1）

2 秒ごとのポーリング（`/v1/ui/state`）。NFR_008（2 秒以内）には届かないことがあるので、PR2 で SSE（変更の通知）に置き換える。ポーリングは、SSE が切れたときの代わりとしても残す。

## 確かめ方

`docs/manual-verification-ui.md`。
