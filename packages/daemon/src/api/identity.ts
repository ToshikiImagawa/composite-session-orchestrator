/**
 * daemon の身元確認（T10m-i。NFR_004・DC_003）。別のプロセスが窓口のポートを奪ったときに、mcp が、トークンを偽の daemon へ送らないための仕組み。
 *
 * - daemon は、起動のたびに、ランダムな秘密 `secret`（32 バイト）と、公開の `daemonId`（16 バイト）を作る。`secret` は、`stateDir` の
 *   0600 のファイル（`daemon-identity`）にだけ置く。窓口（`GET /v1/identity?nonce=…`）は `secret` を返さず、`proof`（HMAC）だけを返す。
 * - 相手（mcp）は、ファイルから `secret` を読み、ランダムな `nonce` で同じ計算をして、`proof` が一致したときだけ、トークンを送る。
 *   ポートを奪っただけの相手は `secret` を知らないので、`proof` を作れない。
 * - 同じユーザーの別プロセスは、ファイルを読めるので、守れない（脅威モデルの範囲外。`docs/daemon-identity.md`）。
 *
 * 形式は、`docs/daemon-identity.md` の契約。`proof = HMAC-SHA256(key = secret のバイト列, data = "cso-daemon-identity-v1\0" + daemonId + "\0" + nonce)` の
 * 16 進（小文字 64 桁）。
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";

export const IDENTITY_FILE = "daemon-identity";
export const IDENTITY_VERSION = 1;
export const IDENTITY_CONTEXT = "cso-daemon-identity-v1";
/** `nonce`: 小文字の 16 進。16 バイト（32 桁）以上、64 バイト（128 桁）以下。 */
export const NONCE_MIN_HEX = 32;
export const NONCE_MAX_HEX = 128;
const NONCE_RE = /^[0-9a-f]+$/;
const DAEMON_ID_RE = /^[0-9a-f]{32}$/;
const SECRET_RE = /^[0-9a-f]{64}$/;

export interface Identity {
  /** 起動ごとの公開 ID（小文字の 16 進 32 桁）。 */
  readonly daemonId: string;
  /** 秘密（小文字の 16 進 64 桁）。ファイルにだけ置く。応答・記録には出さない。 */
  readonly secret: string;
}

export const isValidNonce = (v: unknown): v is string =>
  typeof v === "string" &&
  v.length >= NONCE_MIN_HEX &&
  v.length <= NONCE_MAX_HEX &&
  v.length % 2 === 0 &&
  NONCE_RE.test(v);

export function createIdentity(random: (n: number) => Buffer = randomBytes): Identity {
  return { daemonId: random(16).toString("hex"), secret: random(32).toString("hex") };
}

/** `proof` を計算する（daemon と、相手の検証が、同じ式）。 */
export function proofOf(identity: Identity, nonce: string): string {
  return createHmac("sha256", Buffer.from(identity.secret, "hex"))
    .update(`${IDENTITY_CONTEXT}\0${identity.daemonId}\0${nonce}`, "utf8")
    .digest("hex");
}

/** 定数時間の比較（長さが違えば不一致）。 */
export function proofMatches(expected: string, actual: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(actual, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * 秘密のファイルを、一時ファイル（0600・`wx`）に書いてから、置き換える。古いファイル（異常終了で残ったもの）は、必ず上書きする。
 * 書けなければ例外（起動を失敗させる）。
 */
export function writeIdentityFile(path: string, identity: Identity): void {
  const tmp = `${path}.tmp-${randomBytes(6).toString("hex")}`;
  const body = `${JSON.stringify({ version: IDENTITY_VERSION, daemonId: identity.daemonId, secret: identity.secret })}\n`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, body);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** 自分のファイルだけを消す（別の起動が上書きしたものは消さない）。失敗は無視する（停止を止めない）。 */
export function removeIdentityFile(path: string, identity: Identity): void {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { daemonId?: unknown };
    if (parsed.daemonId !== identity.daemonId) return;
    unlinkSync(path);
  } catch {
    // ない・読めない: 何もしない
  }
}

/** ファイルの内容の検査（相手の実装・試験が使う）。形が違えば `undefined`。 */
export function parseIdentityFile(text: string): Identity | undefined {
  try {
    const o = JSON.parse(text) as Record<string, unknown>;
    if (
      o.version !== IDENTITY_VERSION ||
      typeof o.daemonId !== "string" ||
      !DAEMON_ID_RE.test(o.daemonId) ||
      typeof o.secret !== "string" ||
      !SECRET_RE.test(o.secret)
    ) {
      return undefined;
    }
    return { daemonId: o.daemonId, secret: o.secret };
  } catch {
    return undefined;
  }
}
