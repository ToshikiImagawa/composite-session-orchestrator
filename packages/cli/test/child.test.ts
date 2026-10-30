import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROLE_OPERATIONS } from "@cso/core";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "../src/bin.js";
import { CHILD_FILES, REPORT_OPERATIONS, runChild } from "../src/child.js";

const URL = "http://127.0.0.1:7777";
const CODE = "ABCD-EFGH";
const TOKEN = "child-token-0123456789abcdef0123456789";

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
  verified.length = 0;
  identityOk = true;
});
/** daemon が作った形の引き出し（0700・node のファイル 0600）。 */
const drawer = (): string => {
  const base = mkdtempSync(join(tmpdir(), "cso-child-"));
  made.push(base);
  mkdirSync(join(base, "children.noindex"), { mode: 0o700 });
  const d = join(base, "children.noindex", "k");
  mkdirSync(d, { mode: 0o700 });
  chmodSync(d, 0o700);
  writeFileSync(join(d, CHILD_FILES.node), "node-a\n", { mode: 0o600 });
  return d;
};
/** 子が Write で書いた形の code（0644）。 */
const writeCode = (d: string, code = CODE) =>
  writeFileSync(join(d, CHILD_FILES.code), `${code}\n`, { mode: 0o644 });

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: unknown;
}
/** 偽の窓口。/v1/bind と /v1/request に答える。 */
const daemon = (
  over: {
    bind?: (body: unknown) => { status: number; json: unknown };
    request?: (body: { operation: string; params: unknown }) => { status: number; json: unknown };
  } = {},
) => {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body = JSON.parse(String(init?.body ?? "null"));
    sent.push({ url, headers, body });
    const r = url.endsWith("/v1/bind")
      ? (over.bind?.(body) ?? {
          status: 200,
          json: { ok: true, value: { nodeId: "node-a", token: TOKEN } },
        })
      : (over.request?.(body) ?? { status: 200, json: { ok: true, value: { accepted: true } } });
    return new Response(JSON.stringify(r.json), {
      status: r.status,
      headers: { "content-type": "application/json", "x-cso-daemon-id": "d" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
};
/** 身元の検証の偽物（既定は成功。どの秘密のファイルで確かめたかを残す）。 */
const verified: string[] = [];
let identityOk = true;
const deps = (fetch: typeof globalThis.fetch) => ({
  newRequestId: () => "rid-1",
  fetch,
  verifierFor: (_url: string, identityPath: string) => ({
    verify: async () => {
      verified.push(identityPath);
      return identityOk
        ? { ok: true as const, daemonId: "d" }
        : {
            ok: false as const,
            kind: "identity" as const,
            failure: { code: "daemon_identity_failed", cause: "x", nextActions: ["y"] as [string] },
          };
    },
  }),
});
/** 子が Write で書いた形の report（0644）を置いてから、deps を返す。 */
const withReport = (d: string, body: string, fetch: typeof globalThis.fetch) => {
  writeFileSync(join(d, CHILD_FILES.report), body, { mode: 0o644 });
  return deps(fetch);
};
const mode = (p: string) => lstatSync(p).mode & 0o777;
const all = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describe("cso child bind（T21-cc）", () => {
  it("code を読んで送り、送る前に消す。token・url を 0600 で置き、標準出力は bound だけ。コード・トークンを出さない", async () => {
    const d = drawer();
    writeCode(d);
    const fake = daemon({
      bind: (body) => {
        expect(existsSync(join(d, CHILD_FILES.code))).toBe(false); // 送る前に消えている
        expect(body).toEqual({ nodeId: "node-a", bindCode: CODE });
        return { status: 200, json: { ok: true, value: { nodeId: "node-a", token: TOKEN } } };
      },
    });
    const r = await runChild(["bind", "--dir", d, "--url", URL], deps(fake.fetch));
    expect(r).toEqual({ exitCode: 0, stdout: "bound\n", stderr: "" });
    expect(fake.sent[0]?.url).toBe(`${URL}/v1/bind`);
    expect(fake.sent[0]?.headers.authorization).toBeUndefined();
    expect(readFileSync(join(d, CHILD_FILES.token), "utf8").trim()).toBe(TOKEN);
    expect(readFileSync(join(d, CHILD_FILES.url), "utf8").trim()).toBe(URL);
    expect(mode(join(d, CHILD_FILES.token))).toBe(0o600);
    expect(mode(join(d, CHILD_FILES.url))).toBe(0o600);
    expect(readdirSync(d).sort()).toEqual(["node", "token", "url"]); // 一時ファイルが残らない
    expect(all(r)).not.toContain(CODE);
    expect(all(r)).not.toContain(TOKEN);
  });

  it("結び直し: 古い token は rename で置き換わる", async () => {
    const d = drawer();
    writeFileSync(join(d, CHILD_FILES.token), "old-token\n", { mode: 0o600 });
    writeCode(d);
    const fake = daemon();
    expect((await runChild(["bind", "--dir", d, "--url", URL], deps(fake.fetch))).exitCode).toBe(0);
    expect(readFileSync(join(d, CHILD_FILES.token), "utf8").trim()).toBe(TOKEN);
  });

  it("daemon が断ったら（使用済みのコードなど）: 記号を出して 1。コードは消えている。token は置かない", async () => {
    const d = drawer();
    writeCode(d);
    const fake = daemon({
      bind: () => ({
        status: 401,
        json: {
          ok: false,
          error: {
            code: "unauthenticated",
            cause: "bind コードが無効",
            nextActions: ["bind コードを再発行する"],
          },
        },
      }),
    });
    const r = await runChild(["bind", "--dir", d, "--url", URL], deps(fake.fetch));
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toBe("unauthenticated\n");
    expect(r.stderr).toContain("再発行");
    expect(existsSync(join(d, CHILD_FILES.code))).toBe(false);
    expect(existsSync(join(d, CHILD_FILES.token))).toBe(false);
  });

  it("窓口から応答がなければ bindUnknown。コードは消している", async () => {
    const d = drawer();
    writeCode(d);
    const fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof globalThis.fetch;
    const r = await runChild(["bind", "--dir", d, "--url", URL], deps(fetch));
    expect(r.stdout).toBe("bindUnknown\n");
    expect(existsSync(join(d, CHILD_FILES.code))).toBe(false);
  });

  it("引き出しが 0700 でない・リンク・相対パスなら、読まずに失敗する", async () => {
    const fake = daemon();
    const d = drawer();
    writeCode(d);
    chmodSync(d, 0o755);
    expect((await runChild(["bind", "--dir", d, "--url", URL], deps(fake.fetch))).stdout).toBe(
      "dirInvalid\n",
    );
    expect(existsSync(join(d, CHILD_FILES.code))).toBe(true); // 引き出しを確かめる前に、code に触れない
    const real = drawer();
    const link = `${real}-link`;
    symlinkSync(real, link);
    made.push(link);
    expect((await runChild(["bind", "--dir", link, "--url", URL], deps(fake.fetch))).stdout).toBe(
      "dirInvalid\n",
    );
    expect(
      (await runChild(["bind", "--dir", "rel/k", "--url", URL], deps(fake.fetch))).exitCode,
    ).toBe(2);
    expect(fake.sent).toHaveLength(0);
  });

  it("code がリンク・ハードリンク・書き込みの権限が緩い・大きすぎる・ないときは、送らない（リンクの先は消さない）", async () => {
    const fake = daemon();
    const outside = drawer();
    writeFileSync(join(outside, "secret"), CODE, { mode: 0o600 });
    const cases: [string, (d: string) => void][] = [
      ["codeInvalid", (d) => symlinkSync(join(outside, "secret"), join(d, CHILD_FILES.code))],
      ["codeInvalid", (d) => linkSync(join(outside, "secret"), join(d, CHILD_FILES.code))],
      [
        "codeInvalid",
        (d) => {
          writeCode(d);
          chmodSync(join(d, CHILD_FILES.code), 0o666);
        },
      ],
      ["codeInvalid", (d) => writeCode(d, "x".repeat(100))],
      ["codeMissing", () => undefined],
    ];
    for (const [want, make] of cases) {
      const d = drawer();
      make(d);
      const r = await runChild(["bind", "--dir", d, "--url", URL], deps(fake.fetch));
      expect(r.stdout, want).toBe(`${want}\n`);
    }
    expect(fake.sent).toHaveLength(0);
    expect(readFileSync(join(outside, "secret"), "utf8")).toBe(CODE);
  });

  it("確かめたあとに code が差し替えられたら、読まずに失敗する（fstat の ino）", async () => {
    const d = drawer();
    writeCode(d);
    const fake = daemon();
    const r = await runChild(["bind", "--dir", d, "--url", URL], {
      ...deps(fake.fetch),
      afterCheck: (p) => {
        if (!p.endsWith(`/${CHILD_FILES.code}`)) return;
        writeFileSync(`${p}.new`, "ZZZZ-ZZZZ\n", { mode: 0o644 });
        renameSync(`${p}.new`, p);
      },
    });
    expect(r.stdout).toBe("codeInvalid\n");
    expect(fake.sent).toHaveLength(0);
  });

  it("node のファイル（daemon が書く）は 0600 でなければ失敗する", async () => {
    const d = drawer();
    writeCode(d);
    chmodSync(join(d, CHILD_FILES.node), 0o644);
    const fake = daemon();
    expect((await runChild(["bind", "--dir", d, "--url", URL], deps(fake.fetch))).stdout).toBe(
      "nodeInvalid\n",
    );
    expect(existsSync(join(d, CHILD_FILES.code))).toBe(true); // node を先に確かめるので、code に触れない（R3）
  });

  it("--url はループバックの窓口だけ（パス・ユーザー名・ほかのホストは拒否）", async () => {
    const d = drawer();
    writeCode(d);
    const fake = daemon();
    for (const url of [
      "http://example.com:7777",
      "http://u:p@127.0.0.1:7777",
      `${URL}/v1`,
      "file:///x",
      "x",
    ]) {
      expect(
        (await runChild(["bind", "--dir", d, "--url", url], deps(fake.fetch))).exitCode,
        url,
      ).toBe(2);
    }
    expect(fake.sent).toHaveLength(0);
    expect(existsSync(join(d, CHILD_FILES.code))).toBe(true);
  });
});

describe("cso child report（T21-cc）", () => {
  const bound = () => {
    const d = drawer();
    writeFileSync(join(d, CHILD_FILES.token), `${TOKEN}\n`, { mode: 0o600 });
    writeFileSync(join(d, CHILD_FILES.url), `${URL}\n`, { mode: 0o600 });
    return d;
  };

  it("報告の種類は、子のロールの操作だけ（5 つ。M7）", () => {
    expect(Object.values(REPORT_OPERATIONS).sort()).toEqual([...ROLE_OPERATIONS.child].sort());
  });

  it("progress: 本文は標準入力の文。トークンはファイルから読んでヘッダーで送り、出力に出さない。requestId を出す", async () => {
    const d = bound();
    const fake = daemon();
    const r = await runChild(
      ["report", "--dir", d, "--url", URL, "progress"],
      withReport(d, "半分できた\n", fake.fetch),
    );
    expect(r.exitCode).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      ok: true,
      requestId: "rid-1",
      value: { accepted: true },
    });
    const req = fake.sent.find((x) => x.url.endsWith("/v1/request"));
    expect(req?.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req?.body).toMatchObject({
      requestId: "rid-1",
      operation: "report.progress",
      params: { text: "半分できた" },
    });
    expect(all(r)).not.toContain(TOKEN);
  });

  it("decision・done・scope-extend は、本文を params の JSON として送る。JSON でなければ送らない", async () => {
    const d = bound();
    const fake = daemon({
      request: () => ({ status: 200, json: { ok: true, value: { decisionId: "dec-1" } } }),
    });
    const r = await runChild(
      ["report", "--dir", d, "--url", URL, "decision"],
      withReport(d, JSON.stringify({ question: "どちら？", options: ["a", "b"] }), fake.fetch),
    );
    expect(JSON.parse(r.stdout).value).toEqual({ decisionId: "dec-1" });
    const n = fake.sent.length;
    expect(
      (
        await runChild(
          ["report", "--dir", d, "--url", URL, "done"],
          withReport(d, "not json", fake.fetch),
        )
      ).exitCode,
    ).toBe(1);
    expect(
      (
        await runChild(
          ["report", "--dir", d, "--url", URL, "done"],
          withReport(d, "[]", fake.fetch),
        )
      ).exitCode,
    ).toBe(1);
    expect(fake.sent.length).toBe(n);
  });

  it("知らない種類・人間の操作の名前は、使い方の誤り", async () => {
    const d = bound();
    const fake = daemon();
    for (const op of ["purge", "report.progress", "node.purge", "decision.answer"]) {
      expect(
        (await runChild(["report", "--dir", d, "--url", URL, op], withReport(d, "x", fake.fetch)))
          .exitCode,
        op,
      ).toBe(2);
    }
    expect(fake.sent).toHaveLength(0);
  });

  it("--url が url のファイルと違えば、トークンを送らない（urlMismatch）", async () => {
    const d = bound();
    const fake = daemon();
    const r = await runChild(
      ["report", "--dir", d, "--url", "http://127.0.0.1:8888", "progress"],
      withReport(d, "x", fake.fetch),
    );
    expect(r.stdout).toBe("urlMismatch\n");
    expect(fake.sent).toHaveLength(0);
  });

  it("期限切れ（tokenExpired）: 終了コード 3。token を消し、結び直しを案内する", async () => {
    const d = bound();
    const fake = daemon({
      request: () => ({
        status: 401,
        json: { ok: false, error: { code: "tokenExpired", cause: "期限切れ", nextActions: ["x"] } },
      }),
    });
    const r = await runChild(
      ["report", "--dir", d, "--url", URL, "progress"],
      withReport(d, "x", fake.fetch),
    );
    expect(r.exitCode).toBe(3);
    expect(r.stdout).toBe("tokenExpired\n");
    expect(r.stderr).toContain("node.bindCode");
    expect(existsSync(join(d, CHILD_FILES.token))).toBe(false);
  });

  it("ほかの失敗は記号と、同じ requestId でのやり直しの案内。応答にトークンが入っていても出さない", async () => {
    const d = bound();
    const fake = daemon({
      request: () => ({
        status: 403,
        json: {
          ok: false,
          error: { code: "forbidden", cause: `だめ ${TOKEN}`, nextActions: ["y"] },
        },
      }),
    });
    const r = await runChild(
      ["report", "--dir", d, "--url", URL, "--request-id", "rid-9", "progress"],
      withReport(d, "x", fake.fetch),
    );
    expect(r.stdout).toBe("forbidden\n");
    expect(r.stderr).toContain("--request-id rid-9");
    expect(all(r)).not.toContain(TOKEN);
  });

  it("token・url のファイルは 0600 でなければ・リンクなら失敗する（送らない）", async () => {
    const fake = daemon();
    const d = bound();
    chmodSync(join(d, CHILD_FILES.token), 0o644);
    expect(
      (
        await runChild(
          ["report", "--dir", d, "--url", URL, "progress"],
          withReport(d, "x", fake.fetch),
        )
      ).stdout,
    ).toBe("tokenInvalid\n");
    const e = bound();
    rmSync(join(e, CHILD_FILES.url));
    symlinkSync(join(d, CHILD_FILES.url), join(e, CHILD_FILES.url));
    expect(
      (
        await runChild(
          ["report", "--dir", e, "--url", URL, "progress"],
          withReport(e, "x", fake.fetch),
        )
      ).stdout,
    ).toBe("urlInvalid\n");
    const f = drawer();
    expect(
      (
        await runChild(
          ["report", "--dir", f, "--url", URL, "progress"],
          withReport(f, "x", fake.fetch),
        )
      ).stdout,
    ).toBe("urlMissing\n");
    expect(fake.sent).toHaveLength(0);
  });

  it("runBin: cso child は、人間のトークン・環境変数なしで動く", async () => {
    const d = drawer();
    writeCode(d);
    const fake = daemon();
    const r = await runBin(["child", "bind", "--dir", d, "--url", URL], {
      env: {},
      isTTY: { stdin: false, stdout: false },
      fetch: fake.fetch,
    });
    // 環境変数なしで、身元の確認まで進む（本物の検証は、daemon-identity がないので失敗する。送らない）
    expect(r.stdout).toBe("daemonIdentityFailed\n");
    expect(fake.sent).toHaveLength(0);
  });
});

describe("cso child（レビューの指摘。T21-cc）", () => {
  const bound = () => {
    const d = drawer();
    writeFileSync(join(d, CHILD_FILES.token), `${TOKEN}\n`, { mode: 0o600 });
    writeFileSync(join(d, CHILD_FILES.url), `${URL}\n`, { mode: 0o600 });
    return d;
  };

  it("R2: bind・report の前に、引き出しから決まる <stateDir>/daemon-identity で daemon の身元を確かめる。失敗なら送らない", async () => {
    const d = drawer();
    writeCode(d);
    const fake = daemon();
    identityOk = false;
    const r = await runChild(["bind", "--dir", d, "--url", URL], deps(fake.fetch));
    expect(r.stdout).toBe("daemonIdentityFailed\n");
    expect(verified).toEqual([join(d, "..", "..", "daemon-identity")]);
    expect(fake.sent).toHaveLength(0);
    expect(existsSync(join(d, CHILD_FILES.code))).toBe(false); // コードは消している
    const b = bound();
    const r2 = await runChild(
      ["report", "--dir", b, "--url", URL, "progress"],
      withReport(b, "x", fake.fetch),
    );
    expect(r2.stdout).toBe("daemonIdentityFailed\n");
    expect(fake.sent).toHaveLength(0);
    expect(all(r2)).not.toContain(TOKEN);
  });

  it("R2: 引き出しが children.noindex の中でなければ、送らない", async () => {
    const base = mkdtempSync(join(tmpdir(), "cso-child-"));
    made.push(base);
    const d = join(base, "k");
    mkdirSync(d, { mode: 0o700 });
    chmodSync(d, 0o700);
    writeFileSync(join(d, CHILD_FILES.node), "node-a\n", { mode: 0o600 });
    writeCode(d);
    const fake = daemon();
    expect((await runChild(["bind", "--dir", d, "--url", URL], deps(fake.fetch))).stdout).toBe(
      "dirInvalid\n",
    );
    expect(fake.sent).toHaveLength(0);
  });

  it("R3: node を確かめてから code を読む（node が不正なら code に触れない）", async () => {
    const d = drawer();
    writeCode(d);
    chmodSync(join(d, CHILD_FILES.node), 0o644);
    const fake = daemon();
    expect((await runChild(["bind", "--dir", d, "--url", URL], deps(fake.fetch))).stdout).toBe(
      "nodeInvalid\n",
    );
    expect(existsSync(join(d, CHILD_FILES.code))).toBe(true);
  });

  it("R3: 先に url、そのあと token を置く。token を置けなければ url も消す", async () => {
    const d = drawer();
    writeCode(d);
    mkdirSync(join(d, CHILD_FILES.token)); // rename が失敗する
    const fake = daemon();
    const r = await runChild(["bind", "--dir", d, "--url", URL], deps(fake.fetch));
    expect(r.stdout).toBe("tokenSaveFailed\n");
    expect(existsSync(join(d, CHILD_FILES.url))).toBe(false);
    expect(readdirSync(d).filter((x) => x.includes(".tmp-"))).toEqual([]);
  });

  it("R4: --url の正規化の差: 127.1 は 127.0.0.1 と同じ窓口。[::ffff:127.0.0.1]・localhost. は拒否", async () => {
    const fake = daemon();
    for (const url of ["http://[::ffff:127.0.0.1]:7777", "http://localhost.:7777"]) {
      const d = drawer();
      writeCode(d);
      expect(
        (await runChild(["bind", "--dir", d, "--url", url], deps(fake.fetch))).exitCode,
        url,
      ).toBe(2);
    }
    expect(fake.sent).toHaveLength(0);
    const b = bound();
    const r = await runChild(
      ["report", "--dir", b, "--url", "http://127.1:7777", "progress"],
      withReport(b, "x", fake.fetch),
    );
    expect(r.exitCode).toBe(0);
    expect(fake.sent[0]?.url.startsWith("http://127.0.0.1:7777/")).toBe(true);
  });

  it("N2: bind の失敗の文面は、コードを伏せ、制御文字を除き、長さを切る。N4: unauthenticated は、人に頼む案内を出す", async () => {
    const d = drawer();
    writeCode(d);
    const fake = daemon({
      bind: () => ({
        status: 401,
        json: {
          ok: false,
          error: {
            code: "unauthenticated",
            cause: `コード ${CODE} は無効\u001b[31m${"x".repeat(2000)}`,
            nextActions: ["a"],
          },
        },
      }),
    });
    const r = await runChild(["bind", "--dir", d, "--url", URL], deps(fake.fetch));
    expect(r.stderr).not.toContain(CODE);
    expect(r.stderr).not.toContain("\u001b");
    expect(r.stderr.length).toBeLessThan(1500);
    expect(r.stderr).toContain("会話で人");
    const b = bound();
    const f2 = daemon({
      request: () => ({
        status: 401,
        json: { ok: false, error: { code: "unauthenticated", cause: "x", nextActions: ["y"] } },
      }),
    });
    const r2 = await runChild(
      ["report", "--dir", b, "--url", URL, "progress"],
      withReport(b, "x", f2.fetch),
    );
    expect(r2.stderr).toContain("会話で人");
  });
});

describe("cso child report の本文のファイル（T21-cb R1）", () => {
  const bound = () => {
    const d = drawer();
    writeFileSync(join(d, CHILD_FILES.token), `${TOKEN}\n`, { mode: 0o600 });
    writeFileSync(join(d, CHILD_FILES.url), `${URL}\n`, { mode: 0o600 });
    return d;
  };

  it("report は送る前に消す。リンク・ハードリンク・大きすぎる・ないときは送らない", async () => {
    const d = bound();
    const fake = daemon({
      request: (body) => {
        expect(existsSync(join(d, CHILD_FILES.report))).toBe(false);
        expect(body.params).toEqual({ text: "進んだ" });
        return { status: 200, json: { ok: true, value: { accepted: true } } };
      },
    });
    const r = await runChild(
      ["report", "--dir", d, "--url", URL, "progress"],
      withReport(d, "進んだ\n", fake.fetch),
    );
    expect(r.exitCode).toBe(0);
    const n = fake.sent.length;
    const outside = drawer();
    writeFileSync(join(outside, "secret"), "x", { mode: 0o600 });
    const cases: [string, (x: string) => void][] = [
      ["reportInvalid", (x) => symlinkSync(join(outside, "secret"), join(x, CHILD_FILES.report))],
      ["reportInvalid", (x) => linkSync(join(outside, "secret"), join(x, CHILD_FILES.report))],
      ["reportInvalid", (x) => writeFileSync(join(x, CHILD_FILES.report), "y".repeat(70 * 1024))],
      ["reportMissing", () => undefined],
    ];
    for (const [want, make] of cases) {
      const x = bound();
      make(x);
      const res = await runChild(
        ["report", "--dir", x, "--url", URL, "progress"],
        deps(fake.fetch),
      );
      expect(res.stdout, want).toBe(`${want}\n`);
      expect(res.stderr).toContain("Write");
    }
    expect(fake.sent.length).toBe(n);
    expect(readFileSync(join(outside, "secret"), "utf8")).toBe("x");
  });
});

describe("cso child hook（T21-ch）", () => {
  const HOOK_TOKEN = "hook-token-0123456789abcdef0123456789";
  const withHook = () => {
    const d = drawer();
    writeFileSync(join(d, CHILD_FILES.hookToken), `${HOOK_TOKEN}\n`, { mode: 0o600 });
    return d;
  };
  const pre = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "s1",
    tool_name: "Read",
    tool_input: {},
    cwd: "/wt",
  });
  const post = JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "s1",
    tool_name: "Read",
    tool_input: {},
  });
  const hookFetch = (reply: { status: number; json: unknown } | "throw") => {
    const sent: { url: string; auth: string | null; body: string }[] = [];
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      if (reply === "throw") throw new TypeError("fetch failed");
      sent.push({
        url: String(input),
        auth: new Headers(init?.headers).get("authorization"),
        body: String(init?.body),
      });
      return new Response(JSON.stringify(reply.json), { status: reply.status });
    }) as typeof globalThis.fetch;
    return { f, sent };
  };
  const run = (d: string, input: string, f: typeof globalThis.fetch) =>
    runChild(["hook", "--dir", d, "--url", URL], { ...deps(f), readStdin: async () => input });

  it("フック入力を hook-token で /v1/hook へ送る。許可は 0、拒否は 2 で理由を標準エラーに。トークンは出さない", async () => {
    const d = withHook();
    const ok = hookFetch({ status: 200, json: { ok: true, value: { decision: "allow" } } });
    const r = await run(d, pre, ok.f);
    expect(r).toEqual({ exitCode: 0, stdout: "", stderr: "" });
    expect(ok.sent[0]).toEqual({ url: `${URL}/v1/hook`, auth: `Bearer ${HOOK_TOKEN}`, body: pre });
    const no = hookFetch({
      status: 200,
      json: { ok: true, value: { decision: "deny", reason: `範囲外です ${HOOK_TOKEN}` } },
    });
    const r2 = await run(d, pre, no.f);
    expect(r2.exitCode).toBe(2);
    expect(r2.stderr).toContain("範囲外です");
    expect(r2.stdout + r2.stderr).not.toContain(HOOK_TOKEN);
  });

  it("PreToolUse はフェイルクローズ（届かない・200 以外・形が違う・hook-token がない・身元を確かめられない）。PostToolUse は 0", async () => {
    const d = withHook();
    expect((await run(d, pre, hookFetch("throw").f)).exitCode).toBe(2);
    expect(
      (await run(d, pre, hookFetch({ status: 403, json: { ok: false, error: { cause: "x" } } }).f))
        .exitCode,
    ).toBe(2);
    expect(
      (await run(d, pre, hookFetch({ status: 200, json: { ok: true, value: {} } }).f)).exitCode,
    ).toBe(2);
    expect((await run(d, "not json", hookFetch("throw").f)).exitCode).toBe(2);
    expect((await run(drawer(), pre, hookFetch("throw").f)).exitCode).toBe(2); // hook-token がない
    expect((await run(d, post, hookFetch("throw").f)).exitCode).toBe(0);
    identityOk = false;
    const f = hookFetch({ status: 200, json: { ok: true, value: { decision: "allow" } } });
    expect((await run(d, pre, f.f)).exitCode).toBe(2);
    expect(f.sent).toHaveLength(0); // 身元を確かめられなければ、トークンを送らない
  });
});

