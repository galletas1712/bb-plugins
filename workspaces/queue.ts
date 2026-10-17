/** Runs tasks one at a time per key, in call order. A failed task does not stop the ones queued behind it. */
export function keyedQueue(): <T>(key: string, run: () => Promise<T>) => Promise<T> {
  const tails = new Map<string, Promise<unknown>>();
  return async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const current = (tails.get(key) ?? Promise.resolve()).catch(() => undefined).then(run);
    tails.set(key, current);
    try {
      return await current;
    } finally {
      if (tails.get(key) === current) tails.delete(key);
    }
  };
}
