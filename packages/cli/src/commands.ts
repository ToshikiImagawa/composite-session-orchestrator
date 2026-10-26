/**
 * 人間用コマンド（FR_029, FR_031, NFR_006, NFR_010）。入出力は持たず、終了コードと
 * 標準出力・標準エラーの文字列を返す。窓口は `DaemonClient` で受ける。
 *
 *   cso purge <nodeId> [--dry-run] [--yes --expect <digest>] [--tombstone|--no-tombstone] [--request-id <id>]
 *   cso reclaim <nodeId> [--yes --expect <digest>] [--request-id <id>]
 *   cso purge-hold <nodeId> [--until <ISO 8601 UTC> | --days <1〜365>] [--reason <文>] [--request-id <id>]
 *   cso purge-release <nodeId> [--request-id <id>]
 *   cso confirm-stopped <nodeId> [--note <根拠>] [--request-id <id>]
 *   cso hook-unbind <nodeId> [--request-id <id>]
 *   eval "$(cso hook-env <nodeId>)"
 *   cso discarded list
 *   cso discarded restore <nodeId|key> [--branch <名前>] [--request-id <id>]
 *   cso discarded drop <nodeId|key> [--yes] [--request-id <id>]
 *
 * 結果が確認できないとき（接続不可・不正な応答）は、同じ requestId で再実行できる（冪等、NFR_003）。
 */
import {
  type DaemonRequest,
  DEFAULT_PURGE_TOMBSTONE,
  type Failure,
  isBoundedText,
  isFailure,
  isSafeId,
  LIMITS,
} from "@cso/core";
import type { DaemonClient, HumanOperation } from "./client.js";

export interface CommandDeps {
  readonly client: DaemonClient;
  /** 要求の識別子（冪等性）。時刻・乱数を持たないよう、呼び出し側が渡す。 */
  readonly newRequestId: () => string;
  /**
   * 端末に繋がっているか（実行ファイル〔T22-cli〕が `process.stdin.isTTY`・`process.stdout.isTTY` を渡す）。既存のコマンドは使わない。
   * `hook-env`（T22-ht）は、**省略されたときもトークンを出さない**（画面に出す経路を作らない。渡されて、標準出力が端末でないときだけ出す）。
   */
  readonly isTTY?: { readonly stdin: boolean; readonly stdout: boolean };
}

export interface CommandResult {
  readonly exitCode: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
}

