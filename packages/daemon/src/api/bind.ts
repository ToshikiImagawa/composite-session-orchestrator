/**
 * bind コード（Desktop の子が、紐付けコードで自分をノードに結ぶ。FR_032）。トークンを持たない子のための、専用の認証経路の
 * 部品。コードは、一度きり・短い有効期限（既定 10 分）・ノードに結ぶ。受け付けるときは、失敗の回数を制限する
 * （総当たりへの対策。窓の中で失敗が上限に達したらロックし、ロック中は正しいコードも拒否する）。
 *
 * - コードそのものは保持せず、SHA-256 のハッシュだけを持つ。メモリ上だけ（daemon の再起動で無効になる。再発行する）。
 * - 同じノードへの再発行で、古いコードは無効になる。未使用のコードの数には上限があり、超えたら古いものから捨てる。
 * - 時計は注入する（テストで進める）。
 */

import { createHash, randomBytes } from "node:crypto";
import { isSafeId } from "@cso/core";

export type RedeemResult =
  | { readonly ok: true; readonly nodeId: string }
  | { readonly ok: false; readonly reason: "invalid" }
  /** ロック中。`retryAfterMs` 後に再試行できる。 */
  | { readonly ok: false; readonly reason: "locked"; readonly retryAfterMs: number };

export interface BindCodes {
  /** ノードに結ぶコードを発行する。そのノードの古いコードは無効になる。 */
  issue(nodeId: string): string;
  /** コードを使う（成功すれば無効になる）。失敗は回数を数え、上限でロックする。 */
  redeem(code: unknown): RedeemResult;
  revoke(nodeId: string): void;
}

export interface BindCodesOptions {
  /** 現在時刻（ミリ秒）。 */
  readonly clock?: () => number;
  /** コードの有効期間。既定 10 分。 */
  readonly ttlMs?: number;
  /** 窓の中の失敗の上限。既定 5 回。 */
  readonly maxFailures?: number;
  /** 失敗を数える窓。既定 1 分。 */
  readonly failureWindowMs?: number;
  /** ロックの時間（最後の失敗から）。既定 1 分。 */
  readonly lockoutMs?: number;
  /** 未使用のコードの上限。既定 1000。 */
  readonly maxOutstanding?: number;
  readonly randomBytes?: (size: number) => Buffer;
}

const CODE_SHAPE = /^[A-Za-z0-9_-]{16,128}$/;
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export function createBindCodes(options: BindCodesOptions = {}): BindCodes {
  const clock = options.clock ?? Date.now;
  const ttl = options.ttlMs ?? 10 * 60_000;
  const maxFailures = options.maxFailures ?? 5;
  const window = options.failureWindowMs ?? 60_000;
  const lockout = options.lockoutMs ?? 60_000;
  const maxOutstanding = options.maxOutstanding ?? 1000;
  const random = options.randomBytes ?? randomBytes;

  /** ハッシュ → { nodeId, 期限 }。挿入順（古い順）を保つ。 */
  const byHash = new Map<string, { nodeId: string; expiresAt: number }>();
  const byNode = new Map<string, string>();
  let failures: number[] = [];
  let lockedUntil = 0;

  const drop = (hash: string): void => {
    const e = byHash.get(hash);
    if (e === undefined) return;
    byHash.delete(hash);
    if (byNode.get(e.nodeId) === hash) byNode.delete(e.nodeId);
  };

  return {
    issue(nodeId) {
      if (!isSafeId(nodeId)) throw new RangeError("nodeId が不正");
      const old = byNode.get(nodeId);
      if (old !== undefined) drop(old);
      const code = random(16).toString("base64url");
      const h = sha256(code);
      byHash.set(h, { nodeId, expiresAt: clock() + ttl });
      byNode.set(nodeId, h);
      while (byHash.size > maxOutstanding) {
        const oldest = byHash.keys().next().value as string;
        drop(oldest);
      }
      return code;
    },
    redeem(code) {
      const now = clock();
      if (now < lockedUntil)
        return { ok: false, reason: "locked", retryAfterMs: lockedUntil - now };
      const entry =
        typeof code === "string" && CODE_SHAPE.test(code) ? byHash.get(sha256(code)) : undefined;
      if (entry !== undefined && now < entry.expiresAt) {
        drop(sha256(code as string));
        return { ok: true, nodeId: entry.nodeId };
      }
      if (entry !== undefined) drop(sha256(code as string)); // 期限切れは掃除する
      failures = failures.filter((t) => t > now - window);
      failures.push(now);
      if (failures.length >= maxFailures) lockedUntil = now + lockout;
      return { ok: false, reason: "invalid" };
    },
    revoke(nodeId) {
      const h = byNode.get(nodeId);
      if (h !== undefined) drop(h);
    },
  };
}
