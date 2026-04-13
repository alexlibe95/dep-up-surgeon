import type { PackageJson } from '../types.js';
import type { ScannedPackage } from '../types.js';
import type { CustomLinkedGroup, LinkedGroup } from './groups.js';
import { buildDependencyGraph, findConnectedComponents } from './graph.js';
import { isRegistryRange } from './scanner.js';
import { log } from '../utils/logger.js';
import { createManifestCache } from '../utils/registryCache.js';

/**
 * Build linked upgrade groups from **registry metadata only** (no framework lists):
 *
 * 1. Apply **custom** `.dep-up-surgeonrc` `linkedGroups` first.
 * 2. Build a graph from root `package.json` + published **peerDependencies** only (runtime
 *    `dependencies` are not used for clustering — they over-connect via hubs like `typescript`).
 * 3. Link `@types/<name>` ↔ `<name>` when both are direct dependencies.
 * 4. **Connected components** become one batch each; isolated packages stay singletons.
 * 5. Non-registry ranges (workspace/file/git) are always singletons.
 */
export async function buildDynamicLinkedGroups(
  pkg: PackageJson,
  scanned: ScannedPackage[],
  ignore: Set<string>,
  custom: CustomLinkedGroup[] | undefined,
  jsonOutput: boolean,
): Promise<LinkedGroup[]> {
  const allNames = [
    ...new Set(
      scanned
        .map((p) => p.name)
        .filter((n) => !ignore.has(n)),
    ),
  ];

  const assigned = new Set<string>();
  const groups: LinkedGroup[] = [];

  for (const cg of custom ?? []) {
    const want = cg.packages.filter((n) => allNames.includes(n) && !assigned.has(n));
    if (want.length === 0) {
      continue;
    }
    for (const n of want) {
      assigned.add(n);
    }
    want.sort((a, b) => a.localeCompare(b));
    groups.push({ id: cg.id, names: want });
  }

  const pool = allNames.filter((n) => !assigned.has(n));
  const byName = new Map(scanned.map((p) => [p.name, p]));

  const registryInPool: string[] = [];
  const nonRegistry: string[] = [];
  for (const n of pool) {
    const s = byName.get(n);
    if (s && isRegistryRange(s.currentRange)) {
      registryInPool.push(n);
    } else {
      nonRegistry.push(n);
    }
  }

  for (const n of nonRegistry) {
    groups.push({ id: `single:${n}`, names: [n] });
  }

  if (registryInPool.length === 0) {
    return sortGroupsStable(groups);
  }

  const cache = createManifestCache();
  const isRegistryPackage = (name: string) => {
    const s = byName.get(name);
    return Boolean(s && isRegistryRange(s.currentRange));
  };

  const onlyNames = new Set(registryInPool);
  const graph = await buildDependencyGraph(
    pkg,
    {
      isRegistryPackage,
      getManifest: (name) => cache.get(name),
    },
    { onlyNames },
  );

  const components = findConnectedComponents(graph);
  let graphIdx = 0;
  let multiCount = 0;

  for (const rawMembers of components) {
    const members = rawMembers.filter((n) => onlyNames.has(n));
    if (members.length === 0) {
      continue;
    }
    members.sort((a, b) => a.localeCompare(b));
    if (members.length === 1) {
      groups.push({ id: `single:${members[0]}`, names: members });
    } else {
      multiCount++;
      groups.push({ id: `graph-${graphIdx++}`, names: members });
    }
  }

  if (!jsonOutput) {
    log.dim(
      `Linked groups: ${multiCount} multi-package cluster(s) from registry peerDependency graph (+ @types/* pairing).`,
    );
  }

  return sortGroupsStable(groups);
}

function sortGroupsStable(gs: LinkedGroup[]): LinkedGroup[] {
  return gs.sort((a, b) => (a.names[0] ?? '').localeCompare(b.names[0] ?? ''));
}
