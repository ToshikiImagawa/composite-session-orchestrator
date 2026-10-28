import { describe, expect, it } from "vitest";
import {
  CONFIRMATION_ATTEMPTS,
  CONFIRMATION_TTL_MS,
  createConfirmationGate,
} from "../../src/api/confirmation-gate.js";
import type { HandlerRequest, Handlers } from "../../src/api/server.js";
import { EventLog } from "../../src/eventlog.js";
import { createMemoryStore } from "../../src/memory-store.js";

const clock = (): string => "2026-10-28T00:00:00Z";

const rig = () => {
  const opened = EventLog.open(createMemoryStore().open(), { clock });
  if (!opened.ok) throw new Error(opened.error.code);
  const log = opened.value;
  const created = log.append({
    requestId: "seed-root",
    actor: { system: true },
    body: {
      type: "node.created",
      payload: { nodeId: "root", role: "integrator", parentId: null, dependsOn: [] },
    },
  });
  if (!created.ok) throw new Error(created.error.code);
  let now = 1_000_000;
  const lines: string[] = [];
  const calls: HandlerRequest[] = [];
  let purgeable = true;
  const gate = createConfirmationGate({
    log,
    clock,
    nowMs: () => now,
    writeTerminal: (l) => lines.push(l),
  });
  const inner: Handlers = {
    "node.purge": (r) => {
      calls.push(r);
      return purgeable
        ? { ok: true, value: { purged: ["a"] } }
        : {
            ok: false,
            error: { code: "notPurgeable", cause: "保持期間が過ぎていない", nextActions: ["待つ"] },
          };
    },
    "node.purgePreview": () => ({
      ok: true,
      value: {
        nodeIds: ["a"],
        archivedAt: "2026-01-01T00:00:00Z",
        elapsedDays: 300,
        retentionDays: 30,
        tombstoneTitle: "t",
        purgeable,
        blockers: [],
      },
    }),
    "node.discardedDrop": (r) => {
      calls.push(r);
      return { ok: true, value: { dropped: true, key: "k", tip: "a".repeat(40) } };
    },
    "node.reclaimInstruct": (r) => {
      calls.push(r);
      return { ok: true, value: { accepted: true } };
    },
  };
  const h = gate.wrap(inner);
  const call = async <Op extends keyof Handlers>(
    operation: Op,
    params: unknown,
    opts: { requestId?: string; role?: HandlerRequest["role"] } = {},
  ) => {
    const f = h[operation] as unknown as (r: HandlerRequest) => unknown;
    return (await f({
      requestId: opts.requestId ?? `rq-${operation}`,
      operation,
      role: opts.role ?? "human",
      ...(opts.role === undefined || opts.role === "human" ? {} : { caller: { nodeId: "a" } }),
      params,
    } as HandlerRequest)) as {
      ok: boolean;
      value?: Record<string, unknown>;
      error?: { code: string; cause: string };
    };
  };
  const codeOf = (line: string | undefined): string => {
    const m = line?.match(/確認コード ([0-9A-Z]{4})-([0-9A-Z]{4})/);
    if (m === null || m === undefined) throw new Error(`コードの行がない: ${line}`);
    return `${m[1]}${m[2]}`;
  };
  return {
    log,
    gate,
    lines,
    calls,
    call,
    codeOf,
    advance: (ms: number) => {
      now += ms;
    },
    setPurgeable: (v: boolean) => {
      purgeable = v;
    },
  };
};