describe("cso child hook のレビューの指摘（T21-ch M2・R3）", () => {
  const HOOK_TOKEN = "hook-token-0123456789abcdef0123456789";
  const withHook = () => {
    const d = drawer();
    writeFileSync(join(d, CHILD_FILES.hookToken), `${HOOK_TOKEN}\n`, { mode: 0o600 });
    return d;
  };
  const pre = JSON.stringify({
    hook_event_name: "PreToolUse",
    session_id: "s1",
    tool_name: "Read",
    tool_input: {},
  });

  it("R3: 429 で Retry-After が短ければ、2 回まで送り直す。長ければ送り直さずに拒否", async () => {
    const d = withHook();
    const replies = [429, 429, 200];
    let n = 0;
    const slept: number[] = [];
    const f = (async () => {
      const status = replies[n++] ?? 200;
      return status === 429
        ? new Response("{}", { status, headers: { "retry-after": "1" } })
        : new Response(JSON.stringify({ ok: true, value: { decision: "allow" } }), { status });
    }) as typeof globalThis.fetch;
    const r = await runChild(["hook", "--dir", d, "--url", URL], {
      ...deps(f),
      readStdin: async () => pre,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    expect(r.exitCode).toBe(0);
    expect(slept).toEqual([1000, 1000]);
    const long = (async () =>
      new Response("{}", {
        status: 429,
        headers: { "retry-after": "30" },
      })) as typeof globalThis.fetch;
    const r2 = await runChild(["hook", "--dir", d, "--url", URL], {
      ...deps(long),
      readStdin: async () => pre,
    });
    expect(r2.exitCode).toBe(2);
  });

  it("M2: 予期しない例外でも、PreToolUse は終了コード 2（Claude Code は 2 のときだけ拒否する）", async () => {
    const d = withHook();
    const r = await runChild(["hook", "--dir", d, "--url", URL], {
      ...deps((async () => new Response("{}")) as typeof globalThis.fetch),
      readStdin: async () => {
        throw new Error("boom");
      },
    });
    expect(r.exitCode).toBe(2);
    const r2 = await runChild(["hook", "--dir", d, "--url", URL], {
      ...deps((async () => new Response("{}")) as typeof globalThis.fetch),
      readStdin: async () => pre,
      verifierFor: () => ({
        verify: async () => {
          throw new Error("boom");
        },
      }),
    });
    expect(r2.exitCode).toBe(2);
  });
});
