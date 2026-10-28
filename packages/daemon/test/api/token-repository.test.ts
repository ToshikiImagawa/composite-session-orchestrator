import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCredentialStore } from "../../src/api/credentials.js";
import { loadOrCreateHumanToken } from "../../src/api/human-token.js";
import { FileTokenRepository, MemoryTokenRepository } from "../../src/api/token-repository.js";

const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "cso-token-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const HUMAN = "h".repeat(40);
const rec = (nodeId: string, role: "integrator" | "child" = "child") => ({
  tokenHash: `${nodeId}`.padEnd(64, "0").replace(/[^0-9a-f]/g, "a"),
  role,
  nodeId,
  issuedAt: "2026-10-20T00:00:00.000Z",
});
const mode = (p: string) => statSync(p).mode & 0o777;

describe("FileTokenRepository（ハッシュ・ロール・nodeId・発行日時だけを 0600 のファイルに保存）", () => {
  it("保存したものを、開き直しても読める。ファイルは 0600、ディレクトリは 0700", () => {
    const path = join(tmp(), "state", "tokens.json");
    const r1 = new FileTokenRepository(path);
    expect(r1.load()).toEqual([]);
    r1.put(rec("a"));
    r1.put(rec("m1", "integrator"));
    expect(mode(path)).toBe(0o600);
    expect(mode(join(path, ".."))).toBe(0o700);
    const r2 = new FileTokenRepository(path);
    expect(
      r2
        .load()
        .map((x) => x.nodeId)
        .sort(),
    ).toEqual(["a", "m1"]);
  });

  it("同じノードへの保存は置き換え。remove で消える。未知のノードの remove は無視", () => {
    const path = join(tmp(), "tokens.json");
    const r = new FileTokenRepository(path);
    r.put(rec("a"));
    r.put({ ...rec("a"), issuedAt: "2026-10-21T00:00:00.000Z" });
    expect(r.load()).toHaveLength(1);
    expect(r.load()[0]?.issuedAt).toBe("2026-10-21T00:00:00.000Z");
    r.remove("a");
    r.remove("zzz");
    expect(new FileTokenRepository(path).load()).toEqual([]);
  });

  it("保存後に一時ファイルが残らない（原子的な書き込み）", () => {
    const dir = tmp();
    const r = new FileTokenRepository(join(dir, "tokens.json"));
    r.put(rec("a"));
    r.put(rec("b"));
    expect(readdirSync(dir)).toEqual(["tokens.json"]);
  });

  it("グループ・他者が読める権限、壊れた JSON、不正な形のファイルは、黙って捨てずに失敗する（フェイルクローズ）", () => {
    const dir = tmp();
    const path = join(dir, "tokens.json");
    new FileTokenRepository(path).put(rec("a"));
    chmodSync(path, 0o644);
    expect(() => new FileTokenRepository(path).load()).toThrow(/権限/);
    chmodSync(path, 0o600);
    writeFileSync(path, "{not json", { mode: 0o600 });
    expect(() => new FileTokenRepository(path).load()).toThrow();
    for (const bad of [
      { version: 3, tokens: [] },
      { version: 1, tokens: [{ ...rec("a"), role: "human" }] },
      { version: 1, tokens: [{ ...rec("a"), tokenHash: "xyz" }] },
      { version: 1, tokens: [{ ...rec("a"), nodeId: "../x" }] },
      { version: 1, tokens: [{ ...rec("a"), issuedAt: "yesterday" }] },
      { version: 1, tokens: "x" },
      [],
    ]) {
      writeFileSync(path, JSON.stringify(bad), { mode: 0o600 });
      expect(() => new FileTokenRepository(path).load(), JSON.stringify(bad)).toThrow();
    }
  });

  it("ファイルに、トークンそのものは含まれない", () => {
    const path = join(tmp(), "tokens.json");
    const repo = new FileTokenRepository(path);
    const store = createCredentialStore({ humanToken: HUMAN, repository: repo });
    const t = store.issueNodeToken("a", "child");
    const text = readFileSync(path, "utf8");
    expect(text).not.toContain(t);
    expect(text).not.toContain(HUMAN);
    expect(text).toContain('"nodeId": "a"');
  });
});

