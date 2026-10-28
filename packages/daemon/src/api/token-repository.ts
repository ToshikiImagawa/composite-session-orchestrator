/**
 * ノードのトークンの永続化（daemon の再起動後も有効にする）。保存するのはハッシュ・ロール・nodeId・発行日時だけで、
 * トークンそのものは保存しない。ファイルは 0600、置き場所のディレクトリは 0700。
 *
 * - 書き込みは、同じディレクトリの一時ファイル（0600）に書いて `rename` する（原子的。途中で止まっても壊れない）。
 * - 読み込みで、権限が緩い・シンボリックリンク・所有者が違う・置き場所のディレクトリがグループ・他者から書き込める・
 *   壊れた JSON・不正な形・ハッシュや nodeId の重複は、黙って捨てずに失敗させる（フェイルクローズ。全トークンが
 *   無効になることを、起動の失敗として人が知れるようにする）。読み込みのとき、前回の書き込みの途中で残った
 *   一時ファイル（`.tokens-*.tmp`）を掃除する。
 * - `rename` のあとに、置き場所のディレクトリも `fsync` する（電源断のあとも、新しいファイルが残るように）。
 * - Windows は対象外（POSIX のモード・所有者を前提にする）。
 * - トークンの最大有効期間（例: 30 日）の方針は design 9.2。
 * - daemon は単一プロセス。複数のプロセスが同じファイルを書く使い方は想定しない。
 */

import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isSafeId } from "@cso/core";
import { assertSecureDirectory, assertSecureFile, processUid } from "./fs-safety.js";

export interface TokenRecord {
  /** トークンの SHA-256（16 進 64 文字）。 */
  readonly tokenHash: string;
  readonly role: "integrator" | "child";
  readonly nodeId: string;
  /** ISO 8601（UTC）。 */
  readonly issuedAt: string;
  /** 最後に使った時刻（ISO 8601 UTC。版 2。T21-te）。なければ issuedAt とみなす。 */
  readonly lastUsedAt?: string;
  /**
   * 発行のしかた（版 2。T21-te）。`sdk`: daemon が起動する子（生成・再開）、`bind`: 紐付け（Desktop の子）。
   * なければ `sdk` とみなす（版 1 のファイル）。期限の決まりが違う。
   */
  readonly kind?: "sdk" | "bind";
}

export interface TokenRepository {
  load(): TokenRecord[];
  /** 同じノードの記録は置き換える。失敗したら例外（呼び出し側はトークンを発行しない）。 */
  put(record: TokenRecord): void;
  remove(nodeId: string): void;
}

/** 書く版（T21-te で 2。読みは 1 と 2）。 */
const FILE_VERSION = 2;
const READABLE_VERSIONS: ReadonlySet<unknown> = new Set([1, 2]);
const HASH = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isTokenRecord(x: unknown): x is TokenRecord {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.tokenHash === "string" &&
    HASH.test(r.tokenHash) &&
    (r.role === "integrator" || r.role === "child") &&
    isSafeId(r.nodeId) &&
    typeof r.issuedAt === "string" &&
    ISO.test(r.issuedAt) &&
    !Number.isNaN(Date.parse(r.issuedAt)) &&
    (r.lastUsedAt === undefined ||
      (typeof r.lastUsedAt === "string" &&
        ISO.test(r.lastUsedAt) &&
        !Number.isNaN(Date.parse(r.lastUsedAt)))) &&
    (r.kind === undefined || r.kind === "sdk" || r.kind === "bind")
  );
}

/** グループ・他者に権限があるか。 */
export const isLoosePermission = (mode: number): boolean => (mode & 0o077) !== 0;

export class FileTokenRepository implements TokenRepository {
  private records: Map<string, TokenRecord> | undefined;
  private readonly getUid: () => number | undefined;

  constructor(
    private readonly path: string,
    options: { readonly getUid?: () => number | undefined } = {},
  ) {
    this.getUid = options.getUid ?? processUid;
  }

  load(): TokenRecord[] {
    const dir = dirname(this.path);
    let dirExists = true;
    try {
      lstatSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      dirExists = false;
    }
    if (dirExists) {
      assertSecureDirectory(dir, this.getUid());
      this.cleanTemp(dir);
    }
    try {
      lstatSync(this.path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.records = new Map();
        return [];
      }
      throw e;
    }
    assertSecureFile(this.path, this.getUid());
    const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
    const p = parsed as { version?: unknown; tokens?: unknown };
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      !READABLE_VERSIONS.has(p.version) ||
      !Array.isArray(p.tokens) ||
      !p.tokens.every(isTokenRecord)
    ) {
      throw new Error(`トークンのファイル ${this.path} の形が不正`);
    }
    const hashes = new Set(p.tokens.map((t) => t.tokenHash));
    const nodes = new Set(p.tokens.map((t) => t.nodeId));
    if (hashes.size !== p.tokens.length || nodes.size !== p.tokens.length) {
      throw new Error(`トークンのファイル ${this.path} に、ハッシュまたは nodeId の重複がある`);
    }
    this.records = new Map(p.tokens.map((t) => [t.nodeId, t]));
    return [...this.records.values()];
  }

  put(record: TokenRecord): void {
    const records = this.ensure();
    const next = new Map(records);
    next.set(record.nodeId, record);
    this.write(next);
    this.records = next;
  }

  remove(nodeId: string): void {
    const records = this.ensure();
    if (!records.has(nodeId)) return;
    const next = new Map(records);
    next.delete(nodeId);
    this.write(next);
    this.records = next;
  }

  private ensure(): Map<string, TokenRecord> {
    if (this.records === undefined) this.load();
    return this.records as Map<string, TokenRecord>;
  }

  /** 前回の書き込みの途中で残った一時ファイル（`.tokens-*.tmp`）を消す。 */
  private cleanTemp(dir: string): void {
    for (const name of readdirSync(dir)) {
      if (!/^\.tokens-[0-9]+-[0-9]+\.tmp$/.test(name)) continue;
      try {
        unlinkSync(join(dir, name));
      } catch {
        // 消せなくても続ける（次の起動でまた試す）。
      }
    }
  }

  private write(records: ReadonlyMap<string, TokenRecord>): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertSecureDirectory(dir, this.getUid());
    const tmp = join(dir, `.tokens-${process.pid}-${Date.now()}.tmp`);
    const body = `${JSON.stringify({ version: FILE_VERSION, tokens: [...records.values()] }, null, 2)}\n`;
    const fd = openSync(tmp, "wx", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(tmp, 0o600);
    renameSync(tmp, this.path);
    // rename を永続にするため、ディレクトリも fsync する。
    const dfd = openSync(dir, "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  }
}

/** テスト・永続化しない構成用。`failNext` で保存の失敗を再現できる。 */
export class MemoryTokenRepository implements TokenRepository {
  private readonly records = new Map<string, TokenRecord>();
  failNext = false;

  load(): TokenRecord[] {
    return [...this.records.values()];
  }
  put(record: TokenRecord): void {
    this.check();
    this.records.set(record.nodeId, record);
  }
  remove(nodeId: string): void {
    this.check();
    this.records.delete(nodeId);
  }
  private check(): void {
    if (this.failNext) {
      this.failNext = false;
      throw new Error("保存に失敗した");
    }
  }
}
