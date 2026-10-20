/**
 * bind コード（Desktop の子が、紐付けコードで自分をノードに結ぶ。FR_032）。トークンを持たない子のための、専用の認証経路の
 * 部品。コードは、一度きり・短い有効期限（既定 10 分）・ノードに結ぶ。受け付けるときは、ノードごとの失敗の回数を制限する
 * （窓の中で上限に達したら、そのノードをロックする。ロック中は正しいコードも拒否する）。全体は、ロックではなく短い
 * スロットル（`createThrottle`。1 秒あたり N 回の失敗）で抑える。
 *
 * - 形式: Crockford base32（0-9 と A-Z から I L O U を除く 32 種）から一様に 26 文字（130 ビット）を選ぶ。英数字だけで、
 *   識別子の形式（`isSafeId`）の部分集合（`BIND_CODE_SHAPE`）。表示用には `formatBindCodeForDisplay` で区切る。
 *   入力は、大文字小文字・区切り・空白を問わず、紛らわしい文字は Crockford の規則（I L → 1、O → 0）で読む（`normalizeBindCode`）。
 * - コードそのものは保持せず、正規化したコードの SHA-256 だけを持つ。照合は、全エントリに対して定数時間の比較を行う。
 * - 一致したノードの状態を、呼び出し側（`accept`）が許したときだけ、コードを消費する（許さなければ消費しない）。
 * - メモリ上だけ（daemon の再起動で無効になる。再発行する）。同じノードへの再発行で、古いコードは無効になる。
 *   未使用のコードの数には上限があり、超えたら古いものから捨てる。
 * - 時計は注入する（テストで進める）。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isSafeId } from "@cso/core";

/** Crockford base32（I L O U を除く 32 種）。 */
export const BIND_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const CODE_LENGTH = 26;
/** 正規化したコードの形。`ID_PATTERN`（識別子の形式）の部分集合。 */
export const BIND_CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** 入力を、比較用の形（大文字、区切りと空白を除き、O → 0、I・L → 1）にする。 */
export const normalizeBindCode = (input: string): string =>
  input.toUpperCase().replace(/[\s-]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");

/** 表示用に、5 文字ずつ「-」で区切る（5-5-5-5-6）。 */
export const formatBindCodeForDisplay = (code: string): string =>
  [
    code.slice(0, 5),
    code.slice(5, 10),
    code.slice(10, 15),
    code.slice(15, 20),
    code.slice(20),
  ].join("-");

export type RedeemResult =
  | { readonly ok: true; readonly nodeId: string }
  | { readonly ok: false; readonly reason: "invalid" }
  /** コードは正しいが、ノードの状態が許さない（`accept` が偽）。コードは消費せず、失敗にも数えない。 */
  | { readonly ok: false; readonly reason: "rejected" }
  /** ロック中。`retryAfterMs` 後に再試行できる。 */
  | { readonly ok: false; readonly reason: "locked"; readonly retryAfterMs: number };

export interface BindCodes {
  /** ノードに結ぶコードを発行する。そのノードの古いコードは無効になる。 */
  issue(nodeId: string): string;
  /**
   * `nodeId` のコードを使う。コードとノードが合い、`accept(nodeId)` が真のときだけ、コードを消費して成功する。
   * 失敗は回数を数え、上限でロックする。`accept` が偽・例外なら `rejected`（消費せず、失敗にも数えない）。
   */
  redeem(nodeId: unknown, code: unknown, accept?: (nodeId: string) => boolean): RedeemResult;
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
  const window = options.failureWindowMs ?? 60_000;
  const lockout = options.lockoutMs ?? 60_000;
  const maxOutstanding = options.maxOutstanding ?? 1000;
  const maxTracked = options.maxTrackedNodes ?? 1000;
  const random = options.randomBytes ?? randomBytes;

  /** nodeId → { コードのハッシュ, 期限 }。挿入順（古い順）を保つ。 */
  const entries = new Map<string, { hash: Buffer; expiresAt: number }>();
  const perNode = new Map<string, Limiter>();

  /** 偏りなく選ぶ（32 種なので、バイトの下位 5 ビットがちょうど一様）。 */
  const generate = (): string => {
    let out = "";
    for (const b of random(CODE_LENGTH)) out += BIND_CODE_ALPHABET[b & 31];
    return out;
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
      entries.set(nodeId, { hash: sha256(code), expiresAt: clock() + ttl });
      while (entries.size > maxOutstanding) {
        entries.delete(entries.keys().next().value as string);
      }
      return code;
    },
    redeem(nodeId, code, accept) {
      const now = clock();
      const node = typeof nodeId === "string" && isSafeId(nodeId) ? nodeId : undefined;
      const limiter = node === undefined ? undefined : perNode.get(node);
      const lockedUntil = limiter?.lockedUntil ?? 0;
      if (now < lockedUntil)
        return { ok: false, reason: "locked", retryAfterMs: lockedUntil - now };

      // 全エントリを、定数時間の比較で走査する（早期に抜けない）。
      const normalized = typeof code === "string" ? normalizeBindCode(code) : "";
      const shapeOk = BIND_CODE_SHAPE.test(normalized);
      const probe = sha256(shapeOk ? normalized : "\0invalid");
      let matched: string | undefined;
      for (const [id, e] of entries) {
        if (timingSafeEqual(e.hash, probe) && shapeOk) matched = id;
      }
      const e = matched === undefined ? undefined : entries.get(matched);
      if (matched !== undefined && matched === node && e !== undefined && now < e.expiresAt) {
        // ノードの状態を先に確かめ、許されたときだけコードを消費する。
        let allowed = true;
        try {
          allowed = accept === undefined ? true : accept(matched);
        } catch {
          allowed = false;
        }
        if (!allowed) return { ok: false, reason: "rejected" };
        entries.delete(matched);
        return { ok: true, nodeId: matched };
      }
      if (e !== undefined && matched !== undefined && now >= e.expiresAt) entries.delete(matched); // 期限切れは掃除する

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

/** 全体の短いスロットル（1 秒あたり N 回の失敗）。ロックではなく、その秒の残りを止めるだけ。 */
export interface Throttle {
  /** 止めるべきなら、再試行できるまでのミリ秒（最大 1000）。 */
  blocked(): number | undefined;
  /** 失敗を数える（止めている間は数えない）。 */
  fail(): void;
}

export function createThrottle(options: {
  readonly clock?: () => number;
  /** 1 秒あたりの失敗の上限。既定 10。 */
  readonly perSecond?: number;
}): Throttle {
  const clock = options.clock ?? Date.now;
  const max = options.perSecond ?? 10;
  let times: number[] = [];
  const prune = (now: number): void => {
    times = times.filter((t) => t > now - 1000);
  };
  const blocked = (): number | undefined => {
    const now = clock();
    prune(now);
    const first = times[0];
    return times.length >= max && first !== undefined ? first + 1000 - now : undefined;
  };
  return {
    blocked,
    fail() {
      if (blocked() === undefined) times.push(clock());
    },
  };
}
