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
});
/** daemon が作った形の引き出し（0700・node のファイル 0600）。 */
const drawer = (): string => {
  const base = mkdtempSync(join(tmpdir(), "cso-child-"));
  made.push(base);
  const d = join(base, "k");
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
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { fetch, sent };
};
const deps = (fetch: typeof globalThis.fetch, stdin = "") => ({
  readStdin: async () => stdin,
  newRequestId: () => "rid-1",
  fetch,
});
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
    expect(existsSync(join(d, CHILD_FILES.code))).toBe(false); // コードは消す
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
      deps(fake.fetch, "半分できた\n"),
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
      deps(fake.fetch, JSON.stringify({ question: "どちら？", options: ["a", "b"] })),
    );
    expect(JSON.parse(r.stdout).value).toEqual({ decisionId: "dec-1" });
    const n = fake.sent.length;
    expect(
      (await runChild(["report", "--dir", d, "--url", URL, "done"], deps(fake.fetch, "not json")))
        .exitCode,
    ).toBe(2);
    expect(
      (await runChild(["report", "--dir", d, "--url", URL, "done"], deps(fake.fetch, "[]")))
        .exitCode,
    ).toBe(2);
    expect(fake.sent.length).toBe(n);
  });

  it("知らない種類・人間の操作の名前は、使い方の誤り", async () => {
    const d = bound();
    const fake = daemon();
    for (const op of ["purge", "report.progress", "node.purge", "decision.answer"]) {
      expect(
        (await runChild(["report", "--dir", d, "--url", URL, op], deps(fake.fetch, "x"))).exitCode,
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
      deps(fake.fetch, "x"),
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
      deps(fake.fetch, "x"),
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
      deps(fake.fetch, "x"),
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
      (await runChild(["report", "--dir", d, "--url", URL, "progress"], deps(fake.fetch, "x")))
        .stdout,
    ).toBe("tokenInvalid\n");
    const e = bound();
    rmSync(join(e, CHILD_FILES.url));
    symlinkSync(join(d, CHILD_FILES.url), join(e, CHILD_FILES.url));
    expect(
      (await runChild(["report", "--dir", e, "--url", URL, "progress"], deps(fake.fetch, "x")))
        .stdout,
    ).toBe("urlInvalid\n");
    const f = drawer();
    expect(
      (await runChild(["report", "--dir", f, "--url", URL, "progress"], deps(fake.fetch, "x")))
        .stdout,
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
    expect(r.stdout).toBe("bound\n");
  });
});
