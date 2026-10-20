import {
  type DaemonRequest,
  DEFAULT_PURGE_TOMBSTONE,
  err,
  failure,
  isSafeId,
  ok,
  type Result,
} from "@cso/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type DaemonClient, formatFailure, runCommand } from "../src/index.js";

const PREVIEW = { nodeIds: ["n1", "n2"], archivedAt: "2026-01-01T00:00:00Z", elapsedDays: 95 };

/** 操作ごとに用意した結果を返し、送られた要求を記録するフェイク。 */
function fakeClient(results: Record<string, Result<unknown> | (() => never)>) {
  const sent: DaemonRequest<"human">[] = [];
  const client: DaemonClient = {
    call: async (req) => {
      sent.push(req);
      const r = results[req.operation];
      if (r === undefined) throw new Error(`想定外の操作: ${req.operation}`);
      return (typeof r === "function" ? r() : r) as never;
    },
  };
  return { client, sent };
}
const deps = (client: DaemonClient) => ({ client, newRequestId: () => "req-1" });
const happy = () =>
  fakeClient({
    "node.purgePreview": ok(PREVIEW),
    "node.purge": ok({ purged: ["n1", "n2"] }),
    "node.reclaimInstruct": ok({ accepted: true }),
  });
const ops = (sent: readonly DaemonRequest<"human">[]) => sent.map((s) => s.operation);

