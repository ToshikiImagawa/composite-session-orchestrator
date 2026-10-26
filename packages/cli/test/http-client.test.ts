import { failure, ok } from "@cso/core";
import { describe, expect, it } from "vitest";
import { createHttpClient } from "../src/http-client.js";

describe("createHttpClient（relay を包む。T22-cli）", () => {
  const call = (result: unknown) => {
    const seen: unknown[] = [];
    const client = createHttpClient({
      request: async (operation, params, options) => {
        seen.push([operation, params, options]);
        return result as never;
      },
    });
    return { client, seen };
  };
  const req = {
    requestId: "r-1",
    role: "human",
    operation: "node.hookUnbind",
    params: { nodeId: "a" },
  } as const;

  it("requestId をそのまま relay に渡し、成功・daemon の失敗は、そのまま返す", async () => {
    const a = call(ok({ unbound: true, duplicate: false }));
    expect(await a.client.call(req as never)).toEqual(ok({ unbound: true, duplicate: false }));
    expect(a.seen).toEqual([["node.hookUnbind", { nodeId: "a" }, { requestId: "r-1" }]]);
    const f = failure("notFound", "ない", "ID を確かめる");
    expect(await call({ ok: false, error: f }).client.call(req as never)).toEqual({
      ok: false,
      error: f,
    });
  });

  it("結果が分からない失敗（応答なし・タイムアウト・不正な応答）は、例外にする（runCommand が再実行を案内する）", async () => {
    for (const code of [
      "daemon_result_unknown",
      "daemon_unreachable",
      "daemon_timeout",
      "daemon_bad_response",
      "daemon_response_too_large",
    ]) {
      await expect(
        call({ ok: false, error: failure(code, "x", "y") }).client.call(req as never),
      ).rejects.toThrow(code);
    }
  });

  it("身元の確認の失敗は、トークンを送っていないので、失敗として返す", async () => {
    const f = failure("daemon_identity_failed", "身元を確認できない", "daemon を起動し直す");
    expect(await call({ ok: false, error: f }).client.call(req as never)).toEqual({
      ok: false,
      error: f,
    });
  });
});
