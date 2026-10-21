/** 窓口のハンドラをまとめる。操作の追加ごとに、ここへ足す（足していない操作は 501）。 */

import { createReadHandlers } from "../read-handlers.js";
import type { Handlers } from "../server.js";
import { createStateHandlers, type StateHandlerDeps } from "./state-handlers.js";

export type { LogPort } from "./context.js";
export { createStateHandlers, type StateHandlerDeps } from "./state-handlers.js";

export function createHandlers(deps: StateHandlerDeps): Handlers {
  return {
    ...createReadHandlers(() => deps.log.state()),
    ...createStateHandlers(deps),
  } as Handlers;
}
