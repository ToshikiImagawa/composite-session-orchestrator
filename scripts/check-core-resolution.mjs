// 本番の解決の疎通チェック: daemon・mcp・cli の各ディレクトリから、別名なしで @cso/core を import する。
// (1) 公開名（index）が解決できること、(2) index 以外への deep import は拒否されること（A-001: 公開面は index のみ）。
// 実行前に `pnpm build` が必要（core の dist を解決するため）。
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const probe = `
const core = await import("@cso/core");
if (!Array.isArray(core.NODE_STATES) || !core.NODE_STATES.includes("pending")) {
  throw new Error("公開名 NODE_STATES を解決できない");
}
let deepRejected = false;
try {
  await import("@cso/core/dist/tree.js");
} catch {
  deepRejected = true;
}
if (!deepRejected) throw new Error("deep import が拒否されない（exports で公開面を index のみにする）");
`;

let failed = false;
for (const pkg of ["daemon", "mcp", "cli"]) {
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: `${root}packages/${pkg}`,
    encoding: "utf8",
  });
  if (r.status !== 0) {
    failed = true;
    console.error(`NG: packages/${pkg} から @cso/core を解決できない\n${r.stderr}`);
  } else {
    console.log(`OK: packages/${pkg} → @cso/core`);
  }
}
process.exit(failed ? 1 : 0);
