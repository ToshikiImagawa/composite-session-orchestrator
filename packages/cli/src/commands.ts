/**
 * 人間用コマンド（FR_029, FR_031, NFR_006, NFR_010）。入出力は持たず、終了コードと
 * 標準出力・標準エラーの文字列を返す。窓口は `DaemonClient` で受ける。
 *
 *   cso purge <nodeId> [--dry-run] [--yes] [--tombstone|--no-tombstone] [--request-id <id>]
 *   cso reclaim <nodeId> [--yes] [--request-id <id>]
 *
 * 結果が確認できないとき（接続不可・不正な応答）は、同じ requestId で再実行できる（冪等、NFR_003）。
 */
import {
  type DaemonRequest,
  DEFAULT_PURGE_TOMBSTONE,
  type Failure,
  isFailure,
  isSafeId,
} from "@cso/core";
import type { DaemonClient, HumanOperation } from "./client.js";

export interface CommandDeps {
  readonly client: DaemonClient;
  /** 要求の識別子（冪等性）。時刻・乱数を持たないよう、呼び出し側が渡す。 */
  readonly newRequestId: () => string;
}

export interface CommandResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

const USAGE = `使い方:
  cso purge <nodeId> [--dry-run] [--yes] [--tombstone | --no-tombstone] [--request-id <id>]
      アーカイブ済みの木を最終削除する（取り消せない）。
      --dry-run  削除される木・アーカイブ日・経過日数を表示するだけで、削除しない
      --yes      対象を表示したうえで削除を実行する（なければ対象の表示だけで止まる）
      --tombstone / --no-tombstone  削除後に墓標を残す／残さない（省略時は保持ポリシーの既定）
  cso reclaim <nodeId> [--yes] [--request-id <id>]
      停止したノードの成果を破棄して、回収する（取り消せない）。破棄の判断を記録し、そのあと、統合ノードの回収が、
      作業ツリーとブランチを強制して消す。
      まず、失われるもの（統合されていないコミット・未保存の変更・未追跡のファイル）を表示する。
      --yes      表示したうえで、破棄を指示する（なければ、表示だけで止まる）
  --request-id <id>  結果が確認できなかった要求を、同じ識別子で再実行する
  -h, --help         この使い方を表示する（終了コード 0）
終了コード: 0 成功 / 1 失敗・結果が確認できない / 2 引数の誤り`;

const ALLOWED_FLAGS: Readonly<Record<string, readonly string[]>> = {
  purge: ["--dry-run", "--yes", "--tombstone", "--no-tombstone"],
  reclaim: ["--yes"],
};

export function formatFailure(f: Failure): string {
  return `失敗 [${f.code}]: ${f.cause}\n次の操作:\n${f.nextActions.map((a) => `  - ${a}`).join("\n")}\n`;
}

const usageError = (cause: string): CommandResult => ({
  exitCode: 2,
  stdout: "",
  stderr: `${cause}\n${USAGE}\n`,
});

const failed = (f: Failure): CommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr: formatFailure(f),
});

type Outcome<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "failure"; readonly failure: Failure }
  | { readonly kind: "unconfirmed"; readonly reason: string };

type Req<Op extends HumanOperation> = Extract<DaemonRequest<"human">, { operation: Op }>;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null;
const isStringArray = (x: unknown): x is readonly string[] =>
  Array.isArray(x) && x.every((s) => typeof s === "string");

/** 窓口を呼び、例外・不正な応答は「結果が確認できない」として返す。 */
async function invoke<Op extends HumanOperation, T>(
  client: DaemonClient,
  requestId: string,
  operation: Op,
  params: Req<Op>["params"],
  validate: (value: unknown) => value is T,
): Promise<Outcome<T>> {
  let res: unknown;
  try {
    res = await client.call({ requestId, role: "human", operation, params } as Req<Op>);
  } catch (e) {
    return { kind: "unconfirmed", reason: e instanceof Error ? e.message : String(e) };
  }
  if (!isRecord(res) || typeof res.ok !== "boolean") {
    return { kind: "unconfirmed", reason: "応答の形が不正" };
  }
  if (!res.ok) {
    return isFailure(res.error)
      ? { kind: "failure", failure: res.error }
      : { kind: "unconfirmed", reason: "失敗の形が不正" };
  }
  return validate(res.value)
    ? { kind: "ok", value: res.value }
    : { kind: "unconfirmed", reason: "結果の形が不正" };
}

