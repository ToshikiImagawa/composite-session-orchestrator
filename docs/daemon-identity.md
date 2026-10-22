# daemon の身元確認（T10m-i）

別のプロセスが、窓口のポート（`daemonUrl`）を奪うと、mcp の中継が、子のトークン（Bearer）を、偽の daemon へ送ってしまう。
これを防ぐために、**mcp は、トークンを送る前に、相手が本物の daemon か確かめる**。この文書は、daemon（実装 3）と mcp（実装 2）の**契約**。

## 仕組み（チャレンジ応答）

1. daemon は、**起動のたびに**、ランダムな秘密 `secret`（32 バイト）と、公開の `daemonId`（16 バイト）を作る。
2. `secret` は、`<stateDir>/daemon-identity`（0600）にだけ置く。窓口は `secret` を返さず、`proof`（HMAC）だけを返す。
3. mcp は、ファイルから `secret` を読み、ランダムな `nonce` で `GET /v1/identity` を呼び、同じ式で計算した `proof` と**定数時間で**比べる。
   一致したときだけ、トークンつきの要求（`GET /v1/whoami`・`POST /v1/request`）を送る。
4. ポートを奪っただけの相手は `secret` を知らない（ファイルは 0600 の `stateDir` の中）ので、`proof` を作れない。

## 1. 秘密のファイル

- 場所: `<stateDir>/daemon-identity`。`stateDir` は、daemon の設定ファイル（`--config`）の `stateDir`（絶対パス）。
- 権限: 0600。`stateDir` は 0700。
- 内容（JSON 1 行）:

```json
{"version":1,"daemonId":"<小文字の 16 進 32 桁>","secret":"<小文字の 16 進 64 桁>"}
```

- **作り直し**: daemon は、`start()` のたびに、新しい `daemonId`・`secret` を作り、**待ち受けを始める前に**、一時ファイルに書いてから置き換える。
  異常終了で古いファイルが残っていても、次の起動で必ず上書きされる。待ち受けが失敗したら、自分のファイルを消す。
- **削除**: daemon の停止（`stop()`）で、自分のファイルを消す（別の起動が上書きしたものは消さない）。
- 読む側の注意: `version` が 1 でない・形が違うときは、**ファイルを信用しない**（身元を確認できないものとして扱う）。

## 2. 窓口: `GET /v1/identity?nonce=<nonce>`

- **認証なし**（Bearer は不要。送らない）。Host・Origin の検査は、ほかの入口と同じ（`127.0.0.1:<port>`・`localhost:<port>`）。
- `nonce`: **小文字の 16 進**で、**32〜128 桁（16〜64 バイト）の偶数**。クエリは `nonce` を**ちょうど 1 つ**（余計なパラメータ・重複は 400）。
- 成功（200）:

```json
{"ok":true,"value":{"daemonId":"<32 桁の 16 進>","proof":"<64 桁の 16 進>"}}
```

- 応答には `Cache-Control: no-store`。`secret` は含まれない。
- 失敗: 400 `invalidRequest`（nonce が不正）、405 `methodNotAllowed`（GET 以外）、403 `invalidHost`、
  429 `tooManyRequests`（接続元ごとの回数の制限。`Retry-After` あり。ほかの入口と同じ bucket の仕組み）、503 `unavailable`（起動の途中で、まだ身元がない）。
- 回数の制限に入るので、**毎要求ごとに呼ばない**（下のキャッシュを使う）。

## 3. proof の計算

```
proof = hex( HMAC-SHA256( key  = secret を 16 進として解釈したバイト列（32 バイト）,
                          data = "cso-daemon-identity-v1" + "\0" + daemonId + "\0" + nonce ) )
```

- `data` は UTF-8。`\0` は NUL（1 バイト）。`daemonId`・`nonce` は、**文字列（16 進）のまま**つなぐ（バイト列に戻さない）。
- 出力は小文字の 16 進 64 桁。
- 比較は**定数時間**（`crypto.timingSafeEqual` など。長さが違えば不一致）。

