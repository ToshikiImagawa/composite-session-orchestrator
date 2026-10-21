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

export interface CredentialStore {
  authenticate(token: unknown): Principal | undefined;
  /** ノード専用のトークンを発行する（そのノードの既存のトークンは無効になる）。 */
  issueNodeToken(nodeId: string, role: NodeRoleForToken): string;
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
  const repository = options.repository;
  const clock = options.clock ?? (() => new Date().toISOString());
  // 保存済みのトークンを復元する（壊れたファイルなどは例外。黙って捨てない）。
  for (const r of repository?.load() ?? []) {
    byHash.set(r.tokenHash, { role: r.role, nodeId: r.nodeId });
    byNode.set(r.nodeId, r.tokenHash);
  }

  return {
    authenticate(token) {
      if (typeof token !== "string" || token === "") return undefined;
      const h = sha256(token);
      if (timingSafeEqual(h, humanHash)) return { role: "human" };
      return byHash.get(h.toString("hex"));
    },
    issueNodeToken(nodeId, role) {
      if (typeof nodeId !== "string" || nodeId === "") throw new RangeError("nodeId が不正");
      if (role !== "integrator" && role !== "child") throw new RangeError("ロールが不正");
      const old = byNode.get(nodeId);
      const token = random(32).toString("base64url");
      const h = sha256(token).toString("hex");
      // 保存に成功してから有効にする（失敗したら例外で、トークンは発行されず、古いトークンも残る）。
      repository?.put({ tokenHash: h, role, nodeId, issuedAt: clock() });
      if (old !== undefined) byHash.delete(old);
      byHash.set(h, { role, nodeId });
      byNode.set(nodeId, h);
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
    },
  };
}