describe("取り消せない操作の確認（T24-cf。Desktop の木）", () => {
  it.each([
    ["node.purge", { nodeId: "a" }],
    ["node.discardedDrop", { target: "a", expectTip: "a".repeat(40) }],
    ["node.reclaimInstruct", { nodeId: "a", expectTips: {} }],
  ] as const)(
    "%s: 人間のトークンだけでは実行しない（確認待ち。端末に 1 行、受信箱に info）",
    async (op, params) => {
      const r = rig();
      const res = await r.call(op, params);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("confirmationRequired");
      expect(r.calls).toHaveLength(0);
      expect(r.lines).toHaveLength(1);
      const [p] = r.gate.pending();
      expect(p?.operation).toBe(op);
      // 端末の行: コードと、番号の先頭だけ。番号の全体・対象の ID は出さない
      expect(r.lines[0]).toContain(`確認 ${p?.shortId}…`);
      expect(r.lines[0]).not.toContain(p?.confirmationId ?? "x");
      expect(r.lines[0]).not.toMatch(/（a|: a|対象/);
      const info = r.log.state().inbox.filter((i) => i.kind === "info");
      expect(info).toHaveLength(1);
      expect(info[0]?.summary).toContain(op);
    },
  );

  it("正しいコードで 1 回だけ実行する。同じ番号・同じコードの 2 回目は拒否", async () => {
    const r = rig();
    await r.call("node.purge", { nodeId: "a" });
    const [p] = r.gate.pending();
    const code = r.codeOf(r.lines[0]);
    const ok = await r.call("confirm.approve", { confirmationId: p?.confirmationId, code });
    expect(ok.ok).toBe(true);
    expect(ok.value).toEqual({
      executed: true,
      operation: "node.purge",
      result: { purged: ["a"] },
    });
    expect(r.calls).toHaveLength(1);
    expect(r.calls[0]?.requestId).toBe("rq-node.purge"); // 元の要求 ID で実行する
    const again = await r.call("confirm.approve", { confirmationId: p?.confirmationId, code });
    expect(again.error?.code).toBe("confirmationInvalid");
    expect(r.calls).toHaveLength(1);
    expect(r.gate.pending()).toHaveLength(0);
  });

  it("同じ要求の再送: 確認待ちの間は新しいコードを出さない。確認のあとは、前の結果を返す（二重に実行しない）", async () => {
    const r = rig();
    await r.call("node.purge", { nodeId: "a" });
    await r.call("node.purge", { nodeId: "a" });
    expect(r.lines).toHaveLength(1);
    expect(r.gate.pending()).toHaveLength(1);
    const [p] = r.gate.pending();
    await r.call("confirm.approve", {
      confirmationId: p?.confirmationId,
      code: r.codeOf(r.lines[0]),
    });
    const resent = await r.call("node.purge", { nodeId: "a" });
    expect(resent.ok).toBe(true);
    expect(r.calls).toHaveLength(1);
    const conflict = await r.call("node.purge", { nodeId: "b" });
    expect(conflict.error?.code).toBe("requestIdConflict");
  });

  it("コードは大文字小文字・区切りを問わない", async () => {
    const r = rig();
    await r.call("node.discardedDrop", { target: "a", expectTip: "a".repeat(40) });
    const [p] = r.gate.pending();
    const code = r.codeOf(r.lines[0]);
    const typed = `${code.slice(0, 4).toLowerCase()} - ${code.slice(4).toLowerCase()}`;
    const ok = await r.call("confirm.approve", { confirmationId: p?.confirmationId, code: typed });
    expect(ok.ok).toBe(true);
  });

  it("期限切れは confirmationExpired で拒否し、実行しない", async () => {
    const r = rig();
    await r.call("node.reclaimInstruct", { nodeId: "a", expectTips: {} });
    const [p] = r.gate.pending();
    r.advance(CONFIRMATION_TTL_MS + 1);
    const res = await r.call("confirm.approve", {
      confirmationId: p?.confirmationId,
      code: r.codeOf(r.lines[0]),
    });
    expect(["confirmationExpired", "confirmationInvalid"]).toContain(res.error?.code);
    expect(r.calls).toHaveLength(0);
    expect(r.gate.pending()).toHaveLength(0);
  });

  it("期限の直前に approve すると confirmationExpired（期限切れの記号）", async () => {
    const r = rig();
    await r.call("node.reclaimInstruct", { nodeId: "a", expectTips: {} });
    const [p] = r.gate.pending();
    r.advance(CONFIRMATION_TTL_MS);
    // pending() を呼ばずに approve する（期限の判定は approve の中で行う）
    const res = await r.call("confirm.approve", {
      confirmationId: p?.confirmationId,
      code: r.codeOf(r.lines[0]),
    });
    expect(res.error?.code).toBe("confirmationExpired");
  });

  it(`誤ったコードは confirmationInvalid。${CONFIRMATION_ATTEMPTS} 回で確認待ちを捨てる`, async () => {
    const r = rig();
    await r.call("node.purge", { nodeId: "a" });
    const [p] = r.gate.pending();
    const right = r.codeOf(r.lines[0]);
    const wrong = right.startsWith("0") ? `1${right.slice(1)}` : `0${right.slice(1)}`;
    for (let i = 0; i < CONFIRMATION_ATTEMPTS; i++) {
      const res = await r.call("confirm.approve", {
        confirmationId: p?.confirmationId,
        code: wrong,
      });
      expect(res.error?.code).toBe("confirmationInvalid");
    }
    expect(r.gate.pending()).toHaveLength(0);
    const late = await r.call("confirm.approve", {
      confirmationId: p?.confirmationId,
      code: right,
    });
    expect(late.ok).toBe(false);
    expect(r.calls).toHaveLength(0);
  });

  it("子・統合のロールでは確認できない", async () => {
    const r = rig();
    await r.call("node.purge", { nodeId: "a" });
    const [p] = r.gate.pending();
    for (const role of ["child", "integrator"] as const) {
      const res = await r.call(
        "confirm.approve",
        { confirmationId: p?.confirmationId, code: r.codeOf(r.lines[0]) },
        { role },
      );
      expect(res.error?.code).toBe("forbidden");
    }
    expect(r.calls).toHaveLength(0);
    expect(r.gate.pending()).toHaveLength(1);
  });

  it("取り消すと、確認待ちが消え、そのコードでは実行できない", async () => {
    const r = rig();
    await r.call("node.purge", { nodeId: "a" });
    const [p] = r.gate.pending();
    const v = r.gate.version();
    expect((await r.call("confirm.cancel", { confirmationId: p?.confirmationId })).ok).toBe(true);
    expect(r.gate.version()).toBeGreaterThan(v);
    const res = await r.call("confirm.approve", {
      confirmationId: p?.confirmationId,
      code: r.codeOf(r.lines[0]),
    });
    expect(res.ok).toBe(false);
    expect(r.calls).toHaveLength(0);
  });

  it("最終削除が事前確認で実行できないなら、確認待ちにせず、元の失敗を返す（何も消さない）", async () => {
    const r = rig();
    r.setPurgeable(false);
    const res = await r.call("node.purge", { nodeId: "a" });
    expect(res.error?.code).toBe("notPurgeable");
    expect(r.gate.pending()).toHaveLength(0);
    expect(r.lines).toHaveLength(0);
  });

  it("コードの平文は、確認待ち・記録・受信箱に出ない", async () => {
    const r = rig();
    await r.call("node.purge", { nodeId: "a" });
    const code = r.codeOf(r.lines[0]);
    const [p] = r.gate.pending();
    const blob = JSON.stringify({ pending: r.gate.pending(), state: r.log.state() });
    expect(blob).not.toContain(code);
    expect(blob).not.toContain(`${code.slice(0, 4)}-${code.slice(4)}`);
    // 記録には、確認の番号も書かない
    expect(JSON.stringify(r.log.state())).not.toContain(p?.confirmationId ?? "x");
  });

  it("再起動（新しい確認の口）では、前の確認待ちは消える", async () => {
    const r = rig();
    await r.call("node.purge", { nodeId: "a" });
    const [p] = r.gate.pending();
    const fresh = createConfirmationGate({ log: r.log, clock, writeTerminal: () => {} });
    const h = fresh.wrap({ "node.purge": () => ({ ok: true, value: { purged: [] } }) });
    const approve = h["confirm.approve"] as unknown as (q: HandlerRequest) => Promise<{
      ok: boolean;
    }>;
    const res = await approve({
      requestId: "x",
      operation: "confirm.approve",
      role: "human",
      params: { confirmationId: p?.confirmationId ?? "", code: r.codeOf(r.lines[0]) },
    } as HandlerRequest);
    expect(res.ok).toBe(false);
    expect(fresh.pending()).toHaveLength(0);
  });

  it("人間以外のロールの呼び出しは、そのまま通す（対象の操作は人間だけのもの）", async () => {
    const r = rig();
    const res = await r.call("node.purge", { nodeId: "a" }, { role: "integrator" });
    expect(res.ok).toBe(true);
    expect(r.calls).toHaveLength(1);
  });
});
