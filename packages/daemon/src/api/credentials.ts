/**
 * 窓口の認証情報。人間（画面・コマンド）の資格情報と、ノード専用のトークン（MCP）を分ける（NFR_004）。
 * 呼び出したロールとノードは、要求の本文の申告ではなく、このトークンから決める。
 *
 * - トークンそのものは保持せず、SHA-256 のハッシュだけを持つ。照合は定数時間で行う。
 * - ノードのトークンは、ノードごとに 1 つ。再発行すると古いものは無効になる。`revokeNode` で失効させる。
 * - 未知・不正なトークンは認証しない（フェイルクローズ）。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { TokenRepository } from "./token-repository.js";

export type Principal =
  | { readonly role: "human" }
  | { readonly role: "integrator" | "child"; readonly nodeId: string };

export type NodeRoleForToken = "integrator" | "child";

/** トークンの期限（T21-te。M5）。値はミリ秒。 */
export interface TokenExpiry {
  /** daemon が起動する子（`sdk`）の、使わなければ切れる期限。絶対の期限は付けない。既定 6 時間。 */
  readonly sdkIdleMs: number;
  /** 紐付け（`bind`。Desktop の子）の、発行からの絶対の期限。既定 24 時間。 */
  readonly bindAbsoluteMs: number;
  /** 紐付け（`bind`）の、使わなければ切れる期限。既定 1 時間。 */
  readonly bindIdleMs: number;
}
export const DEFAULT_TOKEN_EXPIRY: TokenExpiry = {
  sdkIdleMs: 6 * 3_600_000,
  bindAbsoluteMs: 24 * 3_600_000,
  bindIdleMs: 3_600_000,
};
/** 最後に使った時刻を、保存先へ書く間隔の下限（1 ノードにつき）。 */
export const LAST_USED_WRITE_MS = 60_000;

/** 期限切れ・役目の終わりで失効させた理由。 */
export type ExpiryReason = "absolute" | "idle" | "retired";

export type TokenKind = "sdk" | "bind";

export interface CredentialStore {
  authenticate(token: unknown): Principal | undefined;
  /** 直近に期限切れ・役目の終わりで失効させたトークンか（応答の失敗の記号を tokenExpired にするため。メモリだけ）。 */
  wasExpired?(token: unknown): boolean;
  /** 期限・役目の終わりを見回り、失効させる（定期の見回り）。失効させたノードの ID。 */
  sweepExpired?(): string[];
  /**
   * そのノードのトークンを、役目の終わりとして失効させる（止まった子。T21-te M1）。`revokeNode` と違い、その後の呼び出しは
   * tokenExpired になる。トークンがなければ何もしない（false）。
   */
  expireNode?(nodeId: string): boolean;
  /** そのノードのトークンを使ったものとして数える（フックの呼び出し・道具の使用。T21-te R3）。 */
  touchNode?(nodeId: string): void;
  /** ノード専用のトークンを発行する（そのノードの既存のトークンは無効になる）。`kind` の既定は `sdk`。 */
  issueNodeToken(nodeId: string, role: NodeRoleForToken, kind?: TokenKind): string;
  revokeNode(nodeId: string): void;
  /** トークンを持つノードの ID（起動時に、ストアにないノードのトークンを掃除するのに使う）。 */
  nodeIds(): string[];
}

export const TOKEN_SHAPE = /^[A-Za-z0-9._~+/=-]{16,512}$/;
const MIN_HUMAN_TOKEN = 32;

/** `Authorization: Bearer <token>` からトークンを取り出す。形が違えば `undefined`。 */
export function parseBearer(header: unknown): string | undefined {
  if (typeof header !== "string") return undefined;
  const m = /^Bearer ([^ ]+)$/.exec(header);
  const token = m?.[1];
  return token !== undefined && TOKEN_SHAPE.test(token) ? token : undefined;
}

/** 人間のトークンを生成する（`randomBytes(32).base64url` に固定。43 文字）。 */
export const generateHumanToken = (): string => randomBytes(32).toString("base64url");

const sha256 = (s: string): Buffer => createHash("sha256").update(s, "utf8").digest();

