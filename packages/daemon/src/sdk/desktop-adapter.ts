/**
 * Desktop のランタイムアダプタ（T20。FR_032, FR_034, FR_036）。
 *
 * Desktop の子は、統合セッションが Desktop のタスク生成機能で起動する。daemon は子を直接操作できないので、
 * - 能力表は、実機確認（Spike 01 の項目 1〜7）までは控えめな値にする（`DESKTOP_CAPABILITIES`。確認後は値を差し替えるだけ）。
 * - 停止は、受信箱を通じて親に代行を依頼する（停止未完了として記録し、代行の文面を受信箱の項目に出す）。
 * - 指示は直接届けられないので、理由と代替手段つきで失敗する。
 * - フックが確認済み（`ok`）でない間は、子に作業を許可しない（ゲート。既定で有効。設定ファイルでのみ外せる）。
 */

import { type Failure, failure, ok, type Result, type Scope } from "@cso/core";
import { derivedRequestId } from "../api/handlers/context.js";
import type {
  Capabilities,
  DeliveryValue,
  EventSink,
  RuntimeAdapter,
  StartRequest,
  StartValue,
  StopRequest,
  StopValue,
} from "./runtime.js";

/** 実機確認前の能力表。確認が済んだら、この値を差し替える。 */
export const DESKTOP_CAPABILITIES: Capabilities = {
  send: "unsupported",
  stopGraceful: false,
  stopImmediate: false,
  stopDelegated: true,
  hooks: "unverified",
  sessionId: false,
};

export interface DesktopAdapterDeps {
  readonly sink: EventSink;
  /** フックが確認済みでない子の起動を拒否するか（daemon の設定 `desktopRequireVerifiedHooks`）。既定 true。 */
  readonly requireVerifiedHooks?: boolean;
  /** 能力表（テスト用。省略すると `DESKTOP_CAPABILITIES`）。 */
  readonly capabilities?: Capabilities;
  /** ゲートを外して起動したときの警告の記録先（起動のたびに呼ぶ）。 */
  readonly onWarning?: (nodeId: string, text: string) => void;
}

const fail = (
  code: string,
  cause: string,
  ...next: [string, ...string[]]
): { ok: false; error: Failure } => ({ ok: false, error: failure(code, cause, ...next) });

const UNSAFE = "作業範囲外の拒否（FR_014）による安全を保証できない";

const HOOKS_LABEL: Readonly<Record<Capabilities["hooks"], string>> = {
  ok: "確認済み",
  unverified: "未確認",
  unsupported: "未対応",
};

/** 停止の代行依頼の手順（受信箱の要約の上限 200 文字から、最長の ID と区切りを引いた長さに収める）。 */
export const DELEGATION_STEPS =
  "親に停止の代行を依頼: Desktop でこのタスクを止め（停止がなければアーカイブ）、結果を報告する";

export class DesktopRuntimeAdapter implements RuntimeAdapter {
  readonly kind = "desktop" as const;
  private readonly scopes = new Map<string, Scope>();

  constructor(private readonly deps: DesktopAdapterDeps) {}

  private get caps(): Capabilities {
    return this.deps.capabilities ?? DESKTOP_CAPABILITIES;
  }

  has(nodeId: string): boolean {
    return this.scopes.has(nodeId);
  }

  capabilities(_nodeId: string): Capabilities {
    return this.caps;
  }

  async start(request: StartRequest): Promise<Result<StartValue, Failure>> {
    if (this.caps.hooks !== "ok") {
      if (this.deps.requireVerifiedHooks ?? true) {
        return fail(
          "hooksUnverified",
          `Desktop の子のフックが${HOOKS_LABEL[this.caps.hooks]}（hooks: ${this.caps.hooks}）。${UNSAFE}。確認が済むまで、Desktop の子は動かさない`,
          "CLI の子として起動する",
          "Spike 01 の項目 4 を確認して能力表を更新する",
        );
      }
      this.deps.onWarning?.(request.nodeId, `フックのゲートを設定で外して起動した: ${UNSAFE}`);
    }
    this.scopes.set(request.nodeId, request.scope);
    // 子のセッション識別子は Desktop のタスク生成の戻り値にない。紐付け（T21）までは、ノードの ID で代える。
    return ok({ sessionId: request.nodeId, cwd: request.worktreePath, removedEnv: [] });
  }

  async send(nodeId: string, _text: string): Promise<Result<DeliveryValue, Failure>> {
    return fail(
      "unsupported",
      `Desktop の子（ノード ${nodeId}）には、daemon から直接指示を届けられない`,
      "親（統合セッション）に、Desktop のメッセージ送信で代わりに送るよう頼む",
    );
  }

  async stop(nodeId: string, request: StopRequest): Promise<Result<StopValue, Failure>> {
    if (!this.has(nodeId)) {
      return fail("notManaged", `ノード ${nodeId} の子を管理していない`, "ノードの状態を確認する");
    }
    const requestId = derivedRequestId({ system: true }, `desktop-stop-${request.stopSeq}`, 0);
    let r: Result<unknown, Failure>;
    try {
      r = this.deps.sink.record({
        requestId,
        actor: { system: true },
        body: { type: "node.stateChanged", payload: { nodeId, event: { type: "stopTimeout" } } },
      });
    } catch (e) {
      r = {
        ok: false,
        error: failure("recordFailed", `記録口が例外: ${String(e)}`, "ログの状態を確認する"),
      };
    }
    if (!r.ok) {
      return fail(
        "recordFailed",
        `停止の代行依頼を記録できなかった: ${r.error.cause}`,
        "ログの状態を確認する",
      );
    }
    return ok({
      state: "stopIncomplete" as const,
      blockers: [],
      // 手順を先に、ID を後ろに置く（受信箱の要約の上限で切れても、手順は残る。ID は最長 128 文字）。
      delegation: `${DELEGATION_STEPS}。対象ノード: ${nodeId}`,
    });
  }

  release(nodeId: string): void {
    this.scopes.delete(nodeId);
  }

  updateScope(nodeId: string, scope: Scope): Result<undefined, Failure> {
    if (!this.has(nodeId)) {
      return fail("notManaged", `ノード ${nodeId} の子を管理していない`, "ノードの状態を確認する");
    }
    this.scopes.set(nodeId, scope);
    return ok(undefined);
  }
}
