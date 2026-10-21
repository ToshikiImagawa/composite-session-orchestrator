import { describe, expect, it } from "vitest";
import {
  type EventBody,
  foldEvents,
  type NodeEvent,
  type OrchEvent,
  type OrchState,
  purgeEventSeqs,
} from "../src/index.js";

const SYS = { system: true } as const;
let counter = 100;
const ev = (
  body: EventBody,
  over: Partial<Pick<OrchEvent, "seq" | "requestId">> = {},
): OrchEvent => {
  counter += 1;
  return {
    seq: over.seq ?? counter,
    at: "2026-10-21T00:00:00Z",
    requestId: over.requestId ?? `req-${counter}`,
    actor: SYS,
    ...body,
  } as OrchEvent;
};
const created = (nodeId: string, role: "integrator" | "implement", parentId: string | null) =>
  ev({ type: "node.created", payload: { nodeId, role, parentId, dependsOn: [] } });
const changed = (nodeId: string, event: NodeEvent) =>
  ev({ type: "node.stateChanged", payload: { nodeId, event } });
const base = (): OrchEvent[] => [
  created("root", "integrator", null),
  changed("root", { type: "start" }),
  created("a", "implement", "root"),
  changed("a", { type: "start" }),
];
const last = (nodeId: string, commit: unknown) =>
  ev({ type: "node.lastCommit", payload: { nodeId, commit } } as never);
const code = (r: ReturnType<typeof foldEvents>) => (r.ok ? null : r.error.code);
const must = (r: ReturnType<typeof foldEvents>): OrchState => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.cause}`);
  return r.value;
};
const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const SHA256 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("node.lastCommit（最終コミットの記録。状態は変えない）", () => {
  it("ノードに最終コミットを記録する。状態は変わらない", () => {
    const s = must(foldEvents([...base(), last("a", SHA1)]));
    const n = s.nodes.find((x) => x.id === "a");
    expect(n?.lastCommit).toBe(SHA1);
    expect(n?.state).toBe("running");
  });

  it("SHA-256（64 桁）も受け付ける。後の記録が前の記録を置き換える", () => {
    const s = must(foldEvents([...base(), last("a", SHA1), last("a", SHA256)]));
    expect(s.nodes.find((x) => x.id === "a")?.lastCommit).toBe(SHA256);
  });

  it("存在しないノード・不正な識別子は拒否する", () => {
    expect(code(foldEvents([...base(), last("zz", SHA1)]))).toBe("unknownNode");
    expect(code(foldEvents([...base(), last("a b", SHA1)]))).toBe("invalidPayload");
  });

  it.each([
    ["空", ""],
    ["短い", "abc123"],
    ["大文字", SHA1.toUpperCase()],
    ["16 進でない", `${"g".repeat(40)}`],
    ["41 桁", `${SHA1}0`],
    ["末尾の改行", `${SHA1}\n`],
    ["数値", 123],
    ["未指定", undefined],
  ])("SHA の形でない値は拒否する（%s）", (_name, commit) => {
    expect(code(foldEvents([...base(), last("a", commit)]))).toBe("invalidPayload");
  });

  it("最終削除の対象のノードの行として、消す対象に入る", () => {
    const events = [...base(), last("a", SHA1)];
    const seqs = purgeEventSeqs(events, new Set(["a"]));
    expect(seqs).toContain(events[events.length - 1]?.seq);
  });
});
