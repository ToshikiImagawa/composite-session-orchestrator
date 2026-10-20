#!/usr/bin/env bash
# ローカルと CI で共通のチェック。install 後に実行する。
set -euo pipefail
cd "$(dirname "$0")/.."

step() { printf '\n==> %s\n' "$1"; }

step "lint";            pnpm lint
step "build";           pnpm build
step "typecheck";       pnpm typecheck
step "test";            pnpm test
step "validate plugin"; pnpm validate:plugin
printf '\nAll checks passed.\n'
