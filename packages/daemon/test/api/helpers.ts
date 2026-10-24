export const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/**
 * 条件が成り立つまで待つ（上限つき）。固定の `sleep` は、負荷が高いと、要求がサーバーに届く前に終わってしまうので、
 * 「届いた・動いた」は、観測できる事実で待つ。`read` が返す値を `done` で判定し、上限を超えたら、最後に見た値を添えて失敗する（黙って進めない）。
 */
export const waitFor = async <T>(
  what: string,
  read: () => T | Promise<T>,
  done: (value: T) => boolean = Boolean,
  timeoutMs = 10_000,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(`待ちきれなかった: ${what}（最後に見た値: ${JSON.stringify(value)}）`);
    }
    await sleep(2);
  }
};
