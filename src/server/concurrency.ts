/**
 * Calls `fn` for each item with at most `limit` calls running at once, starting the next as soon as
 * any one finishes, so a slow item never holds up the others the way fixed batches do. Results keep
 * the items' order. A rejection rejects the whole map, as Promise.all does; callers that want every
 * item's outcome catch inside `fn`.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker));
  return results;
}
/**
 * A gate that runs at most `limit` calls at once and starts each queued one, in order, as soon as a running one settles,
 * fulfilled or rejected. Each call's promise is its own, so a caller can stop waiting for it while it goes on.
 */
export function limiter(limit: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  const next = () => { running--; queue.shift()?.(); };
  return <R>(fn: () => Promise<R>): Promise<R> => new Promise<R>((resolve, reject) => {
    const run = () => { running++; fn().then(resolve, reject).finally(next); };
    if (running < Math.max(1, limit)) run(); else queue.push(run);
  });
}
