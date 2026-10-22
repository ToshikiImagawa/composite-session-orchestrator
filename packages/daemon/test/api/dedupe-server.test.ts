import { type EventBody, failure, foldEvents, type OrchEvent, type OrchState, ok } from "@cso/core";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import {
  type ApiLogEvent,
  type ApiServer,
  createApiServer,
  type Handlers,
} from "../../src/api/server.js";

let n = 0;
const ev = (body: EventBody): OrchEvent =>
  ({
    seq: ++n,
    at: "2026-10-20T00:00:00Z",
    requestId: `r${n}`,
    actor: { system: true },
    ...body,
  }) as OrchEvent;
const state = (): OrchState => {
  const r = foldEvents([
    ev({
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    }),
    ev({ type: "node.stateChanged", payload: { nodeId: "root", event: { type: "start" } } }),
    ev({
      type: "node.created",
      payload: { nodeId: "m1", role: "integrator", parentId: "root", dependsOn: [] },
    }),
    ev({ type: "node.stateChanged", payload: { nodeId: "m1", event: { type: "start" } } }),
    ev({
      type: "node.created",
      payload: { nodeId: "a", role: "implement", parentId: "m1", dependsOn: [] },
    }),
    ev({ type: "node.stateChanged", payload: { nodeId: "a", event: { type: "start" } } }),
  ]);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};
const HUMAN = "human-token-human-token-human-token-1234";

/** 手動で開く門。ハンドラは、門が開くまで待つ。 */
const gate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

type Mode = "ok" | "fail" | "throw";
interface Rig {
  server: ApiServer;
  url: string;
  tokens: { human: string; m1: string; a: string };
  /** ハンドラが実行された回数（操作ごと）。 */
  calls: Record<string, number>;
  logs: ApiLogEvent[];
  mono: { now: () => number; advance: (ms: number) => void };
  g: ReturnType<typeof gate>;
  mode: { current: Mode };
}
let rig: Rig | undefined;
afterEach(async () => {
  rig?.g.open();
  await rig?.server.close();
  rig = undefined;
});

const start = async (
  over: {
    inProgress?: { waitMs?: number; maxWaiters?: number; staleMs?: number; maxEntries?: number };
    burst?: number;
  } = {},
): Promise<Rig> => {
  const credentials = createCredentialStore({ humanToken: HUMAN });
  const calls: Record<string, number> = {};
  const logs: ApiLogEvent[] = [];
  let t = 1_000;
  const mono = { now: () => t, advance: (ms: number) => (t += ms) };
  const g = gate();
  const mode: { current: Mode } = { current: "ok" };
  const count = (op: string): void => {
    calls[op] = (calls[op] ?? 0) + 1;
  };
  const handlers: Handlers = {
    "report.progress": async () => {
      count("report.progress");
      await g.promise;
      if (mode.current === "throw") throw new Error("内部の不具合");
      if (mode.current === "fail")
        return { ok: false, error: failure("rejected", "断られた", "直す") };
      return ok({ accepted: true as const });
    },
    "tree.list": async () => {
      count("tree.list");
      await g.promise;
      return ok({ table: "t" });
    },
    "node.purge": async (req) => {
      count("node.purge");
      await g.promise;
      return ok({ purged: [req.params.nodeId] });
    },
    "node.purgePreview": () => {
      count("node.purgePreview");
      return ok({
        nodeIds: [],
        archivedAt: "2026-01-01T00:00:00Z",
        elapsedDays: 0,
        retentionDays: 90,
        tombstoneTitle: "x",
        purgeable: false,
        blockers: [],
      });
    },
  };
  const s = state();
  const server = createApiServer({
    credentials,
    getState: () => s,
    handlers,
    logger: (e) => logs.push(e),
    ...(over.inProgress === undefined ? {} : { inProgress: over.inProgress }),
    rateLimit: {
      perPrincipal: { burst: over.burst ?? 100, perSecond: 100 },
      authFailures: { burst: 5, perSecond: 0.1 },
      monotonicMs: mono.now,
    },
  });
  const { url } = await server.listen(0);
  rig = {
    server,
    url,
    calls,
    logs,
    mono,
    g,
    mode,
    tokens: {
      human: HUMAN,
      m1: credentials.issueNodeToken("m1", "integrator"),
      a: credentials.issueNodeToken("a", "child"),
    },
  };
  return rig;
};

const post = async (r: Rig, body: unknown, token: string) => {
  const res = await fetch(`${r.url}/v1/request`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    retryAfter: res.headers.get("retry-after"),
    json: (await res.json()) as {
      ok: boolean;
      value?: unknown;
      error?: { code: string; cause: string; nextActions: string[] };
    },
  };
};
const progress = (id: string, text = "x") => ({
  requestId: id,
  operation: "report.progress",
  params: { text },
});
const list = (id: string) => ({ requestId: id, operation: "tree.list", params: {} });
const purge = (id: string) => ({ requestId: id, operation: "node.purge", params: { nodeId: "x" } });
const preview = (id: string) => ({
  requestId: id,
  operation: "node.purgePreview",
  params: { nodeId: "x" },
});
const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

