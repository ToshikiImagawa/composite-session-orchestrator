/** 窓口のハンドラをまとめる。操作の追加ごとに、ここへ足す（足していない操作は 501）。 */

import { createReadHandlers } from "../read-handlers.js";
import type { Handlers } from "../server.js";
import { createReclaimHandlers, type ReclaimPorts } from "./reclaim-handlers.js";
import { createRuntimeHandlers, type RuntimeHandlerDeps } from "./runtime-handlers.js";
import { createSpawnHandlers, type SpawnHandlerDeps } from "./spawn-handlers.js";
import { createStateHandlers, type StateHandlerDeps } from "./state-handlers.js";

export type { LogPort } from "./context.js";
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
  spawn?: Pick<SpawnHandlerDeps, "ports" | "credentials" | "onFailure">,
): Handlers {
  const rt = runtime === undefined ? undefined : createRuntimeHandlers({ ...deps, ...runtime });
  return {
    ...createReadHandlers(() => deps.log.state()),
    ...createStateHandlers(deps),
    ...(rt === undefined ? {} : rt),
    ...(reclaim === undefined ? {} : createReclaimHandlers({ ...deps, ports: reclaim })),
    ...(rt === undefined || runtime === undefined || spawn === undefined
      ? {}
      : createSpawnHandlers({
          ...deps,
          ...spawn,
          adapterFor: runtime.adapterFor,
          stop: rt["node.stop"],
        })),
  } as Handlers;
}