describe("保存先の安全性（ディレクトリ・ファイルの検査）", () => {
  it("保存先のディレクトリが、グループ・他者から書き込めるなら失敗する（読み込みも書き込みも）", () => {
    const dir = tmp();
    const sub = join(dir, "open");
    mkdirSync(sub, { mode: 0o700 });
    chmodSync(sub, 0o775);
    expect(() => new FileTokenRepository(join(sub, "tokens.json")).load()).toThrow(/ディレクトリ/);
    expect(() => new FileTokenRepository(join(sub, "tokens.json")).put(rec("a"))).toThrow(
      /ディレクトリ/,
    );
    chmodSync(sub, 0o755); // 読めるだけなら許す
    expect(() => new FileTokenRepository(join(sub, "tokens.json")).load()).not.toThrow();
  });

  it("ディレクトリがシンボリックリンクなら失敗する", () => {
    const dir = tmp();
    const real = join(dir, "real");
    mkdirSync(real, { mode: 0o700 });
    symlinkSync(real, join(dir, "link"));
    expect(() => new FileTokenRepository(join(dir, "link", "tokens.json")).load()).toThrow(
      /ディレクトリ/,
    );
  });

  it("トークンのファイルは、通常のファイルだけ（シンボリックリンク・ディレクトリは失敗）。所有者がこのプロセスと違えば失敗", () => {
    const dir = tmp();
    const real = join(dir, "real.json");
    new FileTokenRepository(real).put(rec("a"));
    symlinkSync(real, join(dir, "tokens.json"));
    expect(() => new FileTokenRepository(join(dir, "tokens.json")).load()).toThrow(
      /通常のファイル/,
    );
    mkdirSync(join(dir, "asdir.json"), { mode: 0o700 });
    expect(() => new FileTokenRepository(join(dir, "asdir.json")).load()).toThrow(/通常のファイル/);
    const uid = process.getuid?.() ?? 0;
    expect(() => new FileTokenRepository(real, { getUid: () => uid + 1 }).load()).toThrow(/所有者/);
    expect(() => new FileTokenRepository(real, { getUid: () => uid }).load()).not.toThrow();
  });

  it("ハッシュや nodeId が重複しているファイルは、不正として失敗する", () => {
    const dir = tmp();
    const path = join(dir, "tokens.json");
    for (const tokens of [
      [rec("a"), { ...rec("b"), tokenHash: rec("a").tokenHash }],
      [rec("a"), { ...rec("a"), tokenHash: rec("b").tokenHash }],
    ]) {
      writeFileSync(path, JSON.stringify({ version: 1, tokens }), { mode: 0o600 });
      expect(() => new FileTokenRepository(path).load()).toThrow(/重複/);
    }
  });

  it("起動時（load）に、前回の書き込みの途中で残った一時ファイル（.tokens-*.tmp）を掃除する。他のファイルは消さない", () => {
    const dir = tmp();
    const path = join(dir, "tokens.json");
    writeFileSync(join(dir, ".tokens-123-456.tmp"), "x", { mode: 0o600 });
    writeFileSync(join(dir, "other.txt"), "keep", { mode: 0o600 });
    new FileTokenRepository(path).load();
    expect(readdirSync(dir).sort()).toEqual(["other.txt"]);
  });
});

