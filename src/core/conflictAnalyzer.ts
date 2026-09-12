import type { Conflict } from '../types.js';
import {
  parseConflictsFromNpmOutput,
  parseEresolveFallback,
  dedupeConflicts,
} from './conflictParser.js';

export type ConflictCategory =
  | 'peerDependencyMismatch'
  | 'versionOutOfRange'
  | 'missingDependency'
  | 'incompatibleEngine'
  | 'unresolvedTree';

export interface ClassifiedConflict extends Conflict {
  category: ConflictCategory;
}

/**
 * Heuristic classification from raw npm text + structured fields.
 */
export function classifyConflict(c: Conflict): ConflictCategory {
  const raw = `${c.rawMessage} ${c.requiredRange}`.toLowerCase();
  if (/ebadengine|unsupported engine|engine node/i.test(raw) || c.dependency === 'node') {
    return 'incompatibleEngine';
  }
  if (/eresolve|unable to resolve dependency tree|dependency tree.*not.*found/i.test(raw)) {
    return 'unresolvedTree';
  }
  // pnpm `✕ unmet peer react@^18: found 17.0.2` names an installed copy — a mismatch, not a missing peer.
  if (c.installedVersion && /unmet peer/i.test(raw)) {
    return 'peerDependencyMismatch';
  }
  if (/not installed|missing|unmet peer|none is installed|doesn't provide/i.test(raw)) {
    return 'missingDependency';
  }
  if (/incorrect peer|conflicting peer|peer dep/i.test(raw)) {
    return 'peerDependencyMismatch';
  }
  if (/could not resolve|invalid|does not satisfy|not compatible/i.test(raw)) {
    return 'versionOutOfRange';
  }
  return 'peerDependencyMismatch';
}

export function analyzeConflicts(conflicts: Conflict[]): ClassifiedConflict[] {
  return conflicts.map((c) => ({
    ...c,
    category: classifyConflict(c),
  }));
}

/**
 * Deduplicate classified rows while preserving `category` and other fields (same key as
 * {@link dedupeConflicts}).
 */
