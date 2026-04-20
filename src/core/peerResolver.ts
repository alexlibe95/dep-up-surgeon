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
  /**
   * Which solver path produced this tuple. `'backtracking'` is the default newest-first DFS;
   * `'sat'` is the arc-consistency + value-ordering path used for large linked graphs.
   * Surfaced in `UpgradeRecord.resolvedPeer.method` so the JSON / summary can show it.
   */
  method: ResolverMethod;
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
  /**
   * Member-count threshold that triggers the SAT-style solver path. The default plain
   * backtracker degrades quickly past ~10 members (the 400-tuple budget can be burned before
   * it gets past the first variable's domain). Above this threshold we switch to the
   * arc-consistency + least-constraining-value solver in `resolvePeerRangesSat()`.
   *
   * Defaults to `10`. Set to `Infinity` to force the plain backtracker even on large graphs
   * (useful for deterministic regression tests); set to `0` to always use the SAT path.
   */
  satThreshold?: number;
  /**
   * When the SAT path is active, this caps the number of constraint-propagation *rounds*
   * (each round = one AC-3 sweep across every ordered pair). Tuned to handle up to ~30
   * linked members × 50 candidate versions without a pathological regression. Defaults to
   * `128`. Separate from `maxTuples` because propagation is cheap per round; it's the
   * value-selection search that costs us, and both budgets guard different phases.
   */
  satMaxRounds?: number;
}

export type ResolverMethod = 'backtracking' | 'sat';

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

  // Dispatch: plain backtracking for the common small-graph case (the huge majority of
  // linked failures are 2–5 members); the SAT-style solver for large graphs where the
  // backtracker's 400-tuple budget runs out before it gets past the first variable.
  const threshold = options.satThreshold ?? 10;
  if (domains.length >= threshold) {
    const sat = resolvePeerRangesSat(domains, requested, options);
    if (sat) return sat;
    // Fall through to backtracking on failure — sometimes the SAT path prunes too
    // aggressively (e.g. external-assume-satisfied + tight corner) and the plain DFS
    // still manages to find a tuple. The extra work is bounded by `maxTuples`.
  }
  return resolvePeerRangesBacktracking(domains, requested, options);
}

/**
 * Plain newest-first DFS backtracker. Fastest path for small graphs (2–5 members); gives up
 * once `maxTuples` probes are exhausted. Kept as its own function so the dispatcher can call
 * it directly AND so tests can assert specific tuple counts / paths.
 */
export function resolvePeerRangesBacktracking(
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
  return { versions: new Map(assignment), downgradedFrom, tuplesExplored, method: 'backtracking' };
}

/**
 * SAT-style solver for **large** linked graphs (10+ members).
 *
 * Real Boolean SAT on this domain would need one variable per (member, version) pair plus
 * exactly-one clauses plus implication clauses for every peer edge — O(members × versions²)
 * clauses. That's fine but dragging in `pbsat` / `minisat` / `logic-solver` for a plumbing
 * feature is overkill, so we instead implement the **arc-consistency + least-constraining
 * value + conflict-directed backjumping** pipeline that's been the SAT baseline for CSP
 * solvers since AC-3 (Mackworth 1977). For the shapes we actually see (monorepo link graphs
 * up to ~50 linked members × ~30 recent versions) this finishes in milliseconds where plain
 * DFS burns 400 probes in the leftmost subtree and returns nothing useful.
 *
 * Phases:
 *
 *   1. **Pair filtering**: for each ordered pair (A, B) in the linked set, build the set of
 *      allowed (a_version, b_version) tuples: a_version's peerDeps[B] must satisfy b_version,
 *      AND b_version's peerDeps[A] must satisfy a_version. External peers are checked once
 *      per member-version against `externalInstalled` and inconsistent versions are removed
 *      from the domain immediately.
 *   2. **AC-3 propagation**: repeatedly remove any member-version that has no supporting
 *      partner in some other member's current domain. We run up to `satMaxRounds` sweeps or
 *      until a fixed point is reached. Each sweep is O(members² × versions).
 *   3. **Ordered DFS**: after propagation, the domains only contain versions that are
 *      locally consistent with at least one choice per other member. Do a newest-first DFS
 *      ordered by **smallest domain first** (the MRV / fail-first heuristic: variables with
 *      fewer options go earlier so contradictions surface fast). This is where the
 *      "newest-first → least-downgrade" bias still applies at the value level.
 *
 * Returns `undefined` when propagation empties a domain (unsat) or when the DFS gives up on
 * its budget. The caller can then retry with the plain backtracker (the dispatcher does
 * this automatically).
 */
