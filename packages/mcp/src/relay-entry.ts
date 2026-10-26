/**
 * daemon の窓口への中継（relay）と身元確認（identity）だけの入口（`@cso/mcp/relay`。T22-cli）。cli がこれを使う。
 * MCP SDK・zod を読み込まない（このファイルと、その import 先は、relay.ts・identity.ts・@cso/core だけ）。
 */
export * from "./identity.js";
export * from "./relay.js";
