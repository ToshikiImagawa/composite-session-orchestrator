# 依存パッケージの公開日の確認（2026-10-21）

T10b ④（Agent SDK の追加）で、`pnpm-lock.yaml` の全 207 パッケージについて、npm レジストリの公開日（`npm view <名前> time`）を確かめた結果。公開から 14 日（`minimumReleaseAge: 20160`）未満の版は、この PR の前から lockfile にあった開発用ツール（vitest とその推移的な依存）だけで、`pnpm-workspace.yaml` の `minimumReleaseAgeExclude` で版を指定して除外している（2026-10-29 以降は消せる）。

- 直接の依存（daemon）: `@anthropic-ai/claude-agent-sdk` 0.3.292、`@anthropic-ai/sdk` 0.131.0、`@modelcontextprotocol/sdk` 1.32.1（いずれも固定）。
- 公開から 14 日未満だった推移的な依存は、`overrides` で 14 日以上前の版に固定した: `@hono/node-server` 2.1.3、`@opentelemetry/api` 1.9.1、`express` 5.2.1、`fast-uri` 3.1.8、`ip-address` 10.7.3、`jose` 6.2.12、`qs` 6.16.0。

| パッケージ | 版 | 公開日 | 経過日数 | 備考 |
|:--|:--|:--|--:|:--|
| postcss | 8.5.31 | 2026-10-18 | 2 | 除外（既存の開発用ツール） |
| vitest | 5.0.5 | 2026-10-15 | 5 | 除外（既存の開発用ツール） |
| @vitest/spy | 5.0.5 | 2026-10-15 | 5 | 除外（既存の開発用ツール） |
| @vitest/mocker | 5.0.5 | 2026-10-15 | 5 | 除外（既存の開発用ツール） |
| rolldown | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @rolldown/binding-linux-x64-gnu | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @rolldown/binding-android-arm-eabi | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @rolldown/binding-win32-x64-msvc | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @rolldown/binding-linux-arm64-gnu | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @rolldown/binding-linux-s390x-gnu | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @rolldown/binding-darwin-arm64 | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @rolldown/binding-freebsd-x64 | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @rolldown/binding-android-arm64 | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @rolldown/binding-darwin-x64 | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @rolldown/binding-linux-arm-gnueabihf | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @rolldown/binding-linux-ppc64-gnu | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @rolldown/binding-linux-x64-musl | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @rolldown/binding-linux-arm64-musl | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @rolldown/binding-openharmony-arm64 | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @rolldown/binding-win32-arm64-msvc | 1.2.14 | 2026-10-14 | 6 | 除外（既存の開発用ツール） |
| @oxc-project/types | 0.154.0 | 2026-10-13 | 7 | 除外（既存の開発用ツール） |
| tinybench | 6.2.2 | 2026-10-10 | 10 | 除外（既存の開発用ツール） |
| @types/node | 26.6.5 | 2026-10-09 | 11 | 除外（既存の開発用ツール） |
| vite | 8.3.4 | 2026-10-08 | 12 | 除外（既存の開発用ツール） |
| @anthropic-ai/claude-agent-sdk | 0.3.292 | 2026-10-06 | 14 | この PR で追加 |
| @anthropic-ai/claude-agent-sdk-win32-arm64 | 0.3.292 | 2026-10-06 | 14 | この PR で追加 |
| @anthropic-ai/claude-agent-sdk-linux-x64-musl | 0.3.292 | 2026-10-06 | 14 | この PR で追加 |
| @anthropic-ai/claude-agent-sdk-win32-x64 | 0.3.292 | 2026-10-06 | 14 | この PR で追加 |
| @anthropic-ai/claude-agent-sdk-linux-x64 | 0.3.292 | 2026-10-06 | 14 | この PR で追加 |
| @anthropic-ai/claude-agent-sdk-linux-arm64-musl | 0.3.292 | 2026-10-06 | 14 | この PR で追加 |
| @anthropic-ai/claude-agent-sdk-linux-arm64 | 0.3.292 | 2026-10-06 | 14 | この PR で追加 |
| @anthropic-ai/claude-agent-sdk-darwin-x64 | 0.3.292 | 2026-10-06 | 14 | この PR で追加 |
| @anthropic-ai/claude-agent-sdk-darwin-arm64 | 0.3.292 | 2026-10-06 | 14 | この PR で追加 |
| express-rate-limit | 8.7.1 | 2026-10-06 | 15 | この PR で追加 |
| @modelcontextprotocol/sdk | 1.32.1 | 2026-10-05 | 15 | この PR で追加 |
| nanoid | 3.3.20 | 2026-10-05 | 15 |  |
| magic-string | 1.4.3 | 2026-10-05 | 16 |  |
| hono | 4.13.13 | 2026-10-04 | 17 | この PR で追加 |
| @types/node | 22.20.5 | 2026-10-01 | 19 |  |
| ip-address | 10.7.3 | 2026-10-01 | 19 | この PR で追加 |
| @anthropic-ai/sdk | 0.131.0 | 2026-09-30 | 20 | この PR で追加 |
| chai | 6.3.0 | 2026-09-30 | 20 |  |
| @biomejs/cli-win32-x64 | 2.5.15 | 2026-09-30 | 20 |  |
| @biomejs/cli-darwin-x64 | 2.5.15 | 2026-09-30 | 20 |  |
| @biomejs/cli-win32-arm64 | 2.5.15 | 2026-09-30 | 20 |  |
| @biomejs/cli-linux-x64 | 2.5.15 | 2026-09-30 | 20 |  |
| @biomejs/cli-linux-arm64-musl | 2.5.15 | 2026-09-30 | 20 |  |
| @biomejs/cli-linux-x64-musl | 2.5.15 | 2026-09-30 | 20 |  |
| @biomejs/cli-linux-arm64 | 2.5.15 | 2026-09-30 | 20 |  |
| @biomejs/biome | 2.5.15 | 2026-09-30 | 20 |  |
| @biomejs/cli-darwin-arm64 | 2.5.15 | 2026-09-30 | 20 |  |
| source-map-js | 1.2.2 | 2026-09-30 | 20 |  |
| std-env | 4.3.0 | 2026-09-29 | 21 |  |
| @hono/node-server | 2.1.3 | 2026-09-29 | 22 | この PR で追加 |
| fast-check | 4.10.2 | 2026-09-19 | 31 |  |
| fast-uri | 3.1.8 | 2026-09-15 | 36 | この PR で追加 |
| proxy-addr | 2.0.8 | 2026-09-15 | 36 | この PR で追加 |
| zod | 4.6.5 | 2026-09-13 | 37 |  |
| obug | 3.0.0 | 2026-09-09 | 42 |  |
| jose | 6.2.12 | 2026-09-05 | 45 | この PR で追加 |
| tinyexec | 1.3.1 | 2026-09-03 | 48 |  |
| qs | 6.16.0 | 2026-08-29 | 52 | この PR で追加 |
| standardwebhooks | 1.1.1 | 2026-08-28 | 53 | この PR で追加 |
| @jridgewell/sourcemap-codec | 1.6.0 | 2026-08-28 | 54 |  |
| picomatch | 4.0.7 | 2026-08-24 | 57 |  |
| negotiator | 1.1.0 | 2026-08-20 | 61 | この PR で追加 |
| es-module-lexer | 2.3.2 | 2026-08-17 | 65 |  |
| content-type | 2.1.0 | 2026-08-13 | 68 | この PR で追加 |
| node-addon-api | 8.9.2 | 2026-08-12 | 69 |  |
| eventsource-parser | 3.1.1 | 2026-08-10 | 71 | この PR で追加 |
| better-sqlite3 | 13.0.3 | 2026-08-05 | 77 |  |
| @types/better-sqlite3 | 9.6.0 | 2026-08-01 | 81 |  |
| undici-types | 8.9.0 | 2026-07-24 | 88 |  |
| media-typer | 1.1.1 | 2026-07-23 | 89 | この PR で追加 |
| lightningcss | 1.33.0 | 2026-07-20 | 93 |  |
| lightningcss-win32-x64-msvc | 1.33.0 | 2026-07-20 | 93 |  |
| lightningcss-win32-arm64-msvc | 1.33.0 | 2026-07-20 | 93 |  |
| lightningcss-linux-x64-musl | 1.33.0 | 2026-07-20 | 93 |  |
| lightningcss-linux-x64-gnu | 1.33.0 | 2026-07-20 | 93 |  |
| lightningcss-linux-arm64-musl | 1.33.0 | 2026-07-20 | 93 |  |
| lightningcss-linux-arm64-gnu | 1.33.0 | 2026-07-20 | 93 |  |
| lightningcss-linux-arm-gnueabihf | 1.33.0 | 2026-07-20 | 93 |  |
| lightningcss-freebsd-x64 | 1.33.0 | 2026-07-20 | 93 |  |
| lightningcss-darwin-x64 | 1.33.0 | 2026-07-20 | 93 |  |
| lightningcss-darwin-arm64 | 1.33.0 | 2026-07-20 | 93 |  |
| lightningcss-android-arm64 | 1.33.0 | 2026-07-20 | 93 |  |
| pure-rand | 8.4.2 | 2026-07-10 | 103 |  |
| typescript | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-win32-x64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-win32-arm64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-sunos-x64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-openbsd-x64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-openbsd-arm64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-netbsd-x64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-netbsd-arm64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-linux-x64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-linux-s390x | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-linux-riscv64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-linux-ppc64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-linux-mips64el | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-linux-loong64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-linux-arm64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-linux-arm | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-freebsd-x64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-freebsd-arm64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-darwin-x64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-darwin-arm64 | 7.0.2 | 2026-07-08 | 104 |  |
| @typescript/typescript-aix-ppc64 | 7.0.2 | 2026-07-08 | 104 |  |
| iconv-lite | 0.7.3 | 2026-07-03 | 109 | この PR で追加 |
| range-parser | 1.3.0 | 2026-06-25 | 117 | この PR で追加 |
| expect-type | 1.4.0 | 2026-06-25 | 117 |  |
| body-parser | 2.3.0 | 2026-06-15 | 127 | この PR で追加 |
| side-channel | 1.1.1 | 2026-06-08 | 134 | この PR で追加 |
| tinyglobby | 0.2.17 | 2026-05-30 | 143 |  |
| hasown | 2.0.4 | 2026-05-28 | 145 | この PR で追加 |
| @babel/runtime | 7.29.7 | 2026-05-25 | 148 | この PR で追加 |
| es-object-atoms | 1.1.2 | 2026-05-22 | 151 | この PR で追加 |
| type-is | 2.1.0 | 2026-05-13 | 160 | この PR で追加 |
| @rolldown/pluginutils | 1.0.1 | 2026-05-13 | 161 |  |
| @types/estree | 1.0.9 | 2026-05-06 | 167 |  |
| ajv | 8.20.0 | 2026-04-24 | 179 | この PR で追加 |
| side-channel-list | 1.0.1 | 2026-04-08 | 195 | この PR で追加 |
| content-disposition | 1.1.0 | 2026-04-07 | 196 | この PR で追加 |
| path-to-regexp | 8.4.2 | 2026-04-01 | 202 | この PR で追加 |
| zod-to-json-schema | 3.25.2 | 2026-03-27 | 208 | この PR で追加 |
| cors | 2.8.6 | 2026-01-22 | 271 | この PR で追加 |
| send | 1.2.1 | 2025-12-15 | 309 | この PR で追加 |
| serve-static | 2.2.1 | 2025-12-15 | 309 | この PR で追加 |
| express | 5.2.1 | 2025-12-01 | 323 | この PR で追加 |
| finalhandler | 2.1.1 | 2025-12-01 | 323 | この PR で追加 |
| pkce-challenge | 5.0.1 | 2025-11-23 | 332 | この PR で追加 |
| raw-body | 3.0.2 | 2025-11-21 | 333 | この PR で追加 |
| http-errors | 2.0.1 | 2025-11-20 | 334 | この PR で追加 |
| mime-types | 3.0.2 | 2025-11-20 | 334 | この PR で追加 |
| json-schema-typed | 8.0.2 | 2025-11-17 | 337 | この PR で追加 |
| @types/chai | 5.2.3 | 2025-10-20 | 365 |  |
| detect-libc | 2.1.2 | 2025-10-05 | 380 |  |
| debug | 4.4.3 | 2025-09-13 | 402 | この PR で追加 |
| @jridgewell/trace-mapping | 0.3.31 | 2025-09-10 | 405 |  |
| fdir | 6.5.0 | 2025-08-14 | 432 |  |
| statuses | 2.0.2 | 2025-06-06 | 501 | この PR で追加 |
| eventsource | 3.0.7 | 2025-05-09 | 529 | この PR で追加 |
| router | 2.2.0 | 2025-03-27 | 573 | この PR で追加 |
| mime-db | 1.54.0 | 2025-03-18 | 581 | この PR で追加 |
| call-bound | 1.0.4 | 2025-03-03 | 596 | この PR で追加 |
| get-intrinsic | 1.3.0 | 2025-02-22 | 605 | この PR で追加 |
| call-bind-apply-helpers | 1.0.2 | 2025-02-12 | 615 | この PR で追加 |
| object-inspect | 1.13.4 | 2025-02-05 | 623 | この PR で追加 |
| get-proto | 1.0.1 | 2025-01-02 | 656 | この PR で追加 |
| math-intrinsics | 1.1.0 | 2024-12-19 | 671 | この PR で追加 |
| dunder-proto | 1.0.1 | 2024-12-17 | 673 | この PR で追加 |
| side-channel-weakmap | 1.0.2 | 2024-12-11 | 679 | この PR で追加 |
| side-channel-map | 1.0.1 | 2024-12-11 | 679 | この PR で追加 |
| es-define-property | 1.0.1 | 2024-12-06 | 683 | この PR で追加 |
| gopd | 1.2.0 | 2024-12-04 | 685 | この PR で追加 |
| has-symbols | 1.1.0 | 2024-12-02 | 687 | この PR で追加 |
| cross-spawn | 7.0.6 | 2024-11-18 | 701 | この PR で追加 |
| undici-types | 6.21.0 | 2024-11-13 | 706 |  |
| cookie-signature | 1.2.2 | 2024-10-29 | 721 | この PR で追加 |
| why-is-node-running | 3.2.1 | 2024-10-29 | 721 |  |
| picocolors | 1.1.1 | 2024-10-16 | 734 |  |
| cookie | 0.7.2 | 2024-10-07 | 744 | この PR で追加 |
| fresh | 2.0.0 | 2024-09-04 | 776 | この PR で追加 |
| accepts | 2.0.0 | 2024-08-31 | 780 | この PR で追加 |
| json-schema-to-ts | 3.1.1 | 2024-08-29 | 782 | この PR で追加 |
| ts-algebra | 2.0.0 | 2024-05-04 | 899 | この PR で追加 |
| ajv-formats | 3.0.1 | 2024-03-30 | 934 | この PR で追加 |
| encodeurl | 2.0.0 | 2024-03-29 | 936 | この PR で追加 |
| @jridgewell/resolve-uri | 3.1.2 | 2024-02-14 | 979 |  |
| es-errors | 1.3.0 | 2024-02-05 | 989 | この PR で追加 |
| merge-descriptors | 2.0.0 | 2023-11-16 | 1069 | この PR で追加 |
| @types/deep-eql | 4.0.2 | 2023-11-07 | 1079 |  |
| assertion-error | 2.0.1 | 2023-10-18 | 1098 |  |
| function-bind | 1.1.2 | 2023-10-12 | 1104 | この PR で追加 |
| fsevents | 2.3.3 | 2023-08-21 | 1156 |  |
| content-type | 1.0.5 | 2023-01-29 | 1360 | この PR で追加 |
| estree-walker | 3.0.3 | 2023-01-20 | 1370 |  |
| on-finished | 2.4.1 | 2022-02-22 | 1701 | この PR で追加 |
| bytes | 3.1.2 | 2022-01-28 | 1727 | この PR で追加 |
| toidentifier | 1.0.1 | 2021-11-14 | 1801 | この PR で追加 |
| forwarded | 0.2.0 | 2021-05-31 | 1968 | この PR で追加 |
| @stablelib/base64 | 1.0.1 | 2021-05-21 | 1978 | この PR で追加 |
| json-schema-traverse | 1.0.0 | 2020-12-13 | 2137 | この PR で追加 |
| ms | 2.1.3 | 2020-12-08 | 2142 | この PR で追加 |
| fast-deep-equal | 3.1.3 | 2020-06-08 | 2326 | この PR で追加 |
| is-promise | 4.0.0 | 2020-04-27 | 2367 | この PR で追加 |
| fast-sha256 | 1.3.0 | 2020-01-16 | 2469 | この PR で追加 |
| path-key | 3.1.1 | 2019-11-22 | 2524 | この PR で追加 |
| which | 2.0.2 | 2019-11-18 | 2528 | この PR で追加 |
| shebang-command | 2.0.0 | 2019-09-06 | 2601 | この PR で追加 |
| setprototypeof | 1.2.0 | 2019-07-18 | 2652 | この PR で追加 |
| ipaddr.js | 1.9.1 | 2019-07-17 | 2653 | この PR で追加 |
| inherits | 2.0.4 | 2019-06-19 | 2680 | この PR で追加 |
| shebang-regex | 3.0.0 | 2019-04-27 | 2733 | この PR で追加 |
| parseurl | 1.3.3 | 2019-04-16 | 2745 | この PR で追加 |
| depd | 2.0.0 | 2018-10-26 | 2916 | この PR で追加 |
| require-from-string | 2.0.2 | 2018-04-09 | 3116 | この PR で追加 |
| safer-buffer | 2.1.2 | 2018-04-08 | 3117 | この PR で追加 |
| vary | 1.1.2 | 2017-09-24 | 3314 | この PR で追加 |
| etag | 1.8.1 | 2017-09-13 | 3325 | この PR で追加 |
| isexe | 2.0.0 | 2017-03-23 | 3499 | この PR で追加 |
| object-assign | 4.1.1 | 2017-01-16 | 3564 | この PR で追加 |
| once | 1.4.0 | 2016-09-06 | 3696 | この PR で追加 |
| wrappy | 1.0.2 | 2016-05-17 | 3808 | この PR で追加 |
| escape-html | 1.0.3 | 2015-09-01 | 4068 | この PR で追加 |
| unpipe | 1.0.0 | 2015-06-14 | 4146 | この PR で追加 |
| ee-first | 1.1.1 | 2015-05-25 | 4166 | この PR で追加 |
