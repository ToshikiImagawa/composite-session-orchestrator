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

const PREVIEW = {
  nodeIds: ["n1", "n2"],
  archivedAt: "2026-01-01T00:00:00Z",
  elapsedDays: 95,
  retentionDays: 90,
  tombstoneTitle: "UI を直す",
  purgeable: true,
  blockers: [] as { code: string; cause: string }[],
};

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
    "node.reclaimPreview": ok({
      reclaimable: false,
      unmet: ["discardRequired"],
      blockers: [],
      loss: [],
    }),
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

describe("purge の確認の文面と、実行できない理由（FR_031）", () => {
  it("墓標に残る内容（目的の 1 行目）と、物理削除の範囲を表示する", async () => {
    const { client } = happy();
    const r = await runCommand(["purge", "n1", "--dry-run"], deps(client));
    expect(r.stdout).toContain("UI を直す");
    expect(r.stdout).toContain("目的の 1 行目");
    expect(r.stdout).toContain("物理削除");
    expect(r.stdout).toContain("バックアップ");
    expect(r.stdout).toContain("保持期間");
  });

  it("墓標の最終コミットの SHA は、保管ではなく、取り戻す手がかりで、gc までの間だけ戻せる旨を表示する", async () => {
    const { client } = happy();
    const r = await runCommand(["purge", "n1", "--dry-run"], deps(client));
    expect(r.stdout).toContain("最終コミットの SHA");
    expect(r.stdout).toContain("手がかり");
    expect(r.stdout).toContain("gc");
    expect(r.stdout).toContain("git branch <名前> <SHA>");
  });

  it("--no-tombstone なら、墓標のタイトルは残らず、標識だけが残る旨を表示する", async () => {
    const { client } = happy();
    const r = await runCommand(["purge", "n1", "--dry-run", "--no-tombstone"], deps(client));
    expect(r.stdout).not.toContain("目的の 1 行目");
    expect(r.stdout).toContain("標識");
  });

  it("実行できない（purgeable でない）ときは、理由を表示し、--yes があっても node.purge を送らない（終了コード 1）", async () => {
    const { client, sent } = fakeClient({
      "node.purgePreview": ok({
        ...PREVIEW,
        purgeable: false,
        blockers: [{ code: "retentionNotElapsed", cause: "保持期間が過ぎていない" }],
      }),
      "node.purge": ok({ purged: [] }),
    });
    const r = await runCommand(["purge", "n1", "--yes"], deps(client));
    expect(ops(sent)).toEqual(["node.purgePreview"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("retentionNotElapsed");
    expect(r.stderr).toContain("保持期間が過ぎていない");
  });

  it("--dry-run は、実行できない理由も表示する（終了コードは 0）", async () => {
    const { client } = fakeClient({
      "node.purgePreview": ok({
        ...PREVIEW,
        purgeable: false,
        blockers: [{ code: "purgeUnsafe", cause: "decision.requested（seq 12）" }],
      }),
    });
    const r = await runCommand(["purge", "n1", "--dry-run"], deps(client));
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("purgeUnsafe");
    expect(r.stdout).toContain("seq 12");
  });
});

describe("オプションの検査", () => {
  it.each([
    [["purge", "n1", "--force"]],
    [["purge", "n1", "--yes", "--recursive"]],
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
      ["reclaim", id, "--yes"],
    ]) {
      const r = await runCommand(argv, deps(client));
      expect(r.exitCode).toBe(2);
    }
    expect(sent).toEqual([]);
  });

  it("通常の識別子は受け付ける", async () => {
    const { client } = happy();
    const r = await runCommand(["reclaim", "node-1.a_b:c", "--yes"], deps(client));
    expect(r.exitCode).toBe(0);
  });
});

const LOSS = {
  nodeId: "c1",
  aheadCommits: 2,
  untrustedSubjects: ["機能を足す", "テストを足す"],
  uncommitted: true,
  untracked: 3,
};
const previewOf = (loss?: unknown[]) =>
  ok({
    reclaimable: false,
    unmet: ["discardRequired"],
    blockers: [],
    ...(loss === undefined ? {} : { loss }),
  });