export function createCredentialStore(options: {
  readonly humanToken: string;
  /** テスト用。既定は `crypto.randomBytes`。 */
  readonly randomBytes?: (size: number) => Buffer;
  /** ノードのトークンの保存先。省略するとメモリ上だけ（再起動で無効になる）。 */
  readonly repository?: TokenRepository;
  /** 発行日時（ISO 8601 UTC）。既定は現在時刻。 */
  readonly clock?: () => string;
  /**
   * ノードのトークンを発行し直した・失効させた直後に呼ぶ（T22-hu。フックの受け口の session_id の結び付けを外す）。
   * 古いトークンを無効にしたあと、同じ同期の処理の中で呼ぶ。これだけでは、認証を済ませて本文を読んでいる途中の古い要求が、
   * 外したあとに結んでしまいうるので、受け口は、結ぶ直前に、もう一度認証する（`server.ts` の `handleHook`）。
   * 両方で、古いトークンの要求は、発行し直したあとに結び付けを作れない。
   */
  readonly onNodeTokenChanged?: (nodeId: string) => void;
  /** 期限（T21-te）。省略すると既定。 */
  readonly expiry?: TokenExpiry;
  /** 期限を付けないノード（根）。 */
  readonly exemptNodeId?: string;
  /** 壁時計（ミリ秒）。起動時の基準と、保存した時刻の読み直しに使う。 */
  readonly nowMs?: () => number;
  /**
   * 単調時計（ミリ秒）。動いている間の経過は、これで数える（壁時計が巻き戻っても、期限が延びない。T21-te R1）。
   * 省略すると `nowMs`（試験で時計を差し込むとき）、それもなければ `performance.now`。
   */
  readonly monoMs?: () => number;
  /** 使わなければ切れる時計を止めるノードか（判断待ち・done の子。T21-te R3）。bind の絶対の期限は止めない。 */
  readonly isIdlePaused?: (nodeId: string) => boolean;
  /** そのノードのトークンが、もう要らないか（verified・reclaimable・archived、CLI の子なら停止など）。 */
  readonly isRetired?: (nodeId: string, kind: TokenKind) => boolean;
  /** 期限切れ・役目の終わりで失効させたとき（受信箱への知らせなど）。`issuedAt` は、同じトークンを見分けるのに使う。 */
  readonly onExpired?: (
    nodeId: string,
    reason: ExpiryReason,
    kind: TokenKind,
    issuedAt: string,
  ) => void;
}): CredentialStore {
  if (typeof options.humanToken !== "string" || options.humanToken.length < MIN_HUMAN_TOKEN) {
    throw new RangeError(`人間のトークンは ${MIN_HUMAN_TOKEN} 文字以上が必要`);
  }
  const random = options.randomBytes ?? randomBytes;
  const humanHash = sha256(options.humanToken);
  /** ハッシュ（16 進）→ 主体。 */
  const byHash = new Map<string, Principal>();
  /** nodeId → 現在のトークンのハッシュ。 */
  const byNode = new Map<string, string>();
  /** nodeId → 期限の情報（発行・最後に使った時刻〔ミリ秒〕、保存先へ最後に書いた時刻）。 */
  const meta = new Map<
    string,
    {
      kind: TokenKind;
      role: NodeRoleForToken;
      issuedAt: string;
      issuedMs: number;
      lastUsedMs: number;
      writtenMs: number;
    }
  >();
  /** 直近に失効させたトークンのハッシュ（応答で tokenExpired にする。上限つき。メモリだけ）。 */
  const expiredHashes = new Set<string>();
  const EXPIRED_MAX = 1000;
  const repository = options.repository;
  const clock = options.clock ?? (() => new Date().toISOString());
  // 今の時刻 = 起動時の壁時計 + 単調時計の経過。
  const wallMs = options.nowMs ?? Date.now;
  const mono = options.monoMs ?? options.nowMs ?? (() => performance.now());
  const wall0 = wallMs();
  const mono0 = mono();
  const nowMs = (): number => wall0 + (mono() - mono0);
  const expiry = options.expiry ?? DEFAULT_TOKEN_EXPIRY;
  const parseMs = (iso: string | undefined, fallback: number): number => {
    const t = iso === undefined ? Number.NaN : Date.parse(iso);
    return Number.isNaN(t) ? fallback : t;
  };
  // 保存済みのトークンを復元する（壊れたファイルなどは例外。黙って捨てない）。
  for (const r of repository?.load() ?? []) {
    byHash.set(r.tokenHash, { role: r.role, nodeId: r.nodeId });
    byNode.set(r.nodeId, r.tokenHash);
    const issuedMs = parseMs(r.issuedAt, nowMs());
    // 時計が戻った（最後に使った時刻が未来）ときは、今の時刻に丸める。版 1（最後に使った時刻がない）は、読んだ時から数える
    const lastUsedMs = Math.min(parseMs(r.lastUsedAt, nowMs()), nowMs());
    meta.set(r.nodeId, {
      // 版 1（種類がない）は、厳しい側の bind とみなす（発行から 24 時間。どの子のものか分からないため。T21-te R2）
      kind: r.kind ?? "bind",
      role: r.role,
      issuedAt: r.issuedAt,
      issuedMs,
      lastUsedMs,
      writtenMs: lastUsedMs,
    });
  }
  /** 期限切れ・役目の終わりなら、その理由。 */
  const expiredReason = (nodeId: string, now: number): ExpiryReason | undefined => {
    if (nodeId === options.exemptNodeId) return undefined;
    const m = meta.get(nodeId);
    if (m === undefined) return undefined;
    if (options.isRetired?.(nodeId, m.kind) === true) return "retired";
    // 判断待ち・done のあいだは、使ったものとして数える（使わなければ切れる時計を進めない）
    if (options.isIdlePaused?.(nodeId) === true) m.lastUsedMs = Math.max(m.lastUsedMs, now);
    if (m.kind === "bind") {
      if (now - m.issuedMs >= expiry.bindAbsoluteMs) return "absolute";
      if (now - m.lastUsedMs >= expiry.bindIdleMs) return "idle";
      return undefined;
    }
    return now - m.lastUsedMs >= expiry.sdkIdleMs ? "idle" : undefined;
  };
  /** 期限切れで失効させる（今の revoke と同じ流れ。フック用も onNodeTokenChanged で一緒に無効）。 */
  const expire = (nodeId: string, reason: ExpiryReason): void => {
    const h = byNode.get(nodeId);
    const m = meta.get(nodeId);
    if (h === undefined || m === undefined) return;
    repository?.remove(nodeId);
    byHash.delete(h);
    byNode.delete(nodeId);
    meta.delete(nodeId);
    expiredHashes.add(h);
    if (expiredHashes.size > EXPIRED_MAX) {
      const first = expiredHashes.values().next().value;
      if (first !== undefined) expiredHashes.delete(first);
    }
    options.onNodeTokenChanged?.(nodeId);
    options.onExpired?.(nodeId, reason, m.kind, m.issuedAt);
  };
  /** 最後に使った時刻を更新し、保存先へは 1 ノードにつき LAST_USED_WRITE_MS に 1 回まで書く。 */
  const touch = (nodeId: string, h: string, now: number): void => {
    const m = meta.get(nodeId);
    if (m === undefined) return;
    m.lastUsedMs = Math.max(m.lastUsedMs, now);
    if (repository === undefined || now - m.writtenMs < LAST_USED_WRITE_MS) return;
    try {
      repository.put({
        tokenHash: h,
        role: m.role,
        nodeId,
        issuedAt: m.issuedAt,
        lastUsedAt: new Date(m.lastUsedMs).toISOString(),
        kind: m.kind,
      });
      m.writtenMs = now;
    } catch {
      // 書けなくても認証は続ける（次の機会に書く。daemon が落ちれば、古い時刻が残る＝期限が早く来る側）
    }
  };

  return {
    authenticate(token) {
      if (typeof token !== "string" || token === "") return undefined;
      const h = sha256(token);
      if (timingSafeEqual(h, humanHash)) return { role: "human" };
      const hex = h.toString("hex");
      const p = byHash.get(hex);
      if (p === undefined || p.role === "human") return p;
      const now = nowMs();
      const reason = expiredReason(p.nodeId, now);
      if (reason !== undefined) {
        expire(p.nodeId, reason);
        return undefined;
      }
      touch(p.nodeId, hex, now);
      return p;
    },
    wasExpired(token) {
      if (typeof token !== "string" || token === "") return false;
      return expiredHashes.has(sha256(token).toString("hex"));
    },
    expireNode(nodeId) {
      if (nodeId === options.exemptNodeId || !byNode.has(nodeId)) return false;
      expire(nodeId, "retired");
      return true;
    },
    touchNode(nodeId) {
      const h = byNode.get(nodeId);
      if (h === undefined) return;
      const now = nowMs();
      if (expiredReason(nodeId, now) !== undefined) return; // 切れたものは延ばさない（次の認証・見回りで失効）
      touch(nodeId, h, now);
    },
    sweepExpired() {
      const now = nowMs();
      const out: string[] = [];
      for (const nodeId of [...byNode.keys()]) {
        const reason = expiredReason(nodeId, now);
        if (reason === undefined) continue;
        expire(nodeId, reason);
        out.push(nodeId);
      }
      return out;
    },
    issueNodeToken(nodeId, role, kind = "sdk") {
      if (typeof nodeId !== "string" || nodeId === "") throw new RangeError("nodeId が不正");
      if (role !== "integrator" && role !== "child") throw new RangeError("ロールが不正");
      const old = byNode.get(nodeId);
      const token = random(32).toString("base64url");
      const h = sha256(token).toString("hex");
      // 保存に成功してから有効にする（失敗したら例外で、トークンは発行されず、古いトークンも残る）。
      const issuedAt = clock();
      repository?.put({ tokenHash: h, role, nodeId, issuedAt, lastUsedAt: issuedAt, kind });
      if (old !== undefined) byHash.delete(old);
      byHash.set(h, { role, nodeId });
      byNode.set(nodeId, h);
      const now = nowMs();
      meta.set(nodeId, { kind, role, issuedAt, issuedMs: now, lastUsedMs: now, writtenMs: now });
      options.onNodeTokenChanged?.(nodeId);
      return token;
    },
    nodeIds: () => [...byNode.keys()],
    revokeNode(nodeId) {
      const h = byNode.get(nodeId);
      if (h === undefined) return;
      // 保存先から消せなかったら例外（メモリ上も残す。失効できていないことを、呼び出し側が知れる）。
      repository?.remove(nodeId);
      byHash.delete(h);
      byNode.delete(nodeId);
      meta.delete(nodeId);
      options.onNodeTokenChanged?.(nodeId);
    },
  };
}
