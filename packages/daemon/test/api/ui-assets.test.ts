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
});
