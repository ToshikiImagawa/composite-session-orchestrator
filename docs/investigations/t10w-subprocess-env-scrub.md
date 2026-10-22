# T10w 調査: `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`

- 対象: `@anthropic-ai/claude-agent-sdk` 0.3.292（リポジトリで固定）と、同梱の CLI `@anthropic-ai/claude-agent-sdk-linux-x64` 0.3.292（`claude --version` → `2.1.292 (Claude Code)`）
- 調べた日: 2026-10-22
- 方法: `pnpm install --frozen-lockfile --ignore-scripts`（依存は変更なし）で入れた実体を grep、公式ドキュメント（<https://code.claude.com/docs/en/env-vars>）を参照、同梱 CLI を最小限起動。
- 表記: **［確認］** はコード・ドキュメント・実行で確かめた事実、**［推測］** は確かめていない見立て。

## 結論（要約）

**採らない（現時点）。条件がそろえば再検討**。

- 効果はある: 子（SDK が起動する `claude`）が Bash・フック・stdio MCP として起動するプロセスから、`ANTHROPIC_API_KEY`・`CLAUDE_CODE_OAUTH_TOKEN` など、許可リストで子に**渡している**認証情報を除ける。許可リストだけでは防げない穴を埋める。
- しかし 0.3.292 では、有効にすると (1) **bubblewrap が必須**（無ければ子が起動しない）、(2) **権限モードが `default` に強制**され、このリポジトリの設計 `permissionMode: "dontAsk"` が効かなくなる。(2) は権限の設計そのものを変えるため、単純に足すことはできない。

## 1. 何をするものか

- ［確認・ドキュメント］`1` にすると、Claude Code が起動するサブプロセス（Bash コマンド、フック、stdio MCP サーバー）の環境から認証情報を除く。Claude Code 本体は自分の API 呼び出しのために認証情報を保持する。判定は**変数名または値の形**による（拒否リスト・発見的方法）。
  - 除く: `ANTHROPIC_API_KEY`・`AWS_SECRET_ACCESS_KEY`、名前が認証情報らしいもの（`NPM_TOKEN`・`DB_PASSWORD`）、値にパスワードを含む `DATABASE_URL`、`CLAUDE_CONFIG_DIR`。
  - URL の中の利用者名・パスワードだけ切る: `PIP_INDEX_URL`・`NPM_CONFIG_REGISTRY`。
  - 残す: `GITHUB_TOKEN`・`GH_TOKEN`・`GH_ENTERPRISE_TOKEN`・`GITHUB_ENTERPRISE_TOKEN`、`HTTP(S)_PROXY`（URL 内の認証情報も）、`GIT_CONFIG_*`、名前も値も認証情報らしくない秘密。
  - Linux では Bash サブプロセスを別の PID 名前空間で動かし、`/proc` から親の環境を読めなくする（副作用で `ps`・`kill` がホストのプロセスを見られない）。
  - `claude-code-action` は `allowed_non_write_users` 設定時に自動で有効にする。
- ［確認・CLI の実体］除く処理は **CLI（子）の中**、サブプロセスを起動する直前の環境の組み立てで行われる（SDK の `sdk.mjs` は変数名を一覧に持つだけで、除く処理はない）。名前の一覧 `bo`（`ANTHROPIC_API_KEY`・`CLAUDE_CODE_OAUTH_TOKEN`・`ANTHROPIC_AUTH_TOKEN`・`ANTHROPIC_CUSTOM_HEADERS`・`AWS_SESSION_TOKEN`・`AWS_BEARER_TOKEN_BEDROCK`・`GOOGLE_APPLICATION_CREDENTIALS`・`AZURE_CLIENT_SECRET` ほか、`INPUT_` 付きも）と、名前の正規表現（`TOKEN`・`SECRET`・`PASSWORD`・`KEY`・`AUTH`・`COOKIE`・`PAT`・`DSN`・`CREDENTIAL(S)` など）、値の形の判定がある。シェルのスナップショットにも、同じ一覧で `unset` する処理が組み込まれる。
- ［確認・CLI の実体］値の解釈: `1/true/yes/on` で有効。未設定でも `GITHUB_ACTIONS` が真なら有効（`0/false/no/off` で明示的に無効化）。settings の `env` からは設定できず、起動時の環境変数として渡す必要がある（`re` 集合に含まれ、起動環境が優先）。

## 2. 0.3.292 で使えるか

- ［確認］使える。同梱 CLI 2.1.292 の実体に実装がある（ドキュメントの「v2.1.251 より前は 2 変数のみ」に対し、2.1.292 は拡張後の版）。
- ［確認・実行］この環境（bubblewrap 無し）で `env -i ... CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 claude -p hi` を実行すると、起動時に次で失敗した。`=0` では起動した（ダミーの鍵のため API エラーで終了）。

  ```
  Error: bubblewrap is required for subprocess env scrubbing and isolation. Install with: sudo apt-get install -y bubblewrap, set sandbox.bwrapPath in managed settings, or set CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=0 to disable (loses subprocess isolation).
  ```
- ［確認・CLI の実体］有効時の制約:
  - 権限モードを `default` に強制する。CLI・継承・エージェント定義のいずれかで `default` 以外（`dontAsk` を含む）が指定されると、「Permission mode forced to default — CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is set (allowed_non_write_users hardening). Declare allowedTools explicitly…」を出して `default` にする。
  - `--await-claim`（予備プロセスの取り置き）と併用できない。
