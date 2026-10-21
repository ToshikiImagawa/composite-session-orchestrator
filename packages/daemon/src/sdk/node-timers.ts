/** 実時間のタイマー（`Timers` の実装）。 */

import type { Timers } from "./runtime.js";

export const nodeTimers: Timers = {
  now: () => Date.now(),
  after(ms) {
    let handle: NodeJS.Timeout | undefined;
    const promise = new Promise<void>((resolve) => {
      handle = setTimeout(resolve, ms);
    });
    return {
      promise,
      cancel() {
        if (handle !== undefined) clearTimeout(handle);
      },
    };
  },
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
