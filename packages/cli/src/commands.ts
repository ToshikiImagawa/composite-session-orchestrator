/**
 * 人間用コマンド（FR_029, FR_031, NFR_006, NFR_010）。入出力は持たず、終了コードと
 * 標準出力・標準エラーの文字列を返す。窓口は `DaemonClient` で受ける。
 *
 *   cso purge <nodeId> [--dry-run] [--yes] [--tombstone|--no-tombstone] [--request-id <id>]
 *   cso reclaim <nodeId> [--request-id <id>]
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
  cso reclaim <nodeId> [--request-id <id>]
      回収を指示する
  --request-id <id>  結果が確認できなかった要求を、同じ識別子で再実行する
  -h, --help         この使い方を表示する（終了コード 0）
終了コード: 0 成功 / 1 失敗・結果が確認できない / 2 引数の誤り`;

const ALLOWED_FLAGS: Readonly<Record<string, readonly string[]>> = {
  purge: ["--dry-run", "--yes", "--tombstone", "--no-tombstone"],
  reclaim: [],
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
}
const isPreview = (v: unknown): v is Preview =>
  isRecord(v) &&
  isStringArray(v.nodeIds) &&
  typeof v.archivedAt === "string" &&
  typeof v.elapsedDays === "number";
const isPurged = (v: unknown): v is { purged: readonly string[] } =>
  isRecord(v) && isStringArray(v.purged);
const isAccepted = (v: unknown): v is { accepted: true } => isRecord(v) && v.accepted === true;

const unconfirmed = (reason: string, rerun: string, requestId: string): CommandResult => ({
  exitCode: 1,
  stdout: "",
  stderr: `結果が確認できない（${reason}）。実行されたかどうかは不明（requestId: ${requestId}）。\n次の操作:\n  - 先に状態を確認する（受信箱・木の一覧）\n  - 同じ requestId で再実行する: ${rerun}\n`,
});

function describePreview(p: Preview, tombstone: boolean | undefined): string {
  const tomb =
    tombstone === undefined
      ? `保持ポリシーの既定に従う（既定: ${DEFAULT_PURGE_TOMBSTONE ? "墓標を残す" : "墓標を残さない"}）`
      : tombstone
        ? "墓標を残す"
        : "墓標を残さない";
  return `最終削除の対象（${p.nodeIds.length} ノード）: ${p.nodeIds.join(", ")}\n  アーカイブ日: ${p.archivedAt}\n  経過日数: ${p.elapsedDays}\n  墓標: ${tomb}\n`;
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
    const res = await invoke(deps.client, id, "node.reclaimInstruct", { nodeId }, isAccepted);
    if (res.kind !== "ok") return fail(res);
    return { exitCode: 0, stdout: `回収を指示した: ${nodeId}\nrequestId: ${id}\n`, stderr: "" };
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
