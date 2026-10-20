# composite-session-orchestrator

複数の Claude セッションを「統合セッション 1 対 作業セッション n」の木構造（Composite パターン）で束ね、
人間が最上位の統合セッションとだけ対話すれば、並列に進む実装・レビュー・調査を依頼・把握・判断できるようにするシステム。

要求は [`.sdd/requirement/composite-session-orchestrator.md`](.sdd/requirement/composite-session-orchestrator.md) を参照。

## 構成

| パス | 役割 |
|:--|:--|
| `packages/core` | 木構造、状態遷移、回収判定、受信箱の整列。純粋関数のみで I/O を持たない |
| `packages/daemon` | イベントログ、ランタイムアダプタ（sdk / desktop）、フック受付、HTML 画面 |
| `packages/mcp` | MCP ツール定義、ロール別の公開、エラー設計 |
| `packages/cli` | 人間用コマンド（`orch purge` など） |
| `plugin` | Claude Code plugin（役割定義 skill、hooks、MCP 設定、起動コマンド） |
| `docs/spikes` | 実装前の技術検証の手順と結果 |

## 進め方

1. `docs/spikes/` の技術検証を実施し、結果を記録する
2. Claude Code で `/sdd-workflow:sdd-init` を実行し、CLAUDE.md と `CONSTITUTION.md` を整える
3. PRD をレビューする（prd-reviewer / front-matter-reviewer、`/clarify composite-session-orchestrator`）
4. `/generate-spec --ticket {チケット番号}` で仕様と設計に落とす

## セットアップ

Node 20 以上と pnpm 10.28.0（`packageManager` で固定）が必要です。

```bash
pnpm install --frozen-lockfile
pnpm check   # lint、typecheck、build、test、plugin 検証をまとめて実行（CI と同じ）
```

`pnpm validate:plugin` は `plugin/.claude-plugin/plugin.json` の JSON 構文、必須項目（name、version、description）、name の kebab-case、version の semver、`plugin/{agents,hooks,skills}` の存在を確認します。

個別に実行する場合は `pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test`、`pnpm validate:plugin` を使います。整形は `pnpm format` です。

パッケージ単体の `typecheck`・`test`（例: `pnpm --filter @cso/daemon test`）は、`@cso/core` を core のソースに別名解決するため、先にビルドしなくても動きます。本番の解決（core の `dist`）は、`pnpm check` の中の `scripts/check-core-resolution.mjs` が確かめます（`pnpm build` の後に実行）。

テストは Vitest と fast-check、lint と format は Biome を使います。依存パッケージ（MCP TypeScript SDK、Claude Agent SDK、SQLite ドライバ、zod）は未追加です。着手時点の最新版を確認し、各パッケージに追加して固定してください。