const USAGE = `使い方:
  cso purge <nodeId> [--dry-run] [--yes --expect <digest>] [--tombstone | --no-tombstone] [--request-id <id>]
      アーカイブ済みの木を最終削除する（取り消せない）。
      --dry-run  削除される木・アーカイブ日・経過日数・照合の値を表示するだけで、削除しない
      --yes      対象を表示したうえで削除を実行する（なければ対象の表示だけで止まる）。--expect が要る
      --expect <digest>  表示した、削除される木の照合用の値（表示に出る 12 桁の 16 進）。実行の時点の木から計算し直した値と違えば、何も削除しない
      --tombstone / --no-tombstone  削除後に墓標を残す／残さない（省略時は保持ポリシーの既定）
  cso reclaim <nodeId> [--yes --expect <digest>] [--request-id <id>]
      停止したノードの成果を破棄して、回収する（取り消せない）。破棄の判断を記録し、そのあと、統合ノードの回収が、
      作業ツリーとブランチを強制して消す。
      まず、失われるもの（統合されていないコミット・未保存の変更・未追跡のファイル）を表示する。
      --yes      破棄を指示する（なければ、表示だけで止まる）。--expect が要る
      --expect <digest>  表示した先端の照合用の値（表示に出る 12 桁の 16 進）。指示の時点の先端から計算し直した値と違えば、何も指示しない
  cso purge-hold <nodeId> [--until <日時> | --days <日数>] [--reason <理由>] [--request-id <id>]
      自動の最終削除（autoPurge）を、この木について保留する。nodeId は、予告に出ている木の根（アーカイブ済みで、親がアーカイブされていないノード）。
      有効な予告は、その場で取り下げる。人間の cso purge は、保留に関係なく実行できる（保留を無視したことは監査に残る）。
      --until   保留の期限（ISO 8601 UTC。例: 2026-12-01T00:00:00Z。現在より後、365 日先まで）。省略すると無期限
      --days    保留の日数（1〜365 の整数。いまから数える。--until とは同時に指定できない。365 日のときは、時計のずれを見込んで 10 分短くする。実際の期限は、結果に出る）
      --reason  理由（200 文字まで）
  cso purge-release <nodeId> [--request-id <id>]
      保留を解除する。解除のあとは、予告から出し直し、そこから noticeDays 日たつまで消えない
  cso confirm-stopped <nodeId> [--note <根拠>] [--request-id <id>]
      daemon が直接止められないノード（Desktop の子。受信箱に停止の代行依頼が出ている）を、親が Desktop で止めた
      （またはアーカイブした）あとに、止めたと宣言する（取り消せない）。停止未完了から停止済みに進み、宣言した者（人間）と根拠が記録に残る。
      --note  根拠（200 文字まで。例: 「Desktop でアーカイブした」）
  cso hook-unbind <nodeId> [--request-id <id>]
      子のフック（plugin のファイルで設定するフック）の session_id の結び付けを外す。/clear・--resume で session_id が変わって、
      フックが拒否され続けるときに使う。次に来たセッションに結び直す。外した者（人間）が記録に残る。
      トークンが漏れた疑いがあるときは、外さずに、子を止めてトークンを失効させる
  eval "$(cso hook-env <nodeId>)"
      手動の CLI セッション用に、その子のフック専用のトークンを発行し、環境変数 CSO_DAEMON_URL・CSO_NODE_TOKEN を設定する
      （eval で使うときだけ。標準出力が端末なら、トークンを出さずに失敗する）。そのあと、子の作業ツリーで plugin つきの claude を起動する。
      発行し直すと、古いフック用トークンは無効になり、フックの結び付けも外れる。CLI の子（childRuntime: cli）の、動作中の子だけ
  cso discarded list
      強制の回収で破棄した成果の保管（refs/cso/discarded/*）の一覧: 名前・ノード・先端の SHA・日時・件名（コミットメッセージ由来の、信頼できない入力）。孤立（ノードがもうない）も出る。
      保管は、最終削除（cso purge）のときに、その木のノードの分が消える。数の上限（daemon の設定 discardedRefsMax）に達すると、強制の回収は失敗する
  cso discarded restore <nodeId|key> [--branch <名前>] [--request-id <id>]
      保管している先端から、新しいブランチを作る（作成だけ。既存のブランチは上書きしない。保管は残る）。既定の名前は cso/restored/<key>
  cso discarded drop <nodeId|key> [--yes] [--request-id <id>]
      保管を 1 件消す（取り消せない）。--yes がなければ、対象の表示だけで止まる
  --request-id <id>  結果が確認できなかった要求を、同じ識別子で再実行する
  -h, --help         この使い方を表示する（終了コード 0）
終了コード: 0 成功 / 1 失敗・結果が確認できない / 2 引数の誤り`;

const ALLOWED_FLAGS: Readonly<Record<string, readonly string[]>> = {
  purge: ["--dry-run", "--yes", "--expect", "--tombstone", "--no-tombstone"],
  reclaim: ["--yes", "--expect"],
  "purge-hold": ["--until", "--days", "--reason"],
  "purge-release": [],
  "confirm-stopped": ["--note"],
  "hook-unbind": [],
  "hook-env": [],
  "discarded-list": [],
  "discarded-restore": ["--branch"],
  "discarded-drop": ["--yes"],
};
/** 値を取るオプション。 */
const VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--until",
  "--days",
  "--reason",
  "--branch",
  "--expect",
  "--note",
]);

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
  /** 自動の最終削除の保留（有効なもの）。 */
  readonly hold?: { readonly until?: string; readonly reason?: string };
  /** 最終削除で一緒に消える、保管している破棄した成果の数。 */
  readonly discardedRefs?: number;
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
  v.blockers.every(
    (b) => isRecord(b) && typeof b.code === "string" && typeof b.cause === "string",
  ) &&
  (v.discardedRefs === undefined ||
    (typeof v.discardedRefs === "number" &&
      Number.isInteger(v.discardedRefs) &&
      v.discardedRefs >= 0)) &&
  (v.hold === undefined ||
    (isRecord(v.hold) &&
      (v.hold.until === undefined || typeof v.hold.until === "string") &&
      (v.hold.reason === undefined || typeof v.hold.reason === "string")));
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
  /** 対象と配下のブランチの先端（nodeId → SHA。T21r-e）。破棄の指示（`expectTips`）に、そのまま渡す。 */
  readonly tips?: Readonly<Record<string, string>>;
}
const isTips = (v: unknown): v is Readonly<Record<string, string>> =>
  isRecord(v) &&
  !Array.isArray(v) &&
  Object.values(v).every((x) => typeof x === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(x));
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
  (v.loss === undefined || (Array.isArray(v.loss) && v.loss.every(isLossView))) &&
  (v.tips === undefined || isTips(v.tips));
