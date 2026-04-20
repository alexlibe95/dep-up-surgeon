/**
 * Tiny concurrency utilities used by the multi-target orchestrator (`runUpgradeFlow`).
 *
 * We deliberately avoid `p-limit` / `p-queue` to keep the dependency footprint small —
 * everything below is a few lines of stdlib-only code with the semantics we need.
 */

/**
 * A minimal asynchronous mutex. `runExclusive(fn)` queues `fn` so that at most ONE call is
 * in flight at a time, and FIFO ordering is preserved (callers see the same order they
 * acquired the lock in). Errors don't poison the queue — a thrown call still releases the
 * lock for the next waiter.
 *
 * Used by the engine to serialize lockfile-touching operations (install + validate) when
 * multiple workspace targets traverse in parallel: scanning + plan-building can race freely,
 * but everything that mutates `node_modules` / `package-lock.json` must happen one at a time.
 */
export class AsyncMutex {
  private last: Promise<unknown> = Promise.resolve();

  async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Chain off the previous promise BUT swallow its result/rejection so a poisoned ancestor
    // never leaks into our caller. Callers see only their own fn's outcome.
    const next = this.last.then(
      () => fn(),
      () => fn(),
    );
    this.last = next.then(
      () => undefined,
      () => undefined,
    );
    return next as Promise<T>;
  }
}

/**
 * Run `worker` for every item in `items` with at most `concurrency` in flight at any time.
 * Returns results in the **original input order** (not completion order) so callers can
 * deterministically merge / display per-item output.
 *
 * `concurrency <= 1` falls back to a serial loop, which keeps log ordering stable for the
 * common single-target case and avoids spawning unnecessary microtask churn.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const results: R[] = new Array(n);
  const limit = Math.max(1, Math.min(concurrency, n));

  if (limit === 1) {
    for (let i = 0; i < n; i++) {
      results[i] = await worker(items[i], i);
    }
    return results;
  }

  let cursor = 0;
  const workers: Promise<void>[] = [];
  for (let w = 0; w < limit; w++) {
    workers.push(
      (async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= n) {
            return;
          }
          results[idx] = await worker(items[idx], idx);
        }
      })(),
    );
  }
  await Promise.all(workers);
  return results;
}

/**
 * In-process registry fetch cache shared across targets (and across engine calls within one
 * `runUpgradeFlow`). Even at `--concurrency 1`, the same dependency name often appears in
 * multiple workspace members → we'd otherwise issue N redundant `pacote.manifest` /
 * `pacote.packument` requests for the same package. Caching by package name collapses those
 * to a single in-flight promise per name.
 *
 * Keys are bare package names (e.g. `"axios"`, `"@scope/pkg"`). Values are the in-flight
 * promise (NOT the resolved value) so concurrent callers share the same fetch instead of
 * racing two HTTP requests.
 */
export interface RegistryCache {
  /** `pkgName -> Promise<latest version string>` */
  latest: Map<string, Promise<string>>;
  /** `pkgName -> Promise<all published version strings>` */
  versions: Map<string, Promise<string[]>>;
  /**
   * `pkgName -> Promise<version -> peerDependencies>`. Populated on demand by the peer-range
   * intersection resolver. We cache the entire per-version peer map rather than per-version
   * individually so one `pacote.packument` call serves every backtracking probe for that
   * package in a given run.
   */
  peers: Map<string, Promise<Map<string, VersionPeers>>>;
}

/**
 * Per-published-version slice of a packument entry that the peer resolver cares about.
 * `deprecated` is the raw string (when the version was marked deprecated) so the resolver can
 * skip it; everything else is the shape that powers the actual range-intersection search.
 */
export interface VersionPeers {
  peerDependencies: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  deprecated?: string;
}

export function createRegistryCache(): RegistryCache {
  return { latest: new Map(), versions: new Map(), peers: new Map() };
}

/**
 * Run async work with a fixed parallelism limit (registry-friendly). Older API used by the
 * dependency-graph builder. New code should prefer `runWithConcurrency`, which has the same
 * semantics but a slightly cleaner signature; this export is preserved for backwards
 * compatibility with existing call sites in `core/graph.ts`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  return runWithConcurrency(items, limit, fn);
}
