/**
 * ランタイムアダプタの契約（design 6.1）。daemon は環境（CLI・Desktop）の差をこの契約の裏に閉じ込める。
 * 不可能な操作は、理由と代替手段を含む失敗を返す（FR_034, NFR_010）。
 */

import type { Actor, EventBody, Failure, Result, Scope, StopOutcome } from "@cso/core";

export interface Capabilities {
  readonly send: "ok" | "delayed" | "unreliable" | "unsupported";
  readonly stopGraceful: boolean;
  readonly stopImmediate: boolean;
  readonly hooks: "ok" | "unverified" | "unsupported";
  readonly sessionId: boolean;
}

export interface StartRequest {
  readonly nodeId: string;
  /** 作業ツリーのパス（絶対）。アダプタが実パスにして使う。 */
  readonly worktreePath: string;
  readonly scope: Scope;
  /** 最初の指示（ブリーフ）。 */
  readonly instruction: string;
  /** ノード専用の MCP 接続（資格情報つき）。 */
  readonly mcp?: { readonly url: string; readonly token: string };
}

export interface StartValue {
  readonly sessionId: string;
  /** 実パスにした作業ツリー。 */
  readonly cwd: string;
  /** 子の環境から除いた変数の名前（値は含めない）。 */
  readonly removedEnv: readonly string[];
}

export interface DeliveryValue {
  /** 指示を入力へ受け付けた。実行中のときは、ツール完了後に届く。 */
  readonly status: "queued";
}

export interface StopRequest {
  readonly mode: "graceful" | "immediate";
  /** 穏当な停止の猶予（1 以上 3,600,000 以下の整数ミリ秒）。省略時は既定値。停止要求ごとに上書きできる。即時停止では指定できない。 */
  readonly graceMs?: number;
  /** 対応する停止要求（`stop`・`retryStop` の `node.stateChanged`）のイベントの `seq`。観測の記録に結び付ける。 */
  readonly stopSeq: number;
}

export interface StopValue {
  /** `stopped`: 作業ツリー配下にプロセスがないことを確認できた。`stopIncomplete`: 所定の時間を超えても残っている。 */
  readonly state: "stopped" | "stopIncomplete";
  /** 猶予内に止まったか、`interrupt()` に落ちたか、`abort()` したか。 */
  readonly outcome: StopOutcome;
  /** 残っているプロセスの pid（`stopIncomplete` のときの手がかり）。 */
  readonly blockers: readonly number[];
}

export interface RuntimeAdapter {
  readonly kind: "cli" | "desktop";
  capabilities(nodeId: string): Capabilities;
  start(request: StartRequest): Promise<Result<StartValue, Failure>>;
  send(nodeId: string, text: string): Promise<Result<DeliveryValue, Failure>>;
  stop(nodeId: string, request: StopRequest): Promise<Result<StopValue, Failure>>;
}

/** タイマー（テストでは手動で進める）。 */
export interface Timers {
  after(ms: number): { readonly promise: Promise<void>; cancel(): void };
  sleep(ms: number): Promise<void>;
}

export interface SinkRequest {
  readonly requestId: string;
  readonly actor: Actor;
  readonly body: EventBody;
}

/** イベントの記録口（daemon では EventLog.append に配線する）。 */
export interface EventSink {
  record(request: SinkRequest): Result<unknown, Failure>;
}
