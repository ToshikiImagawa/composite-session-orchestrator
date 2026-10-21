/**
 * 同じ呼び出し元・同じ requestId の処理を、同時に 1 つだけ走らせる（同じ Promise を共有する）。
 * 内容の指紋が違えば `requestIdConflict`。終わったら外す（以降の再試行は、記録を見て判定する）。
 * `node.spawn`・`node.split`・`node.send`・`node.review` が使う。
 */

import { type Failure, failure, type Result } from "@cso/core";

export type Exclusive = <T>(
  key: string,
  fingerprint: string,
  run: () => Promise<Result<T, Failure>>,
) => Promise<Result<T, Failure>>;

export function createExclusive(): Exclusive {
  const inflight = new Map<
    string,
    { fingerprint: string; promise: Promise<Result<unknown, Failure>> }
  >();
  return function exclusive<T>(
    key: string,
    fingerprint: string,
    run: () => Promise<Result<T, Failure>>,
  ): Promise<Result<T, Failure>> {
    const running = inflight.get(key);
    if (running !== undefined) {
      if (running.fingerprint !== fingerprint) {
        return Promise.resolve({
          ok: false,
          error: failure(
            "requestIdConflict",
            "同じ requestId で、処理中の要求と内容が違う",
            "別の requestId で要求する",
          ),
        });
      }
      return running.promise as Promise<Result<T, Failure>>;
    }
    const promise = run().finally(() => inflight.delete(key));
    inflight.set(key, { fingerprint, promise });
    return promise;
  };
}
