import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// テストは core のソースを直接参照する（core を先にビルドしなくても `pnpm test` が動く）。
export default defineConfig({
  resolve: {
    alias: { "@cso/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)) },
  },
});
