import { chmodSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfigFile, parseConfig } from "../src/config.js";

const base = {
  stateDir: "/var/cso/state",
  repoRoot: "/work/repo",
  worktreeRoot: "/work/worktrees",
  rootCwd: "/work/repo",
  rootScope: {
    writableLocations: ["src", "docs"],
    forbiddenLocations: [".git"],
    allowedCommands: ["pnpm test"],
  },
  mcpUrl: "http://127.0.0.1:7777/mcp",
};

describe("parseConfig（設定は厳密に検査し、不正なら起動を失敗させる）", () => {
  it("正しい設定を受け取り、既定値（rootNodeId・port）を補う", () => {
    const r = parseConfig(JSON.stringify(base));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toMatchObject({ ...base, rootNodeId: "root", port: 0 });
  });

  it("rootNodeId・port を指定できる", () => {
    const r = parseConfig(JSON.stringify({ ...base, rootNodeId: "top", port: 8123 }));
    expect(r.ok && r.value).toMatchObject({ rootNodeId: "top", port: 8123 });
  });

  const bad = (over: Record<string, unknown>, expectCause?: string) => {
    const r = parseConfig(JSON.stringify({ ...base, ...over }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("invalidConfig");
      expect(r.error.nextActions.length).toBeGreaterThan(0);
      if (expectCause !== undefined) expect(r.error.cause).toContain(expectCause);
    }
  };

  it("JSON でない・オブジェクトでない・未知のキーは拒否する", () => {
    expect(parseConfig("{").ok).toBe(false);
    expect(parseConfig("[]").ok).toBe(false);
    expect(parseConfig("null").ok).toBe(false);
    bad({ extra: 1 }, "extra");
  });

  it("必須のキーがない・絶対パスでない・.. を含むパスは拒否する", () => {
    for (const k of ["stateDir", "repoRoot", "worktreeRoot", "rootCwd", "rootScope", "mcpUrl"]) {
      const { [k]: _omit, ...rest } = base as Record<string, unknown>;
      expect(parseConfig(JSON.stringify(rest)).ok, k).toBe(false);
    }
    bad({ stateDir: "relative/dir" }, "stateDir");
    bad({ worktreeRoot: "/work/../etc" }, "worktreeRoot");
    bad({ repoRoot: "/work/repo\0x" }, "repoRoot");
    bad({ worktreeRoot: "/" }, "worktreeRoot");
  });

  it("置き場が重なる（状態の置き場が作業ツリーの置き場の中、など）設定は拒否する", () => {
    bad({ stateDir: "/work/worktrees/state" }, "重な");
    bad({ worktreeRoot: "/work/repo/wt" }, "重な");
    bad({ stateDir: "/work/repo/.cso" }, "重な");
  });

  it("port は 0〜65535 の整数、rootNodeId は識別子", () => {
    bad({ port: -1 }, "port");
    bad({ port: 70000 }, "port");
    bad({ port: 1.5 }, "port");
    bad({ rootNodeId: "bad id" }, "rootNodeId");
  });

  it("rootScope は、相対パスで、根の作業ツリー（rootCwd）の規則を満たすこと", () => {
    bad({ rootScope: { ...base.rootScope, writableLocations: ["/etc"] } }, "rootScope");
    bad({ rootScope: { ...base.rootScope, writableLocations: ["../x"] } }, "rootScope");
    bad({ rootScope: { ...base.rootScope, writableLocations: [], extra: 1 } }, "rootScope");
    bad({ rootScope: { writableLocations: ["src"] } }, "rootScope");
    bad({ rootScope: { ...base.rootScope, allowedCommands: [""] } }, "rootScope");
  });

  it("regenerableIgnored は、ディレクトリ名の配列（任意）", () => {
    const ok1 = parseConfig(
      JSON.stringify({ ...base, regenerableIgnored: ["node_modules", "build"] }),
    );
    expect(ok1.ok && ok1.value.regenerableIgnored).toEqual(["node_modules", "build"]);
    const none = parseConfig(JSON.stringify(base));
    expect(none.ok && none.value.regenerableIgnored).toBeUndefined();
    for (const v of ["x", [""], ["a/b"], ["."], [".."], ["a", "a"], [1], [" a"]]) {
      bad({ regenerableIgnored: v }, "regenerableIgnored");
    }
  });

  it("digest（配下の要約。T24-d）は、省略できる（既定で有効）。enabled・intervalSec（5〜3600）・minIntervalSec（10〜3600）・maxPerRun（1〜100）だけを持つ", () => {
    const d = parseConfig(JSON.stringify(base));
    expect(d.ok && d.value.digest).toBeUndefined();
    const on = parseConfig(
      JSON.stringify({
        ...base,
        digest: { enabled: true, intervalSec: 5, minIntervalSec: 10, maxPerRun: 3 },
      }),
    );
    expect(on.ok && on.value.digest).toEqual({
      enabled: true,
      intervalSec: 5,
      minIntervalSec: 10,
      maxPerRun: 3,
    });
    const off = parseConfig(JSON.stringify({ ...base, digest: { enabled: false } }));
    expect(off.ok && off.value.digest).toEqual({ enabled: false });
    expect(parseConfig(JSON.stringify({ ...base, digest: {} })).ok).toBe(true);
    for (const v of [
      true,
      "on",
      { enabled: "yes" },
      { intervalSec: 4 },
      { intervalSec: 3601 },
      { intervalSec: 1.5 },
      { minIntervalSec: 9 },
      { maxPerRun: 0 },
      { maxPerRun: 101 },
      { unknown: 1 },
    ]) {
      expect(parseConfig(JSON.stringify({ ...base, digest: v })).ok, JSON.stringify(v)).toBe(false);
    }
  });

  it("wake（中間統合ノードを起こす。T24-w）は、省略するとオフ（既定で無効）。enabled・intervalSec（5〜3600）・minIntervalSec（10〜3600）・maxPerRun（1〜100）だけを持つ", () => {
    const d = parseConfig(JSON.stringify(base));
    expect(d.ok && d.value.wake).toBeUndefined();
    const on = parseConfig(
      JSON.stringify({
        ...base,
        wake: { enabled: true, intervalSec: 5, minIntervalSec: 10, maxPerRun: 3 },
      }),
    );
    expect(on.ok && on.value.wake).toEqual({
      enabled: true,
      intervalSec: 5,
      minIntervalSec: 10,
      maxPerRun: 3,
    });
    expect(parseConfig(JSON.stringify({ ...base, wake: {} })).ok).toBe(true);
    for (const v of [
      true,
      "on",
      { enabled: "yes" },
      { intervalSec: 4 },
      { intervalSec: 3601 },
      { minIntervalSec: 9 },
      { maxPerRun: 0 },
      { maxPerRun: 101 },
      { unknown: 1 },
    ]) {
      expect(parseConfig(JSON.stringify({ ...base, wake: v })).ok, JSON.stringify(v)).toBe(false);
    }
  });

  it("autoPurge（自動の最終削除）は、省略するとオフ。enabled（必須）・intervalMinutes（1〜1440）・maxTreesPerRun（1〜100）だけを持つ", () => {
    const d = parseConfig(JSON.stringify(base));
    expect(d.ok && d.value.autoPurge).toBeUndefined();
    const on = parseConfig(
      JSON.stringify({
        ...base,
        autoPurge: { enabled: true, intervalMinutes: 5, maxTreesPerRun: 2, noticeDays: 14 },
      }),
    );
    expect(on.ok && on.value.autoPurge).toEqual({
      enabled: true,
      intervalMinutes: 5,
      maxTreesPerRun: 2,
      noticeDays: 14,
    });
    const min = parseConfig(JSON.stringify({ ...base, autoPurge: { enabled: false } }));
    expect(min.ok && min.value.autoPurge).toEqual({ enabled: false });
    for (const v of [
      true,
      "on",
      null,
      [],
      {},
      { enabled: "yes" },
      { enabled: true, intervalMinutes: 0 },
      { enabled: true, intervalMinutes: 1441 },
      { enabled: true, intervalMinutes: 1.5 },
      { enabled: true, maxTreesPerRun: 0 },
      { enabled: true, maxTreesPerRun: 101 },
      { enabled: true, noticeDays: 0 },
      { enabled: true, noticeDays: 31 },
      { enabled: true, noticeDays: 1.5 },
      { enabled: true, noticeDays: "7" },
      { enabled: true, unknown: 1 },
    ]) {
      bad({ autoPurge: v }, "autoPurge");
    }
  });

  it("autoPurge を有効にするときは、retentionDays が 7 未満なら拒否する（省略した既定の 90 や、7 以上は可。無効なら制限しない）", () => {
    for (const days of [0, 1, 6]) {
      bad({ retentionDays: days, autoPurge: { enabled: true } }, "retentionDays を 7 以上");
    }
    for (const days of [7, 90]) {
      const ok1 = parseConfig(
        JSON.stringify({ ...base, retentionDays: days, autoPurge: { enabled: true } }),
      );
      expect(ok1.ok, String(days)).toBe(true);
    }
    expect(parseConfig(JSON.stringify({ ...base, autoPurge: { enabled: true } })).ok).toBe(true);
    const off = parseConfig(
      JSON.stringify({ ...base, retentionDays: 0, autoPurge: { enabled: false } }),
    );
    expect(off.ok).toBe(true);
    expect(parseConfig(JSON.stringify({ ...base, retentionDays: 0 })).ok).toBe(true);
  });

  it("rateLimit（窓口の回数の制限の調整。無効にはできない）: 範囲・未知のキーを検査する。下限がある", () => {
    const d = parseConfig(JSON.stringify(base));
    expect(d.ok && d.value.rateLimit).toBeUndefined();
    const ok1 = parseConfig(
      JSON.stringify({
        ...base,
        rateLimit: {
          perPrincipal: { burst: 10, perSecond: 1 },
          authFailures: { burst: 5, perMinute: 5 },
          maxKeys: 100,
        },
      }),
    );
    expect(ok1.ok && ok1.value.rateLimit).toEqual({
      perPrincipal: { burst: 10, perSecond: 1 },
      authFailures: { burst: 5, perMinute: 5 },
      maxKeys: 100,
    });
    const part = parseConfig(
      JSON.stringify({ ...base, rateLimit: { perPrincipal: { burst: 30 } } }),
    );
    expect(part.ok && part.value.rateLimit).toEqual({ perPrincipal: { burst: 30 } });
    for (const v of [
      true,
      "off",
      null,
      [],
      { enabled: false },
      { perPrincipal: { burst: 9 } }, // 重い操作が通らなくなる下限
      { perPrincipal: { burst: 10001 } },
      { perPrincipal: { perSecond: 0 } },
      { perPrincipal: { perSecond: 1.5 } },
      { perPrincipal: { unknown: 1 } },
      { authFailures: { burst: 4 } },
      { authFailures: { perMinute: 4 } },
      { authFailures: { perMinute: 100001 } },
      { maxKeys: 99 },
      { maxKeys: 1000001 },
      { perPrincipal: "x" },
    ]) {
      bad({ rateLimit: v }, "rateLimit");
    }
  });

  it("retentionDays（最終削除の保持期間）は 0 以上の整数（既定は 90）。purgeTombstone は真偽値（任意）", () => {
    const d = parseConfig(JSON.stringify(base));
    expect(d.ok && d.value.retentionDays).toBeUndefined();
    expect(d.ok && d.value.purgeTombstone).toBeUndefined();
    const ok1 = parseConfig(JSON.stringify({ ...base, retentionDays: 0, purgeTombstone: false }));
    expect(ok1.ok && ok1.value.retentionDays).toBe(0);
    expect(ok1.ok && ok1.value.purgeTombstone).toBe(false);
    for (const v of [-1, 1.5, "90", null, 100000]) bad({ retentionDays: v }, "retentionDays");
    for (const v of ["yes", 1, null]) bad({ purgeTombstone: v }, "purgeTombstone");
  });

  it("childEnvAllow は、環境変数の名前の配列（任意）", () => {
    const ok1 = parseConfig(JSON.stringify({ ...base, childEnvAllow: ["AWS_PROFILE", "MY_VAR"] }));
    expect(ok1.ok && ok1.value.childEnvAllow).toEqual(["AWS_PROFILE", "MY_VAR"]);
    const none = parseConfig(JSON.stringify(base));
    expect(none.ok && none.value.childEnvAllow).toBeUndefined();
    for (const v of ["x", [""], ["A B"], ["A=1"], ["1A"], ["A", "A"], [1], Array(101).fill("A")]) {
      bad({ childEnvAllow: v }, "childEnvAllow");
    }
  });

  it("childEnvAllow は、読み込みや実行に影響する名前（LD_*・NODE_OPTIONS など）を拒否する", () => {
    for (const v of [
      "LD_PRELOAD",
      "DYLD_INSERT_LIBRARIES",
      "NODE_OPTIONS",
      "BASH_ENV",
      "GIT_SSH_COMMAND",
    ]) {
      bad({ childEnvAllow: [v] }, "childEnvAllow");
    }
  });

  it("childHome は、isolated（既定）か inherit", () => {
    const none = parseConfig(JSON.stringify(base));
    expect(none.ok && none.value.childHome).toBeUndefined();
    const inh = parseConfig(JSON.stringify({ ...base, childHome: "inherit" }));
    expect(inh.ok && inh.value.childHome).toBe("inherit");
    const iso = parseConfig(JSON.stringify({ ...base, childHome: "isolated" }));
    expect(iso.ok && iso.value.childHome).toBe("isolated");
    for (const v of ["x", true, 1, null]) bad({ childHome: v }, "childHome");
  });

  it("maxTurns・maxBudgetUsd（子ごとの上限）は、正の数（任意）", () => {
    const ok1 = parseConfig(JSON.stringify({ ...base, maxTurns: 50, maxBudgetUsd: 2.5 }));
    expect(ok1.ok && [ok1.value.maxTurns, ok1.value.maxBudgetUsd]).toEqual([50, 2.5]);
    const none = parseConfig(JSON.stringify(base));
    expect(none.ok && none.value.maxTurns).toBeUndefined();
    for (const v of [0, -1, 1.5, "9", null, 100001]) bad({ maxTurns: v }, "maxTurns");
    for (const v of [0, -1, "9", null, 10001, Number.NaN]) bad({ maxBudgetUsd: v }, "maxBudgetUsd");
  });

  it("startLimits（同時に起動する数の上限）は、1〜64 の整数（任意。省略は既定の 4）", () => {
    const ok1 = parseConfig(JSON.stringify({ ...base, startLimits: { perParent: 2, total: 8 } }));
    expect(ok1.ok && ok1.value.startLimits).toEqual({ perParent: 2, total: 8 });
    const part = parseConfig(JSON.stringify({ ...base, startLimits: { total: 3 } }));
    expect(part.ok && part.value.startLimits).toEqual({ total: 3 });
    const none = parseConfig(JSON.stringify(base));
    expect(none.ok && none.value.startLimits).toBeUndefined();
    for (const v of [1, "x", [], { perParent: 0 }, { total: 65 }, { perParent: 1.5 }, { x: 1 }]) {
      bad({ startLimits: v }, "startLimits");
    }
  });

  it("mcpUrl は、ループバックの http(s) だけ（トークンを外へ送らない）", () => {
    for (const url of [
      "http://example.com/mcp",
      "ftp://127.0.0.1/x",
      "not a url",
      "http://10.0.0.5/mcp",
      "http://user:pw@127.0.0.1:1/mcp",
      "http://user@127.0.0.1:1/mcp",
    ]) {
      bad({ mcpUrl: url }, "mcpUrl");
    }
    expect(parseConfig(JSON.stringify({ ...base, mcpUrl: "http://localhost:1/mcp" })).ok).toBe(
      true,
    );
    expect(parseConfig(JSON.stringify({ ...base, mcpUrl: "https://127.0.0.1:1/mcp" })).ok).toBe(
      true,
    );
  });
});

describe("loadConfigFile", () => {
  it("ファイルを読んで検査する。なければ失敗する", () => {
    const dir = mkdtempSync(join(tmpdir(), "cso-cfg-"));
    const p = join(dir, "daemon.json");
    writeFileSync(p, JSON.stringify(base));
    expect(loadConfigFile(p).ok).toBe(true);
    const missing = loadConfigFile(join(dir, "none.json"));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.code).toBe("invalidConfig");
    expect(loadConfigFile("relative.json").ok).toBe(false);
  });

  it("他のユーザーが書き換えられるファイル・リンクは拒否する", () => {
    const dir = mkdtempSync(join(tmpdir(), "cso-cfg-"));
    const p = join(dir, "daemon.json");
    writeFileSync(p, JSON.stringify(base));
    chmodSync(p, 0o666);
    const loose = loadConfigFile(p);
    expect(loose.ok).toBe(false);
    if (!loose.ok) expect(loose.error.cause).toContain("書き換えられる");
    chmodSync(p, 0o600);
    expect(loadConfigFile(p).ok).toBe(true);
    const link = join(dir, "link.json");
    symlinkSync(p, link);
    expect(loadConfigFile(link).ok).toBe(false);
  });
});
