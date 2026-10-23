/**
 * 窓口の 429・401 の件数の運用の見える化（T10l-f PR-B。`docs/rate-limit.md`）。窓口の件数のまとめ（`apiSummary`。窓は既定 1 分）の
 * 認証の失敗・制限の発動の件数が、閾値以上のとき、根の受信箱に `info` の項目を 1 件出す（人間が、画面・受信箱で気づけるように）。
 *
 * - 文面は固定の形で、**種類ごとの件数と、理由・種類の名前**だけを書く（トークン・nodeId・要求の内容・接続元は出さない。名前は、窓口が数える
 *   固定の語〔`missing`・`invalid`・`principalRejected`・`bindFailed`・`principal`・`origin` など〕だけ。形が違うものは捨てる）。
 * - 出しすぎない: 種類（`authFailed`・`rateLimited`）ごとに、最短 `minIntervalMs`（単調時計。既定 10 分）あける。閾値未満の窓は、何も出さない。
 * - 積み上げない: 新しい警告を出すとき、**同じ種類の、前の未解決の警告を system が解決済みにする**（項目の ID に、種類の記号〔`a`・`r`〕を持つ）。
 *   未解決の警告は、種類ごとに高々 1 件（人間が先に解決したものは、そのまま）。
 * - 窓口の処理から切り離す: 記録は、`defer`（既定 `setImmediate`）で、要求の処理のあとに行う。
 * - 失敗（記録できない）は、daemon の記録（`note`）に出すだけで、窓口の動作を変えない。
 */

import type { EventBody, Failure, Result } from "@cso/core";
import type { ApiLogEvent } from "./api/server.js";

/** 閾値の既定（1 つの窓の、種類ごとの件数）。認証の失敗の bucket の毎分の補充（30）と同じ。 */
export const DEFAULT_ALERT_THRESHOLD = 30;
/** 同じ種類の項目を出す最短の間隔（分）の既定。 */
export const DEFAULT_ALERT_INTERVAL_MINUTES = 10;

export interface ApiAlertDeps {
  /** 閾値（種類ごとの、1 つの窓の件数）。 */
  readonly threshold: number;
  /** 同じ種類の項目を出す最短の間隔（ミリ秒。単調時計）。 */
  readonly minIntervalMs: number;
  /** 項目の持ち主（根のノード）。 */
  readonly rootNodeId: string;
  readonly monoMs: () => number;
  readonly record: (requestId: string, body: EventBody) => Result<unknown, Failure>;
  /** 未解決の警告（この機能が出した項目）の ID。新しい警告を出すとき、同じ種類のものを解決済みにする。 */
  readonly openAlertIds: () => readonly string[];
  readonly note: (event: string, data?: Record<string, unknown>) => void;
  /** 記録を、窓口の処理から切り離す（既定 `setImmediate`）。試験で、同期にする。 */
  readonly defer?: (fn: () => void) => void;
}

/** 警告の項目の ID: `api-alert-<種類の記号>-<窓の時刻の数字>`。種類の記号は、`a`（認証の失敗）・`r`（制限の発動）。 */
export const ALERT_ID_PREFIX = "api-alert-";
const ALERT_ID = /^api-alert-([ar]{1,2})-/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

const KINDS = [
  { key: "authFailed", label: "認証の失敗", code: "a" },
  { key: "rateLimited", label: "制限の発動", code: "r" },
] as const;
type KindKey = (typeof KINDS)[number]["key"];

const SAFE_NAME = /^[A-Za-z][A-Za-z0-9]{0,31}$/;
const MAX_NAMES = 8;

/** 件数の表（名前 → 件数）の合計と、内訳の文（固定の語だけ。件数の多い順）。 */
function summarize(counts: Readonly<Record<string, number>>): { total: number; detail: string } {
  let total = 0;
  const named: { name: string; n: number }[] = [];
  for (const [name, n] of Object.entries(counts)) {
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) continue;
    total += n;
    if (SAFE_NAME.test(name)) named.push({ name, n });
  }
  named.sort((a, b) => b.n - a.n || (a.name < b.name ? -1 : 1));
  const detail = named
    .slice(0, MAX_NAMES)
    .map((x) => `${x.name} ${x.n}`)
    .join("・");
  return { total, detail };
}

const seconds = (iso: string): string => iso.slice(0, 19);

/** 窓の時刻の文（UTC。秒まで）。時刻がなければ（壁時計がない）、窓の長さだけ。 */
function windowText(event: Extract<ApiLogEvent, { event: "apiSummary" }>): string {
  const sec = Math.trunc(Number(event.windowSec)) || 0;
  const { windowStart: start, windowEnd: end } = event;
  if (
    typeof start === "string" &&
    typeof end === "string" &&
    ISO_UTC.test(start) &&
    ISO_UTC.test(end)
  ) {
    return `${seconds(start)}〜${seconds(end)} UTC（${sec} 秒間）`;
  }
  return `窓（${sec} 秒間）`;
}

export function createApiAlert(deps: ApiAlertDeps): (event: ApiLogEvent) => void {
  const last = new Map<KindKey, number>();
  const defer = deps.defer ?? ((fn: () => void) => void setImmediate(fn));
  const post = (event: Extract<ApiLogEvent, { event: "apiSummary" }>): void => {
    try {
      const now = deps.monoMs();
      const parts: string[] = [];
      const fired: (typeof KINDS)[number][] = [];
      for (const k of KINDS) {
        const s = summarize(event[k.key]);
        if (s.total < deps.threshold) continue;
        const prev = last.get(k.key);
        if (prev !== undefined && now - prev < deps.minIntervalMs) continue; // 出しすぎない
        parts.push(`${k.label} ${s.total} 件${s.detail === "" ? "" : `（${s.detail}）`}`);
        fired.push(k);
      }
      if (fired.length === 0) return;
      const digits = String(event.at)
        .replace(/[^0-9]/g, "")
        .slice(0, 24);
      const codes = fired.map((k) => k.code).join("");
      const id = `${ALERT_ID_PREFIX}${codes}-${digits === "" ? String(Math.trunc(now)) : digits}`;
      const r = deps.record(`api-alert:${id}`, {
        type: "inbox.added",
        payload: {
          id,
          kind: "info",
          nodeId: deps.rootNodeId,
          summary: `窓口の警告（${windowText(event)}）: ${parts.join("・")}。トークンの総当たりや、暴走した呼び出しの可能性がある（daemon の記録の apiSummary に、内訳がある）`,
        },
      } as EventBody);
      if (!r.ok) {
        deps.note("apiAlert.failed", { code: r.error.code });
        return;
      }
      for (const k of fired) last.set(k.key, now);
      deps.note("apiAlert.posted", { kinds: fired.map((k) => k.key).join(",") });
      // 同じ種類の、前の未解決の警告を、system が解決済みにする（積み上げない）
      for (const old of deps.openAlertIds()) {
        if (old === id) continue;
        const m = ALERT_ID.exec(old);
        if (m === null || !fired.some((k) => m[1]?.includes(k.code))) continue;
        const rr = deps.record(`api-alert-resolve:${old}`, {
          type: "inbox.resolved",
          payload: { itemId: old },
        } as EventBody);
        if (!rr.ok) deps.note("apiAlert.resolveFailed", { code: rr.error.code });
      }
    } catch (e) {
      deps.note("apiAlert.failed", { code: "exception", cause: String(e) });
    }
  };
  return (event) => {
    if (event.event !== "apiSummary") return;
    defer(() => post(event));
  };
}
