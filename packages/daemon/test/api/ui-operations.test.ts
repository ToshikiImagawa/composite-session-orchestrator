import { foldEvents, type OrchEvent, type OrchState, ok } from "@cso/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { type ApiServer, createApiServer } from "../../src/api/server.js";

/**
 * 画面からの操作（T23 PR3）。画面（ui-assets）が送る要求と同じ形（`POST /v1/request`・Bearer・JSON・同じ origin）で、
 * 通るもの・拒まれるものを確かめる。画面そのものの動きは、実ブラウザの確認（scripts/ui-browser-check.mjs）。
 */
const HUMAN = "human-token-human-token-human-token-1234";
const SYS = { system: true } as const;
const state = (): OrchState => {
  let n = 0;
  const e = (body: unknown): OrchEvent =>
    ({
      seq: ++n,
      at: "2026-10-20T00:00:00Z",
      requestId: `r${n}`,
      actor: SYS,
      ...(body as object),
    }) as OrchEvent;
  const r = foldEvents([
    e({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    }),
    e({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
    e({
      type: "node.created",
      payload: { nodeId: "a", role: "implement", parentId: "root", dependsOn: [] },
    }),
  ]);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};

let server: ApiServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

const start = async () => {
  const credentials = createCredentialStore({ humanToken: HUMAN });
  const calls: { operation: string; params: unknown; role: string }[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  server = createApiServer({
    credentials,
    getState: state,
    handlers: {
      "decision.answer": async (req) => {
        calls.push({ operation: req.operation, params: req.params, role: req.role });
        await gate;
        return ok({ accepted: true });
      },
    },
  });
  const { url } = await server.listen(0);
  return {
    url,
    calls,
    release: () => release?.(),
    child: credentials.issueNodeToken("a", "child"),
    root: credentials.issueNodeToken("root", "integrator"),
  };
};

/** 画面（sendPending）と同じ形の要求。 */
const send = (
  url: string,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
  contentType = "application/json",
) =>
  fetch(`${url}/v1/request`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": contentType, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

const ANSWER = (requestId: string) => ({
  requestId,
  operation: "decision.answer",
  params: { decisionId: "d1", choice: "A案" },
});

describe("画面からの操作（decision.answer）の要求", () => {
  it("同じ origin・JSON・人間のトークンなら通る（判断への回答）。ロールは human", async () => {
    const r = await start();
    r.release();
    const origin = new URL(r.url).origin;
    const a = await send(r.url, HUMAN, ANSWER("11111111-1111-4111-8111-111111111111"), { origin });
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true, value: { accepted: true } });
    expect(r.calls.map((c) => c.role)).toEqual(["human"]);
  });

  it("CSRF: 誤った Origin は 403（実行しない）。JSON でない Content-Type（フォームから送れる形）は 415（実行しない）", async () => {
    const r = await start();
    r.release();
    const evil = await send(r.url, HUMAN, ANSWER("33333333-3333-4333-8333-333333333333"), {
      origin: "http://evil.example",
    });
    expect(evil.status).toBe(403);
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"]) {
      const res = await send(
        r.url,
        HUMAN,
        JSON.stringify(ANSWER("44444444-4444-4444-8444-444444444444")),
        {},
        type,
      );
      expect(res.status, type).toBe(415);
    }
    // cookie だけでは認証されない（トークンなしは 401）
    const noToken = await fetch(`${r.url}/v1/request`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: `token=${HUMAN}` },
      body: JSON.stringify(ANSWER("55555555-5555-4555-8555-555555555555")),
    });
    expect(noToken.status).toBe(401);
    expect(r.calls).toEqual([]);
  });

  it("権限: 人間のトークンだけ。子・統合ノードのトークンでは、decision.answer は 403", async () => {
    const r = await start();
    r.release();
    expect(
      (await send(r.url, r.child, ANSWER("66666666-6666-4666-8666-666666666666"))).status,
    ).toBe(403);
    expect((await send(r.url, r.root, ANSWER("77777777-7777-4777-8777-777777777777"))).status).toBe(
      403,
    );
    expect(r.calls).toEqual([]);
  });

  it("不正な本文（両方指定・空の選択肢・制御文字・長すぎる）は 400（実行しない）", async () => {
    const r = await start();
    r.release();
    const bad = (params: unknown) =>
      send(r.url, HUMAN, {
        requestId: "88888888-8888-4888-8888-888888888888",
        operation: "decision.answer",
        params,
      });
    expect((await bad({ decisionId: "d1", choice: "A", text: "B" })).status).toBe(400);
    expect((await bad({ decisionId: "d1" })).status).toBe(400);
    expect((await bad({ decisionId: "d1", text: "a\u0007b" })).status).toBe(400);
    expect((await bad({ decisionId: "d1", text: "a‮b" })).status).toBe(400);
    expect((await bad({ decisionId: "d1", text: "a".repeat(64 * 1024 + 1) })).status).toBe(400);
    expect(r.calls).toEqual([]); // どれも、ハンドラまで届かない
    // 改行・タブは、使える（複数行の回答）
    expect((await bad({ decisionId: "d1", text: "複数行\nの回答\tです" })).status).toBe(200);
    expect(r.calls).toHaveLength(1);
  });

  it("二重送信: 同じ requestId・同じ本文を同時に 2 回送っても、ハンドラは 1 回だけ（結果は同じ）", async () => {
    const r = await start();
    const origin = new URL(r.url).origin;
    const body = ANSWER("99999999-9999-4999-8999-999999999999");
    const first = send(r.url, HUMAN, body, { origin });
    await new Promise((x) => setTimeout(x, 50));
    const second = send(r.url, HUMAN, body, { origin });
    await new Promise((x) => setTimeout(x, 50));
    r.release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(r.calls).toHaveLength(1);
  });
});