describe("永続化つきの認証情報（再起動後も有効）", () => {
  it("発行したトークンは、ストアを作り直しても認証できる。失効は永続する。再発行で古いトークンは無効", () => {
    // 使わなければ切れる期限（T21-te）に掛からないよう、発行の少しあとの時計で読み直す
    const soon = () => Date.parse("2026-10-20T01:05:00.000Z");
    const path = join(tmp(), "tokens.json");
    const s1 = createCredentialStore({
      humanToken: HUMAN,
      repository: new FileTokenRepository(path),
      clock: () => "2026-10-20T01:02:03.000Z",
      nowMs: soon,
    });
    const a = s1.issueNodeToken("a", "child");
    const m = s1.issueNodeToken("m1", "integrator");
    const b = s1.issueNodeToken("b", "child");
    s1.revokeNode("b");

    const s2 = createCredentialStore({
      humanToken: HUMAN,
      repository: new FileTokenRepository(path),
      nowMs: soon,
    });
    expect(s2.authenticate(a)).toEqual({ role: "child", nodeId: "a" });
    expect(s2.authenticate(m)).toEqual({ role: "integrator", nodeId: "m1" });
    expect(s2.authenticate(b)).toBeUndefined();
    expect(s2.authenticate(HUMAN)).toEqual({ role: "human" });
    expect(new FileTokenRepository(path).load().find((x) => x.nodeId === "a")?.issuedAt).toBe(
      "2026-10-20T01:02:03.000Z",
    );

    const a2 = s2.issueNodeToken("a", "child"); // 再起動後の再発行
    const s3 = createCredentialStore({
      humanToken: HUMAN,
      repository: new FileTokenRepository(path),
      nowMs: soon,
    });
    expect(s3.authenticate(a)).toBeUndefined();
    expect(s3.authenticate(a2)).toEqual({ role: "child", nodeId: "a" });
  });

  it("保存に失敗したらトークンは発行されない（例外。古いトークンも残る）", () => {
    const repo = new MemoryTokenRepository();
    const store = createCredentialStore({ humanToken: HUMAN, repository: repo });
    const old = store.issueNodeToken("a", "child");
    repo.failNext = true;
    expect(() => store.issueNodeToken("a", "child")).toThrow();
    expect(store.authenticate(old)).toEqual({ role: "child", nodeId: "a" });
    repo.failNext = true;
    expect(() => store.revokeNode("a")).toThrow();
    expect(store.authenticate(old)).toEqual({ role: "child", nodeId: "a" }); // 失効できなかった。呼び出し側が知れる
  });
});

describe("loadOrCreateHumanToken（人間のトークンは 0600 のファイル）", () => {
  it("なければ作成（0600）し、あれば同じ値を返す", () => {
    const path = join(tmp(), "cfg", "human-token");
    const a = loadOrCreateHumanToken(path);
    expect(a.created).toBe(true);
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(mode(path)).toBe(0o600);
    const b = loadOrCreateHumanToken(path);
    expect(b).toEqual({ token: a.token, created: false });
    expect(createCredentialStore({ humanToken: a.token }).authenticate(a.token)).toEqual({
      role: "human",
    });
  });

  it("権限が緩い・短すぎる・空のファイルは失敗する（上書きしない）", () => {
    const dir = tmp();
    const path = join(dir, "human-token");
    writeFileSync(path, `${"x".repeat(43)}\n`, { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(() => loadOrCreateHumanToken(path)).toThrow(/権限/);
    chmodSync(path, 0o600);
    writeFileSync(path, "short\n", { mode: 0o600 });
    expect(() => loadOrCreateHumanToken(path)).toThrow();
    expect(readFileSync(path, "utf8")).toBe("short\n");
    writeFileSync(path, "", { mode: 0o600 });
    expect(() => loadOrCreateHumanToken(path)).toThrow();
    mkdirSync(join(dir, "d"));
    expect(() => loadOrCreateHumanToken(join(dir, "d"))).toThrow();
  });

  it("形（TOKEN_SHAPE）を検査する: 空白・制御文字・長すぎる値は失敗する", () => {
    const dir = tmp();
    const path = join(dir, "human-token");
    for (const bad of [
      `${"x".repeat(20)} ${"y".repeat(20)}`,
      `${"x".repeat(40)}\u0000`,
      "x".repeat(600),
      `${"é".repeat(40)}`,
    ]) {
      writeFileSync(path, `${bad}\n`, { mode: 0o600 });
      expect(() => loadOrCreateHumanToken(path), JSON.stringify(bad)).toThrow();
    }
  });

  it("置き場所のディレクトリの権限（グループ・他者が書ける）とシンボリックリンクのファイルは失敗する", () => {
    const dir = tmp();
    const open = join(dir, "open");
    mkdirSync(open, { mode: 0o700 });
    chmodSync(open, 0o777);
    expect(() => loadOrCreateHumanToken(join(open, "human-token"))).toThrow(/ディレクトリ/);
    const real = join(dir, "real");
    writeFileSync(real, `${"x".repeat(43)}\n`, { mode: 0o600 });
    symlinkSync(real, join(dir, "link-token"));
    expect(() => loadOrCreateHumanToken(join(dir, "link-token"))).toThrow(/通常のファイル/);
  });
});
