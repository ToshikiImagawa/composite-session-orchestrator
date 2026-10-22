import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIdentity,
  IDENTITY_FILE,
  isValidNonce,
  parseIdentityFile,
  proofMatches,
  proofOf,
  removeIdentityFile,
  writeIdentityFile,
} from "../../src/api/identity.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cso-identity-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// 契約（docs/daemon-identity.md）の試験ベクトル。相手の実装も、同じ値になること。
const VECTOR = {
  daemonId: "00112233445566778899aabbccddeeff",
  secret: "ff".repeat(32),
  hostPort: "127.0.0.1:43210",
  nonce: "0123456789abcdef0123456789abcdef",
  proof: "a4c03bfab8207e7a550d464c02f9467f4bed4a7e504bfb5da6fe98b22e29be3a",
  /** 同じ入力で、ポートだけが違う（43211）ときの proof。 */
  proofOtherPort: "1577069198737695bc2df73dc098dce25f6abd3157c269450ab49f29d58f4855",
};

describe("身元の proof（T10m-i）", () => {
  it("契約の試験ベクトルと一致する（HMAC-SHA256。鍵は秘密のバイト列、データは文脈・daemonId・nonce を NUL でつなぐ）", () => {
    expect(
      proofOf({ daemonId: VECTOR.daemonId, secret: VECTOR.secret }, VECTOR.hostPort, VECTOR.nonce),
    ).toBe(VECTOR.proof);
  });

  it("ポートだけが違っても、proof は変わる（試験ベクトル。中継の攻撃を防ぐ）", () => {
    const id = { daemonId: VECTOR.daemonId, secret: VECTOR.secret };
    expect(proofOf(id, "127.0.0.1:43211", VECTOR.nonce)).toBe(VECTOR.proofOtherPort);
    expect(VECTOR.proofOtherPort).not.toBe(VECTOR.proof);
  });

  it("nonce・秘密・daemonId のどれが違っても、proof は変わる", () => {
    const id = { daemonId: VECTOR.daemonId, secret: VECTOR.secret };
    const hp = VECTOR.hostPort;
    const base = proofOf(id, hp, VECTOR.nonce);
    expect(proofOf(id, hp, `${VECTOR.nonce.slice(0, -1)}0`)).not.toBe(base);
    expect(proofOf({ ...id, secret: "ee".repeat(32) }, hp, VECTOR.nonce)).not.toBe(base);
    expect(proofOf({ ...id, daemonId: "11".repeat(16) }, hp, VECTOR.nonce)).not.toBe(base);
  });

  it("起動ごとの身元は、毎回違う（形式: daemonId 32 桁・secret 64 桁の小文字 16 進）", () => {
    const a = createIdentity();
    const b = createIdentity();
    expect(a.daemonId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(a.daemonId).not.toBe(b.daemonId);
    expect(a.secret).not.toBe(b.secret);
  });

  it("proofMatches は、長さが違っても例外を出さず、不一致にする", () => {
    expect(proofMatches(VECTOR.proof, VECTOR.proof)).toBe(true);
    expect(proofMatches(VECTOR.proof, VECTOR.proof.slice(1))).toBe(false);
    expect(proofMatches(VECTOR.proof, "")).toBe(false);
  });
});

describe("nonce の形式", () => {
  it.each([
    ["a".repeat(32), true],
    ["a".repeat(128), true],
    ["a".repeat(30), false],
    ["a".repeat(130), false],
    ["a".repeat(33), false], // 奇数
    ["A".repeat(32), false], // 大文字
    [`${"a".repeat(31)}g`, false],
    ["", false],
  ])("%s → %s", (nonce, expected) => {
    expect(isValidNonce(nonce)).toBe(expected);
  });
  it("文字列でなければ不正", () => {
    expect(isValidNonce(undefined)).toBe(false);
    expect(isValidNonce(123)).toBe(false);
  });
});

describe("身元のファイル", () => {
  it("0600 で書く。形式は version・daemonId・secret。parseIdentityFile で読み戻せる", () => {
    const path = join(tmp(), IDENTITY_FILE);
    const id = createIdentity();
    writeIdentityFile(path, id);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(parseIdentityFile(readFileSync(path, "utf8"))).toEqual(id);
    expect(JSON.parse(readFileSync(path, "utf8")).version).toBe(1);
  });

  it("古いファイル（異常終了で残ったもの）は、必ず上書きされる", () => {
    const path = join(tmp(), IDENTITY_FILE);
    writeFileSync(path, "壊れた古い内容", { mode: 0o600 });
    const id = createIdentity();
    writeIdentityFile(path, id);
    expect(parseIdentityFile(readFileSync(path, "utf8"))).toEqual(id);
  });

  it("自分のファイルだけを消す。別の起動が上書きしたものは消さない。ないときは何もしない", () => {
    const path = join(tmp(), IDENTITY_FILE);
    const mine = createIdentity();
    const other = createIdentity();
    writeIdentityFile(path, other);
    removeIdentityFile(path, mine);
    expect(parseIdentityFile(readFileSync(path, "utf8"))).toEqual(other);
    removeIdentityFile(path, other);
    expect(() => readFileSync(path)).toThrow();
    expect(() => removeIdentityFile(path, other)).not.toThrow();
  });

  it("形が違う内容は、読めない（undefined）", () => {
    expect(parseIdentityFile("{}")).toBeUndefined();
    expect(parseIdentityFile("not json")).toBeUndefined();
    expect(
      parseIdentityFile(
        JSON.stringify({ version: 2, daemonId: "a".repeat(32), secret: "b".repeat(64) }),
      ),
    ).toBeUndefined();
    expect(
      parseIdentityFile(
        JSON.stringify({ version: 1, daemonId: "A".repeat(32), secret: "b".repeat(64) }),
      ),
    ).toBeUndefined();
  });
});
