/**
 * Resolve the "from" version for outdated checks and upgrade reports.
 *
 * Prefer the highest concrete version present in the lockfile (what is actually installed).
 * Fall back to `semver.coerce(declaredRange)` when the lockfile is missing or the package
 * isn't listed there yet. This avoids the classic false-positive where `^1.0.0` looks
 * outdated even though the lockfile already resolved to `1.9.0` (== registry latest).
 */
import path from 'node:path';
import fs from 'fs-extra';
import semver from 'semver';
import { parseLockfileInstalledVersions } from '../cli/lockfileFix.js';
import type { PackageManager } from '../core/workspaces.js';

export type LockfileVersionTree = Map<string, Set<string> | string[]>;

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

/**
 * Resolve the version to treat as "current" for upgrade planning.
 */
export function resolveInstalledVersion(opts: {
  name: string;
  declaredRange: string;
  lockfileVersions?: LockfileVersionTree;
}): string | undefined {
  const fromLock = highestInstalledVersion(opts.lockfileVersions, opts.name);
  if (fromLock) return fromLock;
  return semver.coerce(opts.declaredRange)?.version;
}

function lockfileBasenameFor(manager: PackageManager): string {
  switch (manager) {
    case 'pnpm':
      return 'pnpm-lock.yaml';
    case 'yarn':
      return 'yarn.lock';
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
): Promise<Map<string, Set<string>>> {
  const file = path.join(cwd, lockfileBasenameFor(manager));
  try {
    if (!(await fs.pathExists(file))) {
      return new Map();
    }
    const raw = await fs.readFile(file, 'utf8');
    return parseLockfileInstalledVersions(raw, manager);
  } catch {
    return new Map();
  }
}