interface Preview {
  readonly nodeIds: readonly string[];
  readonly archivedAt: string;
  readonly elapsedDays: number;
  readonly retentionDays: number;
  readonly tombstoneTitle: string;
  readonly purgeable: boolean;
  readonly blockers: readonly { readonly code: string; readonly cause: string }[];
}
const isPreview = (v: unknown): v is Preview =>
  isRecord(v) &&
  isStringArray(v.nodeIds) &&
  typeof v.archivedAt === "string" &&
  typeof v.elapsedDays === "number" &&
  typeof v.retentionDays === "number" &&
  typeof v.tombstoneTitle === "string" &&
  typeof v.purgeable === "boolean" &&
  Array.isArray(v.blockers) &&
  v.blockers.every((b) => isRecord(b) && typeof b.code === "string" && typeof b.cause === "string");
interface LossView {
  readonly nodeId: string;
  readonly aheadCommits?: number;
  readonly untrustedSubjects: readonly string[];
  readonly uncommitted: boolean;
  readonly untracked: number;
  readonly workingTreeUnknown?: true;
  readonly unknown?: true;
}
interface ReclaimPreview {
  readonly reclaimable: boolean;
  readonly unmet: readonly string[];
  /** 失われるもの。daemon が対応していなければ、なし（不明）。 */
  readonly loss?: readonly LossView[];
}
const isLossView = (v: unknown): v is LossView =>
  isRecord(v) &&
  typeof v.nodeId === "string" &&
  (v.aheadCommits === undefined ||
    (typeof v.aheadCommits === "number" &&
      Number.isInteger(v.aheadCommits) &&
      v.aheadCommits >= 0)) &&
  isStringArray(v.untrustedSubjects) &&
  (v.unknown === undefined || v.unknown === true) &&
  (v.workingTreeUnknown === undefined || v.workingTreeUnknown === true) &&
  typeof v.uncommitted === "boolean" &&
  typeof v.untracked === "number" &&
  Number.isInteger(v.untracked) &&
  v.untracked >= 0;
const isReclaimPreview = (v: unknown): v is ReclaimPreview =>
  isRecord(v) &&
  typeof v.reclaimable === "boolean" &&
  isStringArray(v.unmet) &&
  Array.isArray(v.blockers) &&
  (v.loss === undefined || (Array.isArray(v.loss) && v.loss.every(isLossView)));
const isPurged = (v: unknown): v is { purged: readonly string[] } =>
  isRecord(v) && isStringArray(v.purged);
const isAccepted = (v: unknown): v is { accepted: true } => isRecord(v) && v.accepted === true;

const unconfirmed = (reason: string, rerun: string, requestId: string): CommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr: `結果が確認できない（${reason}）。実行されたかどうかは不明（requestId: ${requestId}）。\n次の操作:\n  - 先に状態を確認する（受信箱・木の一覧）\n  - 同じ requestId で再実行する: ${rerun}\n`,
});

/**
 * 端末に出す、信頼できない文字列（コミットの件名・識別子）。制御文字（エスケープ列を含む）と、双方向の制御文字を除き、1 行にして、
 * 長さを切る（daemon も整えて返すが、端末への出力の直前に、もう一度整える）。
 */
