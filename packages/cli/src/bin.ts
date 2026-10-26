#!/usr/bin/env node
/**
 * `cso`（人間用コマンドの実行ファイル。T22-cli）。窓口と認証は、環境変数だけで受ける（引数に置かない。`ps` に出さない）。
 *
 * - `CSO_DAEMON_URL`: daemon の窓口（ループバックだけ）。
 * - `CSO_HUMAN_TOKEN`: 人間のトークン（`<stateDir>/human-token` の中身）。`--token` のような引数はない。
 * - `CSO_DAEMON_CONFIG`: daemon の設定ファイル。`stateDir` の `daemon-identity` で、トークンつきの要求の直前に毎回、daemon の身元を
 *   確かめる（cso-mcp と同じ）。ないと動かない。環境変数 `CSO_CLI_ALLOW_UNVERIFIED` が**ちょうど `1`** のときだけ、検証なしで動く。
 *
 * 終了コードは `runCommand` と同じ（0 成功・1 失敗／結果が確認できない・2 引数・環境の誤り）。
 */
import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createIdentityVerifier, createRelay, IDENTITY_FILE } from "@cso/mcp/relay";
import { type CommandResult, runCommand } from "./commands.js";
import { createHttpClient } from "./http-client.js";

export interface BinDeps {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isTTY: { readonly stdin: boolean; readonly stdout: boolean };
  readonly fetch?: typeof fetch;
  readonly readFile?: (path: string) => string;
  readonly newRequestId?: () => string;
}

const usage = (cause: string): CommandResult => ({
  exitCode: 2,
  stdout: "",
  stderr: `${cause}\n窓口と認証は、環境変数で渡す: CSO_DAEMON_URL（daemon の窓口）・CSO_HUMAN_TOKEN（人間のトークン）・CSO_DAEMON_CONFIG（daemon の設定ファイル。身元の確認に使う）\n例: export CSO_HUMAN_TOKEN="$(cat <stateDir>/human-token)"（トークンを、コマンドの行に直接書かない）\n`,
});

/** daemon の設定の `stateDir`（絶対パス）。読めない・形が違えば undefined。 */
function stateDirOf(path: string, readFile: (p: string) => string): string | undefined {
  try {
    const json = JSON.parse(readFile(path)) as unknown;
    const dir =
      typeof json === "object" && json !== null
        ? (json as Record<string, unknown>).stateDir
        : undefined;
    return typeof dir === "string" && isAbsolute(dir) ? dir : undefined;
  } catch {
    return undefined;
  }
}

export async function runBin(argv: readonly string[], deps: BinDeps): Promise<CommandResult> {
  if (argv.includes("--help") || argv.includes("-h")) {
    return runCommand(argv, {
      client: { call: async () => Promise.reject(new Error("unused")) },
      newRequestId: () => "help",
      isTTY: deps.isTTY,
    });
  }
  const daemonUrl = deps.env.CSO_DAEMON_URL;
  const token = deps.env.CSO_HUMAN_TOKEN;
  if (daemonUrl === undefined || daemonUrl === "") return usage("CSO_DAEMON_URL がない");
  if (token === undefined || token === "") return usage("CSO_HUMAN_TOKEN がない");
  const configPath = deps.env.CSO_DAEMON_CONFIG;
  let verifier: ReturnType<typeof createIdentityVerifier> | undefined;
  if (configPath !== undefined && configPath !== "") {
    const stateDir = stateDirOf(configPath, deps.readFile ?? ((p) => readFileSync(p, "utf8")));
    if (stateDir === undefined) {
      return usage("CSO_DAEMON_CONFIG の設定ファイルを読めない（stateDir が絶対パスでない）");
    }
    verifier = createIdentityVerifier({
      daemonUrl,
      identityPath: join(stateDir, IDENTITY_FILE),
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    });
  } else if (deps.env.CSO_CLI_ALLOW_UNVERIFIED !== "1") {
    return usage(
      "CSO_DAEMON_CONFIG がない（daemon の身元を確認できないので、動かない）。検証なしで動かすときだけ、CSO_CLI_ALLOW_UNVERIFIED=1 を付ける",
    );
  }
  const relay = createRelay({
    daemonUrl,
    token,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(verifier === undefined ? {} : { verifier }),
  });
  if (!relay.ok) return usage(`${relay.error.code}: ${relay.error.cause}`);
  return runCommand(argv, {
    client: createHttpClient(relay.value),
    newRequestId: deps.newRequestId ?? (() => `cso-${randomUUID()}`),
    isTTY: deps.isTTY,
  });
}

// 直接実行されたときだけ動く（試験では runBin を呼ぶ）。
const entry = process.argv[1];
if (entry !== undefined && realpathSync(entry) === fileURLToPath(import.meta.url)) {
  const result = await runBin(process.argv.slice(2), {
    env: process.env,
    isTTY: { stdin: process.stdin.isTTY === true, stdout: process.stdout.isTTY === true },
  });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  process.exitCode = result.exitCode;
}
