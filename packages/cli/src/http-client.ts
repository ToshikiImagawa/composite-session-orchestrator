/**
 * daemon の窓口を HTTP で呼ぶクライアント（T22-cli）。mcp の relay（`@cso/mcp/relay`）を、そのまま使う: ループバックだけの URL、
 * トークンつきの要求の直前の身元の確認（`/v1/identity`）、429・409 の再送（同じ requestId）、1 MiB の上限、タイムアウト。
 *
 * - daemon の失敗は、そのまま返す（`runCommand` が、原因と次の操作を出す）。
 * - 応答を受け取れなかった・不正な応答（結果が分からない）は、例外にする（`runCommand` が「結果が確認できない」として、同じ
 *   requestId での再実行を案内する）。
 * - 身元の確認の失敗は、トークンを送っていない（操作は実行されていない）ので、失敗として返す。
 */
import type { Failure, Result } from "@cso/core";
import type { Relay } from "@cso/mcp/relay";
import type { DaemonClient } from "./client.js";

/** relay の失敗のうち、結果が分からないもの（操作が実行されたかもしれない）。 */
const UNKNOWN: ReadonlySet<string> = new Set([
  "daemon_result_unknown",
  "daemon_unreachable",
  "daemon_timeout",
  "daemon_bad_response",
  "daemon_response_too_large",
]);

export function createHttpClient(relay: Pick<Relay, "request">): DaemonClient {
  return {
    async call(req) {
      const r: Result<unknown, Failure> = await relay.request(req.operation, req.params, {
        requestId: req.requestId,
      });
      if (!r.ok && UNKNOWN.has(r.error.code)) throw new Error(`${r.error.code}: ${r.error.cause}`);
      return r as never;
    },
  };
}
