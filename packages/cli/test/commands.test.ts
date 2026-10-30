import {
  type DaemonRequest,
  DEFAULT_PURGE_TOMBSTONE,
  err,
  failure,
  isSafeId,
  LIMITS,
  ok,
  type Result,
} from "@cso/core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type DaemonClient,
  formatFailure,
  nodeIdsDigest,
  runCommand,
  tipsDigest,
} from "../src/index.js";

const PREVIEW = {
  nodeIds: ["n1", "n2"],
  archivedAt: "2026-01-01T00:00:00Z",
  elapsedDays: 95,
  retentionDays: 90,
  tombstoneTitle: "UI を直す",
  purgeable: true,
  blockers: [] as { code: string; cause: string }[],
};

const NODES_DG = nodeIdsDigest(PREVIEW.nodeIds);

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
    const r = await runCommand(["purge", "n1", "--yes", "--expect", NODES_DG], deps(client));
    expect(sent).toEqual([
      {
        requestId: "req-1",
        role: "human",
        operation: "node.purgePreview",
        params: { nodeId: "n1" },
      },
      {
        requestId: "req-1",
        role: "human",
        operation: "node.purge",
        params: { nodeId: "n1", expectNodeIds: ["n1", "n2"] },
      },
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
    const r = await runCommand(["purge", "n1", "--yes", "--expect", NODES_DG], deps(client));
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
    await runCommand(["purge", "n1", "--yes", "--expect", NODES_DG, ...flags], deps(client));
    expect(sent.at(-1)?.params).toEqual({
      nodeId: "n1",
      tombstone: expected,
      expectNodeIds: ["n1", "n2"],
    });
  });

  it("両方を指定したら拒否し、窓口を呼ばない", async () => {
    const { client, sent } = happy();
    const r = await runCommand(
      ["purge", "n1", "--yes", "--expect", NODES_DG, "--tombstone", "--no-tombstone"],
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
    const r = await runCommand(["purge", "n1", "--yes", "--expect", NODES_DG], deps(client));
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
    const r = await runCommand(
      ["reclaim", "node-1.a_b:c", "--yes", "--expect", DG_NONE],
      deps(client),
    );
    expect(r.exitCode).toBe(0);
  });
});

const digestOf = (tips: Record<string, string>): string => tipsDigest(tips);
const DG_NONE = digestOf({});
const DG_TIPS = digestOf({ n1: "a".repeat(40), n2: "b".repeat(64) });

const LOSS = {
  nodeId: "c1",
  aheadCommits: 2,
  untrustedSubjects: ["機能を足す", "テストを足す"],
  uncommitted: true,
  untracked: 3,
};
const previewOf = (loss?: unknown[], tips?: unknown) =>
  ok({
    reclaimable: false,
    unmet: ["discardRequired"],
    blockers: [],
    ...(loss === undefined ? {} : { loss }),
    ...(tips === undefined ? {} : { tips }),
  });

