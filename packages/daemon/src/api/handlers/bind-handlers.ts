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

/** 子が紐付けと報告に使う手順（仮置き: curl が使えるかは、実機確認〔Spike 01 の項目 4〕で確かめる）。 */
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
    `最初のメッセージを受けたら、次のコマンドで、このノードのトークンを受け取る（コードは一度きり。${expiresAt} まで）:`,
    `curl -sS -X POST ${baseUrl}/v1/bind -H 'content-type: application/json' -d '${bindBody}'`,
    "応答の value.token が、このノードのトークン。トークンは、ファイルやほかの場所へ書き写さない。",
    "以後の報告（report.progress・report.decision・report.outOfScope・report.done・scope.extend）は、トークンを付けて送る:",
    `curl -sS -X POST ${baseUrl}/v1/request -H "authorization: Bearer $CSO_TOKEN" -H 'content-type: application/json' -d '{"requestId":"<一意な ID>","role":"child","operation":"report.progress","params":{"text":"<進捗>"}}'`,
    "（CSO_TOKEN は、受け取ったトークンを入れたシェルの変数。コマンドの行に、トークンを直接書かない）",
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