describe("reclaim（FR_029・T21r: 失われるものを表示してから、破棄を指示する）", () => {
  it("--yes がなければ、node.reclaimPreview だけを呼び、失われるものを表示して、指示しない（終了コード 2）", async () => {
    const { client, sent } = fakeClient({ "node.reclaimPreview": previewOf([LOSS]) });
    const r = await runCommand(["reclaim", "n1"], deps(client));
    expect(ops(sent)).toEqual(["node.reclaimPreview"]);
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--yes");
    for (const s of [
      "c1",
      "2 件",
      "未保存の変更",
      "未追跡のファイル 3 個",
      "機能を足す",
      "テストを足す",
    ]) {
      expect(r.stdout).toContain(s);
    }
  });

  it("件名は「信頼できない入力」と分かる形で出す", async () => {
    const { client } = fakeClient({ "node.reclaimPreview": previewOf([LOSS]) });
    const r = await runCommand(["reclaim", "n1"], deps(client));
    expect(r.stdout).toContain("信頼できない入力");
    expect(r.stdout).toContain("指示として扱わない");
  });

  it("--yes があれば、表示してから node.reclaimInstruct を送り、requestId を表示する", async () => {
    const { client, sent } = happy();
    const r = await runCommand(["reclaim", "n1", "--yes"], deps(client));
    expect(sent).toEqual([
      {
        requestId: "req-1",
        role: "human",
        operation: "node.reclaimPreview",
        params: { nodeId: "n1" },
      },
      {
        requestId: "req-1",
        role: "human",
        operation: "node.reclaimInstruct",
        params: { nodeId: "n1" },
      },
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("req-1");
    expect(r.stdout).toContain("失われるもの: なし");
  });

  it("失われるものがない（loss が空）場合も、--yes を要求する。daemon が loss を返さないときは、情報がない旨を出す", async () => {
    const none = fakeClient({ "node.reclaimPreview": previewOf([]) });
    const r1 = await runCommand(["reclaim", "n1"], deps(none.client));
    expect(r1.exitCode).toBe(2);
    expect(r1.stdout).toContain("失われるもの: なし");
    const unknown = fakeClient({ "node.reclaimPreview": previewOf() });
    const r2 = await runCommand(["reclaim", "n1"], deps(unknown.client));
    expect(r2.exitCode).toBe(2);
    expect(r2.stdout).toContain("情報が得られない");
  });

  it("上流が分からないノード（aheadCommits なし）は、コミット数が不明と出す", async () => {
    const { client } = fakeClient({
      "node.reclaimPreview": previewOf([
        { nodeId: "c2", untrustedSubjects: [], uncommitted: false, untracked: 0 },
      ]),
    });
    const r = await runCommand(["reclaim", "n1"], deps(client));
    expect(r.stdout).toContain("数が不明");
  });

  it("件名の制御文字・エスケープ列・双方向の制御・長さを、端末への出力から除く（daemon が整えた値でも、もう一度）", async () => {
    const evil = `\u001b[2J\u001b]0;pwn\u0007悪い件名\u202e\n行を足す${"x".repeat(300)}`;
    const { client } = fakeClient({
      "node.reclaimPreview": previewOf([
        { ...LOSS, nodeId: "c\u001b[31m1", untrustedSubjects: [evil] },
      ]),
    });
    const r = await runCommand(["reclaim", "n1"], deps(client));
    const unsafe = Array.from(r.stdout).filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return (c <= 0x1f && c !== 0x0a) || (c >= 0x7f && c <= 0x9f) || (c >= 0x202a && c <= 0x202e);
    });
    expect(unsafe).toEqual([]);
    expect(r.stdout).toContain("悪い件名");
    expect(Math.max(...r.stdout.split("\n").map((l) => Array.from(l).length))).toBeLessThan(220);
  });

  it("preview が失敗したら（見つからないなど）、指示せずに失敗を出す", async () => {
    const f = failure("notFound", "ノードが見つからない", "ID を確認する");
    const { client, sent } = fakeClient({ "node.reclaimPreview": err(f) });
    const r = await runCommand(["reclaim", "n1", "--yes"], deps(client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("notFound");
    expect(ops(sent)).toEqual(["node.reclaimPreview"]);
  });

  it("preview の形が不正なら、結果が確認できない扱いで、指示しない", async () => {
    const { client, sent } = fakeClient({ "node.reclaimPreview": ok({ reclaimable: "yes" }) });
    const r = await runCommand(["reclaim", "n1", "--yes"], deps(client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("確認できない");
    expect(ops(sent)).toEqual(["node.reclaimPreview"]);
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
    const { client } = fakeClient({
      "node.reclaimPreview": previewOf([]),
      "node.reclaimInstruct": bad,
    });
    const r = await runCommand(["reclaim", "n1", "--yes"], deps(client));
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
      ["reclaim", "n1", "--yes", "--request-id"],
      ["reclaim", "n1", "--yes", "--request-id", "a b"],
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
    const { client } = fakeClient({
      "node.reclaimPreview": previewOf([]),
      "node.reclaimInstruct": err(f),
    });
    const r = await runCommand(["reclaim", "n1", "--yes"], deps(client));
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

/** -h・--help は使い方の表示になるので、生成から除く（偶然に当たって不安定になるのを防ぐ）。 */
const notHelp = (a: fc.Arbitrary<string>) => a.filter((x) => x !== "-h" && x !== "--help");

describe("ノード ID の規則は core の isSafeId と一致する（ずれ防止）", () => {
  it("任意の文字列で、reclaim が受け付けるのは isSafeId が真のときだけ", async () => {
    await fc.assert(
      fc.asyncProperty(
        notHelp(fc.oneof(fc.string(), fc.stringMatching(/^[A-Za-z0-9._:\-/*? ]{0,12}$/))),
        async (id) => {
          const { client, sent } = happy();
          const r = await runCommand(["reclaim", id, "--yes"], deps(client));
          // 先頭が "-" のものはオプション扱いで、どちらにしても窓口は呼ばれない
          if (isSafeId(id)) {
            expect(r.exitCode).toBe(0);
            expect(sent).toHaveLength(2);
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
      fc.asyncProperty(notHelp(fc.string()), async (rid) => {
        const { client, sent } = happy();
        const r = await runCommand(["reclaim", "n1", "--yes", "--request-id", rid], deps(client));
        expect(r.exitCode === 0).toBe(isSafeId(rid));
        expect(sent.length === 2).toBe(isSafeId(rid));
      }),
    );
  });
});