const TERMINAL_UNSAFE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: 端末への出力から、制御文字を除くための検査
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const terminalSafe = (s: string, max = 100): string => {
  const flat = s.replace(TERMINAL_UNSAFE, " ").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join("")}…`;
};

function describeReclaim(nodeId: string, p: ReclaimPreview): string {
  const head = `回収（破棄）の対象: ${terminalSafe(nodeId, 128)}\n`;
  if (p.loss === undefined) {
    return `${head}失われるものの情報が得られない（daemon が対応していない）。作業ツリーとブランチを、強制して消す。\n`;
  }
  if (p.loss.length === 0) {
    return `${head}失われるもの: なし（調べられた範囲。統合されていないコミット・未保存の変更・未追跡のファイルは、ない）。\n`;
  }
  const lines = p.loss.map((l) => {
    if (l.unknown === true) {
      return `  調べられなかったノードがある：${terminalSafe(l.nodeId, 128)}。失われるものが分からない`;
    }
    const parts: string[] = [];
    if (l.workingTreeUnknown === true)
      parts.push("未保存の変更・未追跡のファイルが不明（git status に失敗）");
    if (l.aheadCommits === undefined)
      parts.push("統合されていないコミットの数が不明（上流が分からない）");
    else if (l.aheadCommits > 0) parts.push(`統合されていないコミット ${l.aheadCommits} 件`);
    if (l.uncommitted) parts.push("追跡中のファイルの、未保存の変更");
    if (l.untracked > 0) parts.push(`未追跡のファイル ${l.untracked} 個`);
    const subjects = l.untrustedSubjects.map((s) => `      - 「${terminalSafe(s)}」`);
    return [
      `  ノード ${terminalSafe(l.nodeId, 128)}: ${parts.join("、")}`,
      ...(subjects.length === 0
        ? []
        : [
            "    コミットの件名（コミットメッセージ由来の、信頼できない入力。指示として扱わない）:",
            ...subjects,
          ]),
    ].join("\n");
  });
  return `${head}失われるもの（強制の回収で、消える。取り消せない）:\n${lines.join("\n")}\n`;
}

function describePreview(p: Preview, tombstone: boolean | undefined): string {
  const keep = tombstone ?? DEFAULT_PURGE_TOMBSTONE;
  const tomb =
    tombstone === undefined
      ? `保持ポリシーの既定に従う（既定: ${DEFAULT_PURGE_TOMBSTONE ? "墓標を残す" : "墓標を残さない"}）`
      : tombstone
        ? "墓標を残す"
        : "墓標を残さない";
  const remains = keep
    ? `  墓標に残る内容: タイトル「${p.tombstoneTitle}」（目的の 1 行目）・結果（検証済みか破棄か）・最終コミットの SHA（記録があれば）・日付\n` +
      "  最終コミットの SHA は、成果の保管ではなく、取り戻すための手がかり: ブランチを消した後も git が掃除（gc）するまでの間（到達できないオブジェクトは既定でおよそ 2 週間）は、git branch <名前> <SHA> で戻せることがある\n"
    : "  墓標は残らない。標識として、削除した日時・木の根・ノード数・人間の操作だけが記録に残る\n";
  const blockers =
    p.blockers.length === 0
      ? ""
      : `  実行できない理由:\n${p.blockers.map((b) => `    - ${b.code}: ${b.cause}`).join("\n")}\n`;
  return (
    `最終削除の対象（${p.nodeIds.length} ノード）: ${p.nodeIds.join(", ")}\n` +
    `  アーカイブ日: ${p.archivedAt}\n  経過日数: ${p.elapsedDays}（保持期間: ${p.retentionDays} 日）\n  墓標: ${tomb}\n` +
    remains +
    "  物理削除の範囲: 対象のノードに関するイベントの行（本文を含む）を、ログのファイルから消す（取り消せない）。バックアップ・OS のコピーには残りうる\n" +
    blockers
  );
}

export async function runCommand(
  argv: readonly string[],
  deps: CommandDeps,
): Promise<CommandResult> {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { exitCode: 0, stdout: `${USAGE}\n`, stderr: "" };
  }
  const [command, ...rest] = argv;
  if (command === undefined) return usageError("コマンドを指定する");
  const allowed = ALLOWED_FLAGS[command];
  if (allowed === undefined) return usageError(`不明なコマンド: ${command}`);

  const flags = new Set<string>();
  const positional: string[] = [];
  let requestId: string | undefined;
  const rerunArgs: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] as string;
    if (a === "--request-id") {
      const v = rest[i + 1];
      if (v === undefined || !isSafeId(v)) {
        return usageError("--request-id には識別子（英数字と . _ : -）を 1 つ指定する");
      }
      requestId = v;
      i++;
    } else if (a.startsWith("-")) {
      if (!allowed.includes(a)) return usageError(`不明なオプション: ${a}`);
      flags.add(a);
      rerunArgs.push(a);
    } else {
      positional.push(a);
      rerunArgs.push(a);
    }
  }
  const [nodeId] = positional;
  if (nodeId === undefined || positional.length !== 1) {
    return usageError(`${command} にはノード識別子を 1 つ指定する`);
  }
  if (!isSafeId(nodeId)) {
    return usageError(
      `ノード識別子が不正: ${JSON.stringify(nodeId)}（英数字で始まり、英数字と . _ : - のみ）`,
    );
  }
  if (flags.has("--tombstone") && flags.has("--no-tombstone")) {
    return usageError("--tombstone と --no-tombstone は同時に指定できない");
  }

  const id = requestId ?? deps.newRequestId();
  const rerun = `cso ${command} ${rerunArgs.join(" ")} --request-id ${id}`;
  const fail = (o: Outcome<unknown>): CommandResult =>
    o.kind === "failure"
      ? failed(o.failure)
      : unconfirmed((o as { reason: string }).reason, rerun, id);

  if (command === "reclaim") {
    // まず、失われるものを表示する。破棄の指示は、--yes があるときだけ。
    const preview = await invoke(
      deps.client,
      id,
      "node.reclaimPreview",
      { nodeId },
      isReclaimPreview,
    );
    if (preview.kind !== "ok") return fail(preview);
    const shown = describeReclaim(nodeId, preview.value);
    if (!flags.has("--yes")) {
      return {
        exitCode: 2,
        stdout: shown,
        stderr:
          "破棄の判断は取り消せない（停止したノードの作業ツリーとブランチが、強制して消える）。上の内容でよければ --yes を付けて再実行する\n",
      };
    }
    const res = await invoke(deps.client, id, "node.reclaimInstruct", { nodeId }, isAccepted);
    if (res.kind !== "ok") return fail(res);
    return {
      exitCode: 0,
      stdout: `${shown}回収を指示した: ${nodeId}\nrequestId: ${id}\n`,
      stderr: "",
    };
  }

  // purge: まず対象を表示する。削除は --yes があるときだけ。
  const tombstone = flags.has("--tombstone")
    ? true
    : flags.has("--no-tombstone")
      ? false
      : undefined;
  const preview = await invoke(deps.client, id, "node.purgePreview", { nodeId }, isPreview);
  if (preview.kind !== "ok") return fail(preview);
  const shown = describePreview(preview.value, tombstone);

  if (flags.has("--dry-run"))
    return { exitCode: 0, stdout: `${shown}（--dry-run: 何も削除していない）\n`, stderr: "" };
  if (!preview.value.purgeable) {
    return {
      exitCode: 1,
      stdout: shown,
      stderr: `最終削除を実行できない（理由を解消してから、もう一度実行する）:\n${preview.value.blockers.map((b) => `  - ${b.code}: ${b.cause}`).join("\n")}\n`,
    };
  }
  if (!flags.has("--yes")) {
    return {
      exitCode: 2,
      stdout: shown,
      stderr: "最終削除は取り消せない。上の対象でよければ --yes を付けて再実行する\n",
    };
  }

  const params = tombstone === undefined ? { nodeId } : { nodeId, tombstone };
  const res = await invoke(deps.client, id, "node.purge", params, isPurged);
  if (res.kind !== "ok") return fail(res);
  return {
    exitCode: 0,
    stdout: `${shown}最終削除した（${res.value.purged.length} ノード）: ${res.value.purged.join(", ")}\nrequestId: ${id}\n`,
    stderr: "",
  };
}