export function dedupeClassifiedConflicts(
  list: ClassifiedConflict[],
): ClassifiedConflict[] {
  const out: ClassifiedConflict[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    const key = `${c.depender}|${c.dependency}|${c.requiredRange}|${c.installedVersion ?? ''}|${c.attemptedVersion ?? ''}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(c);
  }
  return out;
}

/**
 * Count how often each package name appears as a blocking dependency (generic scoring).
 */
export function scoreBlockingPackages(classified: ClassifiedConflict[]): Map<string, number> {
  const scores = new Map<string, number>();
  const bump = (name: string) => {
    if (!name || name === 'unknown') {
      return;
    }
    scores.set(name, (scores.get(name) ?? 0) + 1);
  };
  for (const c of classified) {
    bump(c.dependency);
    bump(c.depender);
  }
  return new Map([...scores.entries()].sort((a, b) => b[1] - a[1]));
}

export function groupConflictsByCategory(
  classified: ClassifiedConflict[],
): Map<ConflictCategory, ClassifiedConflict[]> {
  const m = new Map<ConflictCategory, ClassifiedConflict[]>();
  for (const c of classified) {
    let list = m.get(c.category);
    if (!list) {
      list = [];
      m.set(c.category, list);
    }
    list.push(c);
  }
  return m;
}

/**
 * Merge line-based parses with whole-output `peer from` extraction + ERESOLVE catch-all.
 * When the global `peer <pkg>@"<range>" from <dep>` scan finds real edges, line-level
 * matches that only say `depender: unknown` for the same **dependency** (e.g. npm’s
 * “Conflicting peer dependency: <pkg>@<hypothetical>”) are dropped — they duplicate
 * the structured tuple and wrong-way label the `need` field.
 */
export function mergeParsedConflicts(output: string, rootPackageName?: string): Conflict[] {
  const skip =
    rootPackageName && rootPackageName.trim() !== ''
      ? new Set([rootPackageName.trim()])
      : undefined;
  let a = parseConflictsFromNpmOutput(output, { skipDependencyNames: skip });
  const b = parseEresolveFallback(output);
  const bWithDepender = b.filter(
    (c) => c.dependency !== 'unknown' && c.depender !== 'unknown',
  );
  if (bWithDepender.length > 0) {
    const covered = new Set(bWithDepender.map((c) => c.dependency));
    a = a.filter(
      (c) =>
        !(
          c.depender === 'unknown' &&
          c.dependency !== 'unknown' &&
          covered.has(c.dependency)
        ),
    );
  }
  const keys = new Set(a.map((x) => x.rawMessage));
  const merged = [
    ...a,
    ...b.filter((x) => !keys.has(x.rawMessage)),
  ];
  return dedupeConflicts(merged);
}

export interface ExtractConflictsOptions {
  rootPackageName?: string;
}

export function extractClassifiedConflicts(
  output: string,
  options?: ExtractConflictsOptions,
): ClassifiedConflict[] {
  return analyzeConflicts(mergeParsedConflicts(output, options?.rootPackageName));
}

/**
 * npm often completes `npm install` with **exit 0** while logging `ERESOLVE overriding
 * peer dependency` — the resolved tree is installed, peers were overridden, not
 * a failed resolution. In that case keeping the upgrade is the expected outcome; rolling
 * back every dependent bump forces users to "fix by hand" for eslint-config-next + ESLint 10
 * and similar. We still roll back on `--force` false when there is a *hard* failure line
 * (`npm error code` / `npm ERR!`) or an irrecoverable ERESOLVE error block in the log.
 */
function npmOverrodePeersButInstallSucceeded(
  fullOutput: string,
  _classified: ClassifiedConflict[],
): boolean {
  const t = fullOutput || '';
  if (!/overriding peer dependency/i.test(t)) {
    return false;
  }
  // Unrecoverable tree (usually accompany exit ≠ 0; be strict if text appears anyway)
  if (/\bnpm error code ERESOLVE\b/i.test(t) && /\bunable to resolve dependency tree/i.test(t)) {
    return false;
  }
  // Real npm-failure lines; do not keep the install if npm emitted these
  if (/(?:^|\n)npm error code /m.test(t) || /(?:^|\n)npm ERR! /m.test(t)) {
    return false;
  }
  return true;
}

type PackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun';

/**
 * Peer warnings pnpm / yarn / bun print on installs that succeed — their counterpart of npm's
 * `overriding peer dependency` block: pnpm's `✕ unmet|missing peer` tree, yarn classic
 * `has unmet|incorrect peer dependency`, yarn berry YN0002 / YN0060 / YN0086, bun
 * `warn: incorrect peer dependency`.
 */
const ADVISORY_PEER_WARNING =
  /✕ (?:unmet|missing) peer |warning ".*" has (?:unmet|incorrect) peer dependency |\bYN00(?:02|60|86):|warn: incorrect peer dependency /i;

/**
 * After a **successful** install (exit 0), roll back if structured conflicts were detected (unless
 * --force), or when the install is truly suspect. Rows that never justify undoing an install that
 * exited 0 are set aside first (they stay in `classified` for the report, and still make a
 * non-zero exit count as a peer failure):
 *   - `incompatibleEngine`: npm prints EBADENGINE for *any* package in the tree whose `engines`
 *     don't match, so one such package would otherwise block every upgrade.
 *   - pnpm / yarn / bun peer warnings ({@link ADVISORY_PEER_WARNING}), unless pnpm's strict-mode
 *     `ERR_PNPM_PEER_DEP_ISSUES` appears anyway.
 * npm-only: if the only issue is the usual `ERESOLVE overriding` warning block, we **do not** roll back.
 */
export function shouldRollbackAfterSuccessfulInstall(
  fullOutput: string,
  classified: ClassifiedConflict[],
  force: boolean,
  manager: PackageManager = 'npm',
): boolean {
  if (force) {
    return false;
  }
  const peerWarningsAdvisory = !/ERR_PNPM_PEER_DEP_ISSUES/.test(fullOutput || '');
  const blocking = classified.filter(
    (c) =>
      c.category !== 'incompatibleEngine' &&
      !(peerWarningsAdvisory && ADVISORY_PEER_WARNING.test(c.rawMessage)),
  );
  if (blocking.length === 0) {
    return false;
  }
  if (manager === 'npm' && npmOverrodePeersButInstallSucceeded(fullOutput, classified)) {
    return false;
  }
  return true;
}

/**
 * True when the parsed install output looks like a **peer-resolution** failure — i.e. the
 * install bailed because the dependency tree couldn't be satisfied (npm `ERESOLVE`, yarn
 * `Couldn't find any versions`, pnpm `ERR_PNPM_PEER_DEP_ISSUES`) rather than an infra
 * failure (registry 500, disk full, network timeout).
 *
 * The main upgrade engine uses this to promote a non-zero install exit from the generic
 * `kind: 'install'` (which the peer resolver ignores) to `kind: 'peer'` (which the resolver
 * will actually try to fix). Without this, an `npm install` that exits 1 with a tree of
 * perfectly-parseable peer edges was being treated as "unknown install failure" and the
 * resolver never fired — even though it's the exact case it was built for.
 *
 * Conservative on purpose: only the three categories that genuinely mean "the dependency
 * graph itself is the problem". `incompatibleEngine` is excluded (the resolver can't fix a
 * Node version mismatch). An empty list returns false — no classification, no promotion.
 */
export function classifiedHasPeerLikeFailure(
  classified: ClassifiedConflict[],
): boolean {
  if (classified.length === 0) return false;
  return classified.some(
    (c) =>
      c.category === 'peerDependencyMismatch' ||
      c.category === 'unresolvedTree' ||
      c.category === 'missingDependency',
  );
}