- ［推測］macOS では bubblewrap が無いため、Linux と同じ隔離は無い（未確認。macOS での挙動は確かめていない）。

## 3. 子の環境変数の許可リスト（`packages/daemon/src/sdk/child-env.ts`, #45）との比較

| 観点 | 許可リスト（#45） | SCRUB |
| --- | --- | --- |
| 効く場所 | daemon → 子（`claude`）の環境 | 子 → 孫（Bash・フック・stdio MCP）の環境 |
| 方式 | 許可した名前だけ通す（既定で拒否） | 認証情報らしいものを除く（既定で通す） |
| `GH_TOKEN` など | 子に渡さない | 孫に**残す** |
| `ANTHROPIC_*`・`CLAUDE_CODE_OAUTH_TOKEN` | 子に渡す（認証に必要） | 孫から除く |
| `childEnvAllow` で足した AWS・GCP 等の認証 | 子に渡す | 孫から除く（名前・値が認識できれば） |
| `CLAUDE_CONFIG_DIR` | 子に渡す | 孫から除く |

- 得: 許可リストで**子には渡す必要がある**認証情報（`ANTHROPIC_*`、OAuth トークン、`childEnvAllow` の追加分）が、子の Bash 等へ漏れるのを防げる。これは許可リストだけでは原理的に防げない（［確認］許可リストは子の環境を決めるだけで、子が孫に何を渡すかには関与しない）。
- 二重・害: 除く対象の重なり（`GH_TOKEN` 等）は、許可リストが先に除くので実害はない（SCRUB は残す側なので、重なっても矛盾しない）。害は重なりではなく**副作用**: bubblewrap 必須、権限モードの強制、PID 名前空間による `ps`/`kill` の制限、孫が `CLAUDE_CONFIG_DIR` を受け取れない（［推測］孫で `claude` を入れ子に起動する使い方があれば、HOME 分離の前提が崩れる可能性）。
- 足す場合の実装（参考・未実装）: `DEFAULT_CHILD_ENV` に名前を足すのではなく、`childEnv()` の結果に `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` を固定で入れる形になる（親の環境にある値を写すのでは、有効かどうかが daemon の起動環境次第になるため）。

## 4. 子が Bash などで起動するプロセスへの秘密の受け渡しを防げるか

- ［確認・ドキュメント／実体］**部分的に防げる**。名前・値で認識できる認証情報は孫の環境から除かれ、Linux では `/proc` 経由で親の環境を読むことも PID 名前空間で塞がれる。
- 防げないもの［確認・ドキュメント］: `GITHUB_TOKEN`/`GH_TOKEN`（意図的に残す）、プロキシ URL 内の認証情報、`GIT_CONFIG_*`、名前も値も認証情報らしくない秘密。ドキュメント自身が「唯一の対策にせず、権限ルールと併用」と書いている。
- 環境変数以外の経路は対象外［推測］: ファイル（`~/.claude/.credentials.json`、`CLAUDE_CONFIG_DIR` 配下）を孫が読むことは SCRUB では防げない。そこは HOME の分離（既存の設計）とサンドボックス（`sandbox.credentials` の deny）で扱う領域。
- このリポジトリでは、`GH_TOKEN` 等は許可リストで既に子に渡していないため、SCRUB の「GitHub トークンを残す」穴は実害にならない。

## 5. 推奨

**採らない（現時点）**。以下が全部そろったら「採る」で再検討する（条件つき）。

1. 権限の設計を `dontAsk` から、`default` ＋明示的な `allowedTools`（＋ `canUseTool` または PreToolUse フックで拒否）に移してよいと判断できる。［推測］SDK で `default` のとき、許可していない操作は `canUseTool` に回るか、無ければ拒否になるはずだが、0.3.292 での挙動は実機で未確認（要検証）。
2. daemon を動かす全ホストで bubblewrap が使える（Linux 限定でよい、または macOS での挙動を確認済み）。無ければ子が起動しないため、起動前に検査して分かりやすく失敗させる必要がある。
3. `--await-claim`（予備プロセス）を使う予定がない。

根拠:
- 得（子に渡す認証情報を孫から隠す）は本物で、許可リストと補い合う。
- しかし 0.3.292 では有効化が権限モードの強制を伴い、`claude-launcher.ts` の `permissionMode: "dontAsk"` の前提（事前に許可していない操作は確認せず拒否）を黙って変える。これは「HOME の分離の補強」という T10w の範囲を超える設計変更で、単独で入れると権限の挙動が変わる危険の方が大きい。
- bubblewrap の有無で子の起動が失敗するため、運用上の依存も増える。

代替（参考）: 孫への受け渡しを減らすだけなら、SCRUB を使わずに、子の `settings` の `sandbox.credentials` の deny や、Bash の許可を絞る既存の PreToolUse フックで対処する余地がある（未調査）。

## 確認に使ったもの

- `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-x64@0.3.292/.../claude`（2.1.292）: 文字列 `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` が 14 箇所。bubblewrap 必須のエラー、権限モード強制、`--await-claim` 併用不可、除く名前の一覧と正規表現。
- `@anthropic-ai/claude-agent-sdk` 0.3.292 の `sdk.mjs`・`bridge.mjs`: 変数名の一覧（列挙）にあるのみ。
- <https://code.claude.com/docs/en/env-vars>「What the subprocess environment scrub removes」。