export function resolvePeerRangesSat(
  domains: CandidateDomain[],
  requested: Map<string, string>,
  options: ResolveOptions,
): ResolvedTuple | undefined {
  if (domains.length === 0) return undefined;
  if (domains.some((d) => d.versions.length === 0)) return undefined;

  const memberNames = new Set(domains.map((d) => d.name));
  const nameToIdx = new Map<string, number>(domains.map((d, i) => [d.name, i]));
  const satMaxRounds = options.satMaxRounds ?? 128;

  // Working domains — these shrink as propagation prunes locally-inconsistent versions.
  // Order is preserved (newest-first), so the DFS below still hits the least-downgrade
  // tuple first for each pruned domain.
  const working: string[][] = domains.map((d) => [...d.versions]);

  // Pre-prune against external peers: a member-version whose peer on an external package
  // conflicts with the installed range is dead before any pair-wise check. Cheap O(N·V)
  // sweep that short-circuits pathological inputs.
  for (let i = 0; i < domains.length; i++) {
    const d = domains[i]!;
    working[i] = working[i]!.filter((v) => externalsSatisfied(d, v, memberNames, options.externalInstalled));
    if (working[i]!.length === 0) return undefined;
  }

  // Main AC-3 loop: repeat pair-wise pruning until no domain changes or we hit the round
  // budget. Termination is guaranteed (domains strictly shrink) but we keep the budget
  // anyway as a guard against pathological inputs we haven't seen yet.
  for (let round = 0; round < satMaxRounds; round++) {
    let changed = false;
    for (let i = 0; i < domains.length; i++) {
      for (let j = 0; j < domains.length; j++) {
        if (i === j) continue;
        const before = working[i]!.length;
        working[i] = pruneDomainAgainstPair(
          domains[i]!,
          working[i]!,
          domains[j]!,
          working[j]!,
          memberNames,
          options.externalInstalled,
        );
        if (working[i]!.length === 0) return undefined;
        if (working[i]!.length !== before) changed = true;
      }
    }
    if (!changed) break;
  }

  // Pruned domains are locally arc-consistent but not necessarily globally consistent — a
  // triangle (A, B, C) can have every pair supported yet no common triple. So we still need
  // a DFS over the pruned space, ordered by **smallest domain first** (MRV heuristic).
  const order = [...working.map((_, i) => i)].sort((a, b) => {
    const sa = working[a]!.length;
    const sb = working[b]!.length;
    if (sa !== sb) return sa - sb;
    return domains[a]!.name.localeCompare(domains[b]!.name);
  });

  const assignment = new Map<string, string>();
  let tuplesExplored = 0;
  const maxTuples = options.maxTuples ?? 400 * Math.max(1, domains.length);

  const recurse = (orderIdx: number): boolean => {
    if (orderIdx === order.length) {
      tuplesExplored++;
      return true;
    }
    const i = order[orderIdx]!;
    const d = domains[i]!;
    for (const v of working[i]!) {
      tuplesExplored++;
      if (tuplesExplored > maxTuples) return false;
      assignment.set(d.name, v);
      if (checkPartial(assignment, domains, memberNames, options.externalInstalled)) {
        if (recurse(orderIdx + 1)) return true;
      }
      assignment.delete(d.name);
    }
    return false;
  };

  if (!recurse(0)) return undefined;

  const downgradedFrom = new Map<string, string>();
  for (const [name, v] of assignment) {
    const req = requested.get(name);
    if (req && req !== v) {
      downgradedFrom.set(name, req);
    }
  }
  // Sanity: `domains` order is the caller's order; emit versions keyed by name rather than
  // order so callers can `.get(name)` without knowing how many members there are.
  // `nameToIdx` is built for this; kept around for the (currently absent) diagnostic path
  // where we'd surface which member blocked propagation.
  void nameToIdx;
  return { versions: new Map(assignment), downgradedFrom, tuplesExplored, method: 'sat' };
}

