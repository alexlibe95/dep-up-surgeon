import pacote from 'pacote';
import type { ScannedPackage } from '../types.js';
import type { CustomLinkedGroup, LinkedGroup } from './groups.js';
import { isRegistryRange } from './scanner.js';
import { log } from '../utils/logger.js';

/** Parallel manifest fetches to stay kind to the registry */
const FETCH_CHUNK = 10;

class UnionFind {
  private readonly parent = new Map<string, string>();

  constructor(keys: string[]) {
    for (const k of keys) {
      this.parent.set(k, k);
    }
  }

  find(x: string): string {
    let p = this.parent.get(x)!;
    if (p !== x) {
      p = this.find(p);
      this.parent.set(x, p);
    }
    return p;
  }

  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) {
      this.parent.set(ra, rb);
    }
  }
}

/**
 * Published `peerDependencies` + `dependencies` keys from the registry manifest.
 */
async function fetchDeclaredRefs(packageName: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const m = await pacote.manifest(`${packageName}@latest`, { fullMetadata: false });
    for (const k of Object.keys(m.peerDependencies ?? {})) {
      out.add(k);
    }
    for (const k of Object.keys(m.dependencies ?? {})) {
      out.add(k);
    }
  } catch {
    /* missing or private package — no edges */
  }
  return out;
}

/**
 * Build linked upgrade groups from **registry metadata only** (no hardcoded framework lists):
 *
 * 1. Apply **custom** `.dep-up-surgeonrc` `linkedGroups` first (same as before).
 * 2. For every remaining **registry** dependency, fetch its published manifest and connect it
 *    to any **other project dependency** that appears in its `peerDependencies` or `dependencies`.
 * 3. Link `@types/<name>` ↔ `<name>` when both are direct dependencies (DefinitelyTyped pattern).
 * 4. **Connected components** of that graph become one batch each; isolated packages stay singletons.
 * 5. Non-registry ranges (workspace/file/git) are always singletons.
 *
 * TODO: optional peer edges from peerDependenciesMeta; monorepo workspace links
 */
export async function buildDynamicLinkedGroups(
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

  const registrySet = new Set(registryInPool);
  const uf = new UnionFind(registryInPool);

  const refsByName = new Map<string, Set<string>>();
  for (let i = 0; i < registryInPool.length; i += FETCH_CHUNK) {
    const chunk = registryInPool.slice(i, i + FETCH_CHUNK);
    const sets = await Promise.all(chunk.map((n) => fetchDeclaredRefs(n)));
    chunk.forEach((n, j) => refsByName.set(n, sets[j]!));
  }

  for (const a of registryInPool) {
    const refs = refsByName.get(a) ?? new Set();
    for (const b of refs) {
      if (b !== a && registrySet.has(b)) {
        uf.union(a, b);
      }
    }
  }

  for (const a of registryInPool) {
    const typed = `@types/${a}`;
    if (registrySet.has(typed)) {
      uf.union(a, typed);
    }
  }

  const rootToMembers = new Map<string, string[]>();
  for (const n of registryInPool) {
    const r = uf.find(n);
    let list = rootToMembers.get(r);
    if (!list) {
      list = [];
      rootToMembers.set(r, list);
    }
    list.push(n);
  }

  const components = [...rootToMembers.values()].sort((a, b) =>
    (a[0] ?? '').localeCompare(b[0] ?? ''),
  );

  let graphIdx = 0;
  for (const members of components) {
    members.sort((a, b) => a.localeCompare(b));
    if (members.length === 1) {
      groups.push({ id: `single:${members[0]}`, names: members });
    } else {
      groups.push({ id: `graph-${graphIdx++}`, names: members });
    }
  }

  if (!jsonOutput) {
    log.dim(
      `Linked groups: ${components.length} cluster(s) from registry peer/dependency graph (+ @types/* pairing).`,
    );
  }

  return sortGroupsStable(groups);
}

function sortGroupsStable(gs: LinkedGroup[]): LinkedGroup[] {
  return gs.sort((a, b) => (a.names[0] ?? '').localeCompare(b.names[0] ?? ''));
}
