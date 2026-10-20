/**
 * bind コード（Desktop の子が、紐付けコードで自分をノードに結ぶ。FR_032）。トークンを持たない子のための、専用の認証経路の
 * 部品。コードは、一度きり・短い有効期限（既定 10 分）・ノードに結ぶ。受け付けるときは、失敗の回数を制限する
 * （総当たりへの対策。ノード単位と全体の両方で数え、窓の中で上限に達したらロックする。ロック中は正しいコードも拒否する）。
 *
 * - 形式: 紛らわしい文字（0 O 1 I L）を除いた英数字 31 種から一様に 16 文字（約 79 ビット）を選び、4 文字ずつ「-」で
 *   区切る（例 `ABCD-EFGH-JKMN-PQRS`）。人が Desktop で見て入力しやすく、識別子の形式（`isSafeId`）も満たす。
 *   入力は、大文字小文字・区切り・空白を問わない（`normalizeBindCode`）。
 * - コードそのものは保持せず、正規化したコードの SHA-256 だけを持つ。照合は、全エントリに対して定数時間の比較を行う。
 * - メモリ上だけ（daemon の再起動で無効になる。再発行する）。同じノードへの再発行で、古いコードは無効になる。
 *   未使用のコードの数には上限があり、超えたら古いものから捨てる。
 * - 時計は注入する（テストで進める）。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isSafeId } from "@cso/core";

/** 紛らわしい文字（0 O 1 I L）を除いた 31 種。 */
export const BIND_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 16;
const NORMALIZED = /^[A-HJ-KM-NP-Z2-9]{16}$/;

/** 入力を、比較用の形（大文字、区切りと空白を除く）にする。 */
export const normalizeBindCode = (input: string): string =>
  input.toUpperCase().replace(/[\s-]/g, "");

export type RedeemResult =
  | { readonly ok: true; readonly nodeId: string }
  | { readonly ok: false; readonly reason: "invalid" }
  /** ロック中。`retryAfterMs` 後に再試行できる。 */
  | { readonly ok: false; readonly reason: "locked"; readonly retryAfterMs: number };

export interface BindCodes {
  /** ノードに結ぶコードを発行する。そのノードの古いコードは無効になる。 */
  issue(nodeId: string): string;
  /** `nodeId` のコードを使う（成功すれば無効になる）。失敗は回数を数え、上限でロックする。 */
  redeem(nodeId: unknown, code: unknown): RedeemResult;
  revoke(nodeId: string): void;
  /** 失敗を覚えているノードの数（テスト・監視用）。 */
  trackedNodes(): number;
}

export interface BindCodesOptions {
  /** 現在時刻（ミリ秒）。 */
  readonly clock?: () => number;
  /** コードの有効期間。既定 10 分。 */
  readonly ttlMs?: number;
  /** 窓の中の、ノードごとの失敗の上限。既定 5 回。 */
  readonly maxFailures?: number;
  /** 窓の中の、全体の失敗の上限。既定 20 回。 */
  readonly maxGlobalFailures?: number;
  /** 失敗を数える窓。既定 1 分。 */
  readonly failureWindowMs?: number;
  /** ロックの時間（最後の失敗から）。既定 1 分。 */
  readonly lockoutMs?: number;
  /** 未使用のコードの上限。既定 1000。 */
  readonly maxOutstanding?: number;
  /** 失敗を覚えるノードの上限。既定 1000。 */
  readonly maxTrackedNodes?: number;
  readonly randomBytes?: (size: number) => Buffer;
}

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

interface Limiter {
  failures: number[];
  lockedUntil: number;
}

export function createBindCodes(options: BindCodesOptions = {}): BindCodes {
  const clock = options.clock ?? Date.now;
  const ttl = options.ttlMs ?? 10 * 60_000;
  const maxFailures = options.maxFailures ?? 5;
  const maxGlobal = options.maxGlobalFailures ?? 20;
  const window = options.failureWindowMs ?? 60_000;
  const lockout = options.lockoutMs ?? 60_000;
  const maxOutstanding = options.maxOutstanding ?? 1000;
  const maxTracked = options.maxTrackedNodes ?? 1000;
  const random = options.randomBytes ?? randomBytes;

  /** nodeId → { コードのハッシュ, 期限 }。挿入順（古い順）を保つ。 */
  const entries = new Map<string, { hash: Buffer; expiresAt: number }>();
  const perNode = new Map<string, Limiter>();
  const global: Limiter = { failures: [], lockedUntil: 0 };

  /** 偏りなく選ぶ（31 の倍数 248 未満のバイトだけを使う）。 */
  const generate = (): string => {
    let out = "";
    while (out.length < CODE_LENGTH) {
      for (const b of random(CODE_LENGTH * 2)) {
        if (b < 248 && out.length < CODE_LENGTH) out += BIND_CODE_ALPHABET[b % 31];
      }
    }
    return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 12)}-${out.slice(12)}`;
  };

  const note = (l: Limiter, now: number, max: number): void => {
    l.failures = l.failures.filter((t) => t > now - window);
    l.failures.push(now);
    if (l.failures.length >= max) l.lockedUntil = now + lockout;
  };

  return {
    issue(nodeId) {
      if (!isSafeId(nodeId)) throw new RangeError("nodeId が不正");
      entries.delete(nodeId); // 古いコードを無効にし、挿入順を更新する
      const code = generate();
      entries.set(nodeId, { hash: sha256(normalizeBindCode(code)), expiresAt: clock() + ttl });
      while (entries.size > maxOutstanding) {
        entries.delete(entries.keys().next().value as string);
      }
      return code;
    },
    redeem(nodeId, code) {
      const now = clock();
      const node = typeof nodeId === "string" && isSafeId(nodeId) ? nodeId : undefined;
      const limiter = node === undefined ? undefined : perNode.get(node);
      const lockedUntil = Math.max(global.lockedUntil, limiter?.lockedUntil ?? 0);
      if (now < lockedUntil)
        return { ok: false, reason: "locked", retryAfterMs: lockedUntil - now };

      // 全エントリを、定数時間の比較で走査する（早期に抜けない）。
      const normalized = typeof code === "string" ? normalizeBindCode(code) : "";
      const probe = sha256(NORMALIZED.test(normalized) ? normalized : "\0invalid");
      let matched: string | undefined;
      for (const [id, e] of entries) {
        if (timingSafeEqual(e.hash, probe) && NORMALIZED.test(normalized)) matched = id;
      }
      const e = matched === undefined ? undefined : entries.get(matched);
      if (matched !== undefined && matched === node && e !== undefined && now < e.expiresAt) {
        entries.delete(matched);
        return { ok: true, nodeId: matched };
      }
      if (e !== undefined && matched !== undefined && now >= e.expiresAt) entries.delete(matched); // 期限切れは掃除する

      note(global, now, maxGlobal);
      if (node !== undefined) {
        let l = perNode.get(node);
        if (l === undefined) {
          l = { failures: [], lockedUntil: 0 };
          perNode.set(node, l);
          // 覚えるノードの数に上限（古いものから捨てる。ロック中のものは、期限が過ぎるまで残す）
          for (const [id, x] of perNode) {
            if (perNode.size <= maxTracked) break;
            if (id !== node && x.lockedUntil <= now) perNode.delete(id);
          }
          for (const id of perNode.keys()) {
            if (perNode.size <= maxTracked) break;
            if (id !== node) perNode.delete(id);
          }
        }
        note(l, now, maxFailures);
      }
      return { ok: false, reason: "invalid" };
    },
    revoke(nodeId) {
      entries.delete(nodeId);
    },
    trackedNodes: () => perNode.size,
  };
}
