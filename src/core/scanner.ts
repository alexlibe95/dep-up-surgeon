import path from 'node:path';
import fs from 'fs-extra';
import semver from 'semver';
import type { DepSection, ScannedPackage } from '../types.js';
import type { PackageJson } from '../types.js';

const NON_REGISTRY = /^(workspace:|link:|file:|git\+|git:|http:|https:)/i;

/**
 * Returns true if the version range points at the npm registry (semver-like).
 */
export function isRegistryRange(range: string): boolean {
  const t = range.trim();
  if (!t || NON_REGISTRY.test(t)) {
    return false;
  }
  return semver.validRange(t) != null || semver.coerce(t) != null;
}

/**
 * Read package.json and list `dependencies` + `devDependencies` entries.
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

  // Deterministic order: dependencies first (sorted), then devDependencies (sorted)
  const deps = out.filter((p) => p.section === 'dependencies').sort((a, b) => a.name.localeCompare(b.name));
  const devs = out.filter((p) => p.section === 'devDependencies').sort((a, b) => a.name.localeCompare(b.name));
  return [...deps, ...devs];
}
