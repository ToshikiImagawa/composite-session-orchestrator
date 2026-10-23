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
        fn("hasForbidden"),
        fn("checkAnswer"),
        fn("waitSecondsOf"),
        fn("describeFailure"),
        "({ checkAnswer: checkAnswer, waitSecondsOf: waitSecondsOf, describeFailure: describeFailure })",
      ].join("\n"),
      {},
    ) as {
      checkAnswer(text: string): string;
      waitSecondsOf(r: { status: number; retry: number }): number;
      describeFailure(r: { status: number; body: unknown; retry: number }): string;
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
  });
});
