import type { ScannedPackage } from '../types.js';

export interface LinkedGroup {
  /** Stable id for logging / reports (e.g. "expo", "react-core", "single:lodash") */
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
 * Built-in: Expo SDK and scoped Expo packages usually must move together.
 */
export function isExpoEcosystem(name: string): boolean {
  return name === 'expo' || name.startsWith('expo-') || name.startsWith('@expo/');
}

/**
 * Built-in: React + RN core often peer each other; bump together to reduce breakage.
 * (Does not include every react-native-* — those stay separate unless in custom groups.)
 */
export function isReactNativeCore(name: string): boolean {
  return (
    name === 'react' ||
    name === 'react-dom' ||
    name === 'react-native' ||
    name === 'react-native-web'
  );
}

/**
 * Partition dependency names into linked upgrade groups.
 *
 * - **auto**: custom groups from config first, then `expo` ecosystem, then `react-core`,
 *   then each remaining package alone.
 * - **none**: one group per package (legacy one-by-one behavior).
 */
export function buildLinkedGroups(
  scanned: ScannedPackage[],
  ignore: Set<string>,
  strategy: 'auto' | 'none',
  custom?: CustomLinkedGroup[],
): LinkedGroup[] {
  const names = [
    ...new Set(
      scanned
        .map((p) => p.name)
        .filter((n) => !ignore.has(n)),
    ),
  ];

  if (strategy === 'none') {
    return names.sort().map((n) => ({ id: `single:${n}`, names: [n] }));
  }

  const assigned = new Set<string>();
  const groups: LinkedGroup[] = [];

  const pushNames = (id: string, picked: string[]): void => {
    const uniq = [...new Set(picked)].filter((n) => names.includes(n) && !assigned.has(n));
    if (uniq.length === 0) {
      return;
    }
    for (const n of uniq) {
      assigned.add(n);
    }
    uniq.sort((a, b) => a.localeCompare(b));
    groups.push({ id, names: uniq });
  };

  for (const cg of custom ?? []) {
    const want = cg.packages.filter((n) => names.includes(n));
    pushNames(cg.id, want);
  }

  pushNames(
    'expo',
    names.filter((n) => !assigned.has(n) && isExpoEcosystem(n)),
  );

  pushNames(
    'react-core',
    names.filter((n) => !assigned.has(n) && isReactNativeCore(n)),
  );

  for (const n of names) {
    if (!assigned.has(n)) {
      assigned.add(n);
      groups.push({ id: `single:${n}`, names: [n] });
    }
  }

  return groups;
}