describe("reclaim（FR_029・T21r: 失われるものを表示してから、破棄を指示する）", () => {
  it("M2: --yes は --expect が要る。表示（--yes なし）には、照合の値と、そのまま使える再実行の案内が出る。送るのは表示の要求だけ", async () => {
    const { client, sent } = fakeClient({
      "node.reclaimPreview": previewOf([LOSS], { n1: "a".repeat(40), n2: "b".repeat(64) }),
    });
    const shownOnly = await runCommand(["reclaim", "n1"], deps(client));
    expect(shownOnly.stdout).toContain(DG_TIPS);
    expect(shownOnly.stderr).toContain(`--yes --expect ${DG_TIPS}`);
    const noExpect = await runCommand(["reclaim", "n1", "--yes"], deps(client));
    expect(noExpect.exitCode).toBe(2);
    expect(noExpect.stderr).toContain("--expect");
    expect(ops(sent)).toEqual(["node.reclaimPreview", "node.reclaimPreview"]);
  });

  it("M2: 照合の値は 12 桁の 16 進で、先端・ノード ID のどちらが変わっても変わり、並び順に依存しない", () => {
    const a = { n1: "a".repeat(40), n2: "b".repeat(40) };
    expect(tipsDigest(a)).toMatch(/^[0-9a-f]{12}$/);
    expect(tipsDigest({ n2: a.n2, n1: a.n1 })).toBe(tipsDigest(a));
    expect(tipsDigest({ ...a, n2: "c".repeat(40) })).not.toBe(tipsDigest(a));
    expect(tipsDigest({ n1: a.n1, n3: a.n2 })).not.toBe(tipsDigest(a));
  });

  it("M2: 表示のあとで先端が変わり、照合の値が違うなら、指示せずに終了コード 1（新しい値を案内する）", async () => {
    const { client, sent } = fakeClient({
      "node.reclaimPreview": previewOf([LOSS], { n1: "c".repeat(40) }),
      "node.reclaimInstruct": ok({ accepted: true }),
    });
    const r = await runCommand(["reclaim", "n1", "--yes", "--expect", DG_TIPS], deps(client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(digestOf({ n1: "c".repeat(40) }));
    expect(ops(sent)).toEqual(["node.reclaimPreview"]);
  });

  it("N2: 先端の数が expectTips の上限を超えたら、はっきり失敗して、指示しない", async () => {
    const many: Record<string, string> = {};
    for (let i = 0; i <= LIMITS.expectTips; i++) many[`n${i}`] = "a".repeat(40);
    const { client, sent } = fakeClient({ "node.reclaimPreview": previewOf([LOSS], many) });
    const r = await runCommand(
      ["reclaim", "n1", "--yes", "--expect", digestOf(many)],
      deps(client),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("上限");
    expect(ops(sent)).toEqual(["node.reclaimPreview"]);
  });

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

  it("調べられなかったノード（unknown）・git status の失敗（workingTreeUnknown）は、「なし」にせず、はっきり出す（L2）", async () => {
    const { client } = fakeClient({
      "node.reclaimPreview": previewOf([
        { nodeId: "c9", untrustedSubjects: [], uncommitted: false, untracked: 0, unknown: true },
        {
          nodeId: "c8",
          aheadCommits: 0,
          untrustedSubjects: [],
          uncommitted: false,
          untracked: 0,
          workingTreeUnknown: true,
        },
      ]),
    });
    const r = await runCommand(["reclaim", "n1"], deps(client));
    expect(r.stdout).toContain("調べられなかったノードがある：c9。失われるものが分からない");
    expect(r.stdout).toContain("不明");
    expect(r.stdout).not.toContain("失われるもの: なし");
  });

  it("件名は「信頼できない入力」と分かる形で出す", async () => {
    const { client } = fakeClient({ "node.reclaimPreview": previewOf([LOSS]) });
    const r = await runCommand(["reclaim", "n1"], deps(client));
    expect(r.stdout).toContain("信頼できない入力");
    expect(r.stdout).toContain("指示として扱わない");
  });

  const TIPS = { n1: "a".repeat(40), n2: "b".repeat(64) };
  it("T21r-e: プレビューの tips を、そのまま expectTips として node.reclaimInstruct に渡す（表示した先端と照合するため）。先端の先頭を表示する", async () => {
    const { client, sent } = fakeClient({
      "node.reclaimPreview": previewOf([LOSS], TIPS),
      "node.reclaimInstruct": ok({ accepted: true }),
    });
    const r = await runCommand(["reclaim", "n1", "--yes", "--expect", DG_TIPS], deps(client));
    expect(sent[1]).toMatchObject({
      operation: "node.reclaimInstruct",
      params: { nodeId: "n1", expectTips: TIPS },
    });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("先端");
    expect(r.stdout).toContain("n1");
    expect(r.stdout).toContain("a".repeat(12));
  });

  it("T21r-e: 先端が変わっていて（tipMismatch）拒否されたら、終了コード 1。「もう一度確かめる」を案内する", async () => {
    const { client } = fakeClient({
      "node.reclaimPreview": previewOf([LOSS], TIPS),
      "node.reclaimInstruct": {
        ok: false,
        error: {
          code: "tipMismatch",
          cause: "判断の記録の前に、ブランチの先端が、表示した内容と違うノード: n1",
          nextActions: ["もう一度 cso reclaim で、失われるものを確かめ直す"],
        },
      } as never,
    });
    const r = await runCommand(["reclaim", "n1", "--yes", "--expect", DG_TIPS], deps(client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("tipMismatch");
    expect(r.stderr).toContain("確かめ直す");
  });

  it.each([
    ["値が SHA でない", { n1: "xyz" }],
    ["値が文字列でない", { n1: 5 }],
    ["配列", ["a".repeat(40)]],
    ["null", null],
  ])(
    "T21r-e: プレビューの tips が不正（%s）なら、指示を送らない（結果を確認できない扱い）",
    async (_n, bad) => {
      const { client, sent } = fakeClient({
        "node.reclaimPreview": previewOf([LOSS], bad),
        "node.reclaimInstruct": ok({ accepted: true }),
      });
      const r = await runCommand(["reclaim", "n1", "--yes", "--expect", DG_NONE], deps(client));
      expect(ops(sent)).toEqual(["node.reclaimPreview"]);
      expect(r.exitCode).not.toBe(0);
    },
  );

  it("--yes があれば、表示してから node.reclaimInstruct を送り、requestId を表示する", async () => {
    const { client, sent } = happy();
    const r = await runCommand(["reclaim", "n1", "--yes", "--expect", DG_NONE], deps(client));
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
        params: { nodeId: "n1", expectTips: {} }, // プレビューに tips がなければ、空
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
    const r = await runCommand(["reclaim", "n1", "--yes", "--expect", DG_NONE], deps(client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("notFound");
    expect(ops(sent)).toEqual(["node.reclaimPreview"]);
  });

  it("preview の形が不正なら、結果が確認できない扱いで、指示しない", async () => {
    const { client, sent } = fakeClient({ "node.reclaimPreview": ok({ reclaimable: "yes" }) });
    const r = await runCommand(["reclaim", "n1", "--yes", "--expect", DG_NONE], deps(client));
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
    const r = await runCommand(["purge", "n1", "--yes", "--expect", NODES_DG], deps(client));
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
    const r = await runCommand(["purge", "n1", "--yes", "--expect", NODES_DG], deps(client));
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
    const r = await runCommand(["reclaim", "n1", "--yes", "--expect", DG_NONE], deps(client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("確認できない");
  });

  it("--request-id を渡すと、その識別子で要求する（再実行）", async () => {
    const { client, sent } = happy();
    await runCommand(
      ["purge", "n1", "--yes", "--expect", NODES_DG, "--request-id", "retry-7"],
      deps(client),
    );
    expect(sent.every((s) => s.requestId === "retry-7")).toBe(true);
  });

  it("--request-id の値が無い・不正なら拒否する", async () => {
    for (const argv of [
      ["reclaim", "n1", "--yes", "--expect", DG_NONE, "--request-id"],
      ["reclaim", "n1", "--yes", "--expect", DG_NONE, "--request-id", "a b"],
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
    const r = await runCommand(["reclaim", "n1", "--yes", "--expect", DG_NONE], deps(client));
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
          const r = await runCommand(["reclaim", id, "--yes", "--expect", DG_NONE], deps(client));
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
        const r = await runCommand(
          ["reclaim", "n1", "--yes", "--expect", DG_NONE, "--request-id", rid],
          deps(client),
        );
        expect(r.exitCode === 0).toBe(isSafeId(rid));
        expect(sent.length === 2).toBe(isSafeId(rid));
      }),
    );
  });
});

describe("cso purge の照合（T23-d2。--yes には --expect）", () => {
  it("表示（--yes なし・--dry-run）に、照合の値と、そのまま使える再実行の案内が出る。node.purge は呼ばない", async () => {
    const a = happy();
    const shown = await runCommand(["purge", "n1"], deps(a.client));
    expect(shown.exitCode).toBe(2);
    expect(shown.stdout).toContain(NODES_DG);
    expect(shown.stderr).toContain(`cso purge n1 --yes --expect ${NODES_DG}`);
    const b = happy();
    const dry = await runCommand(["purge", "n1", "--dry-run"], deps(b.client));
    expect(dry.stdout).toContain(NODES_DG);
    expect(ops(a.sent)).toEqual(["node.purgePreview"]);
    expect(ops(b.sent)).toEqual(["node.purgePreview"]);
  });

  it("--yes に --expect がなければ、終了コード 2（削除しない）", async () => {
    const { client, sent } = happy();
    const r = await runCommand(["purge", "n1", "--yes"], deps(client));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("--expect");
    expect(r.stderr).toContain(NODES_DG);
    expect(ops(sent)).toEqual(["node.purgePreview"]);
  });

  it("取り直した事前確認の値が違えば（表示のあとで木が変わった）、何も削除せずに終了コード 1。新しい値を案内する", async () => {
    const { client, sent } = happy();
    const r = await runCommand(["purge", "n1", "--yes", "--expect", "000000000000"], deps(client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain(NODES_DG);
    expect(ops(sent)).toEqual(["node.purgePreview"]);
  });

  it("照合の値は、12 桁の 16 進で、ノードの順序に依存せず、ノードが変われば変わる", () => {
    expect(NODES_DG).toMatch(/^[0-9a-f]{12}$/);
    expect(nodeIdsDigest(["n2", "n1"])).toBe(NODES_DG);
    expect(nodeIdsDigest(["n1"])).not.toBe(NODES_DG);
    expect(nodeIdsDigest(["n1", "n3"])).not.toBe(NODES_DG);
  });

  it("R1: ノードが 2000 件を超える木は、daemon の照合（expectNodeIds）を省いて送る。--expect の照合は残り、省いたことを出力する", async () => {
    const many = Array.from({ length: LIMITS.expectNodeIds + 1 }, (_, i) => `n${i}`);
    const { client, sent } = fakeClient({
      "node.purgePreview": ok({ ...PREVIEW, nodeIds: many }),
      "node.purge": ok({ purged: many }),
    });
    const r = await runCommand(
      ["purge", "n0", "--yes", "--expect", nodeIdsDigest(many)],
      deps(client),
    );
    expect(r.exitCode).toBe(0);
    expect(sent.at(-1)?.operation).toBe("node.purge");
    expect(sent.at(-1)?.params).toEqual({ nodeId: "n0" });
    expect(r.stderr).toContain("expectNodeIds");
    expect(r.stderr).toContain("省いた");
    // --expect が違えば、削除しない（取り直した事前確認との照合は、2000 件超でも働く）
    const bad = fakeClient({
      "node.purgePreview": ok({ ...PREVIEW, nodeIds: many }),
      "node.purge": ok({ purged: many }),
    });
    const b = await runCommand(
      ["purge", "n0", "--yes", "--expect", "000000000000"],
      deps(bad.client),
    );
    expect(b.exitCode).toBe(1);
    expect(ops(bad.sent)).toEqual(["node.purgePreview"]);
    // ちょうど 2000 件は、daemon の照合つき
    const exact = Array.from({ length: LIMITS.expectNodeIds }, (_, i) => `n${i}`);
    const e = fakeClient({
      "node.purgePreview": ok({ ...PREVIEW, nodeIds: exact }),
      "node.purge": ok({ purged: exact }),
    });
    const er = await runCommand(
      ["purge", "n0", "--yes", "--expect", nodeIdsDigest(exact)],
      deps(e.client),
    );
    expect(er.exitCode).toBe(0);
    const lastParams = e.sent.at(-1)?.params as { expectNodeIds?: string[] } | undefined;
    expect(lastParams?.expectNodeIds).toHaveLength(2000);
    expect(er.stderr).toBe("");
  });

  it("R2: --request-id を指定した再実行で、事前確認が notFound なら、前回の実行が成功して木が消えた可能性を案内する（事前確認は飛ばさない）。指定しなければ、これまでどおり", async () => {
    const notFound = {
      ok: false,
      error: { code: "notFound", cause: "ノードが見つからない", nextActions: ["ID を確認する"] },
    } as never;
    const a = fakeClient({ "node.purgePreview": notFound, "node.purge": ok({ purged: [] }) });
    const r = await runCommand(
      ["purge", "n1", "--yes", "--expect", NODES_DG, "--request-id", "retry-1"],
      deps(a.client),
    );
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("前回の実行が成功して");
    expect(r.stderr).toContain("cso discarded list");
    expect(r.stderr).toContain("ID を確認する");
    expect(ops(a.sent)).toEqual(["node.purgePreview"]); // 事前確認を飛ばす経路はない。node.purge は呼ばない
    const b = fakeClient({ "node.purgePreview": notFound });
    const plain = await runCommand(["purge", "n1", "--yes", "--expect", NODES_DG], deps(b.client));
    expect(plain.stderr).not.toContain("前回の実行が成功して");
    // notFound 以外の失敗は、案内を足さない
    const c = fakeClient({
      "node.purgePreview": {
        ok: false,
        error: { code: "forbidden", cause: "x", nextActions: ["y"] },
      } as never,
    });
    const other = await runCommand(
      ["purge", "n1", "--yes", "--expect", NODES_DG, "--request-id", "retry-2"],
      deps(c.client),
    );
    expect(other.stderr).not.toContain("前回の実行が成功して");
  });

  it("N2: --yes なしで --expect を渡したときは、表示だけで、実行には --yes が要ると出す（reclaim も）", async () => {
    const a = happy();
    const r = await runCommand(["purge", "n1", "--expect", NODES_DG], deps(a.client));
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("表示だけ（実行には --yes が要る）");
    expect(ops(a.sent)).toEqual(["node.purgePreview"]);
    const plain = await runCommand(["purge", "n1"], deps(happy().client));
    expect(plain.stderr).not.toContain("表示だけ");
    const f = fakeClient({ "node.reclaimPreview": previewOf([LOSS]) });
    const rr = await runCommand(["reclaim", "n1", "--expect", DG_NONE], deps(f.client));
    expect(rr.exitCode).toBe(2);
    expect(rr.stderr).toContain("表示だけ（実行には --yes が要る）");
  });

  it("R4: 照合の値は固定（以前の並べ方・畳み方から変えない）。reclaim は ID 順の id:SHA、purge は ID 順の id。ID の記号の並び（- . :）も固定", () => {
    expect(tipsDigest({ n1: "a".repeat(40), n2: "b".repeat(64) })).toBe("ab9fac302398");
    expect(
      tipsDigest({
        "a-b": "c".repeat(40),
        a: "d".repeat(40),
        "a.b": "e".repeat(40),
        "a:b": "f".repeat(40),
      }),
    ).toBe("4b1d102e93ff");
    expect(nodeIdsDigest(["n1", "n2"])).toBe("1838b884792c");
    expect(nodeIdsDigest(["a-b", "a", "a.b", "a:b"])).toBe("0d4122142225");
    expect(tipsDigest({})).toBe(tipsDigest(undefined));
  });
});

describe("cso purge-hold --days（T23-d2・T23-d3）", () => {
  it("--days は、days を送る（until は送らない。期限は daemon の時計で決める）。結果に、daemon が決めた期限が出る", async () => {
    const { client, sent } = fakeClient({
      "node.purgeHold": ok({ held: true, until: "2026-11-22T12:00:00Z" }),
    });
    const r = await runCommand(
      ["purge-hold", "t", "--days", "30", "--reason", "調査"],
      deps(client),
    );
    expect(sent[0]?.params).toEqual({ nodeId: "t", days: 30, reason: "調査" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("2026-11-22T12:00:00Z");
  });

  it("365 日も、そのまま送る（端末の時計で、10 分短くしない）", async () => {
    const { client, sent } = fakeClient({ "node.purgeHold": ok({ held: true }) });
    await runCommand(["purge-hold", "t", "--days", "365"], deps(client));
    expect(sent[0]?.params).toEqual({ nodeId: "t", days: 365 });
  });

  it.each([["0"], ["366"], ["1.5"], ["-1"], ["abc"], ["１０"], ["0030x"], ["1000"]])(
    "--days %j は範囲外・不正で、終了コード 2（窓口を呼ばない）",
    async (v) => {
      const { client, sent } = fakeClient({ "node.purgeHold": ok({ held: true }) });
      const r = await runCommand(["purge-hold", "t", "--days", v], deps(client));
      expect(r.exitCode).toBe(2);
      expect(sent).toEqual([]);
    },
  );

  it("--until と --days の併用は、終了コード 2", async () => {
    const { client, sent } = fakeClient({ "node.purgeHold": ok({ held: true }) });
    const r = await runCommand(
      ["purge-hold", "t", "--until", "2026-12-01T00:00:00Z", "--days", "30"],
      deps(client),
    );
    expect(r.exitCode).toBe(2);
    expect(sent).toEqual([]);
  });

  it("結果が確認できないとき、再実行の案内は、同じコマンド（--days のまま）。同じ requestId の再送で、最初の期限が返る", async () => {
    const boom = () => {
      throw new Error("ECONNRESET");
    };
    const { client } = fakeClient({ "node.purgeHold": boom });
    const r = await runCommand(["purge-hold", "t", "--days", "30"], deps(client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("--days '30'");
    expect(r.stderr).not.toContain("--until");
  });
});

describe("purge-hold・purge-release（自動の最終削除の保留。T13f-h）", () => {
  const heldClient = () =>
    fakeClient({
      "node.purgeHold": ok({ held: true, until: "2026-12-01T00:00:00Z" }),
      "node.purgeRelease": ok({ released: true }),
    });

  it("purge-hold は、node.purgeHold を送る（--until・--reason つき）。結果と期限を表示する", async () => {
    const { client, sent } = heldClient();
    const r = await runCommand(
      ["purge-hold", "t", "--until", "2026-12-01T00:00:00Z", "--reason", "調査中"],
      deps(client),
    );
    expect(sent).toEqual([
      {
        requestId: "req-1",
        role: "human",
        operation: "node.purgeHold",
        params: { nodeId: "t", until: "2026-12-01T00:00:00Z", reason: "調査中" },
      },
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("2026-12-01T00:00:00Z");
    expect(r.stdout).toContain("req-1");
  });

  it("オプションなしは、無期限の保留", async () => {
    const { client, sent } = fakeClient({ "node.purgeHold": ok({ held: true }) });
    const r = await runCommand(["purge-hold", "t"], deps(client));
    expect(sent[0]?.params).toEqual({ nodeId: "t" });
    expect(r.stdout).toContain("無期限");
  });

  it("値のないオプション・未知のオプションは、終了コード 2", async () => {
    const { client, sent } = heldClient();
    expect((await runCommand(["purge-hold", "t", "--until"], deps(client))).exitCode).toBe(2);
    expect((await runCommand(["purge-hold", "t", "--yes"], deps(client))).exitCode).toBe(2);
    expect((await runCommand(["purge-release", "t", "--until", "x"], deps(client))).exitCode).toBe(
      2,
    );
    expect(sent).toEqual([]);
  });

  it("失敗は、原因と次の操作を出す。結果が確認できなければ、同じ requestId で再実行する手順を出す", async () => {
    const f = fakeClient({
      "node.purgeHold": err(failure("notPurgeRoot", "木の根でない", "予告の木の根を指定する")),
    });
    const r = await runCommand(["purge-hold", "c"], deps(f.client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("木の根でない");
    const bad = fakeClient({ "node.purgeHold": ok({ unexpected: 1 }) });
    const u = await runCommand(["purge-hold", "t", "--reason", "a b"], deps(bad.client));
    expect(u.exitCode).toBe(1);
    expect(u.stderr).toContain("cso purge-hold t --reason 'a b' --request-id req-1");
  });

  it("hook-unbind は、node.hookUnbind を送り、外したか・なかったかを表示する（T22-hu）", async () => {
    const a = fakeClient({ "node.hookUnbind": ok({ unbound: true, duplicate: false }) });
    const r = await runCommand(["hook-unbind", "a"], deps(a.client));
    expect(ops(a.sent)).toEqual(["node.hookUnbind"]);
    expect(a.sent[0]?.params).toEqual({ nodeId: "a" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("外した");
    const b = fakeClient({ "node.hookUnbind": ok({ unbound: false, duplicate: false }) });
    expect((await runCommand(["hook-unbind", "a"], deps(b.client))).stdout).toContain("なかった");
    expect((await runCommand(["hook-unbind", "a", "--yes"], deps(b.client))).exitCode).toBe(2);
    const c = fakeClient({ "node.hookUnbind": ok({ unbound: false, duplicate: true }) });
    const again = await runCommand(["hook-unbind", "a", "--request-id", "r-1"], deps(c.client));
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toContain("すでに記録済み（再送");
    expect(again.stdout).not.toContain("なかった");
  });

  it("hook-env は、標準出力が端末でないときだけ、node.hookToken を呼んで eval 用の 2 行を出す（T22-ht）", async () => {
    const TOKEN = "TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT";
    const a = fakeClient({
      "node.hookToken": ok({ token: TOKEN, nodeId: "a", daemonUrl: "http://127.0.0.1:7777" }),
    });
    const r = await runCommand(["hook-env", "a"], {
      ...deps(a.client),
      isTTY: { stdin: true, stdout: false },
    });
    expect(ops(a.sent)).toEqual(["node.hookToken"]);
    expect(a.sent[0]?.params).toEqual({ nodeId: "a" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe(
      `export CSO_DAEMON_URL='http://127.0.0.1:7777'\nexport CSO_NODE_TOKEN='${TOKEN}'\n`,
    );
    expect(r.stderr).not.toContain(TOKEN);
  });

  it("hook-env は、標準出力が端末か、分からないときは、daemon を呼ばずに失敗する（トークンを発行しない・出さない）", async () => {
    for (const tty of [true, undefined]) {
      const a = fakeClient({});
      const r = await runCommand(["hook-env", "a"], {
        ...deps(a.client),
        ...(tty === undefined ? {} : { isTTY: { stdin: true, stdout: tty } }),
      });
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toBe("");
      expect(r.stderr).toContain('eval "$(cso hook-env a)"');
      expect(a.sent).toEqual([]);
    }
  });

  it("hook-env は、形の違う応答（引用符を含むトークン・ループバックでない URL）を出さない", async () => {
    for (const value of [
      { token: "x'; rm -rf ~; '", nodeId: "a", daemonUrl: "http://127.0.0.1:7777" },
      {
        token: "TTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTTT",
        nodeId: "a",
        daemonUrl: "http://evil.example:80",
      },
    ]) {
      const a = fakeClient({ "node.hookToken": ok(value) });
      const r = await runCommand(["hook-env", "a"], {
        ...deps(a.client),
        isTTY: { stdin: true, stdout: false },
      });
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toBe("");
    }
  });

  it("purge-release は、node.purgeRelease を送る", async () => {
    const { client, sent } = heldClient();
    const r = await runCommand(["purge-release", "t"], deps(client));
    expect(ops(sent)).toEqual(["node.purgeRelease"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("解除");
  });

  it("purge の対象表示に、有効な保留（期限・理由）が出る。--yes では、保留を無視して削除を実行する", async () => {
    const { client, sent } = fakeClient({
      "node.purgePreview": ok({
        ...PREVIEW,
        hold: { until: "2026-12-01T00:00:00Z", reason: "調査中\u001b[2J" },
      }),
      "node.purge": ok({ purged: ["n1", "n2"] }),
    });
    const dry = await runCommand(["purge", "n1", "--dry-run"], deps(client));
    expect(dry.stdout).toContain("保留中");
    expect(dry.stdout).toContain("2026-12-01T00:00:00Z");
    expect(dry.stdout).toContain("調査中");
    expect(dry.stdout).not.toContain("\u001b");
    const yes = await runCommand(["purge", "n1", "--yes", "--expect", NODES_DG], deps(client));
    expect(yes.exitCode).toBe(0);
    expect(ops(sent)).toContain("node.purge");
  });
});

describe("discarded（保管した、破棄した成果。T13f-r）", () => {
  const LISTED = {
    max: 200,
    items: [
      {
        key: "k-c1",
        tip: "a".repeat(40),
        nodeId: "c1",
        orphan: false,
        committedAt: "2026-10-01T00:00:00+09:00",
        untrustedSubject: "捨てる成果\u001b[2J",
      },
      { key: "k-gone", tip: "b".repeat(40), orphan: true },
    ],
  };

  it("list: 一覧を出す（孤立も）。件名は信頼できない入力と分かる形で、制御文字を除く", async () => {
    const { client, sent } = fakeClient({ "node.discardedList": ok(LISTED) });
    const r = await runCommand(["discarded", "list"], deps(client));
    expect(ops(sent)).toEqual(["node.discardedList"]);
    expect(r.exitCode).toBe(0);
    for (const s of [
      "k-c1",
      "c1",
      "（孤立）",
      "k-gone",
      "信頼できない入力",
      "捨てる成果",
      "2 件",
      "200",
    ]) {
      expect(r.stdout).toContain(s);
    }
    expect(r.stdout).not.toContain("\u001b");
  });

  it("list: 空なら「なし」。引数があれば終了コード 2", async () => {
    const { client } = fakeClient({ "node.discardedList": ok({ items: [], max: 200 }) });
    expect((await runCommand(["discarded", "list"], deps(client))).stdout).toContain("なし");
    expect((await runCommand(["discarded", "list", "x"], deps(client))).exitCode).toBe(2);
    expect((await runCommand(["discarded"], deps(client))).exitCode).toBe(2);
    expect((await runCommand(["discarded", "nope"], deps(client))).exitCode).toBe(2);
  });

  it("restore: node.discardedRestore を送る（--branch つき）。ブランチと、保管が残ることを表示する", async () => {
    const { client, sent } = fakeClient({
      "node.discardedRestore": ok({ branch: "my/b", tip: "a".repeat(40) }),
    });
    const r = await runCommand(["discarded", "restore", "c1", "--branch", "my/b"], deps(client));
    expect(sent).toEqual([
      {
        requestId: "req-1",
        role: "human",
        operation: "node.discardedRestore",
        params: { target: "c1", branch: "my/b" },
      },
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("my/b");
    expect(r.stdout).toContain("保管は残っている");
  });

  it("restore: 失敗（既存のブランチ）は、原因と次の操作を出す", async () => {
    const { client } = fakeClient({
      "node.discardedRestore": err(
        failure("branchExists", "ブランチがある", "--branch で別の名前"),
      ),
    });
    const r = await runCommand(["discarded", "restore", "c1"], deps(client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("ブランチがある");
  });

  it("drop: --yes がなければ、対象を表示して止まる（終了コード 2。消さない）。--yes で消す", async () => {
    const { client, sent } = fakeClient({
      "node.discardedList": ok(LISTED),
      "node.discardedDrop": ok({ dropped: true, key: "k-c1", tip: "a".repeat(40) }),
    });
    const dry = await runCommand(["discarded", "drop", "c1"], deps(client));
    expect(dry.exitCode).toBe(2);
    expect(dry.stdout).toContain("k-c1");
    expect(dry.stderr).toContain("--yes");
    expect(ops(sent)).toEqual(["node.discardedList"]);
    const done = await runCommand(["discarded", "drop", "c1", "--yes"], deps(client));
    expect(done.exitCode).toBe(0);
    expect(ops(sent)).toEqual(["node.discardedList", "node.discardedList", "node.discardedDrop"]);
    expect(sent.at(-1)?.params).toEqual({ target: "k-c1", expectTip: "a".repeat(40) }); // 表示した先端を渡す。鍵で指定する
  });

  it("drop: 一覧にないものは、notFound（消す要求を送らない）", async () => {
    const { client, sent } = fakeClient({ "node.discardedList": ok(LISTED) });
    const r = await runCommand(["discarded", "drop", "zzz", "--yes"], deps(client));
    expect(r.exitCode).toBe(1);
    expect(ops(sent)).toEqual(["node.discardedList"]);
  });

  it("purge の対象表示に、一緒に消える、保管している成果の数を出す（0 件・なしのときは出さない）", async () => {
    const { client } = fakeClient({
      "node.purgePreview": ok({ ...PREVIEW, discardedRefs: 3 }),
    });
    const r = await runCommand(["purge", "n1", "--dry-run"], deps(client));
    expect(r.stdout).toContain("保管している、破棄した成果");
    expect(r.stdout).toContain("3 件");
    const zero = fakeClient({ "node.purgePreview": ok({ ...PREVIEW, discardedRefs: 0 }) });
    expect(
      (await runCommand(["purge", "n1", "--dry-run"], deps(zero.client))).stdout,
    ).not.toContain("保管している、破棄した成果");
  });
});

describe("discarded（T13f-r レビュー）", () => {
  const two = {
    max: 5,
    items: [
      { key: "k-c1", tip: "a".repeat(40), nodeId: "c1", orphan: false },
      { key: `k-c1.${"b".repeat(12)}`, tip: "b".repeat(40), nodeId: "c1", orphan: false },
    ],
  };

  it("R3: 1 つのノードに保管が複数あるとき、ノード ID の drop は multipleKept で失敗する（消さない）。鍵を指定すれば消せる", async () => {
    const { client, sent } = fakeClient({
      "node.discardedList": ok(two),
      "node.discardedDrop": ok({ dropped: true, key: "k-c1", tip: "a".repeat(40) }),
    });
    const many = await runCommand(["discarded", "drop", "c1", "--yes"], deps(client));
    expect(many.exitCode).toBe(1);
    expect(many.stderr).toContain("multipleKept");
    expect(many.stderr).toContain("k-c1");
    expect(ops(sent)).not.toContain("node.discardedDrop");
    const byKey = await runCommand(["discarded", "drop", "k-c1", "--yes"], deps(client));
    expect(byKey.exitCode).toBe(0);
    expect(sent.at(-1)?.params).toEqual({ target: "k-c1", expectTip: "a".repeat(40) });
  });

  it("R5: list の末尾に、残りの件数（上限 − 現在の数）を出す", async () => {
    const { client } = fakeClient({ "node.discardedList": ok(two) });
    const r = await runCommand(["discarded", "list"], deps(client));
    expect(r.stdout).toContain("残り 3 件");
  });
});

describe("accept（人間の受理。T21-cw）", () => {
  it("node.review（verdict: accept）を送り、結果の状態と requestId を出す。オプションは受け付けない", async () => {
    const { client, sent } = fakeClient({ "node.review": ok({ state: "verified" }) });
    const r = await runCommand(["accept", "a"], deps(client));
    expect(sent).toEqual([
      {
        requestId: "req-1",
        role: "human",
        operation: "node.review",
        params: { nodeId: "a", verdict: "accept" },
      },
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("verified");
    expect(r.stdout).toContain("req-1");
    const bad = fakeClient({});
    expect((await runCommand(["accept", "a", "--note", "x"], deps(bad.client))).exitCode).toBe(2);
    expect(bad.sent).toEqual([]);
  });
});

describe("confirm-stopped（停止の宣言。T22d）", () => {
  it("node.confirmStopped を送る（--note つき・なし）。結果の状態と requestId を出す", async () => {
    const { client, sent } = fakeClient({ "node.confirmStopped": ok({ state: "stopped" }) });
    const r = await runCommand(["confirm-stopped", "a", "--note", "アーカイブした"], deps(client));
    expect(sent).toEqual([
      {
        requestId: "req-1",
        role: "human",
        operation: "node.confirmStopped",
        params: { nodeId: "a", note: "アーカイブした" },
      },
    ]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("stopped");
    expect(r.stdout).toContain("req-1");
    const plain = fakeClient({ "node.confirmStopped": ok({ state: "stopped" }) });
    await runCommand(["confirm-stopped", "a"], deps(plain.client));
    expect(plain.sent[0]?.params).toEqual({ nodeId: "a" });
  });

  it("--note の長さ超え・空白だけ・制御文字・値なし・未知のオプションは、終了コード 2（送らない）", async () => {
    const { client, sent } = fakeClient({ "node.confirmStopped": ok({ state: "stopped" }) });
    for (const argv of [
      ["confirm-stopped", "a", "--note", "x".repeat(201)],
      ["confirm-stopped", "a", "--note", "  "],
      ["confirm-stopped", "a", "--note", "a\u0007b"],
      ["confirm-stopped", "a", "--note", "一行目\n二行目"],
      ["confirm-stopped", "a", "--note", "a\tb"],
      ["confirm-stopped", "a", "--note", "a\u202eb"],
      ["confirm-stopped", "a", "--note"],
      ["confirm-stopped", "a", "--yes"],
      ["confirm-stopped"],
    ]) {
      expect((await runCommand(argv, deps(client))).exitCode, JSON.stringify(argv)).toBe(2);
    }
    expect(sent).toEqual([]);
  });

  it("失敗（notDelegated など）は原因と次の操作を出す。結果が確認できなければ、同じ requestId での再実行を案内する", async () => {
    const f = fakeClient({
      "node.confirmStopped": err(
        failure("notDelegated", "daemon が直接止めるノード", "node.stop で停止を再試行する"),
      ),
    });
    const r = await runCommand(["confirm-stopped", "a"], deps(f.client));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("notDelegated");
    expect(r.stderr).toContain("node.stop");
    const bad = fakeClient({ "node.confirmStopped": ok({ unexpected: 1 }) });
    const u = await runCommand(["confirm-stopped", "a", "--note", "a b"], deps(bad.client));
    expect(u.exitCode).toBe(1);
    expect(u.stderr).toContain("cso confirm-stopped a --note 'a b' --request-id req-1");
  });

  it("根拠は、前後の空白を削り、連続する空白を 1 つにして送る（画面と同じ）", async () => {
    const { client, sent } = fakeClient({ "node.confirmStopped": ok({ state: "stopped" }) });
    await runCommand(["confirm-stopped", "a", "--note", "  アーカイブ   した "], deps(client));
    expect(sent[0]?.params).toEqual({ nodeId: "a", note: "アーカイブ した" });
  });

  it("--request-id を渡すと、その識別子で送る（再実行）", async () => {
    const { client, sent } = fakeClient({ "node.confirmStopped": ok({ state: "stopped" }) });
    await runCommand(["confirm-stopped", "a", "--request-id", "again-1"], deps(client));
    expect(sent[0]?.requestId).toBe("again-1");
  });
});
