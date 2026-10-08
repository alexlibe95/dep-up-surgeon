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
 *   - We never pull a blocker FORWARD past its currently pinned range, nor BELOW the version
 *     the lockfile has installed for it. `buildDomain()` floors each domain at the installed
 *     version (else `currentRange`'s minimum), and we cap the `requestedTarget` for blockers
 *     at the newest version that satisfies the existing range — ad-hoc resolution is allowed
 *     to downgrade the *target* of the bump, never to secretly also bump (or roll back) an
 *     unrelated dep that happened to appear in the peer graph.
 *   - The ad-hoc group is capped at `maxAdHocMembers` (default 6) to keep registry fetch
 *     costs bounded. Beyond that the savings vanish (huge peer graphs with lots of blockers
 *     usually need manual attention) and the resolver would timeout anyway.
 */
import semver from 'semver';
import type { ClassifiedConflict } from './conflictAnalyzer.js';
import { parsePackageSpec } from './conflictParser.js';
import type { RegistryCache } from '../utils/concurrency.js';
import type { LockfileVersionTree } from '../utils/installedVersion.js';
import type { PackageJson, ScannedPackage } from '../types.js';
import { fetchVersionPeers, fetchLatestVersion } from '../utils/npm.js';
import {
  buildDomain,
  describeResolution,
  installedVersionFor,
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
  /**
   * Names this run must not touch (`--ignore`, policy freezes, `--security-only`). They never
   * join the ad-hoc group, but still constrain it as installed externals.
   */
  isFrozen?: (name: string) => boolean;
  /** Let blockers declared only in `peerDependencies` move (`--include-peers`). Default `false`. */
  includePeers?: boolean;
  /**
   * Installed versions (lockfile). Floor every member's domain at what's installed (the primary's
   * `catalog:` range needs it; a blocker must never be modelled — or moved — below its installed
   * version) and check peers on packages outside the group against what's installed, not the
   * range floor.
   */
  lockfileVersions?: LockfileVersionTree;
  /**
   * The workspace's directory relative to the lockfile's (`packages/web`; omit or `.` for the
   * root), so installed versions come from this importer's own lockfile entries.
   */
  memberRelDir?: string;
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
  const { primary, primaryTarget, classified, pkg, registryCache, lockfileVersions, memberRelDir } =
    input;
  const maxMembers = input.maxAdHocMembers ?? 6;

  const directDeps = indexDirectDeps(pkg);
  // Pull blocker names out of the classified conflicts. `dependency` is the package that
  // wants a peer; `depender` is who's complaining about it. For peer-mismatch rows, the
  // "blocker" — the package we might need to downgrade to match the primary's peer
  // expectations — is usually the DEPENDER (it's the one at a version that doesn't satisfy
  // the primary's peer requirement). We include BOTH fields in the candidate set and let
  // the `directDeps` filter drop whichever isn't a direct dep. Parsers print dependers as
  // `<name>@<version>` (`@angular/build@21.2.8`) while direct deps are keyed by bare name.
  const blockerNames = new Set<string>();
  for (const c of classified) {
    if (c.category !== 'peerDependencyMismatch' && c.category !== 'missingDependency') continue;
    for (const field of [c.depender, c.dependency]) {
      if (!field || field === 'unknown') continue;
      const name = parsePackageSpec(field).name;
      if (name !== primary.name) blockerNames.add(name);
    }
  }

  const blockers: DirectDep[] = [];
  for (const name of blockerNames) {
    const hit = directDeps.get(name);
    if (!hit) continue;
    // Frozen packages and consumer-facing peer ranges stay put; as externals they still
    // constrain the primary.
    if (input.isFrozen?.(name)) continue;
    if (hit.section === 'peerDependencies' && !input.includePeers) continue;
    blockers.push(hit);
  }
  if (blockers.length === 0) {
    return undefined;
  }

  // Pick a stable, newest-first order for the blockers and cap the group size. Blockers are
  // sorted alphabetically so cached peer fetches hit consistently across runs; the `slice`
  // preserves whichever blockers came in first when the cap kicks in.
  blockers.sort((a, b) => a.name.localeCompare(b.name));
  const capped = blockers.slice(0, Math.max(1, maxMembers - 1));

  // One packument per member, shared by the blocker caps and the domains below (callers may not
  // pass a registry cache).
  const peersByName = new Map<string, Awaited<ReturnType<typeof fetchVersionPeers>>>();
  const peersOf = async (name: string) => {
    let peers = peersByName.get(name);
    if (!peers) {
      peers = await fetchVersionPeers(name, registryCache);
      peersByName.set(name, peers);
    }
    return peers;
  };
  // This importer's installed version (lockfile). It floors every member's domain: the primary's
  // so a `catalog:` range has one, a blocker's so it's modelled where it actually is — at its
  // range floor, `@react-three/fiber@^9.0.0` (9.7.0 installed) would "solve" a react bump by
  // dropping to 9.3.0, a downgrade npm wouldn't even perform.
  const installedOf = (name: string, range: string): string | undefined =>
    installedVersionFor(name, range, lockfileVersions, memberRelDir);

  // Assemble resolver inputs: primary + each blocker. For blockers we use the newest
  // version **compatible with the existing range** as the upper bound — we never silently
  // upgrade a blocker past what the user pinned.
  const primaryInstalled = installedOf(primary.name, primary.currentRange);
  const inputs: ResolverInput[] = [
    {
      name: primary.name,
      currentRange: primary.currentRange,
      requestedTarget: primaryTarget,
      ...(primaryInstalled ? { installedVersion: primaryInstalled } : {}),
    },
  ];
  for (const b of capped) {
    const installed = installedOf(b.name, b.range);
    const published = [...(await peersOf(b.name)).keys()];
    const currentMax = await resolveExistingUpperBound(b.name, b.range, published, installed, registryCache);
    if (!currentMax) continue;
    inputs.push({
      name: b.name,
      currentRange: b.range,
      requestedTarget: currentMax,
      ...(installed ? { installedVersion: installed } : {}),
    });
  }

  // After filtering, we need at least one blocker alongside the primary — otherwise the
  // resolver degenerates into "is the primary alone satisfiable against externals?", which
  // `buildDomain` already answered implicitly.
  if (inputs.length < 2) return undefined;

  const domains: CandidateDomain[] = [];
  for (const inp of inputs) {
    const peers = await peersOf(inp.name);
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
  const resolved = resolvePeerRanges(domains, requested, {
    externalInstalled,
    ...(lockfileVersions ? { lockfileVersions } : {}),
    ...(memberRelDir !== undefined ? { memberRelDir } : {}),
  });
  if (!resolved) return undefined;

  // Build the `bumps` list. A blocker the resolver left where it already is — its installed
  // version, or the range floor without a lockfile — is omitted: no point writing an
  // identical range back.
  const bumps: AdHocResolveResult['bumps'] = [];
  for (const inp of inputs) {
    const resolvedVersion = resolved.versions.get(inp.name);
    if (!resolvedVersion) continue;
    const isPrimary = inp.name === primary.name;
    const currentPin = isPrimary ? primary.currentRange : capped.find((b) => b.name === inp.name)?.range ?? inp.currentRange;
    const current = inp.installedVersion ?? safeMin(currentPin);
    if (!isPrimary && current && resolvedVersion === current) {
      // Blocker stays put — no mutation needed.
      continue;
    }
    bumps.push({
      name: inp.name,
      from: currentPin,
      to: resolvedVersion,
      isPrimary,
    });
  }

  // If the only bump left is the primary AND the resolver chose the original target, or the
  // version that's already installed (a blocker caps it right where it is), there's nothing new
  // to try → bail out so the engine doesn't spin on an identical retry; its rollback keeps the
  // primary where it is and reports the blocker.
  const onlyPrimaryUnchanged =
    bumps.length === 1 &&
    bumps[0]!.isPrimary &&
    (bumps[0]!.to === primaryTarget || bumps[0]!.to === primaryInstalled);
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
 * Given a pinned range like `^17.0.0`, return the newest version the blocker may move to
 * without leaving it. Used to cap blocker `requestedTarget` at "the newest compatible release"
 * so the ad-hoc resolver never silently bumps a blocker past its current range:
 *
 *   - the registry `latest` dist-tag when it satisfies the pin;
 *   - otherwise (a newer major is out, or the lookup failed) the newest `published` version
 *     that does — not the range floor, which would model `eslint@^7` at 7.0.0 while 7.32.0
 *     is installed;
 *   - never below `installed` (a blocker already past `latest` stays where it is).
 *
 * Falls back to `installed`, then the range floor, when nothing published satisfies the range;
 * `undefined` when neither exists either (e.g. a `workspace:` range).
 */
async function resolveExistingUpperBound(
  name: string,
  range: string,
  published: string[],
  installed: string | undefined,
  registryCache: RegistryCache | undefined,
): Promise<string | undefined> {
  let upper: string | undefined;
  try {
    const latest = await fetchLatestVersion(name, registryCache);
    if (semver.valid(latest) && safeSatisfies(latest, range)) {
      upper = latest;
    }
  } catch {
    // Network / registry miss — fall through to the packument.
  }
  upper ??= safeMaxSatisfying(published, range) ?? installed ?? safeMin(range);
  return upper && installed && semver.gt(installed, upper) ? installed : upper;
}

function safeMaxSatisfying(versions: string[], range: string): string | undefined {
  try {
    return semver.maxSatisfying(versions.filter((v) => semver.valid(v)), range) ?? undefined;
  } catch {
    return undefined;
  }
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