**試験ベクトル**（両側の実装が、この値になること）:

| 項目 | 値 |
| --- | --- |
| daemonId | `00112233445566778899aabbccddeeff` |
| secret | `ff` を 32 個（`ffff…ff`、64 桁） |
| nonce | `0123456789abcdef0123456789abcdef` |
| proof | `1fb4d3ef33530736dc4f9c6258ea01b10e8300a6eac867298eadf58b76ccad92` |

## 4. mcp の手順（契約）

1. **いつ**: 起動時、と、トークンつきの要求を送る前（検証済みの結果のキャッシュが切れていれば）。
2. **検証**: 新しいランダムな `nonce`（16〜64 バイトの乱数を 16 進にしたもの）で `GET /v1/identity` を呼ぶ。
   応答の `daemonId` が、ファイルの `daemonId` と一致し、`proof` が一致すれば成功。
3. **失敗したとき（1 度だけやり直す）**: daemon が再起動すると、`secret` が変わる。**検証に失敗したら、ファイルを読み直して、1 度だけ**やり直す。
   それでも失敗なら、**トークンを送らず**、失敗コード `daemon_identity_failed` で失敗させる（原因に、`secret`・`proof`・トークンを出さない）。
   接続できない・429・503 は、身元の失敗ではなく、通常の接続の失敗として扱う（429 は `Retry-After` に従う）。
4. **キャッシュ**: 成功した結果は、**最長 30 秒**まで使い回してよい。応答の `daemonId` が、キャッシュ済みの値と変わったら、キャッシュを捨てて、検証をやり直す
   （`daemonId` は、トークンつきの要求の前に、`/v1/identity` で確かめた値）。
5. **`--config` がないとき**: 検証できないので、**警告を出して、検証なしで動く**（従来の動き）。`--config` を使う形が、標準の起動手順。
   `--config` があるのに、ファイルが読めない・形が違うときは、**検証に失敗したものとして扱う**（トークンを送らない）。
6. ファイルは、毎回開き直して読む（古い `secret` を、メモリに長く持たない。読み直しの 1 度を含む）。

## 5. 脅威モデル（範囲）

- **守れるもの**: daemon が落ちている間や、起動の前に、別のユーザー・別のプロセスが、窓口のポートを奪ったとき。`secret` を知らないので、`proof` を作れない。
  mcp は、トークンを送らない。
- **守れないもの（範囲外）**:
  - **同じユーザーの別プロセス**: 0600 のファイルを読めるので、`secret` を取れる。同じユーザーで動くコードは、もともと信頼の範囲内（トークンのファイルも同じ）。
  - **中継（MITM）**: 本物の daemon の前に立って、`/v1/identity` を本物へ転送し、その後のトークンつきの要求も転送する相手。ポートを奪ったうえで、本物も動いている状況が必要で、
    その相手は、本物の daemon が受ける要求を、そのまま転送できる。`secret` の保護ではなく、ポートの占有の防止（`stateDir`・ポートの設定）で守る。
  - **子 → mcp の方向**（子が `mcpUrl` の偽物へトークンを送る）: 子の MCP クライアント（SDK）の外なので、この仕組みでは扱わない。別の課題（T10m-j）。
- `secret` は、ログ・応答・エラーに出さない。

## 6. daemon の実装（参考）

- `packages/daemon/src/api/identity.ts`（`createIdentity`・`proofOf`・`writeIdentityFile`・`removeIdentityFile`・`parseIdentityFile`・`isValidNonce`）。
- 窓口は `packages/daemon/src/api/server.ts` の `handleIdentity`。`createDaemon` の `start()` が、ファイルを書いてから待ち受ける。`RunningDaemon.identityPath`。
- 試験: `packages/daemon/test/api/identity.test.ts`（試験ベクトル）・`packages/daemon/test/compose.test.ts`（実 HTTP）。
