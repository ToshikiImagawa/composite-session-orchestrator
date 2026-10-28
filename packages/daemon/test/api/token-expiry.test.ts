import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCredentialStore,
  DEFAULT_TOKEN_EXPIRY,
  type TokenKind,
} from "../../src/api/credentials.js";
import { createHookTokens } from "../../src/api/hook.js";
import {
  FileTokenRepository,
  type TokenRecord,
  type TokenRepository,
} from "../../src/api/token-repository.js";
import { parseConfig } from "../../src/config.js";

const HUMAN = "h".repeat(40);
const H = 3_600_000;
const T0 = Date.parse("2026-10-20T00:00:00.000Z");

const made: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "cso-te-"));
  chmodSync(d, 0o700);
  made.push(d);
  return d;
};
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 時計を進められるストア。 */
const setup = (
  over: {
    repository?: TokenRepository;
    isRetired?: (nodeId: string, kind: TokenKind) => boolean;
  } = {},
) => {
  let now = T0;
  const expired: [string, string, TokenKind][] = [];
  const s = createCredentialStore({
    humanToken: HUMAN,
    nowMs: () => now,
    clock: () => new Date(now).toISOString(),
    exemptNodeId: "root",
    onExpired: (nodeId, reason, kind) => expired.push([nodeId, reason, kind]),
    ...over,
  });
  return { s, expired, advance: (ms: number) => (now += ms) };
};

/** put の回数を数える保存先。 */
const counting = () => {
  const records = new Map<string, TokenRecord>();
  let puts = 0;
  const repo: TokenRepository = {
    load: () => [...records.values()],
    put: (r) => {
      puts += 1;
      records.set(r.nodeId, r);
    },
    remove: (n) => void records.delete(n),
  };
  return { repo, records, puts: () => puts };
};

