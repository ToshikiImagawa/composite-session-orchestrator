/**
 * 取り消せない操作の確認（T24-cf。Desktop の木だけ）。`docs/desktop-runtime.md` の冒頭の注意。
 *
 * Desktop の子は、同じユーザーとして stateDir の人間のトークンを読めてしまう（範囲外の拒否がまだ効かない）。画面（/ui）も同じ
 * 人間のトークンで動くので、トークンだけでは、人の操作と区別できない。そこで、取り消せない操作（`CONFIRMABLE_OPERATIONS`）は、
 * 人間のトークンで呼ばれても実行せず、確認待ちにする。daemon の制御端末（/dev/tty）にだけ短いコードを出し、人がそれを
 * 画面に打つ（`confirm.approve`）と、元の要求を 1 回だけ実行する。
 *
 * - コードの平文は持たない（確認待ちごとの塩＋SHA-256 だけ。照合は定数時間）。一度きり・期限つき・試行の回数に上限。
 * - 確認待ちはメモリだけ（daemon を再起動すると消える）。実行は元の要求 ID で行うので、記録の重複の防止がそのまま効く。
 * - コードは、標準エラー（構造化のログと同じ）には書かず、制御端末（/dev/tty）を直接開いて書く。開けない（launchd などで、
 *   端末なしで動いている）ときは、確認待ちを作らずに失敗する（`confirmationUnavailable`。フェイルクローズ）。
 * - コード・確認の番号は、記録・構造化のログに書かない。端末の行には、番号の先頭
 *   だけを添える（画面の欄と見比べるため）。対象の ID は出さない。
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  CONFIRMABLE_OPERATIONS,
  type ConfirmableOperation,
  type DaemonOperation,
  type Failure,
  failure,
  type PendingConfirmation,
  type Result,
} from "@cso/core";
import { BIND_CODE_ALPHABET, createThrottle, normalizeBindCode, type Throttle } from "./bind.js";
import { appendAtomically, deriveId, type LogPort, summarize } from "./handlers/context.js";
import { pickResult } from "./results.js";
import type { HandlerRequest, Handlers } from "./server.js";

/** 確認待ちの期限（ミリ秒）。 */
export const CONFIRMATION_TTL_MS = 5 * 60_000;
/** 確認待ちごとの試行の上限。 */
export const CONFIRMATION_ATTEMPTS = 5;
/** 同時に持てる確認待ちの数。 */
export const CONFIRMATION_MAX_PENDING = 10;
/** コードの長さ（Crockford base32。約 40 ビット）。 */
export const CONFIRMATION_CODE_LENGTH = 8;
const DONE_MAX = 100;
/** 受信箱の info を、操作ごとに出す間隔の下限（ミリ秒）。 */
export const NOTIFY_INTERVAL_MS = 10 * 60_000;

const CONFIRMABLE: ReadonlySet<string> = new Set(CONFIRMABLE_OPERATIONS);
export const isConfirmable = (op: DaemonOperation): op is ConfirmableOperation =>
  CONFIRMABLE.has(op);

type AnyResult = Result<unknown, Failure>;

interface Entry {
  readonly id: string;
  readonly key: string;
  readonly fingerprint: string;
  readonly request: HandlerRequest;
  readonly operation: ConfirmableOperation;
  readonly target: string;
  readonly salt: Buffer;
  readonly hash: Buffer;
  readonly expiresAtMs: number;
  attemptsLeft: number;
}

export interface ConfirmationGateDeps {
  readonly log: Pick<LogPort, "state" | "appendAll">;
  readonly clock: () => string;
  /** 壁時計（ミリ秒）。期限に使う。 */
  readonly nowMs?: () => number;
  readonly randomBytes?: (n: number) => Buffer;
  /** 制御端末（/dev/tty）に 1 行書く。書けなければ例外（確認待ちを作らない）。標準エラー・記録・ファイルには書かない。 */
  readonly writeTerminal: (line: string) => void;
  readonly throttle?: Throttle;
}

