import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// テストは core のソースを直接参照する（core を先にビルドしなくても `pnpm test` が動く）。
// 本番の解決（dist）は scripts/check-core-resolution.mjs で確かめる。
export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@cso\/core$/,
        replacement: fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      },
    ],
  },
});
