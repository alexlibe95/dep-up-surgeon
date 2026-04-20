/**
 * Ad-hoc peer-range resolver for **non-linked** (single-package) upgrade failures.
 *
 * Context: the main resolver in `peerResolver.ts` only fires for LINKED GROUPS — batches
 * like (`react`, `react-dom`, `@types/react`) that ship together. Single-package bumps that
 * fail with a peer conflict (e.g. "bumping `eslint-plugin-react-hooks` alone but it peers
 * on a `react` range the project doesn't have") were rolled back unconditionally.
 *
 * This module closes that gap. Given a failed single bump + the npm/pnpm/yarn output that
 * flagged the peer conflict, we:
 *
 *   1. Parse the blocker graph from the install output (who demands what).
 *   2. Build an **ad-hoc linked group** containing the bump target PLUS every blocker that
 *      is **already a direct dep** of the workspace (peers on random transitives are out of
 *      scope — we can't upgrade a package we don't own).
 *   3. Run `resolvePeerRanges()` on that synthesized group, exactly like the linked-group
 *      path does. If a tuple is found, the caller retries the install with all members at
 *      the resolved versions. If not, the caller rolls the single bump back as before.
 *
 * Non-goals + safety rails:
 *
 *   - We never ADD packages to `package.json`. The ad-hoc group is filtered down to
 *     packages the workspace already declares as a direct dep. Peers on transitives stay
 *     unresolved → caller falls back to the standard rollback.
 *   - We never pull a blocker FORWARD past its currently pinned range. The resolver's
 *     `buildDomain()` already respects `currentRange` as the lower bound, but we also cap
 *     the `requestedTarget` for blockers at the newest version that satisfies the existing
 *     range — ad-hoc resolution is allowed to downgrade the *target* of the bump, never to
 *     secretly also bump an unrelated dep that happened to appear in the peer graph.
 *   - The ad-hoc group is capped at `maxAdHocMembers` (default 6) to keep registry fetch
 *     costs bounded. Beyond that the savings vanish (huge peer graphs with lots of blockers
 *     usually need manual attention) and the resolver would timeout anyway.
 */
import semver from 'semver';
import type { ClassifiedConflict } from './conflictAnalyzer.js';
import type { RegistryCache } from '../utils/concurrency.js';
import type { PackageJson, ScannedPackage } from '../types.js';
import { fetchVersionPeers, fetchLatestVersion } from '../utils/npm.js';
import {
  buildDomain,
  describeResolution,
  resolvePeerRanges,
  type CandidateDomain,
  type ResolvedTuple,
  type ResolverInput,
} from './peerResolver.js';

export interface AdHocResolveInput {
  /** The package the engine was trying to bump (the "primary"). */
  primary: ScannedPackage;
  /** Version the engine wanted the primary at (the `@latest` or fallback ladder value). */
  primaryTarget: string;
  /** Classified peer-dep conflicts the parser extracted from the failed install output. */
  classified: ClassifiedConflict[];
  /** Workspace `package.json` contents — used to filter blockers to DIRECT deps only. */
  pkg: PackageJson;
  registryCache?: RegistryCache;
  /** Upper bound on ad-hoc group size including the primary. Default 6. */
  maxAdHocMembers?: number;
}

export interface AdHocResolveResult {
  /** Names + target versions the caller must set on `package.json` before retry. */
  bumps: Array<{ name: string; from: string; to: string; isPrimary: boolean }>;
  /** Human-readable reason (reused as `UpgradeRecord.resolvedPeer.reason`). */
  reason: string;
  /** Forwarded from the resolver so the caller can populate `resolvedPeer.tuplesExplored`. */
  tuplesExplored: number;
  /** Which solver path produced the tuple (`'backtracking'` or `'sat'`). */
  method: ResolvedTuple['method'];
}

type DirectDep = { name: string; section: DepSection; range: string };
type DepSection = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';

/**
 * Try to find a satisfiable tuple for a single-package bump that failed with a peer conflict.
 * Returns `undefined` when:
 *   - No blockers from `classified` are direct deps of the workspace (no ad-hoc group can
 *     form — only the primary would be in it, and single-member resolution is a no-op).
 *   - Any registry fetch fails (we'd be guessing).
 *   - The resolver can't find a tuple within its budget.
 */
