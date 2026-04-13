import semver from 'semver';

/** Max candidates after `latest` (per strategy). */
export const DEFAULT_MAX_FALLBACK_LINES = 40;

export type FallbackLineMode = 'major' | 'minor';

/**
 * Build an ordered list of concrete versions to try after `@latest` fails.
 *
 * - **major**: one best stable version per **major** (e.g. 9.6.1 → 8.0.1 → 7.2.0 …).
 *   Fewer installs; best when whole majors change behavior (ESM-only, breaking API).
 * - **minor**: one best stable version per **(major.minor)** line (finer steps).
 *
 * Always tries `registryLatest` first, then walks the generated lines in semver-desc order.
 */
export function buildLineFallbackOrder(
  currentVersion: string,
  registryLatest: string,
  allPublishedVersions: string[],
  mode: FallbackLineMode,
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

  const seen = new Set<string>();
  const onePerLine: string[] = [];
  for (const v of newerThanCurrent) {
    const p = semver.parse(v);
    if (!p) {
      continue;
    }
    const key = mode === 'major' ? String(p.major) : `${p.major}.${p.minor}`;
    if (!seen.has(key)) {
      seen.add(key);
      onePerLine.push(v);
      if (onePerLine.length >= maxLines) {
        break;
      }
    }
  }

  const ordered: string[] = [];
  const pushUnique = (ver: string): void => {
    if (semver.valid(ver) && !ordered.includes(ver)) {
      ordered.push(ver);
    }
  };

  if (semver.gt(registryLatest, cur)) {
    pushUnique(registryLatest);
  }
  for (const v of onePerLine) {
    pushUnique(v);
  }

  return ordered.slice(0, maxLines);
}

/** @deprecated use buildLineFallbackOrder(..., 'minor') */
export function buildMinorLineFallbackOrder(
  currentVersion: string,
  registryLatest: string,
  allPublishedVersions: string[],
  maxLines = DEFAULT_MAX_FALLBACK_LINES,
): string[] {
  return buildLineFallbackOrder(currentVersion, registryLatest, allPublishedVersions, 'minor', maxLines);
}