/** シェルで安全に貼り付けられるように、単一引用符で囲む（中の `'` は `'\''` にする）。 */
const shellQuote = (v: string): string => `'${v.replace(/'/g, "'\\''")}'`;
interface DiscardedView {
  readonly key: string;
  readonly tip: string;
  readonly nodeId?: string;
  readonly orphan: boolean;
  readonly committedAt?: string;
  readonly untrustedSubject?: string;
}
const isDiscardedList = (v: unknown): v is { items: readonly DiscardedView[]; max: number } =>
  isRecord(v) &&
  typeof v.max === "number" &&
  Array.isArray(v.items) &&
  v.items.every(
    (i) =>
      isRecord(i) &&
      typeof i.key === "string" &&
      typeof i.tip === "string" &&
      typeof i.orphan === "boolean" &&
      (i.nodeId === undefined || typeof i.nodeId === "string") &&
      (i.committedAt === undefined || typeof i.committedAt === "string") &&
      (i.untrustedSubject === undefined || typeof i.untrustedSubject === "string"),
  );
const isRestored = (v: unknown): v is { branch: string; tip: string } =>
  isRecord(v) && typeof v.branch === "string" && typeof v.tip === "string";
const isDropped = (v: unknown): v is { dropped: true; key: string; tip: string } =>
  isRecord(v) && v.dropped === true && typeof v.key === "string" && typeof v.tip === "string";
function describeDiscarded(v: { items: readonly DiscardedView[]; max: number }): string {
  if (v.items.length === 0) return `保管している、破棄した成果: なし（上限 ${v.max} 件）\n`;
  const lines = v.items.map((i) => {
    const subject =
      i.untrustedSubject === undefined
        ? ""
        : `\n      件名（信頼できない入力）: 「${terminalSafe(i.untrustedSubject)}」`;
    return `  ${terminalSafe(i.key, 128)}  ノード: ${i.nodeId === undefined ? "（孤立）" : terminalSafe(i.nodeId, 128)}  先端: ${i.tip}${i.committedAt === undefined ? "" : `  ${terminalSafe(i.committedAt, 40)}`}${subject}`;
  });
  const rest = Math.max(v.max - v.items.length, 0);
  return `保管している、破棄した成果（${v.items.length} 件 / 上限 ${v.max} 件）:\n${lines.join("\n")}\n残り ${rest} 件（上限 ${v.max} − 現在 ${v.items.length}）。上限に達すると、強制の回収は失敗する\n`;
}
const isHeld = (v: unknown): v is { held: true; until?: string } =>
  isRecord(v) && v.held === true && (v.until === undefined || typeof v.until === "string");
/** 停止の宣言の根拠に使えない文字（画面の FORBIDDEN と同じ: 制御文字〔改行・タブを含む〕・書式制御文字）。 */
const NOTE_FORBIDDEN = /[\p{Cc}\p{Cf}]/u;
const isConfirmedStopped = (v: unknown): v is { state: string } =>
  isRecord(v) && typeof v.state === "string";
const HOOK_ENV_TOKEN = /^[A-Za-z0-9_-]{16,512}$/;
const HOOK_ENV_URL = /^http:\/\/(127\.0\.0\.1|localhost):[0-9]{1,5}$/;
const isHookToken = (v: unknown): v is { token: string; nodeId: string; daemonUrl: string } =>
  isRecord(v) &&
  typeof v.token === "string" &&
  HOOK_ENV_TOKEN.test(v.token) &&
  typeof v.daemonUrl === "string" &&
  HOOK_ENV_URL.test(v.daemonUrl) &&
  typeof v.nodeId === "string";
const isUnbound = (v: unknown): v is { unbound: boolean; duplicate: boolean } =>
  isRecord(v) && typeof v.unbound === "boolean" && typeof v.duplicate === "boolean";