export interface ConfirmationGate {
  /** 対象の操作を確認待ちに包み、`confirm.approve`・`confirm.cancel` を足す。 */
  wrap(handlers: Handlers): Handlers;
  /** 画面に出す確認待ち（コードは含めない）。 */
  pending(): PendingConfirmation[];
  /** 確認待ちが変わるたびに増える数（画面の表示モデルの鍵に足す）。 */
  version(): number;
}

const sha = (salt: Buffer, code: string): Buffer =>
  createHash("sha256").update(salt).update(code, "utf8").digest();

const targetOf = (op: ConfirmableOperation, params: unknown): string => {
  const p = params as Record<string, unknown>;
  const t = op === "node.discardedDrop" ? p.target : p.nodeId;
  return typeof t === "string" ? t : "";
};

const required = (shortId: string): Failure =>
  failure(
    "confirmationRequired",
    `取り消せない操作なので、確認待ちにした（まだ実行していない。確認 ${shortId}…）`,
    "画面（/ui）のいちばん上の確認の欄で、daemon を起動した端末に出たコードを打つ",
    "やめるなら、画面の確認の欄で「取り消す」を押す（5 分で自動的に消える）",
  );

const invalid = (cause: string): Failure =>
  failure(
    "confirmationInvalid",
    cause,
    "daemon を起動した端末に出たコードを、そのまま打つ（大文字小文字・区切りは問わない）",
    "確認待ちが消えていたら、操作をもう一度呼んで、新しいコードで確認する",
  );

