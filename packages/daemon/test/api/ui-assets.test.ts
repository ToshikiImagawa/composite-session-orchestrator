import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { UI_CSS, UI_HEADERS, UI_HTML, UI_HTML_HEADERS, UI_JS } from "../../src/api/ui-assets.js";

/** 画面の資産の走査（T23）。XSS・トークンの漏れにつながる書き方を禁じる。 */
describe("画面の資産（走査）", () => {
  const FORBIDDEN: readonly [string, RegExp][] = [
    ["innerHTML", /innerHTML/],
    ["outerHTML", /outerHTML/],
    ["insertAdjacentHTML", /insertAdjacentHTML/],
    ["document.write", /document\s*\.\s*write/],
    ["eval", /\beval\s*\(/],
    ["new Function", /new\s+Function\b|\bFunction\s*\(/],
    ["setAttribute", /setAttribute/],
    ["setAttributeNS・attributes", /setAttributeNS|\.attributes\b/],
    ["on* への代入", /\.on[a-z]+\s*=[^=]/],
    [
      "location への代入",
      /\blocation\s*(\.\s*(href|pathname|search|hash|protocol|host|hostname|port)\s*)?=[^=]/,
    ],
    ["location.assign・replace", /location\s*\.\s*(assign|replace)\s*\(/],
    ["srcdoc", /srcdoc/],
    ["文字列の setTimeout・setInterval", /set(Timeout|Interval)\s*\(\s*['"`]/],
    ["storage・cookie", /localStorage|sessionStorage|document\s*\.\s*cookie|indexedDB/],
    ["importScripts・動的 import", /importScripts|\bimport\s*\(/],
    ["postMessage・window.open", /postMessage|window\s*\.\s*open/],
    ["ブラケット記法の文字列キー（メンバーの参照）", /[\w$)\]]\s*\[\s*['"`]/],
    [
      "HTML を解釈する API",
      /setHTMLUnsafe|parseHTMLUnsafe|setHTML\b|createContextualFragment|DOMParser|document\s*\.\s*createRange/,
    ],
    ["href・src・action・formAction への代入", /\.(href|src|action|formAction)\s*=[^=]/],
    [
      "危ないタグの生成",
      /createElement\s*\(\s*['"`](script|iframe|a|img|link|object|embed|form|base|meta|style|svg|math)['"`]/i,
    ],
    [
      "危ないタグを el に渡す",
      /\bel\s*\(\s*['"`](script|iframe|a|img|link|object|embed|form|base|meta|style|svg|math)['"`]/i,
    ],
  ];
  for (const [name, re] of FORBIDDEN) {
    it(`app.js に ${name} を使わない`, () => {
      expect(re.test(UI_JS), name).toBe(false);
    });
  }

  it("許可リスト: `.` の後ろのプロパティ名は、安全な集合にあるものだけ（文字列・コメントを除く）", () => {
    const SAFE = new Set([
      // 要素・文字列・集合・配列・Promise の、安全な操作
      "textContent",
      "className",
      "hidden",
      "value",
      "style",
      "paddingLeft",
      "firstChild",
      "removeChild",
      "appendChild",
      "forEach",
      "length",
      "size",
      "has",
      "get",
      "set",
      "add",
      "then",
      "catch",
      "status",
      "ok",
      "json",
      "headers",
      "truncated",
      "decisions",
      "extensions",
      "expectNodeIds",
      "blocked",
      "typed",
      "rows",
      "typedValue",
      "after",
      "filter",
      "toISOString",
      "replace",
      "map",
      "join",
      "isArray",
      "nodeIds",
      "every",
      "archivedAt",
      "elapsedDays",
      "retentionDays",
      "tombstoneTitle",
      "purgeable",
      "blockers",
      "discardedRefs",
      "hold",
      "until",
      "label",
      "days",
      "items",
      "key",
      "tip",
      "committedAt",
      "untrustedSubject",
      "target",
      "targetHidden",
      "inbox",
      "nodes",
      "lastSeq",
      "options",
      "question",
      "nodeId",
      "reason",
      "priority",
      "kind",
      "at",
      "summary",
      "id",
      "role",
      "state",
      "parentId",
      "openItems",
      "unchanged",
      "preventDefault",
      "addEventListener",
      "getElementById",
      "createElement",
      "clearTimeout",
      "setTimeout",
      "hash",
      "pathname",
      "search",
      "history",
      "replaceState",
      "location",
      "window",
      "document",
      "exec",
      "trim",
      "hasOwn",
      "resolve",
      "push",
      "Error",
      "Object",
      "Promise",
      "Map",
      "Set",
      "body",
      "retryAt",
      "ceil",
      "optionsCut",
      "text",
      "from",
      "some",
      "test",
      "error",
      "code",
      "cause",
      "retry",
      "title",
      "lines",
      "sending",
      "disabled",
      "crypto",
      "randomUUID",
      "stringify",
      "requestId",
      "operation",
      "params",
      "activeElement",
      "dataset",
      "draft",
      "maxLength",
      "placeholder",
      "delete",
      "focus",
      "setSelectionRange",
      "seq",
      "partial",
      "getReader",
      "read",
      "done",
      "decode",
      "indexOf",
      "slice",
      "min",
      "max",
      "floor",
      "random",
      "now",
      "signal",
      "abort",
      "Date",
      "Math",
      "AbortController",
      "TextDecoder",
    ]);
    const code = UI_JS.replace(/'(?:[^'\\\n]|\\.)*'/g, "''").replace(/\/\/[^\n]*/g, "");
    const used = new Set([...code.matchAll(/\.\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1] as string));
    expect(used.has("textContent")).toBe(true); // 抜き出せていること（空の集合で通らない）
    const unknown = [...used].filter((x) => !SAFE.has(x));
    expect(unknown).toEqual([]);
  });

  it("拡張要求の判定（T23-b）: scope.decide は、確認（openConfirm）を挟んでだけ送る。params は extensionId と decision だけ。対象が隠れていれば、却下以外のボタンを無効にする", () => {
    expect(UI_JS).toContain("'scope.decide'");
    expect(UI_JS).toContain("{ extensionId: x.id, decision: decision }");
    expect([...UI_JS.matchAll(/'scope\.decide'/g)]).toHaveLength(1);
    expect(UI_JS).toContain("b.disabled = x.targetHidden && decision !== 'reject'");
    // sendPending 以外に fetch がない（確認なしで送る経路がない）
    expect([...UI_JS.matchAll(/\bfetch\(\s*'\/v1\/request'/g)]).toHaveLength(1);
    // granted（許可する対象）を、画面から送らない
    expect(UI_JS).not.toContain("granted");
  });

  it("el に渡すタグは、div・span・p・button・textarea だけ（実行時にも、許可リストで拒む）", () => {
    const calls = [...UI_JS.matchAll(/\bel\(\s*'([^']*)'/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(5);
    for (const tag of calls) expect(["div", "span", "p", "button", "textarea"]).toContain(tag);
    expect(UI_JS).toContain("Object.hasOwn(TAGS, tag)");
  });

  it("HTML に、インラインの script・style・イベント属性・javascript: を置かない（script は src だけ）", () => {
    const scripts = [...UI_HTML.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(s).toMatch(/\bsrc="\/ui\/app\.js"/);
    expect(UI_HTML).not.toMatch(/<script\b[^>]*>\s*[^<\s]/);
    expect(UI_HTML).not.toMatch(/<style\b/i);
    expect(UI_HTML).not.toMatch(/\sstyle\s*=/i);
    expect(UI_HTML).not.toMatch(/\son[a-z]+\s*=/i);
    expect(UI_HTML).not.toMatch(/javascript:/i);
    expect(UI_HTML).not.toMatch(/https?:\/\//i); // 外部の資産を読まない
    expect(UI_CSS).not.toMatch(/https?:\/\/|@import|url\s*\(/i);
  });

  it("トークンは、アドレスから消す処理（replaceState）が、最初の通信（fetch）より前にある", () => {
    const replace = UI_JS.indexOf("history.replaceState");
    const first = UI_JS.indexOf("fetch(");
    expect(replace).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(replace);
    // 最初の文（フラグメントの読み取り）から replaceState までに、通信・描画はない
    expect(UI_JS.slice(0, replace)).not.toMatch(/fetch\(|textContent/);
  });

  it("CSP は、既定で全てを禁じ、script・style・通信は同じ origin だけ。フレーム・form・base を禁じる", () => {
    const csp = UI_HEADERS["content-security-policy"] ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
    expect(UI_HEADERS["x-content-type-options"]).toBe("nosniff");
    expect(UI_HEADERS["referrer-policy"]).toBe("no-referrer");
    expect(UI_HEADERS["cache-control"]).toBe("no-store");
    expect(UI_HEADERS["cross-origin-resource-policy"]).toBe("same-origin");
    expect(UI_HTML_HEADERS["cross-origin-opener-policy"]).toBe("same-origin");
    expect(UI_HTML_HEADERS["permissions-policy"]).toContain("camera=()");
  });

  describe("画面の純粋な部分（vm で評価する。new Function は使わない）", () => {
    // app.js から、純粋な関数と定数だけを取り出して、別の文脈で評価する（DOM・通信に触れない部分）
    const fn = (name: string): string => {
      const i = UI_JS.indexOf(`  function ${name}(`);
      expect(i, name).toBeGreaterThan(-1);
      return UI_JS.slice(i, UI_JS.indexOf("\n  }\n", i) + 5);
    };
    const line = (prefix: string): string => {
      const i = UI_JS.indexOf(`  ${prefix}`);
      expect(i, prefix).toBeGreaterThan(-1);
      return UI_JS.slice(i, UI_JS.indexOf("\n", i));
    };
    const api = runInNewContext(
      [
        line("var TEXT_MAX ="),
        line("var FORBIDDEN ="),
        line("var REASON_MAX ="),
        line("var HOLD_MAX_DAYS ="),
        fn("parseDays"),
        fn("checkDays"),
        fn("typedMatches"),
        fn("purgeRoots"),
        fn("holdUntil"),
        fn("checkReason"),
        fn("cleanText"),
        fn("hasForbidden"),
        fn("checkAnswer"),
        fn("waitSecondsOf"),
        fn("describeFailure"),
        "({ checkAnswer: checkAnswer, waitSecondsOf: waitSecondsOf, describeFailure: describeFailure, typedMatches: typedMatches, purgeRoots: purgeRoots, holdUntil: holdUntil, parseDays: parseDays, checkDays: checkDays, checkReason: checkReason, cleanText: cleanText })",
      ].join("\n"),
      {},
    ) as {
      checkAnswer(text: string): string;
      waitSecondsOf(r: { status: number; retry: number }): number;
      describeFailure(r: { status: number; body: unknown; retry: number }): string;
      typedMatches(typed: unknown, input: unknown): boolean;
      purgeRoots(nodes: { id: string; parentId: string | null; state: string }[]): { id: string }[];
      holdUntil(days: number, nowMs: number): string | undefined;
      parseDays(text: string): number;
      checkDays(text: string): string;
      checkReason(text: string): string;
      cleanText(text: string, max: number): string;
    };

    it("checkAnswer: 空・空白だけ・長すぎる・制御文字・書式制御文字を拒む。タブ・改行は使える。長さは、コードポイントで数える", () => {
      expect(api.checkAnswer("")).toContain("空");
      expect(api.checkAnswer("   \n\t ")).toContain("空");
      expect(api.checkAnswer("はい")).toBe("");
      expect(api.checkAnswer("a".repeat(4000))).toBe("");
      expect(api.checkAnswer("a".repeat(4001))).toContain("長すぎ");
      expect(api.checkAnswer("😀".repeat(4000))).toBe(""); // 1 文字（サロゲートペア）を 1 と数える
      expect(api.checkAnswer("😀".repeat(4001))).toContain("長すぎ");
      for (const bad of [
        "a\u0007b",
        "a\u0000b",
        "a\u007fb",
        "a\u0085b",
        "a\u202eb",
        "a\u200bb",
        "a\ufeffb",
      ]) {
        expect(api.checkAnswer(bad), JSON.stringify(bad)).toContain("使えない文字");
      }
      expect(api.checkAnswer("一行目\n\t二行目")).toBe("");
    });

    it("waitSecondsOf: 429 は Retry-After の秒数（なければ 5 秒）。それ以外は 0", () => {
      expect(api.waitSecondsOf({ status: 429, retry: 3 })).toBe(3);
      expect(api.waitSecondsOf({ status: 429, retry: 0 })).toBe(5);
      expect(api.waitSecondsOf({ status: 429, retry: Number.NaN })).toBe(5);
      expect(api.waitSecondsOf({ status: 409, retry: 3 })).toBe(0);
      expect(api.waitSecondsOf({ status: 200, retry: 0 })).toBe(0);
    });

    it("describeFailure: code と cause を出す（cause は 300 文字まで）。本文がなければ HTTP の状態。429 は待つ秒数。再送の案内つき", () => {
      const a = api.describeFailure({
        status: 409,
        body: { ok: false, error: { code: "conflict", cause: "先に確定している" } },
        retry: 0,
      });
      expect(a).toContain("conflict: 先に確定している");
      expect(a).toContain("もう一度送れます");
      const long = api.describeFailure({
        status: 422,
        body: { ok: false, error: { code: "x", cause: "あ".repeat(500) } },
        retry: 0,
      });
      expect(long).toContain(`x: ${"あ".repeat(300)}`);
      expect(long).not.toContain("あ".repeat(301));
      expect(api.describeFailure({ status: 500, body: null, retry: 0 })).toContain("HTTP 500");
      expect(api.describeFailure({ status: 429, body: null, retry: 7 })).toContain("7 秒");
      expect(api.describeFailure({ status: 429, body: null, retry: 0 })).toContain("しばらく");
    });

    it("typedMatches: 打ち込む文字列と完全に一致するときだけ。前後の空白・大文字小文字・全角・空・型の違いは、すべて不一致", () => {
      expect(api.typedMatches("root-1", "root-1")).toBe(true);
      expect(api.typedMatches("root-1", "root-1 ")).toBe(false);
      expect(api.typedMatches("root-1", " root-1")).toBe(false);
      expect(api.typedMatches("root-1", "ROOT-1")).toBe(false);
      expect(api.typedMatches("root-1", "ｒｏｏｔ-1")).toBe(false);
      expect(api.typedMatches("root-1", "root-")).toBe(false);
      expect(api.typedMatches("root-1", "")).toBe(false);
      expect(api.typedMatches("", "")).toBe(false); // 打ち込む文字列が空なら、決して一致しない
      expect(api.typedMatches(undefined, "")).toBe(false);
      expect(api.typedMatches(undefined, undefined)).toBe(false);
      expect(api.typedMatches("1", 1)).toBe(false);
    });

    it("purgeRoots: アーカイブ済みで、親がないか、親がアーカイブされていないノードだけ", () => {
      const nodes = [
        { id: "r", parentId: null, state: "archived" },
        { id: "c", parentId: "r", state: "archived" },
        { id: "m", parentId: null, state: "running" },
        { id: "a", parentId: "m", state: "archived" },
        { id: "o", parentId: "gone", state: "archived" },
        { id: "x", parentId: "m", state: "stopped" },
      ];
      expect(api.purgeRoots(nodes).map((n) => n.id)).toEqual(["r", "a", "o"]);
      expect(api.purgeRoots([])).toEqual([]);
    });

    it("holdUntil: 0 日は期限なし。日数は、ミリ秒なしの ISO 8601 UTC（サーバーの検証に合う形）", () => {
      const now = Date.UTC(2026, 9, 23, 12, 0, 0, 345);
      expect(api.holdUntil(0, now)).toBeUndefined();
      expect(api.holdUntil(30, now)).toBe("2026-11-22T12:00:00Z");
      expect(api.holdUntil(90, now)).toBe("2027-01-21T12:00:00Z");
      // 365 日（サーバーの上限）のときだけ、時計のずれを見込んで 10 分短い（cli の holdDeadline と同じ）
      expect(api.holdUntil(364, now)).toBe("2027-10-22T12:00:00Z");
      expect(api.holdUntil(365, now)).toBe("2027-10-23T11:50:00Z");
    });

    it("parseDays・checkDays: 1〜365 の整数だけ（前後の空白は可）。0・366・小数・負・全角・文字・空は不正", () => {
      expect(api.parseDays("1")).toBe(1);
      expect(api.parseDays(" 30 ")).toBe(30);
      expect(api.parseDays("365")).toBe(365);
      expect(api.parseDays("007")).toBe(7);
      for (const bad of [
        "",
        " ",
        "0",
        "366",
        "999",
        "1.5",
        "-1",
        "+1",
        "１０",
        "10日",
        "1e2",
        "1 0",
        "0x10",
      ]) {
        expect(api.parseDays(bad), JSON.stringify(bad)).toBe(0);
        expect(api.checkDays(bad), JSON.stringify(bad)).toContain("1〜365");
      }
      expect(api.checkDays("30")).toBe("");
    });

    it("checkReason: 空は可（任意）。長すぎる・制御文字・書式制御文字は拒む", () => {
      expect(api.checkReason("")).toBe("");
      expect(api.checkReason("   ")).toBe("");
      expect(api.checkReason("調査が済んだ")).toBe("");
      expect(api.checkReason("a".repeat(200))).toBe("");
      expect(api.checkReason("a".repeat(201))).toContain("長すぎ");
      expect(api.checkReason("a\u0007b")).toContain("使えない文字");
      expect(api.checkReason("a\u202eb")).toContain("使えない文字");
      expect(api.checkReason("a\nb")).toContain("使えない文字");
    });

    it("cleanText: 制御文字・書式制御文字を空白にして 1 行にし、長さを切る（信頼できない文字列）", () => {
      expect(api.cleanText("a\u001b[31mb\nc\u202ed", 100)).toBe("a [31mb c d");
      expect(api.cleanText("あ".repeat(10), 5)).toBe("ああああ…");
      expect(api.cleanText("  x   y  ", 10)).toBe("x y");
    });
  });

  describe("sendPending（vm で評価する。打ち込みが一致しないと、通信しない）", () => {
    const fn = (name: string): string => {
      const i = UI_JS.indexOf(`  function ${name}(`);
      expect(i, name).toBeGreaterThan(-1);
      return UI_JS.slice(i, UI_JS.indexOf("\n  }\n", i) + 5);
    };
    type Pending = {
      operation: string;
      params: unknown;
      requestId: string;
      sending: boolean;
      error: string;
      retryAt: number;
      typed?: string;
      typedValue: string;
      blocked: string;
      done: string;
    };
    const run = (p: Pending) => {
      const sent: { operation: string; params: unknown; requestId: string }[] = [];
      const ctx = {
        __pending: p,
        __sent: sent,
        __callOperation: (operation: string, params: unknown, requestId: string) => {
          sent.push({ operation, params, requestId });
          return new Promise(() => {}); // 返さない（送った、までを見る）
        },
      };
      const source = [
        "var pending = __pending;",
        "function callOperation(o, p, r) { return __callOperation(o, p, r); }",
        "function renderConfirm() {}",
        "function notice() {}",
        "function refresh() {}",
        "function describeFailure() { return ''; }",
        "function waitSecondsOf() { return 0; }",
        fn("typedMatches"),
        fn("sendPending"),
        "sendPending();",
      ].join("\n");
      runInNewContext(source, ctx);
      return sent;
    };
    const base = (over: Partial<Pending>): Pending => ({
      operation: "node.purge",
      params: { nodeId: "r1" },
      requestId: "req-1",
      sending: false,
      error: "",
      retryAt: 0,
      typedValue: "",
      blocked: "",
      done: "ok",
      ...over,
    });

    it("打ち込みが一致しなければ、通信しない（画面の無効化を迂回されても）", () => {
      for (const typedValue of ["", "r", "r1 ", " r1", "R1", "ｒ１"]) {
        expect(run(base({ typed: "r1", typedValue })), JSON.stringify(typedValue)).toEqual([]);
      }
    });

    it("打ち込みが一致すれば、1 回だけ通信する（同じ requestId・params）", () => {
      expect(run(base({ typed: "r1", typedValue: "r1" }))).toEqual([
        { operation: "node.purge", params: { nodeId: "r1" }, requestId: "req-1" },
      ]);
    });

    it("送れない理由（blocked）があれば、一致していても通信しない。typed がない（取り消せる）操作は、そのまま送る。送信中は送らない", () => {
      expect(run(base({ typed: "r1", typedValue: "r1", blocked: "実行できない" }))).toEqual([]);
      expect(run(base({}))).toHaveLength(1);
      expect(run(base({ sending: true }))).toEqual([]);
    });
  });

  it("T23-d: 通信は callOperation の 1 か所だけ。最終削除・保管の削除は、打ち込みの確認（typed）を経る。保管の削除は一覧で見た先端を渡す", () => {
    expect([...UI_JS.matchAll(/\bfetch\(\s*'\/v1\/request'/g)]).toHaveLength(1);
    // 取り消せない操作の openConfirm は、typed を指定している
    for (const op of ["'node.purge'", "'node.discardedDrop'"]) {
      const i = UI_JS.indexOf(`openConfirm(`, UI_JS.indexOf(op) - 600);
      expect(UI_JS.slice(i, UI_JS.indexOf(op) + 400), op).toContain("typed:");
    }
    expect(UI_JS).toContain("expectTip: i.tip");
    // 送る側にも、打ち込みの検査がある（画面の無効化を迂回されても送らない）
    expect(UI_JS).toContain("typedMatches(p.typed, p.typedValue)");
    // 取り出しのブランチ名は、入力させない（既定だけ）
    expect(UI_JS).not.toContain("branch:");
    // 読み取りの操作は、確認なしで呼ぶのは事前確認と一覧だけ
    const reads = [...UI_JS.matchAll(/readOperation\('([^']+)'/g)].map((m) => m[1]);
    expect(new Set(reads)).toEqual(new Set(["node.purgePreview", "node.discardedList"]));
  });
});
