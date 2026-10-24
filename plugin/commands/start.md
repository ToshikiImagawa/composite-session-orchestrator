---
description: daemon と cso-mcp の起動を確かめ、統合ノードとして使えるようにする（起動の手順は、設定ファイルのパスを環境変数で受ける）
allowed-tools: mcp__node__whoami, mcp__node__tree_list
---

composite-session-orchestrator を使えるようにします。リポジトリやファイルの場所は、この指示に埋め込まれていません。次のとおり、環境変数か、人間に尋ねて決めます。

1. まず、`mcp__node__whoami` を呼ぶ。`role` が `integrator` で返れば、すでに接続できている。手順 4 へ進む。
2. 接続できなければ（ツールが見えない、または失敗）、人間に、次の 2 つを尋ねる（環境変数 `CSO_DAEMON_CONFIG`・`CSO_DAEMON_URL` があれば、それを提案する。ない値は、勝手に決めない）。
   - daemon の設定ファイルのパス（`CSO_DAEMON_CONFIG`。`cso-mcp` も、この環境変数を読む）
   - daemon の窓口の URL（`CSO_DAEMON_URL`。daemon の起動時の出力に出る）
3. 次の起動の手順を、人間に示す（別の端末で行う。起動の順序は daemon → `cso-mcp` → 統合セッション）。トークンは、チャットに貼らせない。
   - `cso-daemon --config "$CSO_DAEMON_CONFIG"`
   - `cso-mcp --daemon-url "$CSO_DAEMON_URL" --config "$CSO_DAEMON_CONFIG"`
   - 統合セッションの MCP 設定に、サーバー名 `node`・種類 `http`・URL（設定の `mcpUrl`）・ヘッダ `Authorization: Bearer ${CSO_ROOT_TOKEN}` を足す。**トークンの値は、設定ファイルに書かず、環境変数 `CSO_ROOT_TOKEN` で渡す**（人間が、統合セッションを起動する端末で、daemon の状態ディレクトリの `root-token` の中身を設定する。チャットに貼らせない）。設定ファイル（`.mcp.json` など）には、変数の参照だけが残り、値は残らない。
   起動を、人間が済ませたら、手順 1 をやり直す。
4. `mcp__node__tree_list` で、木を見せる。`self` が「あなた」の行が、自分。続けて、`cso-integrator` の skill に従って作業する。

起動できないときは、原因（標準エラーの `daemon_identity_failed`・`identityCheckFailed` など）を、そのまま人間に伝える。身元の検証を回避する設定（`CSO_MCP_ALLOW_UNVERIFIED`）は、勧めない。