describe("トークンの期限（T21-te）", () => {
  it("CLI の子: 使っている間は切れない。6 時間使わなければ切れ、tokenExpired と分かる", () => {
    const { s, expired, advance } = setup();
    const t = s.issueNodeToken("a", "child");
    advance(5 * H);
    expect(s.authenticate(t)).toEqual({ role: "child", nodeId: "a" });
    advance(5 * H); // 最後に使ってから 5 時間（発行から 10 時間）
    expect(s.authenticate(t)).toEqual({ role: "child", nodeId: "a" });
    advance(DEFAULT_TOKEN_EXPIRY.sdkIdleMs);
    expect(s.authenticate(t)).toBeUndefined();
    expect(s.wasExpired?.(t)).toBe(true);
    expect(s.wasExpired?.("x".repeat(43))).toBe(false);
    expect(expired).toEqual([["a", "idle", "sdk"]]);
  });

  it("Desktop の子: 使っていても 24 時間で切れ、1 時間使わなくても切れる", () => {
    const { s, expired, advance } = setup();
    const t = s.issueNodeToken("a", "child", "bind");
    for (let i = 0; i < 24; i++) {
      advance(H - 1);
      expect(s.authenticate(t)).toBeDefined();
    }
    advance(100); // 発行から 24 時間。最後に使ってからは 0.1 秒
    expect(s.authenticate(t)).toBeUndefined();
    expect(expired).toEqual([["a", "absolute", "bind"]]);

    const u = s.issueNodeToken("b", "child", "bind");
    advance(H);
    expect(s.authenticate(u)).toBeUndefined();
    expect(expired[1]).toEqual(["b", "idle", "bind"]);
  });

  it("根のトークンには期限を付けない", () => {
    const { s, advance } = setup();
    const t = s.issueNodeToken("root", "integrator");
    advance(1000 * H);
    expect(s.authenticate(t)).toEqual({ role: "integrator", nodeId: "root" });
  });

  it("役目の終わった子（isRetired）は、見回りで失効させる。期限の内でも", () => {
    const retired = new Set<string>();
    const { s, expired } = setup({ isRetired: (n) => retired.has(n) });
    const a = s.issueNodeToken("a", "child");
    const b = s.issueNodeToken("b", "child");
    retired.add("a");
    s.sweepExpired?.();
    expect(s.authenticate(a)).toBeUndefined();
    expect(s.authenticate(b)).toBeDefined();
    expect(expired).toEqual([["a", "retired", "sdk"]]);
  });

  it("見回りは、使われていないトークンも失効させる（1 回だけ知らせる）", () => {
    const { s, expired, advance } = setup();
    s.issueNodeToken("a", "child");
    advance(7 * H);
    s.sweepExpired?.();
    s.sweepExpired?.();
    expect(expired).toEqual([["a", "idle", "sdk"]]);
  });

  it("最後に使った時刻の書き込みは、ノードごとに 1 分に 1 回まで", () => {
    const c = counting();
    const { s, advance } = setup({ repository: c.repo });
    const t = s.issueNodeToken("a", "child");
    expect(c.puts()).toBe(1);
    for (let i = 0; i < 30; i++) {
      advance(1000);
      s.authenticate(t);
    }
    expect(c.puts()).toBe(1);
    advance(31_000);
    s.authenticate(t);
    expect(c.puts()).toBe(2);
    expect(c.records.get("a")?.lastUsedAt).toBe(new Date(T0 + 61_000).toISOString());
  });

  it("再起動しても、最後に使った時刻と種類から期限を続ける。版 1 のファイルも読める", () => {
    const dir = tmp();
    const path = join(dir, "tokens.json");
    let now = T0;
    const opts = {
      humanToken: HUMAN,
      nowMs: () => now,
      clock: () => new Date(now).toISOString(),
    };
    const s1 = createCredentialStore({ ...opts, repository: new FileTokenRepository(path) });
    const t = s1.issueNodeToken("a", "child", "bind");
    const file = JSON.parse(readFileSync(path, "utf8"));
    expect(file.version).toBe(2);
    expect(file.tokens[0].kind).toBe("bind");
    now += 30 * 60_000;
    const s2 = createCredentialStore({ ...opts, repository: new FileTokenRepository(path) });
    expect(s2.authenticate(t)).toBeDefined();
    now += 61 * 60_000; // 発行から 1 時間半。最後に使ったのは 1 時間前（書き込み済み）
    const s3 = createCredentialStore({ ...opts, repository: new FileTokenRepository(path) });
    expect(s3.authenticate(t)).toBeUndefined();

    // 版 1（lastUsedAt・kind なし）: CLI の子として、発行日時から数える
    const v1 = { ...file.tokens[0] };
    delete v1.lastUsedAt;
    delete v1.kind;
    v1.issuedAt = new Date(now - H).toISOString();
    writeFileSync(path, JSON.stringify({ version: 1, tokens: [v1] }), { mode: 0o600 });
    const s4 = createCredentialStore({ ...opts, repository: new FileTokenRepository(path) });
    expect(s4.authenticate(t)).toBeDefined(); // sdk は 6 時間まで
    now += 6 * H;
    expect(s4.authenticate(t)).toBeUndefined();
  });

  it("最後に使った時刻が未来なら、今に寄せる（時計の巻き戻しで期限が延びない）", () => {
    const c = counting();
    c.records.set("a", {
      tokenHash: "0".repeat(64),
      role: "child",
      nodeId: "a",
      issuedAt: new Date(T0).toISOString(),
      lastUsedAt: new Date(T0 + 1000 * H).toISOString(),
      kind: "sdk",
    });
    const { s, expired, advance } = setup({ repository: c.repo });
    advance(6 * H);
    s.sweepExpired?.();
    expect(expired).toEqual([["a", "idle", "sdk"]]);
  });
});

describe("フック用のトークンの期限（T21-te）", () => {
  it("発行から 24 時間で切れる。使っていても延びない", () => {
    let now = T0;
    const h = createHookTokens({ nowMs: () => now });
    const t = h.issue("a");
    now += 23 * H;
    expect(h.authenticate(t)).toBe("a");
    now += H;
    expect(h.authenticate(t)).toBeUndefined();
    const u = createHookTokens({ nowMs: () => now, maxAgeMs: 60_000 }).issue("b");
    expect(u).toBeTypeOf("string");
  });
});

describe("設定 tokenExpiryMinutes", () => {
  const base = {
    stateDir: "/var/cso/state",
    repoRoot: "/work/repo",
    worktreeRoot: "/work/worktrees",
    rootCwd: "/work/repo",
    rootScope: { writableLocations: ["src"], forbiddenLocations: [".git"], allowedCommands: [] },
    mcpUrl: "http://127.0.0.1:7777/mcp",
  };
  it("1〜525600 の整数だけを受け付ける", () => {
    const ok = parseConfig(
      JSON.stringify({ ...base, tokenExpiryMinutes: { sdkIdle: 30, hookAbsolute: 60 } }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.value.tokenExpiryMinutes).toEqual({ sdkIdle: 30, hookAbsolute: 60 });
    for (const bad of [
      { sdkIdle: 0 },
      { bindIdle: 1.5 },
      { other: 1 },
      { bindAbsolute: 525_601 },
    ]) {
      expect(parseConfig(JSON.stringify({ ...base, tokenExpiryMinutes: bad })).ok).toBe(false);
    }
  });
});