describe("purge の対象表示と --yes（FR_031, NFR_006）", () => {
  it("--yes がなければ削除せず、事前確認で対象を表示して --yes を要求する（終了コード 2）", async () => {
    const { client, sent } = happy();
    const r = await runCommand(["purge", "n1"], deps(client));
    expect(ops(sent)).toEqual(["node.purgePreview"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout + r.stderr).toContain("n2");
    expect(r.stderr).toContain("--yes");
  });

  it("--yes があれば、対象を表示してから node.purge を送る（requestId つき、墓標は省略）", async () => {
    const { client, sent } = happy();
    const r = await runCommand(["purge", "n1", "--yes"], deps(client));
    expect(sent).toEqual([
      {
        requestId: "req-1",
        role: "human",
        operation: "node.purgePreview",
        params: { nodeId: "n1" },
      },
      { requestId: "req-1", role: "human", operation: "node.purge", params: { nodeId: "n1" } },
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("n1");
    expect(r.stdout).toContain("2"); // 対象ノード数
    expect(r.stdout).toContain("req-1");
  });

  it("--dry-run は削除せず、削除される木・アーカイブ日・経過日数を表示する", async () => {
    const { client, sent } = happy();
    const r = await runCommand(["purge", "n1", "--dry-run"], deps(client));
    expect(ops(sent)).toEqual(["node.purgePreview"]);
    expect(r.exitCode).toBe(0);
    for (const s of ["n1", "n2", "2026-01-01", "95"]) expect(r.stdout).toContain(s);
  });

  it("--dry-run は --yes があっても削除しない", async () => {
    const { client, sent } = happy();
    await runCommand(["purge", "n1", "--dry-run", "--yes"], deps(client));
    expect(ops(sent)).toEqual(["node.purgePreview"]);
  });

  it("事前確認が失敗したら、削除を送らず原因と次の操作を出す", async () => {
    const { client, sent } = fakeClient({
      "node.purgePreview": err(failure("not_archived", "アーカイブされていない", "先に回収する")),
    });
    const r = await runCommand(["purge", "n1", "--yes"], deps(client));
    expect(ops(sent)).toEqual(["node.purgePreview"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("アーカイブされていない");
  });
});

describe("墓標の選択（FR_031）", () => {
  it.each([
    [["--tombstone"], true],
    [["--no-tombstone"], false],
  ])("%j は tombstone=%s を node.purge に渡す", async (flags, expected) => {
    const { client, sent } = happy();
    await runCommand(["purge", "n1", "--yes", ...flags], deps(client));
    expect(sent.at(-1)?.params).toEqual({ nodeId: "n1", tombstone: expected });
  });

  it("両方を指定したら拒否し、窓口を呼ばない", async () => {
    const { client, sent } = happy();
    const r = await runCommand(
      ["purge", "n1", "--yes", "--tombstone", "--no-tombstone"],
      deps(client),
    );
    expect(r.exitCode).toBe(2);
    expect(sent).toEqual([]);
  });

  it("省略時の既定は core の DEFAULT_PURGE_TOMBSTONE に従う旨を表示する", async () => {
    const { client } = happy();
    const r = await runCommand(["purge", "n1", "--dry-run"], deps(client));
    expect(r.stdout).toContain(DEFAULT_PURGE_TOMBSTONE ? "墓標を残す" : "墓標を残さない");
  });
});

describe("オプションの検査", () => {
  it.each([
    [["purge", "n1", "--force"]],
    [["purge", "n1", "--yes", "--recursive"]],
    [["reclaim", "n1", "--yes"]],
    [["reclaim", "n1", "--tombstone"]],
    [["purge", "n1", "-y"]],
  ])("%j は「不明なオプション」で終了コード 2、窓口を呼ばない", async (argv) => {
    const { client, sent } = happy();
    const r = await runCommand(argv, deps(client));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("不明なオプション");
    expect(sent).toEqual([]);
  });

  it("--help / -h は使い方を標準出力に出して終了コード 0", async () => {
    for (const argv of [["--help"], ["-h"], ["purge", "--help"], ["reclaim", "-h"]]) {
      const { client, sent } = happy();
      const r = await runCommand(argv, deps(client));
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("purge");
      expect(r.stdout).toContain("reclaim");
      expect(sent).toEqual([]);
    }
  });
});

describe("ノード ID の入口検証", () => {
  it.each([
    [""],
    ["  "],
    ["a b"],
    ["a\nb"],
    ["a\u0000b"],
    ["*"],
    ["a?"],
    ["../x"],
    ["a/b"],
    ["a\\b"],
    ["-rf"],
  ])("%j は拒否し、窓口を呼ばない", async (id) => {
    const { client, sent } = happy();
    for (const argv of [
      ["purge", id, "--yes"],
      ["reclaim", id],
    ]) {
      const r = await runCommand(argv, deps(client));
      expect(r.exitCode).toBe(2);
    }
    expect(sent).toEqual([]);
  });

  it("通常の識別子は受け付ける", async () => {
    const { client } = happy();
    const r = await runCommand(["reclaim", "node-1.a_b:c"], deps(client));
    expect(r.exitCode).toBe(0);
  });
});

describe("reclaim（FR_029: 回収の指示）", () => {
  it("node.reclaimInstruct を送り、requestId を表示する", async () => {
    const { client, sent } = happy();
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
    expect(r.stdout).toContain("req-1");
  });
});

describe("結果が確認できない場合（NFR_010, 冪等性）", () => {
  const boom = () => {
    throw new Error("ECONNREFUSED");
  };

  it("窓口が例外を投げたら、状態の確認と同じ requestId での再実行を案内して終了コード 1", async () => {
    const { client } = fakeClient({ "node.purgePreview": ok(PREVIEW), "node.purge": boom });
    const r = await runCommand(["purge", "n1", "--yes"], deps(client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("確認できない");
    expect(r.stderr).toContain("req-1");
    expect(r.stderr).toContain("--request-id req-1");
  });

  it("purged が配列でない応答は失敗として扱う", async () => {
    const { client } = fakeClient({
      "node.purgePreview": ok(PREVIEW),
      "node.purge": ok({ purged: "n1" }),
    });
    const r = await runCommand(["purge", "n1", "--yes"], deps(client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("確認できない");
  });

  it("失敗の形が不正（nextActions が空）な応答も、結果が確認できない扱いにする", async () => {
    const bad = {
      ok: false,
      error: { code: "x", cause: "c", nextActions: [] },
    } as unknown as Result<unknown>;
    const { client } = fakeClient({ "node.reclaimInstruct": bad });
    const r = await runCommand(["reclaim", "n1"], deps(client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("確認できない");
  });

  it("--request-id を渡すと、その識別子で要求する（再実行）", async () => {
    const { client, sent } = happy();
    await runCommand(["purge", "n1", "--yes", "--request-id", "retry-7"], deps(client));
    expect(sent.every((s) => s.requestId === "retry-7")).toBe(true);
  });

  it("--request-id の値が無い・不正なら拒否する", async () => {
    for (const argv of [
      ["reclaim", "n1", "--request-id"],
      ["reclaim", "n1", "--request-id", "a b"],
    ]) {
      const { client, sent } = happy();
      const r = await runCommand(argv, deps(client));
      expect(r.exitCode).toBe(2);
      expect(sent).toEqual([]);
    }
  });
});

describe("窓口の拒否と引数の誤り", () => {
  it("窓口が拒否したら、code・原因・次の操作を出して終了コード 1（NFR_010）", async () => {
    const f = failure("not_archived", "アーカイブされていない", "先に回収する");
    const { client } = fakeClient({ "node.reclaimInstruct": err(f) });
    const r = await runCommand(["reclaim", "n1"], deps(client));
    expect(r.exitCode).toBe(1);
    for (const s of ["not_archived", "アーカイブされていない", "先に回収する"]) {
      expect(r.stderr).toContain(s);
    }
    expect(r.stdout).toBe("");
  });

  it.each([[[]], [["unknown"]], [["purge"]], [["reclaim"]], [["reclaim", "a", "b"]]])(
    "%j は使い方を示して終了コード 2、窓口を呼ばない",
    async (argv) => {
      const { client, sent } = happy();
      const r = await runCommand(argv, deps(client));
      expect(r.exitCode).toBe(2);
      expect(r.stderr).toContain("purge");
      expect(r.stderr).toContain("reclaim");
      expect(sent).toEqual([]);
    },
  );
});

describe("formatFailure", () => {
  it("code・原因・次の操作を含む", () => {
    const text = formatFailure(failure("some_code", "原因です", "操作 A", "操作 B"));
    for (const s of ["some_code", "原因です", "操作 A", "操作 B"]) expect(text).toContain(s);
  });
});

describe("ノード ID の規則は core の isSafeId と一致する（ずれ防止）", () => {
  it("任意の文字列で、reclaim が受け付けるのは isSafeId が真のときだけ", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(fc.string(), fc.stringMatching(/^[A-Za-z0-9._:\-/*? ]{0,12}$/)),
        async (id) => {
          const { client, sent } = happy();
          const r = await runCommand(["reclaim", id], deps(client));
          // 先頭が "-" のものはオプション扱いで、どちらにしても窓口は呼ばれない
          if (isSafeId(id)) {
            expect(r.exitCode).toBe(0);
            expect(sent).toHaveLength(1);
          } else {
            expect(r.exitCode).toBe(2);
            expect(sent).toEqual([]);
          }
        },
      ),
    );
  });

  it("--request-id の値にも同じ規則を使う", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (rid) => {
        const { client, sent } = happy();
        const r = await runCommand(["reclaim", "n1", "--request-id", rid], deps(client));
        expect(r.exitCode === 0).toBe(isSafeId(rid));
        expect(sent.length === 1).toBe(isSafeId(rid));
      }),
    );
  });
});
