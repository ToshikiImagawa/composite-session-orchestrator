/**
 * ランタイムアダプタの契約（design 6.1）。daemon は環境（CLI・Desktop）の差をこの契約の裏に閉じ込める。
 * 不可能な操作は、理由と代替手段を含む失敗を返す（FR_034, NFR_010）。
 */

import type { Actor, EventBody, Failure, NodeRole, Result, Scope, StopOutcome } from "@cso/core";

export interface Capabilities {
  readonly send: "ok" | "delayed" | "unreliable" | "unsupported";
  readonly stopGraceful: boolean;
  readonly stopImmediate: boolean;
  /** 直接は止められないが、受信箱を通じて親に停止の代行を依頼できる（Desktop。FR_036）。省略すると false。 */
  readonly stopDelegated?: boolean;
  readonly hooks: "ok" | "unverified" | "unsupported";
  readonly sessionId: boolean;
}

export interface StartRequest {
  readonly nodeId: string;
  /** ノードの役割（子に渡す skill を選ぶ。T22-c）。省略すると、統合ノードでない子として扱う。 */
  readonly role?: NodeRole;
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

interface StopValueBase {
  /** 残っているプロセスの pid（`stopIncomplete` のときの手がかり）。 */
  readonly blockers: readonly number[];
  /** 続行した問題（手段の例外、観測の記録の失敗など）。なければ省略する。 */
  readonly warnings?: readonly string[];
}

/**
 * 停止の結果。`stopped`: 作業ツリー配下にプロセスがないことを確認できた（`outcome` は必須）。`stopIncomplete`: 所定の時間を
 * 超えても残っている、または停止を親に代行してもらう（`delegation`。このとき `outcome` はない）。
 */
export type StopValue =
  | (StopValueBase & {
      readonly state: "stopped";
      /** 猶予内に止まったか、`interrupt()` に落ちたか、`abort()` したか。 */
      readonly outcome: StopOutcome;
    })
  | (StopValueBase & {
      readonly state: "stopIncomplete";
      readonly outcome?: StopOutcome;
      /** 停止を親に代行してもらうときの依頼の文面（手順・対象のノード）。受信箱の stopIncomplete の項目に出す。 */
      readonly delegation?: string;
    });

export interface RuntimeAdapter {
  readonly kind: "cli" | "desktop";
  /** そのノードの子を、このアダプタが管理しているか（再起動の後の整合で使う。省略すると、管理していないものとして扱う）。 */
  has?(nodeId: string): boolean;
  capabilities(nodeId: string): Capabilities;
  /** 停止の宣言（`node.confirmStopped`）の後に、そのノードの子を管理から外す（省略可。直接止められるアダプタには不要）。 */
  release?(nodeId: string): void;
  start(request: StartRequest): Promise<Result<StartValue, Failure>>;
  send(nodeId: string, text: string): Promise<Result<DeliveryValue, Failure>>;
  stop(nodeId: string, request: StopRequest): Promise<Result<StopValue, Failure>>;
  /** 作業範囲の更新（範囲の拡張。FR_015）。以後のフック判定から新しい範囲を使う。 */
  updateScope(nodeId: string, scope: Scope): Result<undefined, Failure>;
}

/** タイマー（テストでは手動で進める）。 */
export interface Timers {
  /** 現在時刻（ミリ秒）。停止確認の経過時間を実時間で数えるために使う。 */
  now(): number;
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
  /** 複数のイベントを、1 トランザクションで記録する（1 件でも失敗したら全件を書かない）。 */
  recordAll(requests: readonly SinkRequest[]): Result<unknown, Failure>;
}
