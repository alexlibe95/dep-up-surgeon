import path from 'node:path';
import fs from 'fs-extra';
import semver from 'semver';
import type { DepSection, ScannedPackage } from '../types.js';
import type { PackageJson } from '../types.js';

const NON_REGISTRY =
  /^(workspace:|link:|file:|git\+|git:|http:|https:|portal:|patch:|npm:)/i;

/**
 * npm dist-tag: a single identifier, not a protocol and not a path.
 * `latest`, `next`, `canary`, and custom tags all match.
 */
const DIST_TAG = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isDistTag(range: string): boolean {
  const t = range.trim();
  return DIST_TAG.test(t) && semver.validRange(t) == null && semver.coerce(t) == null;
}

/**
 * Returns true if the version range is something we can resolve from the npm registry:
 * a semver range, a dist-tag (`latest`, `next`, …), or a pnpm/Bun `catalog:` pointer.
 */
export function isRegistryRange(range: string): boolean {
  const t = range.trim();
  if (!t || NON_REGISTRY.test(t)) {
    return false;
  }
  if (/^catalog:/i.test(t)) {
    return true;
  }
  return semver.validRange(t) != null || semver.coerce(t) != null || isDistTag(t);
}

/**
 * First semver range found for a package across standard dependency sections.
 */
export function getPackageRange(pkg: PackageJson, name: string): string | undefined {
  return (
    pkg.dependencies?.[name] ??
    pkg.devDependencies?.[name] ??
    pkg.peerDependencies?.[name] ??
    pkg.optionalDependencies?.[name]
  );
}

/**
 * Read package.json and list direct dependency entries (all standard sections).
 */
export async function scanProject(cwd: string): Promise<ScannedPackage[]> {
  const file = path.join(cwd, 'package.json');
  if (!(await fs.pathExists(file))) {
    throw new Error(`No package.json found at ${file}`);
  }
  const pkg = (await fs.readJson(file)) as PackageJson;
  const out: ScannedPackage[] = [];

  const pushSection = (section: DepSection, rec?: Record<string, string>) => {
    if (!rec) {
      return;
    }
    for (const [name, currentRange] of Object.entries(rec)) {
      out.push({ name, section, currentRange });
    }
  };

  pushSection('dependencies', pkg.dependencies);
  pushSection('devDependencies', pkg.devDependencies);
  pushSection('peerDependencies', pkg.peerDependencies);
  pushSection('optionalDependencies', pkg.optionalDependencies);

  const sortByName = (a: ScannedPackage, b: ScannedPackage) => a.name.localeCompare(b.name);
  const deps = out.filter((p) => p.section === 'dependencies').sort(sortByName);
  const devs = out.filter((p) => p.section === 'devDependencies').sort(sortByName);
  const peers = out.filter((p) => p.section === 'peerDependencies').sort(sortByName);
  const opts = out.filter((p) => p.section === 'optionalDependencies').sort(sortByName);
  return [...deps, ...devs, ...peers, ...opts];
}
