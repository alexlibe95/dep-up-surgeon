import semver from 'semver';

/** Max distinct (major.minor) release lines to try after `latest` fails. */
export const DEFAULT_MAX_FALLBACK_LINES = 40;

/**
 * When upgrading past the current version, npm's `latest` tag may point at a
 * release that breaks this project (ESM-only jump, TypeScript major, etc.).
 * Build an ordered list of concrete versions to try:
 *
 * 1. Always `registryLatest` first (the `@latest` dist-tag).
 * 2. Then, walking **down** semver order, one **best patch per (major.minor)
 *    line** — equivalent to trying "one minor line below" repeatedly across
 *    both patch and minor/major boundaries.
 *
 * Example: current `5.1.1`, and `9.6.1` is `@latest` → try
 * `9.6.1`, then max `9.5.*`, max `9.4.*`, … then `8.x` lines, etc.
 */
export function buildMinorLineFallbackOrder(
  currentVersion: string,
  registryLatest: string,
  allPublishedVersions: string[],
  maxLines = DEFAULT_MAX_FALLBACK_LINES,
): string[] {
  const cur = semver.coerce(currentVersion);
  if (!cur) {
    return semver.valid(registryLatest) ? [registryLatest] : [];
  }

  const stable = allPublishedVersions
    .filter((v) => semver.valid(v))
    .filter((v) => !semver.prerelease(v));

  const newerThanCurrent = stable
    .filter((v) => semver.gt(v, cur))
    .sort(semver.rcompare);

  /** One representative per (major.minor): first in desc order = highest patch. */
  const seenMinorLine = new Set<string>();
  const onePerMinorLine: string[] = [];
  for (const v of newerThanCurrent) {
    const p = semver.parse(v);
    if (!p) {
      continue;
    }
    const key = `${p.major}.${p.minor}`;
    if (!seenMinorLine.has(key)) {
      seenMinorLine.add(key);
      onePerMinorLine.push(v);
      if (onePerMinorLine.length >= maxLines) {
        break;
      }
    }
  }

  const ordered: string[] = [];
  const pushUnique = (v: string): void => {
    if (semver.valid(v) && !ordered.includes(v)) {
      ordered.push(v);
    }
  };

  if (semver.gt(registryLatest, cur)) {
    pushUnique(registryLatest);
  }
  for (const v of onePerMinorLine) {
    pushUnique(v);
  }

  return ordered.slice(0, maxLines);
}
