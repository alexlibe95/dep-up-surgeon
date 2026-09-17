import semver from 'semver';
import type { RegistryCache } from './concurrency.js';
import { fetchAllPublishedVersions } from './npm.js';

/**
 * Newest stable version in `installed`'s major line, when it is newer than `installed`.
 *
 * Pure helper behind {@link correctLaggingLatest}.
 */
export function newestInMajor(installed: string, versions: readonly string[]): string | undefined {
  const current = semver.parse(installed);
  if (!current) {
    return undefined;
  }
  let best: string | undefined;
  for (const version of versions) {
    if (!semver.valid(version) || semver.prerelease(version)) continue;
    if (semver.major(version) !== current.major) continue;
    if (!semver.gt(version, current)) continue;
    if (!best || semver.gt(version, best)) best = version;
  }
  return best;
}

export interface EffectiveLatest {
  /** The version to treat as "latest" for this install. */
  latest: string;
  /** Set when the registry `latest` dist-tag lags behind the installed major: the tag's value. */
  laggingTag?: string;
}

/**
 * The registry `latest` dist-tag, corrected when it lags behind the installed major.
 *
 * Packages that publish several majors in parallel can leave `latest` on an older line: when
 * DefinitelyTyped published `@types/node@22.20.3` seconds after `26.6.1`, `latest` moved to
 * 22.20.3. Compared with that tag, an install on 26.5.1 looks "ahead of latest" and its 26.6.1
 * update is never offered. When `installed` is newer than the tag, the newest stable release of
 * the installed major is used instead (if there is a newer one). Majors above the installed one
 * are still never proposed: a line staged under another dist-tag isn't released yet.
 */
export async function correctLaggingLatest(
  name: string,
  installed: string | undefined,
  tagLatest: string,
  cache?: RegistryCache,
): Promise<EffectiveLatest> {
  if (!installed || !semver.valid(installed) || !semver.valid(tagLatest) || !semver.gt(installed, tagLatest)) {
    return { latest: tagLatest };
  }
  let versions: string[];
  try {
    versions = await fetchAllPublishedVersions(name, cache);
  } catch {
    return { latest: tagLatest };
  }
  const newer = newestInMajor(installed, versions);
  return newer ? { latest: newer, laggingTag: tagLatest } : { latest: tagLatest };
}