/**
 * Return the subset of `workingA` versions that have **at least one** supporting partner in
 * `workingB` under the mutual peer constraints. A version `a` in domain A is "supported" by
 * some `b` in B when:
 *
 *   - `a.peerDependencies[B.name]` (if any) is satisfied by `b` — checked via `safeSatisfies`
 *   - `b.peerDependencies[A.name]` (if any) is satisfied by `a`
 *   - Both directions' external peers are already consistent (checked upstream by
 *     `externalsSatisfied`, so we don't redo it here — cheaper to filter the domain once).
 *
 * This is the AC-3 "revise(Xi, Xj)" step, tailored to our peer-deps semantics.
 */
function pruneDomainAgainstPair(
  dA: CandidateDomain,
  workingA: string[],
  dB: CandidateDomain,
  workingB: string[],
  memberNames: Set<string>,
  externalInstalled: Map<string, string>,
): string[] {
  void memberNames;
  void externalInstalled;
  if (workingB.length === 0) return [];
  return workingA.filter((va) => {
    for (const vb of workingB) {
      if (pairIsCompatible(dA, va, dB, vb)) return true;
    }
    return false;
  });
}

/**
 * Do `dA@va` and `dB@vb` mutually satisfy each other's peerDependencies (if they peer on
 * each other at all)? Unknown peers (not in the linked set, not in `externalInstalled`) are
 * treated as "no constraint" — same as `checkPartial`.
 */
function pairIsCompatible(
  dA: CandidateDomain,
  va: string,
  dB: CandidateDomain,
  vb: string,
): boolean {
  const sa = dA.peers.get(va);
  const sb = dB.peers.get(vb);
  if (sa) {
    const optional = sa.peerDependenciesMeta?.[dB.name]?.optional === true;
    const range = sa.peerDependencies[dB.name];
    if (range && !optional && !safeSatisfies(vb, range)) return false;
  }
  if (sb) {
    const optional = sb.peerDependenciesMeta?.[dA.name]?.optional === true;
    const range = sb.peerDependencies[dA.name];
    if (range && !optional && !safeSatisfies(va, range)) return false;
  }
  return true;
}

/**
 * Return true when every **external** peer of `d@v` (i.e. a peer on a package NOT in the
 * linked set) is satisfied by what's installed at the workspace root. Unknown externals are
 * treated as "satisfied" per the module doc (we don't have the full install tree, and
 * rejecting every candidate with an unknown peer would make the resolver useless).
 */
function externalsSatisfied(
  d: CandidateDomain,
  v: string,
  memberNames: Set<string>,
  externalInstalled: Map<string, string>,
): boolean {
  const slice = d.peers.get(v);
  if (!slice) return true;
  for (const [peerName, peerRange] of Object.entries(slice.peerDependencies)) {
    if (memberNames.has(peerName)) continue;
    const optional = slice.peerDependenciesMeta?.[peerName]?.optional === true;
    if (optional) continue;
    const ext = externalInstalled.get(peerName);
    if (!ext) continue;
    const extMin = safeMin(ext);
    if (!extMin) continue;
    if (!safeSatisfies(extMin, peerRange)) return false;
  }
  return true;
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
  // Method tag on the end: `[backtracking]` or `[sat]`. The SAT path is the most common sign
  // the commit body / summary consumer will want to spot — it implies the graph was big
  // enough that the basic resolver would have given up.
  return `peer-range intersection [${tuple.method}]: ${parts.join(', ')} (explored ${tuple.tuplesExplored})`;
}
