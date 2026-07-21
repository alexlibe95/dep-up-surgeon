/**
 * When the same package name appears in multiple package.json sections (e.g. both
 * `dependencies` and `peerDependencies`), pick one row for upgrade planning.
 *
 * Preference order (runtime deps win over contracts / tooling):
 *   dependencies > optionalDependencies > peerDependencies > devDependencies
 *
 * Callers that want to upgrade every section must iterate the full scan instead.
 */
import type { DepSection, ScannedPackage } from '../types.js';

const SECTION_RANK: Record<DepSection, number> = {
  dependencies: 0,
  optionalDependencies: 1,
  peerDependencies: 2,
  devDependencies: 3,
};

export function preferSection(a: DepSection, b: DepSection): DepSection {
  return SECTION_RANK[a] <= SECTION_RANK[b] ? a : b;
}

/**
 * Collapse duplicate names, keeping the preferred section. Order of first appearance is
 * preserved among unique winners.
 */
export function dedupeScannedByName(scanned: ScannedPackage[]): ScannedPackage[] {
  const best = new Map<string, ScannedPackage>();
  for (const p of scanned) {
    const prev = best.get(p.name);
    if (!prev) {
      best.set(p.name, p);
      continue;
    }
    if (SECTION_RANK[p.section] < SECTION_RANK[prev.section]) {
      best.set(p.name, p);
    }
  }
  // Stable-ish: follow first-seen order from the original scan.
  const out: ScannedPackage[] = [];
  const seen = new Set<string>();
  for (const p of scanned) {
    if (seen.has(p.name)) continue;
    const winner = best.get(p.name);
    if (winner) {
      out.push(winner);
      seen.add(p.name);
    }
  }
  return out;
}
