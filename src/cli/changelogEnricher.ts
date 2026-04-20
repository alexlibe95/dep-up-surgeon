/**
 * Batch changelog enrichment for the structured report. Called once after the upgrade flow
 * completes to fill in `UpgradeRecord.changelog` for every successful upgrade, so the summary
 * writer (`--summary md|html`) and CI consumers can show release notes per package.
 *
 * Design notes:
 *   - Network-bound; we cap parallelism with `runWithConcurrency` so a monorepo that upgrades
 *     50 packages doesn't fire 50 simultaneous GitHub API calls.
 *   - Every failure is swallowed. Enrichment is a courtesy feature — a 503 from the registry
 *     or a missing `CHANGELOG.md` must NEVER mutate the exit code.
 *   - The cache is shared with the git-commit path when both are active, so a package committed
 *     with its changelog during the run is not fetched a second time for the summary.
 */
import type { UpgradeRecord } from '../types.js';
import { runWithConcurrency } from '../utils/concurrency.js';
import {
  fetchChangelog,
  type ChangelogCache,
  type ChangelogFetchers,
} from '../utils/changelog.js';

export interface EnrichChangelogOptions {
  cache: ChangelogCache;
  /** Max concurrent fetches. Kept small to respect GitHub's unauth rate limit (~60/h/IP). */
  concurrency?: number;
  fetchers?: ChangelogFetchers;
  githubToken?: string;
}

/**
 * Mutate `records` in place: attach `.changelog` to every successful upgrade we can find a
 * release note for. Records without a real semver `to` (e.g. `workspace:*`) are skipped.
 */
export async function enrichWithChangelogs(
  records: UpgradeRecord[],
  opts: EnrichChangelogOptions,
): Promise<void> {
  const eligible = records.filter((r) => {
    if (!r.success || r.skipped) {
      return false;
    }
    if (r.changelog) {
      // Already enriched (e.g. by the git-commit path) — skip the duplicate fetch.
      return false;
    }
    const clean = (r.to ?? '').trim().replace(/^[\^~=]/, '');
    return /^\d+\.\d+\.\d+/.test(clean);
  });

  if (eligible.length === 0) {
    return;
  }

  const concurrency = Math.min(Math.max(1, Math.floor(opts.concurrency ?? 4)), 8);

  await runWithConcurrency(
    eligible,
    concurrency,
    async (r) => {
      const clean = (r.to ?? '').trim().replace(/^[\^~=]/, '');
      try {
        const excerpt = await fetchChangelog({
          packageName: r.name,
          toVersion: clean,
          fromVersion: r.from,
          cache: opts.cache,
          fetchers: opts.fetchers,
          githubToken: opts.githubToken,
        });
        if (excerpt) {
          r.changelog = {
            source: excerpt.source,
            url: excerpt.url,
            body: excerpt.body,
          };
        }
      } catch {
        // swallow: enrichment is best-effort
      }
    },
  );
}
