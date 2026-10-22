import { type EventBody, foldEvents, type OrchEvent, type OrchState, ok } from "@cso/core";
import { describe, expect, it } from "vitest";
import {
  createDiscardedHandlers,
  type DiscardedPorts,
} from "../../../src/api/handlers/discarded-handlers.js";
import type { HandlerRequest } from "../../../src/api/server.js";

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
      payload: { nodeId: "c1", role: "implement", parentId: "root", dependsOn: [] },
    }),
  ]);
  if (!r.ok) throw new Error(r.error.code);
  return r.value;
};

const ALL = [
  {
    key: "k-c1",
    tip: "a".repeat(40),
    committedAt: "2026-10-01T00:00:00+09:00",
    subject: "\u001b[2J悪い\n件名  です",
  },
  { key: `k-c1.${"b".repeat(12)}`, tip: "b".repeat(40) },
  { key: "k-gone", tip: "c".repeat(40) },
];

const rig = (only?: string[]) => {
  const calls: string[] = [];
  const audits: string[] = [];
  const keyOf = (id: string): string => `k-${id}`;
  const ports: DiscardedPorts = {
    discardedKeyOf: keyOf,
    discardedList: async () =>
      ok({
        max: 200,
        items: ALL.filter((i) => only === undefined || only.includes(i.key)),
      }),
    discardedRestore: async (r) => {
      calls.push(`restore:${r.key}:${r.branch ?? ""}`);
      return ok({ branch: r.branch ?? `cso/restored/${r.key}`, tip: "a".repeat(40) });
    },
    discardedDrop: async (key, expectTip) => {
      calls.push(`drop:${key}:${expectTip.slice(0, 4)}`);
      return ok({ key, tip: expectTip });
    },
  };
  const h = createDiscardedHandlers({
    state,
    ports,
    audit: (e) => audits.push(e),
  });
  const call = async (op: keyof typeof h, params: unknown, role = "human") =>
    // biome-ignore lint/suspicious/noExplicitAny: 操作ごとの型は呼び出し側で保証
    (await (h[op] as any)({
      requestId: "q",
      operation: op,
      role,
      params,
    } as unknown as HandlerRequest<never>)) as {
      ok: boolean;
      // biome-ignore lint/suspicious/noExplicitAny: テスト用
      value?: any;
      error?: { code: string };
    };
  return { call, calls, audits };
};

describe("保管した成果の操作（T13f-r）", () => {
  it("人間以外は、すべて拒否する（forbidden）。何も呼ばない", async () => {
    const r = rig();
    for (const role of ["integrator", "child"]) {
      for (const [op, params] of [
        ["node.discardedList", {}],
        ["node.discardedRestore", { target: "c1" }],
        ["node.discardedDrop", { target: "c1" }],
      ] as const) {
        const res = await r.call(op, params, role);
        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe("forbidden");
      }
    }
    expect(r.calls).toEqual([]);
  });

  it("一覧: ノードが残っていれば nodeId を付け（名前違いの重複も）、残っていなければ orphan。件名は信頼できない入力として整える", async () => {
    const r = rig();
    const res = await r.call("node.discardedList", {});
    expect(res.ok).toBe(true);
    expect(res.value.max).toBe(200);
    const [a, b, c] = res.value.items;
    expect(a).toMatchObject({ key: "k-c1", nodeId: "c1", orphan: false });
    expect(b).toMatchObject({ nodeId: "c1", orphan: false });
    expect(c).toMatchObject({ key: "k-gone", orphan: true });
    expect(c.nodeId).toBeUndefined();
    // 制御文字（エスケープ列）・改行は除き、空白を詰めて 1 行にする（信頼できない入力）
    expect(
      Array.from(a.untrustedSubject as string).filter((ch) => {
        const c = ch.codePointAt(0) ?? 0;
        return c <= 0x1f || (c >= 0x7f && c <= 0x9f);
      }),
    ).toEqual([]);
    expect(a.untrustedSubject).toContain("悪い 件名 です");
  });

  it("取り出し・消去: 鍵そのものを指定できる。ノード ID の指定は、保管が 1 つなら、その保管（複数ある・ないときは失敗する）", async () => {
    const r = rig();
    // 鍵の指定（c1 の保管が複数あっても通る）
    await r.call("node.discardedRestore", { target: "k-c1", branch: "my/branch" });
    await r.call("node.discardedRestore", { target: "k-gone" });
    await r.call("node.discardedDrop", { target: "k-gone", expectTip: "c".repeat(40) });
    // ノード ID の指定: c1 には保管が 2 件ある → multipleKept（何も呼ばない）
    const many = await r.call("node.discardedRestore", { target: "c1" });
    expect(many.ok).toBe(false);
    expect(many.error?.code).toBe("multipleKept");
    const manyDrop = await r.call("node.discardedDrop", {
      target: "c1",
      expectTip: "a".repeat(40),
    });
    expect(manyDrop.error?.code).toBe("multipleKept");
    // 存在しない
    expect((await r.call("node.discardedRestore", { target: "no-such" })).error?.code).toBe(
      "notFound",
    );
    expect(r.calls).toEqual(["restore:k-c1:my/branch", "restore:k-gone:", "drop:k-gone:cccc"]);
    expect(r.audits).toEqual(["discardedRestored", "discardedRestored", "discardedDropped"]);
    // 保管が 1 つだけなら、ノード ID の指定でも通る
    const one = rig(["k-c1"]);
    expect(
      (await one.call("node.discardedDrop", { target: "c1", expectTip: "a".repeat(40) })).ok,
    ).toBe(true);
    expect(one.calls).toEqual(["drop:k-c1:aaaa"]);
  });

  it("一覧: 名前違いの重複（<鍵>.<12 桁>）も、持ち主のノードが付く。形の違う鍵は孤立", async () => {
    const r = rig();
    const res = await r.call("node.discardedList", {});
    expect(res.value.items[1]).toMatchObject({ nodeId: "c1", orphan: false });
  });
});
