import semver from 'semver';
import { fetchAllPublishedVersions } from '../utils/npm.js';
import type { RegistryCache } from '../utils/concurrency.js';

export interface ResolverContext {
  getManifestAtVersion: (name: string, version: string) => Promise<unknown>;
  /** Optional shared registry cache (deduplicates identical fetches across calls). */
  registryCache?: RegistryCache;
}

/**
 * True if version `v` satisfies every npm range in the list.
 */
export function satisfiesAllPeerRanges(v: string, ranges: string[]): boolean {
  for (const r of ranges) {
    const range = r.trim();
    if (!range) {
      continue;
    }
    if (semver.validRange(range) == null && semver.coerce(range) == null) {
      continue;
    }
    if (!semver.satisfies(v, range, { includePrerelease: true })) {
      return false;
    }
  }
  return true;
}

/**
 * Find highest published version of `packageName` that satisfies every range in `mustSatisfy`.
 * Ranges come from peerDependencies (or similar) of other packages in the same group.
 */
export async function findHighestCompatibleVersion(
  packageName: string,
  mustSatisfy: string[],
  ctx?: ResolverContext,
): Promise<string | null> {
  const ranges = mustSatisfy.map((r) => r.trim()).filter(Boolean);
  if (ranges.length === 0) {
    return null;
  }

  let versions: string[];
  try {
    versions = await fetchAllPublishedVersions(packageName, ctx?.registryCache);
  } catch {
    return null;
  }

  const candidates = versions
    .filter((v) => semver.valid(v) && satisfiesAllPeerRanges(v, ranges))
    .sort((a, b) => semver.rcompare(a, b));

  return candidates[0] ?? null;
}

export type ResolutionStrategy =
  | { type: 'freeze'; packageName: string }
  | { type: 'tryVersion'; packageName: string; version: string }
  | { type: 'removeOptional'; packageName: string }
  | { type: 'force' };

export function buildStrategyList(opts: {
  packageNames: string[];
  optionalPackageNames: Set<string>;
}): ResolutionStrategy[] {
  const strategies: ResolutionStrategy[] = [];
  for (const p of opts.packageNames) {
    strategies.push({ type: 'freeze', packageName: p });
    strategies.push({ type: 'tryVersion', packageName: p, version: 'latest' });
    if (opts.optionalPackageNames.has(p)) {
      strategies.push({ type: 'removeOptional', packageName: p });
    }
  }
  strategies.push({ type: 'force' });
  return strategies;
}
