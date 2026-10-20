import { type DaemonRequest, err, failure, ok, type Result } from "@cso/core";
import { describe, expect, it } from "vitest";
import { type DaemonClient, formatFailure, runCommand } from "../src/index.js";

/** 送られた要求を記録し、用意した結果を返すフェイク。 */
function fakeClient(result: Result<unknown>) {
  const sent: DaemonRequest<"human">[] = [];
  const client: DaemonClient = {
    call: async (req) => {
      sent.push(req);
      return result as never;
    },
  };
  return { client, sent };
}
const deps = (client: DaemonClient) => ({ client, newRequestId: () => "req-1" });

describe("purge（FR_031, DC_003, NFR_006）", () => {
  it("--yes がなければ窓口を呼ばず、取り消せないことと次の操作を示して拒否する", async () => {
    const { client, sent } = fakeClient(ok({ purged: [] }));
    const r = await runCommand(["purge", "n1"], deps(client));
    expect(sent).toEqual([]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--yes");
  });

  it("--yes があれば human ロールの node.purge を requestId つきで送る", async () => {
    const { client, sent } = fakeClient(ok({ purged: ["n1", "n2"] }));
    const r = await runCommand(["purge", "n1", "--yes"], deps(client));
    expect(sent).toEqual([
      { requestId: "req-1", role: "human", operation: "node.purge", params: { nodeId: "n1" } },
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("n1");
    expect(r.stdout).toContain("n2");
  });

  it("窓口が拒否したら、原因と次の操作を出して終了コード 1 にする（NFR_010）", async () => {
    const f = failure("not_archived", "アーカイブされていない", "先に回収する");
    const { client } = fakeClient(err(f));
    const r = await runCommand(["purge", "n1", "--yes"], deps(client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("アーカイブされていない");
    expect(r.stderr).toContain("先に回収する");
    expect(r.stdout).toBe("");
  });
});

describe("reclaim（FR_029: 回収の指示）", () => {
  it("node.reclaimInstruct を送る", async () => {
    const { client, sent } = fakeClient(ok({ accepted: true }));
    const r = await runCommand(["reclaim", "n1"], deps(client));
    expect(sent).toEqual([
      {
        requestId: "req-1",
        role: "human",
        operation: "node.reclaimInstruct",
        params: { nodeId: "n1" },
      },
    ]);
    expect(r.exitCode).toBe(0);
  });
});

describe("引数の誤り", () => {
  it.each([[[]], [["unknown"]], [["purge"]], [["reclaim"]], [["reclaim", "a", "b"]]])(
    "%j は使い方を示して終了コード 2 にし、窓口を呼ばない",
    async (argv) => {
      const { client, sent } = fakeClient(ok({}));
      const r = await runCommand(argv, deps(client));
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("purge");
      expect(r.stderr).toContain("reclaim");
      expect(sent).toEqual([]);
    },
  );
});

describe("formatFailure", () => {
  it("原因と次の操作を含む", () => {
    const text = formatFailure(failure("x", "原因です", "操作 A", "操作 B"));
    expect(text).toContain("原因です");
    expect(text).toContain("操作 A");
    expect(text).toContain("操作 B");
  });
});