describe("同じ要求の処理中の重複（T10l-d）", () => {
  it("同じ主体・同じ requestId の要求が処理中なら、2 つ目はハンドラを呼ばず、最初の結果と同じ結果を返す（probe の再現: ハンドラは 1 回）", async () => {
    const r = await start();
    const first = post(r, progress("same"), r.tokens.a);
    await sleep(50);
    const second = post(r, progress("same"), r.tokens.a);
    const third = post(r, progress("same"), r.tokens.a);
    await sleep(50);
    expect(r.calls["report.progress"]).toBe(1);
    r.g.open();
    const [x, y, z] = await Promise.all([first, second, third]);
    expect(x.status).toBe(200);
    expect(y).toEqual(x);
    expect(z).toEqual(x);
    expect(r.calls["report.progress"]).toBe(1);
  });

  it("最初の要求がハンドラの失敗（422）でも、内部エラー（500）でも、重複には同じ応答を返す。例外のあとも、表から消える", async () => {
    for (const mode of ["fail", "throw"] as const) {
      const r = await start();
      r.mode.current = mode;
      const first = post(r, progress("e1"), r.tokens.a);
      await sleep(50);
      const second = post(r, progress("e1"), r.tokens.a);
      await sleep(50);
      r.g.open();
      const [x, y] = await Promise.all([first, second]);
      expect(x.status).toBe(mode === "fail" ? 422 : 500);
      expect(y).toEqual(x);
      expect(r.calls["report.progress"]).toBe(1);
      // 表から消えている: 同じ requestId の新しい要求は、あらためて実行される
      const again = await post(r, progress("e1"), r.tokens.a);
      expect(again.status).toBe(x.status);
      expect(r.calls["report.progress"]).toBe(2);
      await r.server.close();
      rig = undefined;
    }
  });

  it("本文（操作・引数）が違う同じ requestId は、待たずに 422 requestIdConflict（実行しない）。最初の要求は影響されない", async () => {
    const r = await start();
    const first = post(r, progress("c1", "first"), r.tokens.a);
    await sleep(50);
    const other = await post(r, progress("c1", "different"), r.tokens.a);
    expect(other.status).toBe(422);
    expect(other.json.error?.code).toBe("requestIdConflict");
    expect(r.calls["report.progress"]).toBe(1);
    r.g.open();
    expect((await first).status).toBe(200);
  });

  it("キーの並びが違うだけの引数は、同じ本文として扱う（指紋は正規化する）", async () => {
    const r = await start();
    const a = post(
      r,
      { requestId: "k1", operation: "node.purge", params: { nodeId: "x" } },
      r.tokens.human,
    );
    await sleep(50);
    const b = post(
      r,
      { params: { nodeId: "x" }, operation: "node.purge", requestId: "k1" },
      r.tokens.human,
    );
    await sleep(50);
    r.g.open();
    const [x, y] = await Promise.all([a, b]);
    expect(y).toEqual(x);
    expect(r.calls["node.purge"]).toBe(1);
  });

  it("別の主体の同じ requestId は、別の要求（どちらも実行される）", async () => {
    const r = await start();
    const a = post(r, progress("shared"), r.tokens.a);
    const m = post(r, list("shared"), r.tokens.m1);
    await sleep(80);
    expect(r.calls["report.progress"]).toBe(1);
    expect(r.calls["tree.list"]).toBe(1);
    r.g.open();
    expect((await a).status).toBe(200);
    expect((await m).status).toBe(200);
  });

  it("完了したあとの同じ requestId は、新しい要求として実行される（完了後の冪等性はハンドラの責務）", async () => {
    const r = await start();
    r.g.open();
    expect((await post(r, progress("done"), r.tokens.a)).status).toBe(200);
    expect((await post(r, progress("done"), r.tokens.a)).status).toBe(200);
    expect(r.calls["report.progress"]).toBe(2);
  });

  it("待つ上限を超えたら、409 inProgress と短い Retry-After（実行していない）。最初の要求は続いて、完了する", async () => {
    const r = await start({ inProgress: { waitMs: 150 } });
    const first = post(r, progress("slow"), r.tokens.a);
    await sleep(50);
    const second = await post(r, progress("slow"), r.tokens.a);
    expect(second.status).toBe(409);
    expect(second.json.error?.code).toBe("inProgress");
    expect(second.retryAfter).toBe("2");
    expect(r.calls["report.progress"]).toBe(1);
    r.g.open();
    expect((await first).status).toBe(200);
  });

  it("待てる重複の数に上限がある: 超えた分は、すぐに 409 inProgress", async () => {
    const r = await start({ inProgress: { maxWaiters: 2, waitMs: 5000 } });
    const first = post(r, progress("w"), r.tokens.a);
    await sleep(50);
    const waiting = [post(r, progress("w"), r.tokens.a), post(r, progress("w"), r.tokens.a)];
    await sleep(50);
    const over = await post(r, progress("w"), r.tokens.a);
    expect(over.status).toBe(409);
    r.g.open();
    expect((await first).status).toBe(200);
    for (const w of await Promise.all(waiting)) expect(w.status).toBe(200);
    expect(r.calls["report.progress"]).toBe(1);
  });

  it("古い項目（5 分超）は外す: 外したあとに届いた同じ組の要求は実行されうるので、apiInProgressStale をすぐに記録する。古い項目の終了が、新しい項目を消さない", async () => {
    const r = await start({ inProgress: { staleMs: 5 * 60_000 } });
    const first = post(r, progress("stale"), r.tokens.a);
    await sleep(50);
    r.mono.advance(6 * 60_000);
    const second = post(r, progress("stale"), r.tokens.a);
    await sleep(50);
    expect(r.calls["report.progress"]).toBe(2); // 外したので、実行された
    const staleEvents = r.logs.filter((e) => e.event === "apiInProgressStale");
    expect(staleEvents).toHaveLength(1); // 件数のまとめではなく、すぐに 1 件
    expect(JSON.stringify(staleEvents)).not.toContain('stale"');
    // 3 つ目は、新しい項目（2 つ目）に重なる
    const third = post(r, progress("stale"), r.tokens.a);
    await sleep(50);
    expect(r.calls["report.progress"]).toBe(2);
    r.g.open();
    await Promise.all([first, second, third]);
    expect(r.calls["report.progress"]).toBe(2);
  });

  it("重複は、同時数の枠を重ねて使わない: 1 件処理中に重複 5 件を待たせても、別の要求を 7 件（合計 8）まで通せる。9 件目は 429", async () => {
    const r = await start();
    const first = post(r, progress("base"), r.tokens.a);
    await sleep(50);
    const dups = Array.from({ length: 5 }, () => post(r, progress("base"), r.tokens.a));
    await sleep(80);
    const others = Array.from({ length: 7 }, (_, i) => post(r, progress(`o${i}`), r.tokens.a));
    await sleep(120);
    expect(r.calls["report.progress"]).toBe(8); // 1 + 7（重複は、実行も、枠の占有もしていない）
    const ninth = await post(r, progress("o-extra"), r.tokens.a);
    expect(ninth.status).toBe(429);
    r.g.open();
    const all = await Promise.all([first, ...dups, ...others]);
    expect(all.every((x) => x.status === 200)).toBe(true);
  });

  it("重い操作の重複は、追加の重みを重ねて使わない（基本の 1 トークンだけ）", async () => {
    const r = await start({ burst: 10 });
    const first = post(r, purge("heavy"), r.tokens.human); // 5 トークン
    await sleep(50);
    expect(
      (await Promise.race([post(r, purge("heavy"), r.tokens.human), sleep(100)])) ?? null,
    ).toBeNull(); // 重複は待つ
    // 残りは 10 - 5 - 1 = 4。重複が重みを重ねていたら、0 になっている
    const reads: number[] = [];
    for (let i = 0; i < 4; i++)
      reads.push((await post(r, preview(`p${i}`), r.tokens.human)).status);
    expect(reads).toEqual([200, 200, 200, 200]);
    expect((await post(r, preview("p-over"), r.tokens.human)).status).toBe(429);
    r.g.open();
    await first;
  });

  it("表の項目の数に上限がある: 超える新しい要求は、実行せずに 429。完了すれば、また通る", async () => {
    const r = await start({ inProgress: { maxEntries: 1 } });
    const first = post(r, progress("e1"), r.tokens.a);
    await sleep(50);
    const second = await post(r, list("e2"), r.tokens.m1);
    expect(second.status).toBe(429);
    expect(r.calls["tree.list"] ?? 0).toBe(0);
    r.g.open();
    await first;
    expect((await post(r, list("e3"), r.tokens.m1)).status).toBe(200);
  });

  it("記録: 重複の件数は、窓の最初の 1 件と、窓の終わりのまとめに出る。requestId・トークン・nodeId は出ない", async () => {
    const r = await start();
    const first = post(r, progress("secret-request-id"), r.tokens.a);
    await sleep(50);
    const dup = post(r, progress("secret-request-id"), r.tokens.a);
    const conflict = post(r, progress("secret-request-id", "other"), r.tokens.a);
    await sleep(50);
    r.g.open();
    await Promise.all([first, dup, conflict]);
    expect(r.logs.some((e) => e.event === "apiDeduped" && e.kind === "coalesced")).toBe(true);
    expect(r.logs.some((e) => e.event === "apiDeduped" && e.kind === "conflict")).toBe(true);
    await r.server.close(); // 停止で、件数をまとめる
    const summary = r.logs.find((e) => e.event === "apiSummary");
    expect(summary).toMatchObject({ deduped: { coalesced: 1, conflict: 1 } });
    const text = JSON.stringify(r.logs);
    for (const secret of ["secret-request-id", r.tokens.a, r.tokens.m1, HUMAN, '"a"', '"m1"']) {
      expect(text).not.toContain(secret);
    }
    rig = undefined;
  });
});
