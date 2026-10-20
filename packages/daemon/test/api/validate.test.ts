import { DAEMON_OPERATIONS, LIMITS } from "@cso/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseEnvelope, validateParams } from "../../src/api/validate.js";

const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? null : r.error?.code);

describe("parseEnvelope（要求の封筒）", () => {
  it("requestId・operation・params の形を検査する。role・caller は申告として読むだけ", () => {
    const r = parseEnvelope({
      requestId: "r1",
      operation: "node.stop",
      params: { nodeId: "a", mode: "graceful" },
      role: "integrator",
      caller: { nodeId: "m1" },
    });
    expect(r.ok && r.value).toMatchObject({
      requestId: "r1",
      operation: "node.stop",
      claimedRole: "integrator",
      claimedCaller: "m1",
    });
  });

  it("壊れた封筒・未知の操作は invalidRequest / unknownOperation", () => {
    for (const bad of [
      null,
      [],
      "x",
      5,
      {},
      { requestId: "", operation: "node.stop", params: {} },
    ]) {
      expect(code(parseEnvelope(bad)), JSON.stringify(bad)).toBe("invalidRequest");
    }
    expect(code(parseEnvelope({ requestId: "r", operation: "nope", params: {} }))).toBe(
      "unknownOperation",
    );
    expect(code(parseEnvelope({ requestId: "r", operation: "toString", params: {} }))).toBe(
      "unknownOperation",
    );
    expect(code(parseEnvelope({ requestId: "r", operation: "__proto__", params: {} }))).toBe(
      "unknownOperation",
    );
    expect(code(parseEnvelope({ requestId: "r\u0000", operation: "tree.list", params: {} }))).toBe(
      "invalidRequest",
    );
    expect(
      code(parseEnvelope({ requestId: "r".repeat(129), operation: "tree.list", params: {} })),
    ).toBe("invalidRequest");
    expect(code(parseEnvelope({ requestId: "r", operation: "tree.list", params: [], x: 1 }))).toBe(
      "invalidRequest",
    );
    expect(
      code(parseEnvelope({ requestId: "r", operation: "tree.list", params: {}, extra: 1 })),
    ).toBe("invalidRequest");
  });
});

