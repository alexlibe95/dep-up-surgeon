/**
 * Peer-range intersection resolver.
 *
 * When a linked batch (e.g. `react` + `react-dom` + `@types/react`) fails with a peer
 * conflict — typically because one member's "latest" demands a peer version another member
 * can't satisfy — instead of rolling the whole batch back we try to find a TUPLE of versions,
 * one per linked package, whose mutual + external peer constraints are all satisfiable.
 *
 * This is a bounded constraint-satisfaction problem (CSP):
 *
 *   - Variables: the linked package names.
 *   - Domain for each: the set of published versions filtered to the "interesting" window
 *     (≥ currentVersion, ≤ requestedTarget). Ordered newest-first.
 *   - Constraints: for every ordered pair (A, B) in the tuple where A@version.peerDeps[B] is
 *     set, B's chosen version must satisfy that range. Peers on packages OUTSIDE the linked
 *     set are checked against the "currently installed" ranges from the workspace package.json
 *     (best-effort via `semver.minVersion`).
 *
 * We enumerate tuples with a newest-first backtracking search so the FIRST solution we find
 * is also the "least-downgrade" solution — the whole point of the resolver is to stay as
 * close to the user's requested targets as possible while getting the install to pass.
 *
 * Scope + non-goals:
 *   - Only affects LINKED GROUPS (never single-package upgrades). A single package bump
 *     that fails with peer conflicts is still rolled back as today.
 *   - Optional peers (`peerDependenciesMeta[name].optional === true`) are ignored — they're
 *     informational, not hard constraints.
 *   - Deprecated versions are skipped. We'd rather fail to find a solution than auto-suggest
 *     a deprecated version as the "fix".
 *   - Prerelease versions are filtered out unless the user's current range already included
 *     prereleases (which we'd detect by the `scanned.currentRange` having a `-` suffix).
 *   - Search is capped at 400 version combos explored. Past that we give up silently — the
 *     point is to be helpful, not to block a run on an intractable constraint graph.
 *   - Peers on packages that appear in neither the linked group nor the workspace dependency
 *     list count as "unknown" and are skipped. We'd need `npm ls` output to resolve them
 *     precisely, which is too expensive to do mid-resolve; erring toward "assume satisfied"
 *     is the right bias because the alternative is rejecting every candidate.
 */
import semver from 'semver';
import type { VersionPeers } from '../utils/concurrency.js';

/** One member of a linked group, with the version we *wanted* to bump to. */
export interface ResolverInput {
  /** Package name (matches registry). */
  name: string;
  /** The user's current range from package.json (e.g. `"^18.2.0"`). */
  currentRange: string;
  /** The version the engine initially picked (usually `latest` for this package). */
  requestedTarget: string;
}

/**
 * Candidate version domain for a single package, post-filter. The resolver does NOT fetch
 * this — callers build it from the registry packument (via `utils/npm.fetchVersionPeers`)
 * plus the constraints in `buildDomain()`. Kept separate so tests can inject exact maps.
 */
export interface CandidateDomain {
  name: string;
  /** Ordered newest-first; the resolver picks the first one that satisfies every peer. */
  versions: string[];
  /** Per-version peer info, shared with the resolver. */
  peers: Map<string, VersionPeers>;
}

/**
 * Shape of the resolved tuple. The resolver emits a parallel `downgradedFrom` map so callers
 * can annotate the per-package `UpgradeRecord.resolvedPeer` with the original requested target
 * (for the audit trail in the commit body + summary).
 */
export interface ResolvedTuple {
  /** name → resolved version (always present; the resolver never drops a package). */
  versions: Map<string, string>;
  /** name → requested target, ONLY when the resolver picked a different version. */
  downgradedFrom: Map<string, string>;
  /** Debug: how many tuples were checked before we found a solution. */
  tuplesExplored: number;
}

export interface ResolveOptions {
  /**
   * Known-installed ranges for packages OUTSIDE the linked group. Used to check whether a
   * candidate's peer constraint on an external package is satisfiable.
   *
   * Example: resolving [`react-dom`, `react`], with `externalInstalled = { "next": "^14" }`
   * → if a candidate of `react-dom` peers on `next: "^15"`, we know we'd break. If the peer
   *   is on a package not in `externalInstalled`, we assume satisfied (see module doc).
   */
  externalInstalled: Map<string, string>;
  /**
   * Upper bound on tuples we examine before giving up. Keeps the search bounded on pathological
   * inputs (e.g. 5 packages × 50 versions each = 312M combos). Tuned to handle the typical
   * "3 linked packages × 10 recent versions" case (~1000 combos) with headroom.
   */
  maxTuples?: number;
  /** When true, include prerelease versions in the domain. Default: false. */
  includePrereleases?: boolean;
}

/**
 * Build a candidate version domain for one linked package:
 *   - Keep versions from `semver.minVersion(currentRange)` up to `requestedTarget` (inclusive).
 *   - Drop deprecated versions (the resolver shouldn't auto-suggest a known-bad version).
 *   - Drop prereleases unless `includePrereleases` is set OR the current range already has a `-`.
 *   - Sort descending (newest first).
 *
 * Returns an empty array when `input.requestedTarget` is not a valid semver or the peer map
 * has no overlap with the `[current, target]` window — the caller should treat that as
 * "resolver cannot help, fall back".
 */
