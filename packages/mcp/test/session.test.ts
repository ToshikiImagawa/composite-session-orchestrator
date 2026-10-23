import { failure, ok } from "@cso/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { openSession, type Relay, toolsFor, WHOAMI_TOOL } from "../src/index.js";

const relayOf = (whoami: Relay["whoami"]): Relay => ({
  whoami: vi.fn(whoami),
  request: vi.fn(async () => ok({ accepted: true })),
});

describe("接続ごとのロールの解決（whoami）", () => {
  it.each(["integrator", "child"] as const)(
    "%s のトークンには、そのロールのツールを公開する",
    async (role) => {
      const relay = relayOf(async () => ok({ role }));
      const s = await openSession(relay);
      expect(s.ok).toBe(true);
      if (!s.ok) return;
      const c = new Client({ name: "t", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([s.value.connect(a), c.connect(b)]);
      expect((await c.listTools()).tools.map((t) => t.name)).toEqual([
        ...toolsFor(role).map((t) => t.name),
        WHOAMI_TOOL,
      ]);
      // ロールは接続の間だけ。2 回の tools/list・tools/call で whoami を繰り返さない
      await c.listTools();
      expect(relay.whoami).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["human", "admin", "", "constructor"])(
    "ロール %j には、何も公開せず失敗にする",
    async (role) => {
      const s = await openSession(relayOf(async () => ok({ role })));
      expect(!s.ok && s.error.code).toBe("role_not_exposed");
    },
  );

  it("daemon が 401・403 を返したら、そのまま失敗として扱う", async () => {
    const e = failure("unauthenticated", "資格情報が正しくない", "再発行する");
    const s = await openSession(relayOf(async () => ({ ok: false, error: e })));
    expect(!s.ok && s.error).toEqual(e);
  });

  it("whoami が例外を投げても、例外を出さず失敗にする", async () => {
    const s = await openSession(
      relayOf(async () => {
        throw new Error("boom");
      }),
    );
    expect(s.ok).toBe(false);
  });
});

describe("whoami が 429 のとき", () => {
  it("失敗をそのまま返す（rate_limited。retryAfterSec を保つ）", async () => {
    const e = Object.assign(failure("rate_limited", "要求が多すぎる", "待つ"), {
      retryAfterSec: 3,
    });
    const s = await openSession(relayOf(async () => ({ ok: false, error: e })));
    expect(!s.ok && s.error).toEqual(e);
  });
});
