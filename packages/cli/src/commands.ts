/**
 * 人間用コマンド（FR_029, FR_031, NFR_006, NFR_010）。入出力は持たず、終了コードと
 * 標準出力・標準エラーの文字列を返す。窓口は `DaemonClient` で受ける。
 *
 *   cso purge <nodeId> --yes   最終削除。取り消せないため --yes が必須
 *   cso reclaim <nodeId>       回収の指示
 */
import type { Failure } from "@cso/core";
import type { DaemonClient } from "./client.js";

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
  cso purge <nodeId> --yes   アーカイブ済みの木を最終削除する（取り消せない）
  cso reclaim <nodeId>       回収を指示する`;

export function formatFailure(f: Failure): string {
  return `失敗: ${f.cause}\n次の操作:\n${f.nextActions.map((a) => `  - ${a}`).join("\n")}\n`;
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

export async function runCommand(
  argv: readonly string[],
  deps: CommandDeps,
): Promise<CommandResult> {
  const [command, ...rest] = argv;
  const flags = rest.filter((a) => a.startsWith("--"));
  const positional = rest.filter((a) => !a.startsWith("--"));
  const [nodeId] = positional;

  if (command === "purge") {
    if (nodeId === undefined || positional.length !== 1) {
      return usageError("purge にはノード識別子を 1 つ指定する");
    }
    if (!flags.includes("--yes")) {
      return usageError(
        `${nodeId} の最終削除は取り消せない。実行するなら --yes を付ける（先に回収の事前確認で対象を確かめる）`,
      );
    }
    const res = await deps.client.call({
      requestId: deps.newRequestId(),
      role: "human",
      operation: "node.purge",
      params: { nodeId },
    });
    if (!res.ok) return failed(res.error);
    return {
      exitCode: 0,
      stdout: `最終削除した: ${res.value.purged.join(", ")}\n`,
      stderr: "",
    };
  }

  if (command === "reclaim") {
    if (nodeId === undefined || positional.length !== 1) {
      return usageError("reclaim にはノード識別子を 1 つ指定する");
    }
    const res = await deps.client.call({
      requestId: deps.newRequestId(),
      role: "human",
      operation: "node.reclaimInstruct",
      params: { nodeId },
    });
    if (!res.ok) return failed(res.error);
    return { exitCode: 0, stdout: `回収を指示した: ${nodeId}\n`, stderr: "" };
  }

  return usageError(command === undefined ? "コマンドを指定する" : `不明なコマンド: ${command}`);
}
