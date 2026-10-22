/** 窓口のハンドラをまとめる。操作の追加ごとに、ここへ足す（足していない操作は 501）。 */

import { createReadHandlers } from "../read-handlers.js";
import type { Handlers } from "../server.js";
import { createInstructionDelivery } from "./instruction-delivery.js";
import { createPauseHandlers } from "./pause-handlers.js";
import { createPurgeHandlers, type PurgeHandlerDeps } from "./purge-handlers.js";
import { createReclaimHandlers, type ReclaimPorts } from "./reclaim-handlers.js";
import { createRuntimeHandlers, type RuntimeHandlerDeps } from "./runtime-handlers.js";
import { createScopeHandlers } from "./scope-handlers.js";
import { createSpawner, type SpawnHandlerDeps } from "./spawn-handlers.js";
import { createStateHandlers, type StateHandlerDeps } from "./state-handlers.js";

export type { LogPort } from "./context.js";
export { createPauseHandlers, type PauseHandlerDeps } from "./pause-handlers.js";
export {
  createPurgeHandlers,
  type PurgeHandlerDeps,
  type PurgeMarkerInfo,
} from "./purge-handlers.js";
export {
  createReclaimHandlers,
  type ReclaimHandlerDeps,
  type ReclaimPorts,
  type WorktreeFacts,
} from "./reclaim-handlers.js";
export {
  createRuntimeHandlers,
  operationsFor,
  type RuntimeHandlerDeps,
} from "./runtime-handlers.js";
export { createScopeHandlers, type ScopeHandlerDeps } from "./scope-handlers.js";
export {
  createSpawner,
  createSpawnHandlers,
  type SpawnHandlerDeps,
  type SpawnPorts,
} from "./spawn-handlers.js";
export { createStateHandlers, type StateHandlerDeps } from "./state-handlers.js";

/**
 * `runtime` を渡すと、アダプタを伴う操作（node.send・node.stop・node.capabilities）も有効になる。
 * `spawn` を渡すと（`runtime` も必要）、子の生成（node.spawn・node.split）も有効になる。
 */
export function createHandlers(...args: Parameters<typeof createHandlersWithScheduler>): Handlers {
  return createHandlersWithScheduler(...args).handlers;
}

/**
 * `createHandlers` に加えて、スケジューラ（依存が揃った pending の子を起動する `tick`）を返す。`spawn` がなければ
 * `tick` は何もしない。`report.done`・`node.review` が成功したら、`tick` を（待たずに）呼ぶ。daemon の起動時にも呼ぶ。
 */
export function createHandlersWithScheduler(
  deps: StateHandlerDeps,
  runtime?: Pick<RuntimeHandlerDeps, "adapterFor" | "onStopSettled">,
  /** 渡すと、回収の操作（node.reclaimPreview・node.reclaim）も有効になる。 */
  reclaim?: ReclaimPorts,
  spawn?: Pick<
    SpawnHandlerDeps,
    "ports" | "credentials" | "rootScope" | "onFailure" | "startLimits"
  >,
  /** 渡すと（ログが `purgeTree` を持つとき）、最終削除の操作（node.purge・node.purgePreview）も有効になる。 */
  purge?: Omit<PurgeHandlerDeps, "log">,
): { handlers: Handlers; tick: () => Promise<void>; close: () => Promise<void> } {
  const onFailure = spawn?.onFailure === undefined ? {} : { onFailure: spawn.onFailure };
  // 追加指示の配送は、node.send と node.review（差し戻しの理由）で共有する。
  const delivery =
    runtime === undefined
      ? undefined
      : createInstructionDelivery({ ...deps, adapterFor: runtime.adapterFor, ...onFailure });
  const rt =
    runtime === undefined
      ? undefined
      : createRuntimeHandlers({
          ...deps,
          ...runtime,
          ...(delivery === undefined ? {} : { delivery }),
        });
  // 子の生成（spawn）のポートとアダプタがそろうと、判断待ちの子の一時停止・再開（pauseNodeIds）と、範囲の拡張
  // （scope.extend・scope.decide）も有効になる（作業ツリーの取得 `cwdOf`・根の範囲 `rootScope` を共有する）。
  const full = rt !== undefined && runtime !== undefined && spawn !== undefined;
  const state = createStateHandlers({
    ...deps,
    allowPause: full,
    ...(delivery === undefined
      ? {}
      : { deliver: delivery.deliver, canDeliver: delivery.available }),
  });
  const spawner = !full
    ? undefined
    : createSpawner({
        ...deps,
        ...spawn,
        adapterFor: runtime.adapterFor,
        stop: rt["node.stop"],
      });
  const running = new Set<Promise<void>>();
  let closed = false;
  const tick = (): Promise<void> => {
    if (closed || spawner === undefined) return Promise.resolve();
    const p: Promise<void> = spawner
      .tick()
      .catch((e) => spawn?.onFailure?.("", `スケジューラが失敗: ${String(e)}`))
      .finally(() => running.delete(p));
    running.add(p);
    return p;
  };
  /** 新しい tick を受け付けなくし、実行中の tick が終わるのを待つ（daemon の停止で使う）。 */
  const close = async (): Promise<void> => {
    closed = true;
    while (running.size > 0) await Promise.all([...running]);
  };
  // 依存先の完了（report.done・node.review）の後で、依存が揃った子を起動する（応答は待たせない）。
  const after =
    <Q, T extends { ok: boolean }>(run: (req: Q) => T | Promise<T>) =>
    async (req: Q): Promise<T> => {
      const r = await run(req);
      if (r.ok) void tick();
      return r;
    };
  const purgeTree = deps.log.purgeTree?.bind(deps.log);
  const checkPurge = deps.log.checkPurge?.bind(deps.log);
  const built = {
    ...createReadHandlers(() => deps.log.state()),
    ...state,
    ...(rt === undefined ? {} : rt),
    ...(reclaim === undefined ? {} : createReclaimHandlers({ ...deps, ports: reclaim })),
    ...(purgeTree === undefined || checkPurge === undefined || purge === undefined
      ? {}
      : createPurgeHandlers({
          ...purge,
          log: {
            state: () => deps.log.state(),
            purgeTree,
            checkPurge,
            appendAll: (rs) => deps.log.appendAll(rs),
          },
        })),
    ...(!full
      ? {}
      : {
          ...spawner?.handlers,
          ...createPauseHandlers({
            ...deps,
            present: state["decision.present"],
            answer: state["decision.answer"],
            stop: rt["node.stop"],
            adapterFor: runtime.adapterFor,
            ports: spawn.ports,
            credentials: spawn.credentials,
            ...onFailure,
          }),
          ...createScopeHandlers({
            ...deps,
            adapterFor: runtime.adapterFor,
            cwdOf: spawn.ports.cwdOf,
            ...(spawn.rootScope === undefined ? {} : { rootScope: spawn.rootScope }),
            ...onFailure,
          }),
        }),
  } as Handlers;
  // 依存先の完了（report.done・node.review）と、判断への回答による再開（decision.answer）の後で、起動できる子を起動する。
  const handlers: Handlers = { ...built };
  if (spawner !== undefined) {
    for (const op of ["report.done", "node.review", "decision.answer"] as const) {
      const run = built[op] as ((req: never) => unknown) | undefined;
      if (run !== undefined) (handlers as Record<string, unknown>)[op] = after(run as never);
    }
  }
  return { handlers, tick, close };
}
