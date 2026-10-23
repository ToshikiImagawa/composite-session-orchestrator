import { ok } from "@cso/core";
import { describe, expect, it } from "vitest";
import type { ApiLogEvent } from "../src/api/server.js";
import { createApiAlert } from "../src/api-alert.js";

const summary = (
  authFailed: Record<string, number>,
  rateLimited: Record<string, number> = {},
  at = "2026-10-23T12:00:00.000Z",
): ApiLogEvent => ({
  event: "apiSummary",
  windowSec: 60,
  authFailed,
  rateLimited,
  deduped: {},
  at,
});

const rig = (over: { threshold?: number; minIntervalMs?: number } = {}) => {
  let mono = 0;
  const records: { requestId: string; body: { type: string; payload: Record<string, unknown> } }[] =
    [];
  const notes: string[] = [];
  let failNext = false;
  const alert = createApiAlert({
    threshold: over.threshold ?? 30,
    minIntervalMs: over.minIntervalMs ?? 600_000,
    rootNodeId: "root",
    monoMs: () => mono,
    record: (requestId, body) => {
      if (failNext) {
        failNext = false;
        return { ok: false, error: { code: "boom", cause: "x", nextActions: ["y"] } } as never;
      }
      records.push({ requestId, body: body as never });
      return ok(undefined);
    },
    note: (event) => notes.push(event),
  });
  return {
    alert,
    records,
    notes,
    advance: (ms: number) => {
      mono += ms;
    },
    failNext: () => {
      failNext = true;
    },
  };
};

describe("createApiAlert（窓口の 429・401 の件数の見える化。T10l-f PR-B）", () => {
  it("閾値以上なら、根の受信箱に info を 1 件出す。文面は件数と固定の語だけ", () => {
    const r = rig();
    r.alert(summary({ invalid: 25, missing: 10, bindFailed: 2 }));
    expect(r.records).toHaveLength(1);
    const item = r.records[0]?.body;
    expect(item?.type).toBe("inbox.added");
    expect(item?.payload).toMatchObject({ kind: "info", nodeId: "root" });
    const text = String(item?.payload.summary);
    expect(text).toContain("認証の失敗 37 件");
    expect(text).toContain("invalid 25・missing 10・bindFailed 2"); // 件数の多い順
    expect(text).toContain("直近 60 秒");
    expect(text).not.toContain("制限の発動"); // 閾値未満の種類は、書かない
    expect(r.notes).toEqual(["apiAlert.posted"]);
  });

  it("閾値未満の窓は、何も出さない。ちょうど閾値は出す。apiSummary 以外のイベントは無視する", () => {
    const r = rig();
    r.alert(summary({ invalid: 29 }));
    r.alert({ event: "apiAuthFailed", reason: "invalid", at: "2026-10-23T12:00:00Z" });
    expect(r.records).toEqual([]);
    r.alert(summary({ invalid: 30 }));
    expect(r.records).toHaveLength(1);
  });

  it("認証の失敗と制限の発動は、別々に閾値と間隔を見る。両方が閾値以上なら、1 件にまとめる", () => {
    const r = rig();
    r.alert(summary({ invalid: 40 }, { principal: 50 }));
    expect(r.records).toHaveLength(1);
    const text = String(r.records[0]?.body.payload.summary);
    expect(text).toContain("認証の失敗 40 件");
    expect(text).toContain("制限の発動 50 件（principal 50）");
  });

  it("出しすぎない: 同じ種類は、最短の間隔（既定 10 分）あける。間隔のあとは、また出す。別の種類は、別に数える", () => {
    const r = rig();
    r.alert(summary({ invalid: 40 }, {}, "2026-10-23T12:00:00.000Z"));
    r.advance(60_000);
    r.alert(summary({ invalid: 40 }, {}, "2026-10-23T12:01:00.000Z"));
    r.advance(60_000);
    r.alert(summary({ invalid: 99 }, {}, "2026-10-23T12:02:00.000Z"));
    expect(r.records).toHaveLength(1); // 間隔の内は、出さない
    // 別の種類（制限の発動）は、別に数える
    r.alert(summary({}, { principal: 40 }, "2026-10-23T12:02:30.000Z"));
    expect(r.records).toHaveLength(2);
    r.advance(600_000);
    r.alert(summary({ invalid: 40 }, {}, "2026-10-23T12:12:30.000Z"));
    expect(r.records).toHaveLength(3);
    // 項目の ID は、窓の時刻から決まる（同じ ID が重ならない）
    expect(new Set(r.records.map((x) => x.body.payload.id)).size).toBe(3);
  });

  it("記録できなかったときは、間隔を消費しない（次の窓で、また試す）。例外にしない", () => {
    const r = rig();
    r.failNext();
    r.alert(summary({ invalid: 40 }));
    expect(r.records).toEqual([]);
    expect(r.notes).toEqual(["apiAlert.failed"]);
    r.advance(1000);
    r.alert(summary({ invalid: 40 }, {}, "2026-10-23T12:01:00.000Z"));
    expect(r.records).toHaveLength(1);
  });

  it("本文に、トークン・nodeId・接続元になりうる文字列を出さない: 内訳の名前は、固定の語の形（英字）だけ。形が違うものは、件数には数えるが、名前は書かない", () => {
    const r = rig();
    r.alert(
      summary({
        invalid: 31,
        "token-abc123": 5, // ハイフン・数字から始まらない英字でない
        "127.0.0.1": 5,
        "../x": 5,
        "a b": 5,
      }),
    );
    const text = String(r.records[0]?.body.payload.summary);
    expect(text).toContain("認証の失敗 51 件");
    expect(text).toContain("（invalid 31）");
    for (const secret of ["token-abc123", "127.0.0.1", "../x", "a b"]) {
      expect(text).not.toContain(secret);
    }
  });

  it("内訳の名前は 8 件まで。不正な件数（負・NaN・文字列）は数えない", () => {
    const r = rig({ threshold: 5 });
    const counts: Record<string, number> = {};
    for (let i = 0; i < 12; i++) counts[`kind${String.fromCharCode(97 + i)}`] = 10 + i;
    counts.neg = -5;
    counts.nan = Number.NaN;
    counts.str = "9" as unknown as number;
    r.alert(summary(counts));
    const text = String(r.records[0]?.body.payload.summary);
    expect(text.match(/kind[a-z] \d+/g)).toHaveLength(8);
    expect(text).not.toContain("neg");
    expect(text).not.toContain("nan");
    expect(text).not.toContain("str ");
  });
});