export function buildDomain(
  input: ResolverInput,
  peers: Map<string, VersionPeers>,
  includePrereleases = false,
): CandidateDomain {
  const result: CandidateDomain = { name: input.name, versions: [], peers };
  if (!semver.valid(input.requestedTarget)) {
    return result;
  }
  const currentMin = safeMin(input.currentRange);
  if (!currentMin) {
    // No lower bound (e.g. `"*"` range) — include every non-prerelease up to the target.
  }
  const allowPreInCurrent = /-/.test(input.currentRange);
  const allowPre = includePrereleases || allowPreInCurrent;

  const eligible: string[] = [];
  for (const v of peers.keys()) {
    if (!semver.valid(v)) continue;
    if (!allowPre && semver.prerelease(v)) continue;
    const slice = peers.get(v);
    if (slice?.deprecated) continue;
    if (currentMin && semver.lt(v, currentMin)) continue;
    if (semver.gt(v, input.requestedTarget)) continue;
    eligible.push(v);
  }
  eligible.sort((a, b) => semver.rcompare(a, b));
  result.versions = eligible;
  return result;
}

/**
 * Backtracking CSP solver. Picks a version for each package newest-first, prunes whenever a
 * partial assignment violates a peer constraint. Returns `undefined` when no satisfiable
 * tuple exists within `maxTuples` probes.
 *
 * The resolver is order-sensitive (newest-first per variable), which is exactly what we
 * want: the FIRST solution is also the least-downgrade solution.
 */
export function resolvePeerRanges(
  domains: CandidateDomain[],
  requested: Map<string, string>,
  options: ResolveOptions,
): ResolvedTuple | undefined {
  if (domains.length === 0) return undefined;
  if (domains.some((d) => d.versions.length === 0)) return undefined;

  const maxTuples = options.maxTuples ?? 400;
  const memberNames = new Set(domains.map((d) => d.name));
  const assignment = new Map<string, string>();
  let tuplesExplored = 0;

  const recurse = (i: number): boolean => {
    if (i === domains.length) {
      tuplesExplored++;
      return true;
    }
    const d = domains[i]!;
    for (const v of d.versions) {
      tuplesExplored++;
      if (tuplesExplored > maxTuples) return false;
      assignment.set(d.name, v);
      if (checkPartial(assignment, domains, memberNames, options.externalInstalled)) {
        if (recurse(i + 1)) return true;
      }
      assignment.delete(d.name);
    }
    return false;
  };

  const ok = recurse(0);
  if (!ok) return undefined;

  const downgradedFrom = new Map<string, string>();
  for (const [name, v] of assignment) {
    const req = requested.get(name);
    if (req && req !== v) {
      downgradedFrom.set(name, req);
    }
  }
  return { versions: new Map(assignment), downgradedFrom, tuplesExplored };
}

/**
 * Check every peer constraint that BECOMES knowable under the current partial assignment.
 *
 * For each assigned member A@versionA:
 *   - Walk A's peerDependencies. For each `(peerName, peerRange)`:
 *     - If `peerName` IS in the linked set:
 *       - If that peer is already assigned → check `satisfies(peerVersion, peerRange)`.
 *       - If not yet assigned → defer (later recursion will hit it).
 *     - If `peerName` is in `externalInstalled` → check against its `minVersion`.
 *     - Otherwise → unknown, skip (see module doc).
 *
 * Returns false as soon as any check fails. Optional peers are ignored.
 */
function checkPartial(
  assignment: Map<string, string>,
  domains: CandidateDomain[],
  memberNames: Set<string>,
  externalInstalled: Map<string, string>,
): boolean {
  for (const [name, version] of assignment) {
    const d = domains.find((x) => x.name === name);
    if (!d) continue;
    const slice = d.peers.get(version);
    if (!slice) continue;
    for (const [peerName, peerRange] of Object.entries(slice.peerDependencies)) {
      const optional = slice.peerDependenciesMeta?.[peerName]?.optional === true;
      if (optional) continue;
      if (memberNames.has(peerName)) {
        const peerAssigned = assignment.get(peerName);
        if (!peerAssigned) continue; // deferred; revisit later
        if (!safeSatisfies(peerAssigned, peerRange)) return false;
      } else {
        const ext = externalInstalled.get(peerName);
        if (!ext) continue; // unknown external; assume satisfied
        const extMin = safeMin(ext);
        if (!extMin) continue;
        if (!safeSatisfies(extMin, peerRange)) return false;
      }
    }
  }
  return true;
}

/** `semver.minVersion(range).version` but never throws on garbage input. */
function safeMin(range: string): string | undefined {
  try {
    return semver.minVersion(range)?.version;
  } catch {
    return undefined;
  }
}

/** `semver.satisfies(version, range)` but never throws; returns false on garbage. */
function safeSatisfies(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range, { includePrerelease: true });
  } catch {
    return false;
  }
}

/**
 * Compact summary describing what the resolver did. Used as the `reason` for
 * `UpgradeRecord.resolvedPeer` so the JSON and the summary can both print a human-readable
 * "react: 19.0.0 → 18.3.1 (peer-range intersection)" kind of note.
 */
export function describeResolution(tuple: ResolvedTuple, input: ResolverInput[]): string {
  const parts: string[] = [];
  for (const inp of input) {
    const final = tuple.versions.get(inp.name);
    if (!final) continue;
    if (final === inp.requestedTarget) {
      parts.push(`${inp.name}@${final}`);
    } else {
      parts.push(`${inp.name}: ${inp.requestedTarget} → ${final}`);
    }
  }
  return `peer-range intersection: ${parts.join(', ')} (explored ${tuple.tuplesExplored})`;
}
