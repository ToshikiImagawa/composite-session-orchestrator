# T10w-2 調査: 孫プロセスから認証情報を隠す代替手段

- 対象: `@anthropic-ai/claude-agent-sdk` 0.3.292 と同梱 CLI 2.1.292（T10w と同じ）
- 前提: [T10w](./t10w-subprocess-env-scrub.md) の残余リスク。子に渡した `ANTHROPIC_*`・`CLAUDE_CODE_OAUTH_TOKEN`・`childEnvAllow` の認証情報が、孫プロセス（Bash・フック・stdio MCP）から見える。
- 調べた日: 2026-10-22
- 方法: SDK の型（`sdk.d.ts`）と CLI の実体の grep、公式ドキュメント（<https://code.claude.com/docs/en/sandboxing>）、この環境での最小の実験（Node と bash だけ。SDK の実起動はしていない）。
- 表記: **［確認］** はコード・ドキュメント・実験で確かめた事実、**［推測］** は確かめていない見立て。

## 結論（要約）

**条件つきで採る。** 採るのは `sandbox`（`sandbox.credentials.envVars` の deny）で、次の 3 つをそろえる。

- daemon を動かすのが Linux（bubblewrap・socat あり）または macOS である。
- `failIfUnavailable: true` と `allowUnsandboxedCommands: false` を合わせて指定する。
- 実機で動作を確かめる。

PreToolUse フックで Bash のコマンドを書き換えて変数を外す案は**採らない**。効かないことを実験で確かめた（後述）。

- 効く範囲は Bash（とその子）だけ。フック・stdio MCP は対象外（このリポジトリでは、フックは SDK のプロセス内コールバック、MCP は HTTP なので、現状は実害が小さい）。
- `dontAsk` は保てる見込み（ドキュメント上は両立する。実機では未確認）。
- 0.3.292 での実際の動作（子の Bash から変数が消えること、`dontAsk` と PreToolUse フックとの組み合わせ）は、bubblewrap も API の認証情報もないこの環境では確かめられなかった。**採る前に実機で確かめるのが条件**。
- macOS での挙動は確かめていない。

## 1. 環境変数を「外す」だけでは足りない（実験）

- ［確認・実験］同じ利用者のプロセスは、親の環境を `/proc/<pid>/environ` から読める。Node の親が `SECRETX` を持ち、子の bash には `SECRETX` を除いた環境を渡した。それでも子は `tr '\0' '\n' </proc/$PPID/environ` で `SECRETX=abc` を読めた（`own=0` で、自分の環境には無いことも確認）。`/proc/sys/kernel/yama/ptrace_scope` は 0。
- このため、PID 名前空間（新しい `/proc`）で親のプロセスを見えなくしない限り、環境変数を外す方法はどれも迂回できる。子の `claude` のプロセスは、`ANTHROPIC_*` などを自分の環境に持っている（API の呼び出しに使うため）。
- ［確認・ドキュメント］CLI のサンドボックス（Linux は bubblewrap）は新しい `/proc` を mount する。`enableWeakerNestedSandbox: true` にすると、コンテナの `/proc` をそのまま bind mount するので、この保護が弱まる（ドキュメントは「新しい `/proc` なら隠れるプロセス情報が見える」と明記）。T10w の SCRUB も、Linux では Bash を別の PID 名前空間で動かす。

## 2. 候補ごとの評価

### 2-1. `sandbox.credentials.envVars` の deny（SDK の `Options.sandbox`）

- ［確認・型］0.3.292 の `Options` には `sandbox?: SandboxSettings` がある（`settings` でも渡せる）。`SandboxSettings` は `credentials.envVars`・`credentials.files` を持ち、`mode` は `deny` または `mask`。
  - `settingSources: []` のままでも、`Options.sandbox` はコードから渡す設定なので効く［推測］。flag settings の層に入ると読める記述があるが、実機では確かめていない。
- ［確認・ドキュメント］`deny` の変数は、サンドボックス内の各コマンドの前に unset される。`deny` のファイルは読めなくなる。組み込みの拒否リストは無く、**列挙したものだけ**が対象（SCRUB の発見的な判定とは違う）。
  - 列挙の候補: `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_CUSTOM_HEADERS`、`CLAUDE_CODE_OAUTH_TOKEN`、`childEnvAllow` の各名前。`childEnvAllow` から自動で作れる（実装は別タスク）。
- ［確認・ドキュメント］対象は Bash・PowerShell・Monitor のコマンドとその子だけ。フック・ローカル（stdio）MCP・ステータスライン・`apiKeyHelper` などはサンドボックスの外で、全権限で動く。
- ［確認・ドキュメント］Linux・WSL2 は bubblewrap と socat が必要。サンドボックスが起動できないときは、既定ではサンドボックス無しで続く。`failIfUnavailable: true` で、起動を失敗にできる。
- ［確認・ドキュメント］ネットワークも許可したドメインだけに絞られる（`network.allowedDomains`）。子の Bash が使う通信先（npm・GitHub など）を列挙する必要があり、運用の負担になる。
- ［推測］このリポジトリの子は、loopback の MCP（HTTP）に CLI 本体からつなぐ。サンドボックスは Bash にだけ効くので、ここは影響を受けないはず。Bash から loopback へつなぐ作業がある場合は、`allowedDomains` に足すなどの対応が要る（ドキュメントに loopback の扱いの節がある）。未確認。
- `mask` は TLS の終端（`network.tlsTerminate`）が必要で、実験的な機能。今回は使わない（孫が API を叩く必要はないので、deny で足りる）。

### 2-2. PreToolUse フックで Bash を絞る、または書き換える