const isReleased = (v: unknown): v is { released: true } => isRecord(v) && v.released === true;
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

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const digestOfText = (text: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ 0xa5a5a5a5;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, "0")}${h2.toString(16).padStart(8, "0")}`.slice(0, 12);
};

/**
 * 表示した先端（nodeId → SHA）の照合用の値（`cso reclaim`）。ID 順の `id:SHA` を、FNV-1a（32 ビット 2 本。種を変える）で畳んだ
 * 12 桁の 16 進。T21r-e からの形で、値は変えない（試験で固定している）。改ざん対策ではない（表示のあとで、対象が変わったことの検出。
 * 実際の照合は、daemon が行う）。cli は node の型に依存しない。
 */
export const tipsDigest = (tips: Readonly<Record<string, string>> | undefined): string =>
  digestOfText(
    Object.entries(tips ?? {})
      .sort(([a], [b]) => byId(a, b))
      .map(([id, tip]) => `${id}:${tip}\n`)
      .join(""),
  );

/** 削除される木のノード（`cso purge`）の照合用の値。ID 順の `id` を畳む（同じ方式）。順序に依存しない。 */
export const nodeIdsDigest = (nodeIds: readonly string[]): string =>
  digestOfText(
    [...nodeIds]
      .sort(byId)
      .map((id) => `${id}\n`)
      .join(""),
  );

function describeReclaim(nodeId: string, p: ReclaimPreview): string {
  const tipLines = Object.entries(p.tips ?? {}).map(
    ([id, tip]) => `  ${terminalSafe(id, 128)}: ${tip.slice(0, 12)}`,
  );
  const head = `回収（破棄）の対象: ${terminalSafe(nodeId, 128)}\n${
    tipLines.length === 0
      ? ""
      : `ブランチの先端（照合の値: ${tipsDigest(p.tips)}。破棄の指示は、この値と今の先端が違えば、拒否する）:\n${tipLines.join("\n")}\n`
  }`;
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
      "  最終コミットの SHA は、成果の保管ではなく、取り戻すための手がかり（破棄した成果の保管は、最終削除で一緒に消える）: ブランチを消した後も git が掃除（gc）するまでの間（到達できないオブジェクトは既定でおよそ 2 週間）は、git branch <名前> <SHA> で戻せることがある\n"
    : "  墓標は残らない。標識として、削除した日時・木の根・ノード数・人間の操作だけが記録に残る\n";
  const blockers =
    p.blockers.length === 0
      ? ""
      : `  実行できない理由:\n${p.blockers.map((b) => `    - ${b.code}: ${b.cause}`).join("\n")}\n`;
  return (
    `最終削除の対象（${p.nodeIds.length} ノード）: ${p.nodeIds.join(", ")}\n` +
    `  照合の値: ${nodeIdsDigest(p.nodeIds)}（実行の時点で、削除される木がこれと違えば、削除しない）\n` +
    `  アーカイブ日: ${p.archivedAt}\n  経過日数: ${p.elapsedDays}（保持期間: ${p.retentionDays} 日）\n  墓標: ${tomb}\n` +
    remains +
    (p.hold === undefined
      ? ""
      : `  自動の最終削除は保留中（${p.hold.until === undefined ? "無期限" : `${terminalSafe(p.hold.until, 40)} まで`}${p.hold.reason === undefined ? "" : `。理由: 「${terminalSafe(p.hold.reason, 200)}」`}）。人間のこのコマンドは、保留を無視して削除する（無視したことは監査に残る）\n`) +
    (p.discardedRefs === undefined || p.discardedRefs === 0
      ? ""
      : `  保管している、破棄した成果（refs/cso/discarded/*）: ${p.discardedRefs} 件が、一緒に消える。取り出すなら、先に cso discarded restore（cso discarded list で確かめる）\n`) +
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
  let [command, ...rest] = argv;
  if (command === undefined) return usageError("コマンドを指定する");
  if (command === "discarded") {
    const sub = rest[0];
    if (sub !== "list" && sub !== "restore" && sub !== "drop") {
      return usageError("cso discarded には、list・restore・drop のどれかを指定する");
    }
    command = `discarded-${sub}`;
    rest = rest.slice(1);
  }
  const allowed = ALLOWED_FLAGS[command];
  if (allowed === undefined) return usageError(`不明なコマンド: ${command}`);

  const flags = new Set<string>();
  const values = new Map<string, string>();
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
      if (VALUE_FLAGS.has(a)) {
        const v = rest[i + 1];
        if (v === undefined || v.startsWith("--")) return usageError(`${a} には値を指定する`);
        values.set(a, v);
        rerunArgs.push(a, shellQuote(v));
        i++;
        continue;
      }
      flags.add(a);
      rerunArgs.push(a);
    } else {
      positional.push(a);
      rerunArgs.push(a);
    }
  }
  if (command === "discarded-list") {
    if (positional.length !== 0) return usageError("cso discarded list に、引数はない");
    const res = await invoke(
      deps.client,
      requestId ?? deps.newRequestId(),
      "node.discardedList",
      {},
      isDiscardedList,
    );
    if (res.kind !== "ok") {
      return res.kind === "failure"
        ? failed(res.failure)
        : unconfirmed(res.reason, "cso discarded list", requestId ?? "-");
    }
    return { exitCode: 0, stdout: describeDiscarded(res.value), stderr: "" };
  }
  const [nodeId] = positional;
  if (nodeId === undefined || positional.length !== 1) {
    return usageError(`${command} にはノード識別子（または保管の名前）を 1 つ指定する`);
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

  if (command === "discarded-restore") {
    const branch = values.get("--branch");
    const res = await invoke(
      deps.client,
      id,
      "node.discardedRestore",
      { target: nodeId, ...(branch === undefined ? {} : { branch }) },
      isRestored,
    );
    if (res.kind !== "ok") return fail(res);
    return {
      exitCode: 0,
      stdout: `ブランチを作った: ${terminalSafe(res.value.branch, 200)}（先端 ${res.value.tip}）。保管は残っている\nrequestId: ${id}\n`,
      stderr: "",
    };
  }
  if (command === "discarded-drop") {
    const listed = await invoke(deps.client, id, "node.discardedList", {}, isDiscardedList);
    if (listed.kind !== "ok") return fail(listed);
    const exact = listed.value.items.filter((i) => i.key === nodeId);
    const matches =
      exact.length > 0 ? exact : listed.value.items.filter((i) => i.nodeId === nodeId);
    if (matches.length > 1) {
      return failed({
        code: "multipleKept",
        cause: `ノード ${terminalSafe(nodeId, 128)} の保管が複数ある（${matches.map((m) => terminalSafe(m.key, 128)).join("、")}）`,
        nextActions: ["cso discarded list で確かめて、鍵（key）を指定する"],
      } as Failure);
    }
    const item = matches[0];
    if (item === undefined) {
      return failed({
        code: "notFound",
        cause: "その保管はない",
        nextActions: ["cso discarded list で名前を確かめる"],
      } as Failure);
    }
    const shown = `消す保管: ${terminalSafe(item.key, 128)}（ノード ${item.nodeId === undefined ? "孤立" : terminalSafe(item.nodeId, 128)}。先端 ${item.tip}）\n`;
    if (!flags.has("--yes")) {
      return {
        exitCode: 2,
        stdout: shown,
        stderr:
          "保管を消すと、取り戻せない（先に cso discarded restore で取り出せる）。上の対象でよければ --yes を付けて再実行する\n",
      };
    }
    // 表示した先端を渡す（表示のあとで保管が変わっていたら、消さない）。鍵で指定する（ノード ID だと、複数あるときに曖昧）。
    const res = await invoke(
      deps.client,
      id,
      "node.discardedDrop",
      { target: item.key, expectTip: item.tip },
      isDropped,
    );
    if (res.kind !== "ok") return fail(res);
    return { exitCode: 0, stdout: `${shown}消した\nrequestId: ${id}\n`, stderr: "" };
  }

  if (command === "purge-hold") {
    const until = values.get("--until");
    const daysText = values.get("--days");
    let days: number | undefined;
    if (daysText !== undefined) {
      if (until !== undefined) return usageError("--until と --days は同時に指定できない");
      if (
        !/^[0-9]{1,3}$/.test(daysText) ||
        Number(daysText) < 1 ||
        Number(daysText) > LIMITS.purgeHoldMaxDays
      ) {
        return usageError(`--days は 1〜${LIMITS.purgeHoldMaxDays} の整数`);
      }
      days = Number(daysText); // 期限は、daemon の時計で決める（T23-d3）
    }
    const reason = values.get("--reason");
    const res = await invoke(
      deps.client,
      id,
      "node.purgeHold",
      {
        nodeId,
        ...(until === undefined ? {} : { until }),
        ...(days === undefined ? {} : { days }),
        ...(reason === undefined ? {} : { reason }),
      },
      isHeld,
    );
    if (res.kind !== "ok") return fail(res);
    return {
      exitCode: 0,
      stdout: `自動の最終削除を保留した: ${nodeId}（${res.value.until === undefined ? "無期限" : `${res.value.until} まで`}）\n有効な予告は取り下げた。人間の cso purge は、保留に関係なく実行できる\nrequestId: ${id}\n`,
      stderr: "",
    };
  }
  if (command === "purge-release") {
    const res = await invoke(deps.client, id, "node.purgeRelease", { nodeId }, isReleased);
    if (res.kind !== "ok") return fail(res);
    return {
      exitCode: 0,
      stdout: `保留を解除した: ${nodeId}（保持期間を過ぎていれば、予告から出し直し、noticeDays 日後に消える）\nrequestId: ${id}\n`,
      stderr: "",
    };
  }

  if (command === "hook-env") {
    // 画面に出す経路を作らない: 標準出力が端末なら（分からないときも）、daemon を呼ばずに失敗する（トークンを発行しない）
    if (deps.isTTY === undefined || deps.isTTY.stdout !== false) {
      return {
        exitCode: 2,
        stdout: "",
        stderr: `hook-env は eval で使う: eval "$(cso hook-env ${nodeId})"（標準出力が端末のときは、トークンを出さない）\n`,
      };
    }
    const res = await invoke(deps.client, id, "node.hookToken", { nodeId }, isHookToken);
    if (res.kind !== "ok") return fail(res);
    // 値は、形を確かめた文字（英数字・_・-、ループバックの URL）だけなので、単一引用符の中にそのまま置ける
    return {
      exitCode: 0,
      stdout: `export CSO_DAEMON_URL='${res.value.daemonUrl}'\nexport CSO_NODE_TOKEN='${res.value.token}'\n`,
      stderr: "",
    };
  }

  if (command === "hook-unbind") {
    const res = await invoke(deps.client, id, "node.hookUnbind", { nodeId }, isUnbound);
    if (res.kind !== "ok") return fail(res);
    return {
      exitCode: 0,
      stdout: res.value.duplicate
        ? `すでに記録済み（再送。もう一度は外さない）: ${nodeId}\nrequestId: ${id}\n`
        : `${res.value.unbound ? "フックの結び付けを外した" : "フックの結び付けはなかった（記録だけ残した）"}: ${nodeId}\n次に来たセッションに結び直す\nrequestId: ${id}\n`,
      stderr: "",
    };
  }

  if (command === "confirm-stopped") {
    // 画面と同じ規則: 1 行（改行・制御文字・書式制御文字は不可）。前後の空白を削り、連続する空白を 1 つにした値を送る。
    const rawNote = values.get("--note");
    const note = rawNote?.replace(/\s+/g, " ").trim();
    if (
      rawNote !== undefined &&
      (note === "" ||
        NOTE_FORBIDDEN.test(rawNote) ||
        note === undefined ||
        !isBoundedText(note, LIMITS.summary))
    ) {
      return usageError(
        `--note は 1 行・${LIMITS.summary} 文字以下の文（空白だけ・改行・制御文字は不可）`,
      );
    }
    const res = await invoke(
      deps.client,
      id,
      "node.confirmStopped",
      { nodeId, ...(note === undefined ? {} : { note }) },
      isConfirmedStopped,
    );
    if (res.kind !== "ok") return fail(res);
    return {
      exitCode: 0,
      stdout: `止めたと宣言した: ${nodeId}（状態: ${terminalSafe(res.value.state, 40)}）\n宣言した者（人間）と根拠を記録し、受信箱の停止の代行依頼を解決済みにした\nrequestId: ${id}\n`,
      stderr: "",
    };
  }

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
    const tips = preview.value.tips ?? {};
    if (Object.keys(tips).length > LIMITS.expectTips) {
      return failed({
        code: "tooManyNodes",
        cause: `配下のノードが多すぎて、先端の照合ができない（${Object.keys(tips).length} 件。上限 ${LIMITS.expectTips} 件）`,
        nextActions: ["配下を先に回収して、数を減らす"],
      } as Failure);
    }
    const shown = describeReclaim(nodeId, preview.value);
    const digest = tipsDigest(tips);
    const expect = values.get("--expect");
    if (!flags.has("--yes")) {
      return {
        exitCode: 2,
        stdout: shown,
        stderr: `${values.has("--expect") ? "--expect は、表示だけ（実行には --yes が要る）。" : ""}破棄の判断は取り消せない（停止したノードの作業ツリーとブランチが、強制して消える）。上の内容でよければ、表示の値を付けて再実行する: cso reclaim ${nodeId} --yes --expect ${digest}\n`,
      };
    }
    if (expect === undefined) {
      return usageError(
        `--yes には --expect <digest> が要る（表示した先端の照合用の値。--yes なしで実行すると、表示される: ${digest}）`,
      );
    }
    if (expect !== digest) {
      return {
        exitCode: 1,
        stdout: shown,
        stderr: `表示した内容のあとで、先端が変わっている（照合の値が違う）。何も指示していない。上の内容を確かめ直して、よければ再実行する: cso reclaim ${nodeId} --yes --expect ${digest}\n`,
      };
    }
    // 表示した先端（プレビューの tips）を渡す。daemon が、今の先端と照合する（違えば tipMismatch）。
    const res = await invoke(
      deps.client,
      id,
      "node.reclaimInstruct",
      { nodeId, expectTips: tips },
      isAccepted,
    );
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
  if (
    preview.kind === "failure" &&
    preview.failure.code === "notFound" &&
    requestId !== undefined
  ) {
    // --request-id を指定した再実行で、木が見つからない: 前回の実行が成功して、木がもう消えている可能性がある（事前確認は飛ばさない）。
    return failed({
      ...preview.failure,
      cause: `${preview.failure.cause}（前回の実行が成功して、木がすでに消えた可能性がある）`,
      nextActions: [
        "画面の木の一覧に、そのノードがないか確かめる。ないなら、前回の最終削除は成功している",
        "墓標を残した場合は、墓標の記録（削除した日時・木の根）が残っている。残さない場合も、標識（削除した日時・ノード数）が記録に残る",
        "破棄した成果を保管していた木は、cso discarded list で、その木のノードの保管が（孤立として残っていないか）確かめる",
        ...preview.failure.nextActions,
      ] as unknown as Failure["nextActions"],
    } as Failure);
  }
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
  const digest = nodeIdsDigest(preview.value.nodeIds);
  if (!flags.has("--yes")) {
    return {
      exitCode: 2,
      stdout: shown,
      stderr: `${values.has("--expect") ? "--expect は、表示だけ（実行には --yes が要る）。" : ""}最終削除は取り消せない。上の対象でよければ、表示の値を付けて再実行する: cso purge ${nodeId} --yes --expect ${digest}\n`,
    };
  }
  const expect = values.get("--expect");
  if (expect === undefined) {
    return usageError(
      `--yes には --expect <digest> が要る（表示した、削除される木の照合用の値。--yes なしで実行すると、表示される: ${digest}）`,
    );
  }
  if (expect !== digest) {
    return {
      exitCode: 1,
      stdout: shown,
      stderr: `表示した内容のあとで、削除される木が変わっている（照合の値が違う）。何も削除していない。上の内容を確かめ直して、よければ再実行する: cso purge ${nodeId} --yes --expect ${digest}\n`,
    };
  }

  // 見せた木（削除されるノード）を渡す。実行までの間に木が変わっていたら、daemon が削除しない（purgeStale）。
  // ノードが 2000 件（`LIMITS.expectNodeIds`）を超える木は、daemon の照合（expectNodeIds）を省く。照合は、--expect（取り直した事前確認との照合）だけになる。
  const daemonCheck = preview.value.nodeIds.length <= LIMITS.expectNodeIds;
  const params = {
    nodeId,
    ...(tombstone === undefined ? {} : { tombstone }),
    ...(daemonCheck ? { expectNodeIds: preview.value.nodeIds } : {}),
  };
  const res = await invoke(deps.client, id, "node.purge", params, isPurged);
  if (res.kind !== "ok") return fail(res);
  return {
    exitCode: 0,
    stdout: `${shown}最終削除した（${res.value.purged.length} ノード）: ${res.value.purged.join(", ")}\nrequestId: ${id}\n`,
    stderr: daemonCheck
      ? ""
      : `注意: ノードが ${LIMITS.expectNodeIds} 件を超える木なので、daemon での照合（expectNodeIds）は省いた。照合は、--expect（実行の直前に取り直した事前確認との照合）だけ\n`,
  };
}
