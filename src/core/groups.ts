import type { ScannedPackage } from '../types.js';

export interface LinkedGroup {
  /** Stable id for logging / reports (e.g. "expo", "graph-0", "single:lodash") */
  id: string;
  /** Package names in this group (apply upgrades together) */
  names: string[];
}

export interface CustomLinkedGroup {
  id: string;
  /** Exact package names to move as one unit */
  packages: string[];
}

/**
 * One package per group (`--link-groups none`).
 */
export function buildSingletonGroups(scanned: ScannedPackage[], ignore: Set<string>): LinkedGroup[] {
  const names = [
    ...new Set(
      scanned
        .map((p) => p.name)
        .filter((n) => !ignore.has(n)),
    ),
  ];
  return names.sort().map((n) => ({ id: `single:${n}`, names: [n] }));
}
