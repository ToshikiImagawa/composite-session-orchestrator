/**
 * Desktop の子の紐付けの文面（`node.bindCode`。FR_032。T21・仮置き）。`docs/desktop-runtime.md` の「紐付け」
 *
 * - 人間と、祖先の統合ノード（自分を含まない子孫が対象）だけ。子のトークンは、操作の表（ROLE_OPERATIONS）にないので、窓口で 403。
 * - 対象は、Desktop のアダプタが起動を受け付けた（起動の指示を持っている）、動作中（running・waiting）のノードだけ。
 * - 呼ぶたびに、一度きりのコードを新しく発行する（古いコードは無効）。同じ requestId の再送も、新しいコードを発行する
 *   （コードを記録しないので、前の応答を返せない。前のコードは、その時点で無効になる）。
 * - **コードは記録しない**: イベントログ・受信箱・記録（note）に書かない。応答（instruction）にだけ入る。
 */

import {
  type Failure,
  isStrictDescendant,
  type OperationMap,
  type Result,
  stateOf,
} from "@cso/core";
import type { DesktopRuntimeAdapter } from "../../sdk/desktop-adapter.js";
import type { BindCodes } from "../bind.js";
import { formatBindCodeForDisplay } from "../bind.js";
import type { HandlerRequest } from "../server.js";
import { fail, type LogPort } from "./context.js";

type R<Op extends keyof OperationMap> = Result<OperationMap[Op]["result"], Failure>;

export interface BindHandlerDeps {
  readonly log: LogPort;
  readonly bind: Pick<BindCodes, "issueWithExpiry">;
  /** Desktop の子のアダプタ（設定 `childRuntime` が desktop のときだけ）。 */
  readonly desktop?: Pick<DesktopRuntimeAdapter, "instructionOf">;
  /** 窓口の URL（`http://127.0.0.1:<port>`。待ち受けの前は undefined）。 */
  readonly baseUrl: () => string | undefined;
}

const LIVE = new Set(["running", "waiting"]);

/**
 * 子が紐付けと報告に使う手順（仮置き: curl が使えるかは、実機確認〔Spike 01 の項目 4〕で確かめる）。
 *
 * トークンとコードを、コマンドの引数に置かない（`ps` のプロセス一覧に出さない）: ヘッダーと本文は、シェルの組み込みの `printf` で
 * 標準入力から渡す（`-H @-`・`-d @-`）。トークンは、応答から直接シェルの変数（`CSO_TOKEN`）に入れ、画面に出さない。
 *
 * 注意: `nodeId` は `isSafeId`（英数字と `. _ : -`）を通ったものなので、シェルの単一引用符・JSON の中にそのまま置ける。
 * ノード ID の文字種を広げるときは、ここで引用・エスケープを見直す（`'`・`"`・`\`・`$`・改行が入ると、コマンドが壊れるか、
 * 別のコマンドとして解釈される）。
 */
export function bindInstruction(
  start: string,
  nodeId: string,
  code: string,
  baseUrl: string,
  expiresAt: string,
): string {
  const bindBody = JSON.stringify({ nodeId, bindCode: formatBindCodeForDisplay(code) });
  return [
    start,
    "",
    "---- daemon への紐付け（仮置きの手順）----",
    `最初のメッセージを受けたら、次のコマンドで、このノードのトークンをシェルの変数 CSO_TOKEN に受け取る（コードは一度きり。${expiresAt} まで）:`,
    `CSO_TOKEN=$(printf '%s' '${bindBody}' | curl -sS -X POST ${baseUrl}/v1/bind -H 'content-type: application/json' -d @- | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p')`,
    "トークンは、画面・ファイル・ほかの場所へ書き出さない。",
    "以後の報告（report.progress・report.decision・report.outOfScope・report.done・scope.extend）は、トークンのヘッダーを標準入力から渡して送る（コマンドの引数にトークンを置かない）:",
    `printf 'authorization: Bearer %s\\n' "$CSO_TOKEN" | curl -sS -X POST ${baseUrl}/v1/request -H @- -H 'content-type: application/json' -d '{"requestId":"<一意な ID>","role":"child","operation":"report.progress","params":{"text":"<進捗>"}}'`,
  ].join("\n");
}

export function createBindHandlers(deps: BindHandlerDeps) {
  return {
    "node.bindCode": (req: HandlerRequest<"node.bindCode">): R<"node.bindCode"> => {
      const { nodeId } = req.params;
      const human = req.role === "human";
      const caller = req.caller?.nodeId ?? "";
      const state = deps.log.state();
      if (!human && !isStrictDescendant(state.nodes, caller, nodeId)) {
        return fail(
          "forbidden",
          "対象のノードが、自分の部分木の規則（自分を含まない子孫）を満たさない",
          "親（統合ノード）か人間に依頼する",
        );
      }
      const s = stateOf(state, nodeId);
      if (s === undefined) return fail("notFound", "ノードが見つからない", "ID を確認する");
      // 紐付けで渡すトークンは子のロールだけ（`POST /v1/bind`）。Desktop の中間の統合ノードは、まだ紐付けできない（仮置き）。
      if (state.nodes.find((x) => x.id === nodeId)?.role === "integrator") {
        return fail(
          "integratorNotSupported",
          `ノード ${nodeId} は統合ノードで、Desktop の子としては紐付けできない（紐付けで渡すのは子のトークンだけ。仮置き）`,
          "中間の統合ノードを使わず、統合ノードの直下に作業の子を作る",
          "中間の統合ノードが要るなら、childRuntime を cli にする",
        );
      }
      if (deps.desktop === undefined) {
        return fail(
          "notDesktop",
          "この木の子は Desktop の子ではない（設定 childRuntime が desktop のときだけ）",
          "CLI の子は、daemon が起動する（紐付けは要らない）",
        );
      }
      if (!LIVE.has(s)) {
        return fail(
          "notActive",
          `ノード ${nodeId} は ${s} で、紐付けできない（running・waiting のとき）`,
          "ノードの状態を確認する",
        );
      }
      const start = deps.desktop.instructionOf(nodeId);
      if (start === undefined) {
        return fail(
          "notManaged",
          `ノード ${nodeId} の起動の指示を、daemon が持っていない（daemon の再起動のあとなど）`,
          "子を止めたと宣言し、新しく node.spawn で作り直す",
        );
      }
      const baseUrl = deps.baseUrl();
      if (baseUrl === undefined) {
        return fail("unavailable", "窓口がまだ待ち受けていない", "少し待って、もう一度呼び出す");
      }
      const issued = deps.bind.issueWithExpiry(nodeId);
      const expiresAt = new Date(issued.expiresAtMs).toISOString();
      return {
        ok: true,
        value: {
          instruction: bindInstruction(start, nodeId, issued.code, baseUrl, expiresAt),
          expiresAt,
        },
      };
    },
  };
}
