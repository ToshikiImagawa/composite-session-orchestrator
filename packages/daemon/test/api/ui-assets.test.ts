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
      "inputMode",
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
      // フックの結び付けを外した結果（T22-hub。node.hookUnbind の { unbound, duplicate }）
      "unbound",
      "duplicate",
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
      "command",
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
      "discarded",
      "stopDelegated",
      "reclaimable",
      "unmet",
      "loss",
      "tips",
      "keys",
      "unknown",
      "workingTreeUnknown",
      "aheadCommits",
      "uncommitted",
      "untracked",
      "pid",
      "untrustedSubjects",
      "sort",
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
        line("var EXPECT_TIPS_MAX ="),
        line("var CLI_HINT ="),
        line("var NODE_LIST_MAX ="),
        UI_JS.slice(
          UI_JS.indexOf("  var UNMET_NAMES = {"),
          UI_JS.indexOf("\n  };", UI_JS.indexOf("  var UNMET_NAMES = {")) + 5,
        ),
        line("function name("),
        fn("isReclaimPreview"),
        fn("reclaimBlocked"),
        fn("lossText"),
        fn("reclaimLines"),
        fn("failureHint"),
        line("var HOLD_MAX_DAYS ="),
        fn("parseDays"),
        fn("checkDays"),
        fn("typedMatches"),
        fn("purgeRoots"),
        fn("holdParams"),
        fn("holdDoneText"),
        fn("checkReason"),
        fn("cleanText"),
        fn("hasForbidden"),
        fn("checkAnswer"),
        fn("waitSecondsOf"),
        fn("describeFailure"),
        fn("checkNote"),
        fn("confirmStoppedParams"),
        fn("confirmStoppedLines"),
        fn("hookUnbindLines"),
        fn("hookUnbindDoneText"),
        "({ hookUnbindLines: hookUnbindLines, hookUnbindDoneText: hookUnbindDoneText, checkNote: checkNote, confirmStoppedParams: confirmStoppedParams, confirmStoppedLines: confirmStoppedLines, isReclaimPreview: isReclaimPreview, reclaimBlocked: reclaimBlocked, reclaimLines: reclaimLines, failureHint: failureHint, checkAnswer: checkAnswer, waitSecondsOf: waitSecondsOf, describeFailure: describeFailure, typedMatches: typedMatches, purgeRoots: purgeRoots, holdParams: holdParams, holdDoneText: holdDoneText, parseDays: parseDays, checkDays: checkDays, checkReason: checkReason, cleanText: cleanText })",
      ].join("\n"),
      {},
    ) as {
      checkAnswer(text: string): string;
      waitSecondsOf(r: { status: number; retry: number }): number;
      describeFailure(r: { status: number; body: unknown; retry: number }): string;
      typedMatches(typed: unknown, input: unknown): boolean;
      purgeRoots(nodes: { id: string; parentId: string | null; state: string }[]): { id: string }[];
      holdParams(nodeId: string, days: number, reason: string): Record<string, unknown>;
      holdDoneText(nodeId: string, value: unknown): string;
      parseDays(text: string): number;
      checkDays(text: string): string;
      checkReason(text: string): string;
      cleanText(text: string, max: number): string;
      checkNote(text: string): string;
      confirmStoppedParams(nodeId: string, note: string): Record<string, unknown>;
      confirmStoppedLines(nodeId: string, note: string): [string, string][];
      hookUnbindLines(nodeId: string): [string, string][];
      hookUnbindDoneText(nodeId: string, value: unknown): string;
      isReclaimPreview(v: unknown): boolean;
      reclaimBlocked(v: unknown): string;
      reclaimLines(nodeId: string, v: unknown): [string, string][];
      failureHint(code: unknown): string;
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

    it("停止の宣言（T22d）: 根拠は任意（空白だけなら送らない）。長すぎ・制御文字は拒む。確認の表示は根拠を整えて出す", () => {
      expect(api.confirmStoppedParams("a", "")).toEqual({ nodeId: "a" });
      expect(api.confirmStoppedParams("a", "  ")).toEqual({ nodeId: "a" });
      expect(api.confirmStoppedParams("a", "アーカイブした")).toEqual({
        nodeId: "a",
        note: "アーカイブした",
      });
      expect(api.checkNote("")).toBe("");
      expect(api.checkNote("a".repeat(200))).toBe("");
      expect(api.checkNote("a".repeat(201))).toContain("長すぎ");
      expect(api.checkNote("a\u202eb")).toContain("使えない文字");
      // 見せたものを送る: 確認の表示と、送る値は、同じ整えた値
      const raw = "  アーカイブ   した  ";
      expect(api.confirmStoppedParams("a", raw)).toEqual({ nodeId: "a", note: "アーカイブ した" });
      const lines = api.confirmStoppedLines("a", raw);
      expect(lines[0]).toEqual(["ノード", "a"]);
      expect(lines.at(-1)).toEqual(["根拠", api.confirmStoppedParams("a", raw).note]);
      expect(api.checkNote("x\ny")).toContain("使えない文字"); // 1 行だけ
      expect(api.confirmStoppedLines("a", "").at(-1)).toEqual(["根拠", "（なし）"]);
    });

    it("T22-hub: フックの結び付けを外す確認の行と、結果の 3 通りの文", () => {
      const lines = api.hookUnbindLines("a");
      expect(lines[0]).toEqual(["ノード", "a"]);
      expect(lines.map((l) => l[0])).toEqual(["ノード", "内容", "記録", "注意"]);
      expect(lines.find((l) => l[0] === "注意")?.[1]).toContain("トークンが漏れた疑い");
      expect(lines.find((l) => l[0] === "内容")?.[1]).toContain(
        "（/clear・--resume で session_id が変わって、フックが拒否され続けるとき）",
      );
      expect(api.hookUnbindDoneText("a", { unbound: true, duplicate: false })).toContain(
        "外しました",
      );
      expect(api.hookUnbindDoneText("a", { unbound: false, duplicate: false })).toContain(
        "ありませんでした",
      );
      const dup = api.hookUnbindDoneText("a", { unbound: false, duplicate: true });
      expect(dup).toContain("すでに記録済み");
      expect(dup).not.toContain("ありませんでした");
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
      // 判断の失敗（4xx）は、同じ内容を送り直しても、結果が変わらない。再送を勧めず、状態を確かめさせる
      expect(a).not.toContain("もう一度送れます");
      expect(a).toContain("結果は変わりません");
      const long = api.describeFailure({
        status: 422,
        body: { ok: false, error: { code: "x", cause: "あ".repeat(500) } },
        retry: 0,
      });
      expect(long).toContain(`x: ${"あ".repeat(300)}`);
      expect(long).not.toContain("あ".repeat(301));
      expect(api.describeFailure({ status: 500, body: null, retry: 0 })).toContain("HTTP 500");
      // 保留の期限は、daemon の時計で決める（T23-d3）: 端末の時計のずれの案内は、もう出さない
      const clock = api.describeFailure({
        status: 422,
        body: { ok: false, error: { code: "invalidPurgeHoldUntil", cause: "範囲外" } },
        retry: 0,
      });
      expect(clock).not.toContain("この端末の時計");
      expect(
        api.describeFailure({
          status: 422,
          body: { ok: false, error: { code: "other", cause: "x" } },
          retry: 0,
        }),
      ).not.toContain("時計");
      expect(api.describeFailure({ status: 429, body: null, retry: 7 })).toContain("7 秒");
      expect(api.describeFailure({ status: 429, body: null, retry: 0 })).toContain("しばらく");
      // 再送して意味があるのは、待てば通りうる 429 だけ（ネットワークの失敗は、sendPending の catch で、再送を案内する）
      expect(api.describeFailure({ status: 429, body: null, retry: 3 })).toContain(
        "もう一度送れます",
      );
      for (const status of [400, 403, 404, 409, 422]) {
        const text = api.describeFailure({
          status,
          body: { ok: false, error: { code: "x", cause: "y" } },
          retry: 0,
        });
        expect(text, String(status)).not.toContain("もう一度送れます");
      }
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

    it("holdParams: 日数は days で送る（期限は、daemon の時計で決める。until は送らない）。0 日は無期限（days なし）。空白だけの理由は送らない", () => {
      expect(api.holdParams("t", 0, "")).toEqual({ nodeId: "t" });
      expect(api.holdParams("t", 30, "調査中")).toEqual({
        nodeId: "t",
        days: 30,
        reason: "調査中",
      });
      // 365 日も、そのまま送る（端末の時計で、10 分短くしない）
      expect(api.holdParams("t", 365, "  ")).toEqual({ nodeId: "t", days: 365 });
      expect(api.holdParams("t", 90, "x")).not.toHaveProperty("until");
    });

    it("holdDoneText: 成功の通知に、daemon が決めた期限を出す（until がなければ無期限）。制御文字は除く", () => {
      expect(api.holdDoneText("t", { held: true, until: "2026-11-22T12:00:00Z" })).toBe(
        "保留しました（t）。期限: 2026-11-22T12:00:00Z",
      );
      expect(api.holdDoneText("t", { held: true })).toBe("保留しました（t）。期限: 無期限");
      expect(api.holdDoneText("t", undefined)).toBe("保留しました（t）。期限: 無期限");
      const dirty = api.holdDoneText("t", { until: "2026\u001b[2J-11-22" });
      expect(dirty).not.toContain("\u001b");
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

    // ---- 回収の指示（T23-c）----
    const sha = (c: string): string => c.repeat(40);
    const preview = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
      reclaimable: false,
      unmet: ["discardRequired"],
      blockers: [],
      loss: [],
      tips: { s1: sha("a") },
      ...over,
    });

    it("isReclaimPreview: 事前確認の結果の形（loss・tips は任意。あれば、形を確かめる）", () => {
      expect(api.isReclaimPreview(preview())).toBe(true);
      expect(api.isReclaimPreview(preview({ loss: undefined, tips: undefined }))).toBe(true);
      expect(api.isReclaimPreview(null)).toBe(false);
      expect(api.isReclaimPreview(preview({ reclaimable: "yes" }))).toBe(false);
      expect(api.isReclaimPreview(preview({ unmet: "x" }))).toBe(false);
      expect(api.isReclaimPreview(preview({ blockers: {} }))).toBe(false);
      expect(api.isReclaimPreview(preview({ loss: {} }))).toBe(false);
      expect(api.isReclaimPreview(preview({ tips: [] }))).toBe(false);
      expect(api.isReclaimPreview(preview({ tips: { s1: 1 } }))).toBe(false);
    });

    it("reclaimBlocked: loss がない・調べられなかったノードがある・先端が多すぎるときは、送れない（cli で確かめる案内つき）。それ以外は ''", () => {
      expect(api.reclaimBlocked(preview())).toBe("");
      expect(api.reclaimBlocked(preview({ loss: undefined }))).toContain("cso reclaim");
      const unknown = api.reclaimBlocked(
        preview({
          loss: [
            {
              nodeId: "s2",
              unknown: true,
              untrustedSubjects: [],
              uncommitted: false,
              untracked: 0,
            },
          ],
        }),
      );
      expect(unknown).toContain("s2");
      expect(unknown).toContain("cso reclaim");
      expect(
        api.reclaimBlocked(
          preview({
            loss: [
              {
                nodeId: "s3",
                workingTreeUnknown: true,
                untrustedSubjects: [],
                uncommitted: false,
                untracked: 0,
              },
            ],
          }),
        ),
      ).toContain("s3");
      const many = Object.fromEntries(Array.from({ length: 256 }, (_, i) => [`n${i}`, sha("b")]));
      expect(api.reclaimBlocked(preview({ tips: many }))).toBe("");
      expect(api.reclaimBlocked(preview({ tips: { ...many, extra: sha("c") } }))).toContain(
        "多すぎ",
      );
      // 失われるものがない（loss が空）・先端がない（作業ツリーがない）のは、送れる
      expect(api.reclaimBlocked(preview({ tips: undefined }))).toBe("");
    });

    it("reclaimLines: 対象・取り消せない旨・失われるもの・先端（先頭 12 桁）・照合の説明を出す。件名は整える。パスを出さない", () => {
      const lines = api.reclaimLines(
        "s1",
        preview({
          unmet: ["discardRequired", "processesRunning"],
          blockers: [
            { kind: "process", reason: "processesRunning", pid: 1234 },
            { kind: "node", reason: "dirty", nodeId: "s1" },
          ],
          loss: [
            {
              nodeId: "s1",
              aheadCommits: 2,
              untrustedSubjects: ["fix: a\u001b[31mred\u202e", "<img src=x onerror=1>"],
              uncommitted: true,
              untracked: 3,
            },
          ],
          tips: { s1: `${"ab12".repeat(10)}` },
        }),
      );
      const text = lines.map((l) => l.join(" ")).join("\n");
      expect(lines[0]).toEqual(["対象", "s1"]);
      expect(text).toContain("取り消せません");
      expect(text).toContain("配下の停止ノードは、別に指示が必要");
      expect(text).toContain("破棄の判断が要る");
      expect(text).toContain("プロセス 1234");
      expect(text).toContain(
        "失われるもの（この対象と配下。配下は、それぞれの指示のときに失われる） 1 件のノード",
      );
      expect(text).toContain("ノード s1 統合されていないコミット 2 件");
      expect(text).toContain("統合されていないコミット 2 件");
      expect(text).toContain("追跡中のファイルの未保存の変更あり");
      expect(text).toContain("未追跡のファイル 3 件");
      expect(text).toContain("ab12ab12ab12"); // 先端の先頭 12 桁
      expect(text).not.toContain("ab12ab12ab12a"); // 13 桁目は出さない
      expect(text).toContain("<img src=x onerror=1>"); // 文字として出す（textContent で描く）
      expect(text).not.toContain("\u001b"); // 制御文字は除く
      expect(text).not.toContain("\u202e");
      expect(text).toContain("先端が変わっていたら、何も記録されません");
    });

    it("reclaimLines: 失われるものがなければ「なし」。長い一覧（20 件超）は切り、「ほか N 件」を出す（先端は、すべて照合に含める）", () => {
      const none = api
        .reclaimLines("s1", preview({ tips: undefined }))
        .map((l) => l.join(" "))
        .join("\n");
      expect(none).toContain(
        "失われるもの（この対象と配下。配下は、それぞれの指示のときに失われる） なし",
      );
      const many = api.reclaimLines(
        "s1",
        preview({
          loss: Array.from({ length: 30 }, (_, i) => ({
            nodeId: `n${i}`,
            untrustedSubjects: [],
            uncommitted: false,
            untracked: 0,
            aheadCommits: 0,
          })),
          tips: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`n${i}`, sha("d")])),
        }),
      );
      expect(many.filter((l) => l[0].startsWith("  ノード n")).length).toBe(20);
      expect(many.filter((l) => l[0].startsWith("ブランチの先端（")).length).toBe(20);
      expect(many).toContainEqual([
        "  失われるもの",
        "ほか 10 件（表示を省略。破棄の対象には、すべて含まれる）",
      ]);
      expect(many).toContainEqual(["ブランチの先端", "ほか 10 件（すべて、照合に含める）"]);
      // ちょうど 20 件なら、「ほか」は出さない
      const exact = api.reclaimLines(
        "s1",
        preview({
          tips: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`n${i}`, sha("e")])),
        }),
      );
      expect(exact.some((l) => l[1].startsWith("ほか"))).toBe(false);
    });

    it("reclaimLines: プロセスの名前を整えて添える。文字列でない・空の名前は出さない（T24-sp）", () => {
      const blockers = [
        {
          kind: "process",
          reason: "processesRunning",
          pid: 1,
          command: "<img src=x onerror=alert(1)>\u001b",
        },
        { kind: "process", reason: "processesRunning", pid: 2, command: 42 },
        { kind: "process", reason: "processesRunning", pid: 3 },
      ];
      const causes = api
        .reclaimLines("s1", preview({ unmet: ["processesRunning"], blockers }))
        .filter((l) => l[0] === "原因")
        .map((l) => l[1]);
      expect(causes[0]).toMatch(/^プロセス 1（<img src=x onerror=alert\(1\)>）（/);
      expect(causes[0]).not.toContain("\u001b");
      expect(causes[1]).toMatch(/^プロセス 2（/);
      expect(causes[1]).not.toContain("42");
      expect(causes[2]).toMatch(/^プロセス 3（/);
    });

    it("reclaimLines: 満たしていない条件・原因を 10 件で切ったときも、「ほか N 件」を出す", () => {
      const unmet = Array.from({ length: 12 }, () => "dirty");
      const blockers = Array.from({ length: 13 }, (_, i) => ({
        kind: "process",
        reason: "processesRunning",
        pid: 100 + i,
      }));
      const lines = api.reclaimLines("s1", preview({ unmet, blockers }));
      expect(
        lines.filter((l) => l[0] === "満たしていない条件" && !l[1].startsWith("ほか")).length,
      ).toBe(10);
      expect(lines).toContainEqual(["満たしていない条件", "ほか 2 件"]);
      expect(lines.filter((l) => l[0] === "原因" && !l[1].startsWith("ほか")).length).toBe(10);
      expect(lines).toContainEqual(["原因", "ほか 3 件"]);
      // 10 件ちょうどなら、「ほか」は出さない
      const ten = api.reclaimLines(
        "s1",
        preview({ unmet: unmet.slice(0, 10), blockers: blockers.slice(0, 10) }),
      );
      expect(ten.some((l) => l[1].startsWith("ほか"))).toBe(false);
    });

    it("failureHint・describeFailure: tipMismatch・tipUnknown は、同じ内容の再送でなく、確かめ直しを案内する", () => {
      expect(api.failureHint("tipMismatch")).toContain("確かめ直して");
      expect(api.failureHint("tipUnknown")).toContain("確かめ直して");
      expect(api.failureHint("conflict")).toBe("");
      const mismatch = api.describeFailure({
        status: 422,
        body: { ok: false, error: { code: "tipMismatch", cause: "先端が違う" } },
        retry: 0,
      });
      expect(mismatch).toContain("tipMismatch: 先端が違う");
      expect(mismatch).toContain("何も指示していません");
      expect(mismatch).not.toContain("同じ内容で、もう一度送れます");
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

  it("保留の日数の入力欄は、inputMode='numeric'（プロパティ。setAttribute は使わない。input タグは許可リストに足さない）。askHold は var の関数式", () => {
    expect(UI_JS).toContain("daysArea.inputMode = 'numeric'");
    expect(UI_JS).toContain("var askHold = function (label, days)");
    expect(UI_JS).not.toContain("function askHold");
    expect(UI_JS).not.toContain("setAttribute");
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

  it("T23-c: 回収の指示は、打ち込みの確認（typed: 対象のノード ID）を経る。見せた先端（プレビューの tips）を、作り直さずに、そのまま expectTips に渡す", () => {
    const start = UI_JS.indexOf("function startReclaim(");
    expect(start).toBeGreaterThan(-1);
    const body = UI_JS.slice(start, UI_JS.indexOf("\n  }\n", start));
    expect(body).toContain("readOperationResult('node.reclaimPreview'");
    expect(body).toContain("expectTips: v.tips || {}");
    expect(body).toContain("'node.reclaimInstruct'");
    expect(body).toContain("typed: nodeId");
    expect(body).toContain("blocked: reclaimBlocked(v)");
    // 先端を取り直す・作り直す経路がない（プレビューは、確認を出す前の 1 回だけ）
    expect(body.split("node.reclaimPreview").length - 1).toBe(1);
    expect(body).not.toMatch(/expectTips:\s*\{[^}]/);
    // 通信は、callOperation の 1 か所だけ（reclaimInstruct も、sendPending 経由）
    expect(UI_JS.split("fetch('/v1/request'").length - 1).toBe(1);
    // ボタンは、停止したノードだけ。指示済みには出さない
    expect(UI_JS).toContain("n.state === 'stopped'");
    expect(UI_JS).toContain("n.discarded");
  });

  it("T22-hub: フックの結び付けを外すボタンは、動いている子（統合ノードでなく running・waiting）だけに出し、打ち込みはなく { nodeId } を送る", () => {
    expect(UI_JS).toContain(
      "n.role !== 'integrator' && (n.state === 'running' || n.state === 'waiting') && ID_RE.test(n.id)",
    );
    const start = UI_JS.indexOf("function hookUnbindButton(");
    const body = UI_JS.slice(start, UI_JS.indexOf("\n  }\n", start));
    expect(body).toContain("'node.hookUnbind', { nodeId: nodeId }");
    expect(body).not.toContain("typed:");
  });

  it("T22d: 停止の宣言は、停止未完了かつ stopDelegated のノードだけに出し、打ち込みの確認（typed: ノード ID）を経る", () => {
    expect(UI_JS).toContain(
      "n.state === 'stopIncomplete' && n.stopDelegated === true && ID_RE.test(n.id)",
    );
    const start = UI_JS.indexOf("function confirmStoppedBox(");
    const body = UI_JS.slice(start, UI_JS.indexOf("\n  }\n", start));
    expect(body).toContain("'node.confirmStopped'");
    expect(body).toContain("typed: nodeId");
    expect(body).toContain("confirmStoppedParams(nodeId, note)");
    expect(UI_JS.split("fetch('/v1/request'").length - 1).toBe(1);
  });
});