export async function tryResolveAdHocPeerConflict(
  input: AdHocResolveInput,
): Promise<AdHocResolveResult | undefined> {
  const { primary, primaryTarget, classified, pkg, registryCache } = input;
  const maxMembers = input.maxAdHocMembers ?? 6;

  const directDeps = indexDirectDeps(pkg);
  // Pull blocker names out of the classified conflicts. `dependency` is the package that
  // wants a peer; `depender` is who's complaining about it. For peer-mismatch rows, the
  // "blocker" — the package we might need to downgrade to match the primary's peer
  // expectations — is usually the DEPENDER (it's the one at a version that doesn't satisfy
  // the primary's peer requirement). We include BOTH fields in the candidate set and let
  // the `directDeps` filter drop whichever isn't a direct dep.
  const blockerNames = new Set<string>();
  for (const c of classified) {
    if (c.category !== 'peerDependencyMismatch' && c.category !== 'missingDependency') continue;
    if (c.depender && c.depender !== 'unknown' && c.depender !== primary.name) {
      blockerNames.add(c.depender);
    }
    if (c.dependency && c.dependency !== 'unknown' && c.dependency !== primary.name) {
      blockerNames.add(c.dependency);
    }
  }

  const blockers: DirectDep[] = [];
  for (const name of blockerNames) {
    const hit = directDeps.get(name);
    if (hit) blockers.push(hit);
  }
  if (blockers.length === 0) {
    return undefined;
  }

  // Pick a stable, newest-first order for the blockers and cap the group size. Blockers are
  // sorted alphabetically so cached peer fetches hit consistently across runs; the `slice`
  // preserves whichever blockers came in first when the cap kicks in.
  blockers.sort((a, b) => a.name.localeCompare(b.name));
  const capped = blockers.slice(0, Math.max(1, maxMembers - 1));

  // Assemble resolver inputs: primary + each blocker. For blockers we use the newest
  // version **compatible with the existing range** as the upper bound — we never silently
  // upgrade a blocker past what the user pinned.
  const inputs: ResolverInput[] = [
    {
      name: primary.name,
      currentRange: primary.currentRange,
      requestedTarget: primaryTarget,
    },
  ];
  for (const b of capped) {
    const currentMax = await resolveExistingUpperBound(b.name, b.range, registryCache);
    if (!currentMax) continue;
    inputs.push({ name: b.name, currentRange: b.range, requestedTarget: currentMax });
  }

  // After filtering, we need at least one blocker alongside the primary — otherwise the
  // resolver degenerates into "is the primary alone satisfiable against externals?", which
  // `buildDomain` already answered implicitly.
  if (inputs.length < 2) return undefined;

  const domains: CandidateDomain[] = [];
  for (const inp of inputs) {
    const peers = await fetchVersionPeers(inp.name, registryCache);
    if (peers.size === 0) return undefined;
    const d = buildDomain(inp, peers);
    if (d.versions.length === 0) return undefined;
    domains.push(d);
  }

  // External-installed map: every workspace direct-dep that's NOT in the ad-hoc group. Same
  // construction the linked-group path uses — the resolver treats these as fixed constraints.
  const memberNames = new Set(inputs.map((i) => i.name));
  const externalInstalled = new Map<string, string>();
  for (const [name, dd] of directDeps) {
    if (!memberNames.has(name)) externalInstalled.set(name, dd.range);
  }

  const requested = new Map(inputs.map((i) => [i.name, i.requestedTarget]));
  const resolved = resolvePeerRanges(domains, requested, { externalInstalled });
  if (!resolved) return undefined;

  // Build the `bumps` list. A blocker whose resolved version EQUALS the value already in
  // `package.json` (i.e. the resolver didn't ask us to move it) is omitted — no point
  // writing an identical range back.
  const bumps: AdHocResolveResult['bumps'] = [];
  for (const inp of inputs) {
    const resolvedVersion = resolved.versions.get(inp.name);
    if (!resolvedVersion) continue;
    const isPrimary = inp.name === primary.name;
    const currentPin = isPrimary ? primary.currentRange : capped.find((b) => b.name === inp.name)?.range ?? inp.currentRange;
    const currentFloor = safeMin(currentPin);
    if (!isPrimary && currentFloor && resolvedVersion === currentFloor) {
      // Blocker stayed at its current floor — no mutation needed.
      continue;
    }
    bumps.push({
      name: inp.name,
      from: currentPin,
      to: resolvedVersion,
      isPrimary,
    });
  }

  // If the only bump left is the primary AND the resolver chose the original target, there's
  // nothing new to try → bail out so the engine doesn't spin on an identical retry.
  const onlyPrimaryUnchanged =
    bumps.length === 1 && bumps[0]!.isPrimary && bumps[0]!.to === primaryTarget;
  if (onlyPrimaryUnchanged) return undefined;

  const reason = describeResolution(resolved, inputs);
  return {
    bumps,
    reason: `ad-hoc ${reason}`,
    tuplesExplored: resolved.tuplesExplored,
    method: resolved.method,
  };
}

/**
 * Flatten all four dependency sections of `package.json` into a `name → { section, range }`
 * map. `dependencies` win over `devDependencies` when duplicated (same precedence npm uses
 * for the actual install), and peer/optional sections are included so an ad-hoc group can
 * move a peer-dep-only package too (common in plugin ecosystems like eslint-plugin-*).
 */
function indexDirectDeps(pkg: PackageJson): Map<string, DirectDep> {
  const out = new Map<string, DirectDep>();
  const sections: DepSection[] = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  for (const section of sections) {
    const block = pkg[section];
    if (!block) continue;
    for (const [name, range] of Object.entries(block)) {
      if (typeof range !== 'string') continue;
      if (!out.has(name)) {
        out.set(name, { name, section, range });
      }
    }
  }
  return out;
}

/**
 * Given a pinned range like `^17.0.0`, return the newest published version that still
 * satisfies it. Used to cap blocker `requestedTarget` at "the newest compatible release" so
 * the ad-hoc resolver never silently bumps a blocker past its current range.
 *
 * Returns `undefined` when the registry fetch fails OR when no published version satisfies
 * the range (rare — usually means the lockfile references a deleted / unpublished version).
 */
async function resolveExistingUpperBound(
  name: string,
  range: string,
  registryCache: RegistryCache | undefined,
): Promise<string | undefined> {
  try {
    // `fetchLatestVersion` returns the registry's `latest` dist-tag. If it already satisfies
    // the pin (rare, but happens for packages at a wildcard like `*`), we use it directly.
    // Otherwise we fall back to the floor of the current range — `semver.minVersion(range)`
    // — which is always a valid published version (modulo deleted tarballs).
    const latest = await fetchLatestVersion(name, registryCache);
    if (semver.valid(latest) && safeSatisfies(latest, range)) {
      return latest;
    }
  } catch {
    // Network / registry miss — fall through to the floor.
  }
  return safeMin(range);
}

function safeMin(range: string): string | undefined {
  try {
    return semver.minVersion(range)?.version;
  } catch {
    return undefined;
  }
}

function safeSatisfies(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range, { includePrerelease: true });
  } catch {
    return false;
  }
}
