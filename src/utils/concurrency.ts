/**
 * Run async work with a fixed parallelism limit (registry-friendly).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const cap = Math.max(1, Math.floor(limit));
  const results: R[] = new Array(items.length);
  let next = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) {
        return;
      }
      results[i] = await fn(items[i]!, i);
    }
  }

  const workers = Array.from({ length: Math.min(cap, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
