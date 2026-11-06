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
