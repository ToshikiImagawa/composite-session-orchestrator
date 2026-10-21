/** 窓口のハンドラをまとめる。操作の追加ごとに、ここへ足す（足していない操作は 501）。 */

import { createReadHandlers } from "../read-handlers.js";
import type { Handlers } from "../server.js";
import { createInstructionDelivery } from "./instruction-delivery.js";
import { createPauseHandlers } from "./pause-handlers.js";
import { createReclaimHandlers, type ReclaimPorts } from "./reclaim-handlers.js";
import { createRuntimeHandlers, type RuntimeHandlerDeps } from "./runtime-handlers.js";
import { createScopeHandlers } from "./scope-handlers.js";
import { createSpawnHandlers, type SpawnHandlerDeps } from "./spawn-handlers.js";
import { createStateHandlers, type StateHandlerDeps } from "./state-handlers.js";

export type { LogPort } from "./context.js";
export { createPauseHandlers, type PauseHandlerDeps } from "./pause-handlers.js";
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
export { createSpawnHandlers, type SpawnHandlerDeps, type SpawnPorts } from "./spawn-handlers.js";
export { createStateHandlers, type StateHandlerDeps } from "./state-handlers.js";

/**
 * `runtime` を渡すと、アダプタを伴う操作（node.send・node.stop・node.capabilities）も有効になる。
 * `spawn` を渡すと（`runtime` も必要）、子の生成（node.spawn・node.split）も有効になる。
 */
export function createHandlers(
  deps: StateHandlerDeps,
  runtime?: Pick<RuntimeHandlerDeps, "adapterFor" | "onStopSettled">,
  /** 渡すと、回収の操作（node.reclaimPreview・node.reclaim）も有効になる。 */
  reclaim?: ReclaimPorts,
  spawn?: Pick<SpawnHandlerDeps, "ports" | "credentials" | "rootScope" | "onFailure">,
): Handlers {
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
    ...(delivery === undefined ? {} : { deliver: delivery.deliver }),
  });
  return {
    ...createReadHandlers(() => deps.log.state()),
    ...state,
    ...(rt === undefined ? {} : rt),
    ...(reclaim === undefined ? {} : createReclaimHandlers({ ...deps, ports: reclaim })),
    ...(!full
      ? {}
      : {
          ...createSpawnHandlers({
            ...deps,
            ...spawn,
            adapterFor: runtime.adapterFor,
            stop: rt["node.stop"],
          }),
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
}