describe("validateParams（操作ごとの引数。余計なキーは拒否）", () => {
  const ok = (op: string, params: unknown) => validateParams(op as never, params).ok;

  it("代表的な正しい引数を受け付ける", () => {
    expect(ok("node.spawn", { brief: "やる", parentId: "root" })).toBe(true);
    expect(ok("node.send", { nodeId: "a", text: "続けて" })).toBe(true);
    expect(ok("node.stop", { nodeId: "a", mode: "immediate" })).toBe(true);
    expect(ok("inbox.fetch", {})).toBe(true);
    expect(ok("inbox.fetch", { sinceSeq: 0 })).toBe(true);
    expect(ok("tree.list", {})).toBe(true);
    expect(ok("decision.present", { question: "q", options: ["A", "B"] })).toBe(true);
    expect(ok("decision.present", { question: "q", options: ["A"], pauseNodeIds: ["a"] })).toBe(
      true,
    );
    expect(ok("node.split", { nodeId: "a", brief: "b", keep: "stop" })).toBe(true);
    expect(ok("scope.decide", { extensionId: "e", decision: "split" })).toBe(true);
    expect(ok("node.review", { nodeId: "a", verdict: "accept" })).toBe(true);
    for (const op of [
      "node.reclaimPreview",
      "node.reclaim",
      "node.capabilities",
      "node.reclaimInstruct",
      "node.purgePreview",
    ]) {
      expect(ok(op, { nodeId: "a" }), op).toBe(true);
    }
    expect(ok("decision.get", { decisionId: "d" })).toBe(true);
    expect(ok("report.get", { reportId: "r" })).toBe(true);
    expect(ok("report.progress", { text: "半分" })).toBe(true);
    expect(ok("report.decision", { question: "q", options: ["A", "B"] })).toBe(true);
    expect(ok("report.outOfScope", { text: "別件" })).toBe(true);
    expect(ok("report.done", { evidence: [{ criterion: "c", evidence: "e" }] })).toBe(true);
    expect(ok("scope.extend", { target: "docs", reason: "必要" })).toBe(true);
    expect(ok("node.bind", { bindCode: "abc123" })).toBe(true);
    expect(ok("decision.answer", { decisionId: "d", choice: "A" })).toBe(true);
    expect(ok("decision.answer", { decisionId: "d", text: "自由入力" })).toBe(true);
    expect(ok("node.purge", { nodeId: "root" })).toBe(true);
    expect(ok("node.purge", { nodeId: "root", tombstone: false })).toBe(true);
  });

  it("余計なキー・欠けたキー・型の違い・列挙外の値は invalidRequest", () => {
    for (const [op, p] of [
      ["node.send", { nodeId: "a", text: "x", extra: 1 }],
      ["node.send", { nodeId: "a" }],
      ["node.send", { nodeId: 5, text: "x" }],
      ["node.send", { nodeId: "", text: "x" }],
      ["node.stop", { nodeId: "a", mode: "now" }],
      ["inbox.fetch", { sinceSeq: -1 }],
      ["inbox.fetch", { sinceSeq: 1.5 }],
      ["inbox.fetch", { sinceSeq: "1" }],
      ["tree.list", { x: 1 }],
      ["decision.present", { question: "q", options: [] }],
      ["decision.present", { question: "q", options: ["A", "A"] }],
      ["decision.present", { question: "q", options: ["A"], pauseNodeIds: [""] }],
      ["node.split", { nodeId: "a", brief: "b", keep: "both" }],
      ["scope.decide", { extensionId: "e", decision: "maybe" }],
      ["decision.answer", { decisionId: "d" }],
      ["decision.answer", { decisionId: "d", choice: "A", text: "B" }],
      ["node.purge", { nodeId: "root", tombstone: "yes" }],
      ["report.done", { evidence: [{ criterion: "c" }] }],
      ["report.done", { evidence: "x" }],
    ] as const) {
      expect(code(validateParams(op as never, p)), `${op} ${JSON.stringify(p)}`).toBe(
        "invalidRequest",
      );
    }
    for (const bad of [null, undefined, [], "x", 5]) {
      expect(code(validateParams("node.send", bad)), JSON.stringify(bad)).toBe("invalidRequest");
    }
  });

  it("文字列の上限（LIMITS）と禁止文字を適用する", () => {
    const text = (n: number) => "あ".repeat(n);
    expect(ok("report.progress", { text: text(LIMITS.reportText) })).toBe(true);
    expect(ok("report.progress", { text: text(LIMITS.reportText + 1) })).toBe(false);
    expect(ok("report.decision", { question: text(LIMITS.question + 1), options: ["A"] })).toBe(
      false,
    );
    expect(ok("report.decision", { question: "q", options: [text(LIMITS.optionLength + 1)] })).toBe(
      false,
    );
    expect(
      ok("report.decision", {
        question: "q",
        options: Array.from({ length: LIMITS.optionCount + 1 }, (_, i) => `o${i}`),
      }),
    ).toBe(false);
    expect(
      ok("report.done", {
        evidence: Array.from({ length: LIMITS.evidenceCount + 1 }, () => ({
          criterion: "c",
          evidence: "e",
        })),
      }),
    ).toBe(false);
    for (const bad of ["a\u0000b", "a‮b", "a\rb", "a\u001bb"]) {
      expect(ok("report.progress", { text: bad }), JSON.stringify(bad)).toBe(false);
      expect(ok("node.send", { nodeId: bad, text: "x" }), JSON.stringify(bad)).toBe(false);
      expect(ok("node.send", { nodeId: "a", text: bad }), JSON.stringify(bad)).toBe(false);
    }
    expect(ok("report.progress", { text: "行1\n\t行2" })).toBe(true);
    expect(ok("node.send", { nodeId: "a".repeat(129), text: "x" })).toBe(false);
    expect(ok("node.send", { nodeId: "a".repeat(128), text: "x" })).toBe(true);
    // 識別子の形式（core の isSafeId）: パスの要素・区切り・空白・非 ASCII は拒否
    for (const id of ["../x", "a/b", "a b", ".hidden", "-x", "あ", "a;b", "a$b"]) {
      expect(ok("node.send", { nodeId: id, text: "x" }), id).toBe(false);
      expect(ok("decision.get", { decisionId: id }), id).toBe(false);
      expect(ok("node.purge", { nodeId: id }), id).toBe(false);
    }
  });

  it("値は新しいオブジェクトに写して返す（入力を変更しない）", () => {
    const input = { nodeId: "a", mode: "graceful" };
    const r = validateParams("node.stop", input);
    expect(r.ok && r.value).toEqual(input);
    expect(r.ok && r.value).not.toBe(input);
  });

  it("性質: すべての操作で、どんな入力でも例外を出さず、結果は ok か invalidRequest", () => {
    fc.assert(
      fc.property(fc.constantFrom(...DAEMON_OPERATIONS), fc.anything(), (op, params) => {
        const r = validateParams(op, params);
        expect(r.ok || r.error.code === "invalidRequest").toBe(true);
      }),
    );
  });
});
