/**
 * Resolve the "from" version for outdated checks and upgrade reports.
 *
 * Prefer the version the lockfile resolved for THIS package.json's direct dependency: npm and
 * pnpm lockfiles record it per importer; for yarn/bun we take the highest locked version that
 * satisfies the declared range. Either way a nested copy of the same package elsewhere in the
 * tree (`node_modules/send/node_modules/debug@4`) can't mask an outdated direct one.
 * Fall back to `semver.coerce(declaredRange)` when the lockfile is missing or the package
 * isn't listed there yet. This avoids the classic false-positive where `^1.0.0` looks
 * outdated even though the lockfile already resolved to `1.9.0` (== registry latest).
 */
import path from 'node:path';
import fs from 'fs-extra';
import semver from 'semver';
import {
  parseLockfileDirectVersions,
  parseLockfileInstalledVersions,
  type LockfileDirectVersions,
} from '../cli/lockfileFix.js';
import type { PackageManager } from '../core/workspaces.js';

/**
 * Package → every locked version. Trees from `loadLockfileVersionTree` also carry `direct`
 * (per-importer direct-dependency versions) when the lockfile format records them.
 */
export type LockfileVersionTree = Map<string, Set<string> | string[]> & {
  direct?: LockfileDirectVersions;
};

/**
 * Highest installed version for `name` from a lockfile tree, or `undefined` if absent.
 */
export function highestInstalledVersion(
  tree: LockfileVersionTree | undefined,
  name: string,
): string | undefined {
  if (!tree) return undefined;
  const raw = tree.get(name);
  if (!raw) return undefined;
  const versions = [...raw].filter((v) => semver.valid(v));
  if (versions.length === 0) return undefined;
  versions.sort(semver.rcompare);
  return versions[0];
}

export interface LockfileInstalledVersionOptions {
  /** Range declared in package.json; locked versions outside it belong to other dependents. */
  declaredRange?: string;
  /**
   * Directory of the package.json relative to the lockfile's directory (e.g. `packages/web`).
   * Omit (or `.`) for the lockfile root.
   */
  memberRelDir?: string;
}

/**
 * Version the lockfile resolved for `name` as a direct dependency. With neither a declared
 * range nor a direct-dependency index this is `highestInstalledVersion`.
 */
export function lockfileInstalledVersion(
  tree: LockfileVersionTree | undefined,
  name: string,
  opts: LockfileInstalledVersionOptions = {},
): string | undefined {
  if (!tree) return undefined;
  const range =
    opts.declaredRange && semver.validRange(opts.declaredRange) ? opts.declaredRange : undefined;
  const direct = directInstalledVersion(tree.direct, name, opts.memberRelDir);
  if (direct && (!range || semver.satisfies(direct, range))) return direct;
  if (!range) return direct ?? highestInstalledVersion(tree, name);
  // A direct entry outside the range means we looked at the wrong importer (no memberRelDir)
  // or package.json changed since the last install — a copy that fits the range is closer.
  const versions = [...(tree.get(name) ?? [])].filter((v) => semver.valid(v));
  return semver.maxSatisfying(versions, range) ?? direct;
}

function directInstalledVersion(
  direct: LockfileDirectVersions | undefined,
  name: string,
  memberRelDir: string | undefined,
): string | undefined {
  if (!direct) return undefined;
  const importer = normalizeImporterDir(memberRelDir);
  let version = direct.importers.get(importer)?.get(name);
  if (version === undefined && direct.hoisted && importer !== '.') {
    version = direct.importers.get('.')?.get(name);
  }
  return version && semver.valid(version) ? version : undefined;
}

function normalizeImporterDir(memberRelDir: string | undefined): string {
  const rel = (memberRelDir ?? '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
  return rel === '' ? '.' : rel;
}

/**
 * Resolve the version to treat as "current" for upgrade planning.
 */
export function resolveInstalledVersion(opts: {
  name: string;
  declaredRange: string;
  lockfileVersions?: LockfileVersionTree;
  /** See `LockfileInstalledVersionOptions.memberRelDir`. */
  memberRelDir?: string;
}): string | undefined {
  const fromLock = lockfileInstalledVersion(opts.lockfileVersions, opts.name, {
    declaredRange: opts.declaredRange,
    ...(opts.memberRelDir !== undefined ? { memberRelDir: opts.memberRelDir } : {}),
  });
  if (fromLock) return fromLock;
  return semver.coerce(opts.declaredRange)?.version;
}

function lockfileBasenameFor(manager: PackageManager): string {
  switch (manager) {
    case 'pnpm':
      return 'pnpm-lock.yaml';
    case 'yarn':
      return 'yarn.lock';
    case 'bun':
      return 'bun.lock';
    default:
      return 'package-lock.json';
  }
}

/**
 * Best-effort load of installed versions from the workspace lockfile. Returns an empty map
 * when the file is missing or unreadable — callers fall back to declared ranges.
 */
export async function loadLockfileVersionTree(
  cwd: string,
  manager: PackageManager,
): Promise<Map<string, Set<string>> & { direct?: LockfileDirectVersions }> {
  const file = path.join(cwd, lockfileBasenameFor(manager));
  try {
    if (!(await fs.pathExists(file))) {
      return new Map();
    }
    const raw = await fs.readFile(file, 'utf8');
    const tree: Map<string, Set<string>> & { direct?: LockfileDirectVersions } =
      parseLockfileInstalledVersions(raw, manager);
    const direct = parseLockfileDirectVersions(raw, manager);
    if (direct) tree.direct = direct;
    return tree;
  } catch {
    return new Map();
  }
}