export function createConfirmationGate(deps: ConfirmationGateDeps): ConfirmationGate {
  const nowMs = deps.nowMs ?? Date.now;
  const random = deps.randomBytes ?? randomBytes;
  const throttle = deps.throttle ?? createThrottle({});
  const entries = new Map<string, Entry>();
  /** 要求（操作・要求 ID）→ 確認待ちの番号。同じ要求の再送で、新しいコードを出さない。 */
  const byKey = new Map<string, string>();
  /** 確認して実行した要求の結果（同じ要求の再送に返す。古いものから捨てる）。 */
  const done = new Map<string, { fingerprint: string; result: AnyResult | "running" }>();
  /** 操作ごとの、受信箱の info を最後に出した時刻（増えすぎないように。`NOTIFY_INTERVAL_MS` に 1 件まで）。 */
  const notifiedAt = new Map<ConfirmableOperation, number>();
  let ver = 0;

  const drop = (e: Entry): void => {
    entries.delete(e.id);
    byKey.delete(e.key);
    ver += 1;
  };
  const prune = (): void => {
    const now = nowMs();
    for (const e of [...entries.values()]) if (e.expiresAtMs <= now) drop(e);
  };
  const shortOf = (id: string): string => id.slice(3, 9);

  const newCode = (): string => {
    const b = random(CONFIRMATION_CODE_LENGTH);
    let s = "";
    // 32 は 256 を割り切るので、下位 5 ビットで一様になる。
    for (let i = 0; i < CONFIRMATION_CODE_LENGTH; i++) s += BIND_CODE_ALPHABET[(b[i] ?? 0) & 31];
    return s;
  };

  function notifyInbox(req: HandlerRequest, op: ConfirmableOperation): void {
    const root = deps.log.state().nodes.find((n) => n.parentId === null);
    if (root === undefined) return;
    // 記録には、操作の名前だけを書く（確認の番号・コード・対象の ID は書かない）。
    appendAtomically(
      deps.log as LogPort,
      deps.clock,
      `confirm-required/${req.requestId}`,
      { system: true },
      [
        {
          type: "inbox.added",
          payload: {
            id: deriveId("inbox", "system", req.requestId, `confirm-${op}`),
            kind: "info",
            nodeId: root.id,
            summary: summarize(
              `取り消せない操作（${op}）の確認待ちがある。画面のいちばん上の欄で、daemon を起動した端末に出たコードを打つ（5 分で消える。daemon を再起動しても消える）`,
            ),
          },
        },
      ],
    );
  }

  function gate(op: ConfirmableOperation, inner: (r: HandlerRequest) => unknown) {
    return async (req: HandlerRequest): Promise<AnyResult> => {
      if (req.role !== "human") return (await inner(req)) as AnyResult;
      prune();
      const key = `${op}\0${req.requestId}`;
      const fingerprint = JSON.stringify(req.params);
      const prior = done.get(key);
      if (prior !== undefined) {
        if (prior.fingerprint !== fingerprint)
          return {
            ok: false,
            error: failure(
              "requestIdConflict",
              "同じ requestId が、別の内容の要求に使われている",
              "新しい requestId で要求する",
            ),
          };
        if (prior.result === "running")
          return {
            ok: false,
            error: failure(
              "inProgress",
              "同じ要求を、確認して実行している最中",
              "少し待ってから、同じ要求をもう一度送る（結果が返る）",
            ),
          };
        return prior.result;
      }
      const existing = byKey.get(key);
      if (existing !== undefined) {
        const e = entries.get(existing);
        if (e !== undefined) {
          if (e.fingerprint !== fingerprint)
            return {
              ok: false,
              error: failure(
                "requestIdConflict",
                "同じ requestId が、別の内容の要求に使われている",
                "新しい requestId で要求する",
              ),
            };
          return { ok: false, error: required(shortOf(e.id)) };
        }
      }
      // 最終削除は、事前確認で実行できないと分かれば、確認待ちにせず、そのまま元の操作の失敗を返す（何も消さない）。
      if (op === "node.purge" && precheck !== undefined) {
        const pre = (await precheck({
          ...req,
          operation: "node.purgePreview",
          params: { nodeId: (req.params as { nodeId: string }).nodeId },
        })) as AnyResult;
        if (!pre.ok) return pre;
        if ((pre.value as { purgeable?: unknown }).purgeable === false)
          return (await inner(req)) as AnyResult;
      }
      if (entries.size >= CONFIRMATION_MAX_PENDING) {
        return {
          ok: false,
          error: failure(
            "confirmationLimit",
            `確認待ちが多すぎる（${CONFIRMATION_MAX_PENDING} 件まで）`,
            "画面の確認の欄で、確認するか取り消してから、もう一度呼ぶ",
          ),
        };
      }
      const id = `cf-${random(16).toString("hex")}`;
      const code = newCode();
      const salt = random(16);
      const expiresAtMs = nowMs() + CONFIRMATION_TTL_MS;
      const until = new Date(expiresAtMs).toISOString().slice(11, 16);
      try {
        deps.writeTerminal(
          `[cso] 確認コード ${code.slice(0, 4)}-${code.slice(4)}（${op}。確認 ${shortOf(id)}…。${until}Z まで。画面の確認の欄に打つ）`,
        );
      } catch {
        // 端末に書けない（端末なしで動いている）なら、確認できないので、確認待ちを作らない（フェイルクローズ）。
        return {
          ok: false,
          error: failure(
            "confirmationUnavailable",
            "daemon に端末がない（launchd などで動いている）ため、確認のコードを出せない。取り消せない操作は実行していない",
            "端末から daemon を起動し直してから、操作をもう一度呼ぶ",
          ),
        };
      }
      const e: Entry = {
        id,
        key,
        fingerprint,
        request: req,
        operation: op,
        target: targetOf(op, req.params),
        salt,
        hash: sha(salt, code),
        expiresAtMs,
        attemptsLeft: CONFIRMATION_ATTEMPTS,
      };
      entries.set(id, e);
      byKey.set(key, id);
      ver += 1;
      // 受信箱の info は、操作ごとに NOTIFY_INTERVAL_MS に 1 件まで（確認待ちのたびに増やさない）。
      const last = notifiedAt.get(op);
      if (last === undefined || nowMs() - last >= NOTIFY_INTERVAL_MS) {
        notifiedAt.set(op, nowMs());
        notifyInbox(req, op);
      }
      return { ok: false, error: required(shortOf(id)) };
    };
  }

  let precheck: ((r: HandlerRequest) => unknown) | undefined;

  function approve(inners: Partial<Record<ConfirmableOperation, (r: HandlerRequest) => unknown>>) {
    return async (req: HandlerRequest<"confirm.approve">): Promise<AnyResult> => {
      if (req.role !== "human")
        return {
          ok: false,
          error: failure("forbidden", "確認は人間だけができる", "人が画面で確認する"),
        };
      const wait = throttle.blocked();
      if (wait !== undefined)
        return { ok: false, error: invalid("確認の失敗が多すぎる（少し待つ）") };
      const e = entries.get(req.params.confirmationId);
      if (e === undefined) {
        throttle.fail();
        return {
          ok: false,
          error: invalid(
            "確認待ちがない（確認済み・取り消し・試行の上限・daemon の再起動で消えた）",
          ),
        };
      }
      if (e.expiresAtMs <= nowMs()) {
        drop(e);
        return {
          ok: false,
          error: failure(
            "confirmationExpired",
            "確認待ちの期限が過ぎた（実行していない）",
            "操作をもう一度呼んで、新しいコードで確認する",
          ),
        };
      }
      const given = normalizeBindCode(req.params.code);
      const match =
        given.length === CONFIRMATION_CODE_LENGTH && timingSafeEqual(sha(e.salt, given), e.hash);
      if (!match) {
        throttle.fail();
        e.attemptsLeft -= 1;
        ver += 1;
        if (e.attemptsLeft <= 0) {
          drop(e);
          return {
            ok: false,
            error: invalid(
              "コードが違う。試行の上限に達したので、確認待ちを捨てた（実行していない）",
            ),
          };
        }
        return { ok: false, error: invalid(`コードが違う（残り ${e.attemptsLeft} 回）`) };
      }
      drop(e); // 一度きり: 実行の前に消す
      // 実行中の印を先に置く（実行の最中に同じ要求が届いても、新しい確認待ちを作らない）
      done.set(e.key, { fingerprint: e.fingerprint, result: "running" });
      const inner = inners[e.operation];
      if (inner === undefined)
        return {
          ok: false,
          error: failure("notImplemented", `操作 ${e.operation} は未実装`, "実装の完了を待つ"),
        };
      let r: AnyResult;
      try {
        r = (await inner(e.request)) as AnyResult;
      } catch (err) {
        r = {
          ok: false,
          error: failure("internal", `実行に失敗した（${String(err)}）`, "記録とログを確かめる"),
        };
      }
      done.set(e.key, { fingerprint: e.fingerprint, result: r });
      while (done.size > DONE_MAX) {
        const first = done.keys().next().value;
        if (first === undefined) break;
        done.delete(first);
      }
      if (!r.ok) return r;
      const picked = pickResult(e.operation, r.value) ?? {};
      return { ok: true, value: { executed: true, operation: e.operation, result: picked } };
    };
  }

  return {
    wrap(handlers) {
      const out: Record<string, unknown> = { ...handlers };
      const inners: Partial<Record<ConfirmableOperation, (r: HandlerRequest) => unknown>> = {};
      for (const op of CONFIRMABLE_OPERATIONS) {
        const h = handlers[op] as ((r: HandlerRequest) => unknown) | undefined;
        if (h === undefined) continue;
        inners[op] = h;
        out[op] = gate(op, h);
      }
      precheck = handlers["node.purgePreview"] as ((r: HandlerRequest) => unknown) | undefined;
      out["confirm.approve"] = approve(inners);
      out["confirm.cancel"] = (req: HandlerRequest<"confirm.cancel">): AnyResult => {
        const e = entries.get(req.params.confirmationId);
        if (e === undefined)
          return {
            ok: false,
            error: invalid(
              "確認待ちがない（確認済み・取り消し・期限切れ・daemon の再起動で消えた）",
            ),
          };
        drop(e);
        return { ok: true, value: { cancelled: true } };
      };
      return out as Handlers;
    },
    pending() {
      prune();
      return [...entries.values()].map((e) => ({
        confirmationId: e.id,
        shortId: shortOf(e.id),
        operation: e.operation,
        target: e.target,
        expiresAt: new Date(e.expiresAtMs).toISOString(),
        attemptsLeft: e.attemptsLeft,
      }));
    },
    version() {
      prune();
      return ver;
    },
  };
}