- ［確認・型］PreToolUse フックの出力には `updatedInput` がある。コマンドを `env -u ANTHROPIC_API_KEY … <元のコマンド>` に書き換えることはできる。
- ［確認・実験］しかし 1 章のとおり、孫は `/proc/$PPID/environ`（`claude` 本体の環境）から読めるので、**効かない**。
- コマンドの文字列を見て拒否する（`env`・`printenv`・`/proc/*/environ` を含むものを拒否する）方法も、文字列による判定なので、迂回する書き方がいくらでもある（`cat /proc/$(…)/environ`、スクリプトのファイル経由など）［推測。一般的な性質］。
- 有効なのは「Bash そのものを許可しない、または許可するコマンドをごく狭く列挙する」ことだけ。これは子の作業内容（テスト・ビルド）を大きく制限する。**単独の対策としては採らない**。サンドボックスと併用する防御の層としては有用（既存のフックがその役割）。

### 2-3. （参考）Claude Code 本体をサンドボックスの中で動かす

- ［確認・ドキュメント］`@anthropic-ai/sandbox-runtime` や dev container で `claude` ごと囲むと、フック・MCP も境界の中に入る。ただし本体と孫が同じ境界の中にいるので、孫から本体の環境を隠すことにはならない［推測］。目的（孫から隠す）には合わない。

## 3. `dontAsk` を保ったまま使えるか

- ［確認・ドキュメント］`sandbox` は権限モードではなく、`dontAsk` を変えない（T10w の SCRUB と違い、`default` への強制は無い。CLI の実体の grep でも、権限モードを強制するのは SCRUB の分岐だけだった）。
- ［確認・ドキュメント］`dontAsk` では、サンドボックスの外での再試行（`dangerouslyDisableSandbox`）は拒否される。さらに `allowUnsandboxedCommands: false` を指定すると、このパラメータ自体が無視される。
- ［確認・ドキュメント］`autoAllowBashIfSandboxed`（既定 true）は、サンドボックス内の Bash を確認なしで許可する。ただし Bash の deny ルールは、この場合も効く。
- ［推測］このリポジトリでは、PreToolUse フックがすべてのツール呼び出しに明示的な allow・deny を返す。フックの deny は自動許可より優先されるはずなので、フックで拒否した Bash は、サンドボックス内でも走らない見込み。0.3.292 の実機では未確認。安全側に倒すなら、`autoAllowBashIfSandboxed: false` を指定する。

## 4. 0.3.292 での実際の動作

- ［確認］型・ドキュメント・CLI の実体の上では使える（`Options.sandbox`、`credentials.envVars` の deny、`failIfUnavailable`、`allowUnsandboxedCommands`）。
- ［未確認］SDK から子を起動し、子の Bash で `env` と `/proc/$PPID/environ` を見て、列挙した変数が見えないことは確かめていない。この環境には bubblewrap も、子に渡せる API の認証情報も無いため。
- 採る前の最初の作業（実機で確かめる。Linux、bubblewrap・socat あり）:
  1. 次の設定で子を起動する: `permissionMode: "dontAsk"`、既存の PreToolUse フック、`sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, credentials: { envVars: [{ name: "ANTHROPIC_API_KEY", mode: "deny" }, …] } }`。
  2. 子の Bash で `env | grep -c ANTHROPIC` と `tr '\0' '\n' </proc/$PPID/environ | grep ANTHROPIC` が、どちらも何も出さないことを確かめる。
  3. フックで拒否した Bash が実行されないことを確かめる。
  4. bubblewrap が無いホストで、起動が失敗する（続行しない）ことを確かめる。
  5. 子の通常の作業（テスト・ビルド・loopback の MCP）が、ネットワークの許可リストの下で動くことを確かめる。

## 5. 推奨

| 候補 | 推奨 | 理由 |
| --- | --- | --- |
| `sandbox.credentials.envVars` の deny（＋`failIfUnavailable`・`allowUnsandboxedCommands: false`） | **条件つきで採る** | PID 名前空間込みで Bash の孫から隠せる唯一の手段。`dontAsk` を保てる。条件は 4 章の実機確認、bubblewrap のあるホスト、ネットワークの許可リストの運用 |
| PreToolUse フックでのコマンドの書き換え・文字列による拒否 | 採らない（防御の補助としては既存のまま） | `/proc/$PPID/environ` で迂回できることを実験で確かめた |
| SCRUB（T10w） | 採らない（T10w のとおり） | 権限モードを `default` に強制する |
| 本体ごとサンドボックスに入れる | 目的に合わない | 本体と孫が同じ境界の中にいる |

残余リスク（採っても残るもの）:
- フック・stdio MCP は対象外。現状は該当する子プロセスが無いので受け入れる。外部のコマンドのフックや stdio MCP を足すときに再評価する。
- 列挙していない秘密は守られない（`childEnvAllow` から自動で列挙すれば足りる）。
- ファイルの認証情報（`CLAUDE_CONFIG_DIR` 配下など）は、`credentials.files` の deny で別途扱う［推測。HOME の分離との組み合わせは未検討］。

## 確認に使ったもの

- `sdk.d.ts`（0.3.292）: `Options.sandbox`、`SandboxSettings`、`credentials.envVars`・`files`、`updatedInput`。
- CLI 2.1.292 の実体: `sandbox.credentials` の検証・合成の処理、`mask` の警告文。
- <https://code.claude.com/docs/en/sandboxing>: 「What runs outside the sandbox」「Protect credentials」「Sandbox modes」「The unsandboxed retry escape hatch」「Bubblewrap fails to start inside a container」。
- この環境での実験: `/proc/$PPID/environ` から親の環境変数を読めること。
