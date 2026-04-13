import type { Manifest } from 'pacote';
import type { PackageJson } from '../types.js';
import { mapWithConcurrency } from '../utils/concurrency.js';

/** Where a package appears in the root package.json */
export type DirectSection =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies';

export type GraphEdgeKind =
  | 'registry-dependency'
  | 'registry-peer'
  | 'registry-optional'
  | 'types-pair';

export interface DepGraphNode {
  name: string;
  directIn: Set<DirectSection>;
}

export interface DepGraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
}

export interface DependencyGraph {
  nodes: Map<string, DepGraphNode>;
  edges: DepGraphEdge[];
}

export interface BuildGraphContext {
  /** Project package names eligible for edges (registry semver ranges only) */
  isRegistryPackage: (name: string) => boolean;
  /** Latest manifest for a package name; null if unavailable */
  getManifest: (packageName: string) => Promise<Manifest | null>;
}

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

function addNode(nodes: Map<string, DepGraphNode>, name: string, section: DirectSection): void {
  let n = nodes.get(name);
  if (!n) {
    n = { name, directIn: new Set() };
    nodes.set(name, n);
  }
  n.directIn.add(section);
}

function collectNodesFromPackageJson(
  pkg: PackageJson,
  onlyNames?: Set<string>,
): Map<string, DepGraphNode> {
  const nodes = new Map<string, DepGraphNode>();
  const push = (section: DirectSection, rec?: Record<string, string>) => {
    if (!rec) {
      return;
    }
    for (const name of Object.keys(rec)) {
      if (onlyNames && !onlyNames.has(name)) {
        continue;
      }
      addNode(nodes, name, section);
    }
  };
  push('dependencies', pkg.dependencies);
  push('devDependencies', pkg.devDependencies);
  push('peerDependencies', pkg.peerDependencies);
  push('optionalDependencies', pkg.optionalDependencies);
  return nodes;
}

function addUndirectedEdge(
  edges: DepGraphEdge[],
  seen: Set<string>,
  a: string,
  b: string,
  kind: GraphEdgeKind,
): void {
  if (a === b) {
    return;
  }
  const key = a < b ? `${a}\0${b}\0${kind}` : `${b}\0${a}\0${kind}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  edges.push({ from: a, to: b, kind });
}

export interface BuildDependencyGraphOptions {
  /** If set, only these direct dependency names participate as nodes (e.g. registry pool). */
  onlyNames?: Set<string>;
}

/**
 * Build an undirected graph: project packages are nodes; edges come only from published
 * **peerDependencies** (the signal that versions must align), not from runtime
 * `dependencies` / `optionalDependencies` (those create hub edges through `typescript`,
 * `eslint`, etc. and collapse unrelated tools into one giant batch). Also
 * `@types/<name>` ↔ `<name>` when both exist.
 */
export async function buildDependencyGraph(
  pkg: PackageJson,
  ctx: BuildGraphContext,
  options?: BuildDependencyGraphOptions,
): Promise<DependencyGraph> {
  const nodes = collectNodesFromPackageJson(pkg, options?.onlyNames);
  const names = [...nodes.keys()];
  const registryNames = names.filter((n) => ctx.isRegistryPackage(n));
  const registrySet = new Set(registryNames);
  const edges: DepGraphEdge[] = [];
  const edgeKeys = new Set<string>();

  await mapWithConcurrency(registryNames, 10, (name) => ctx.getManifest(name));

  for (const name of registryNames) {
    const m = await ctx.getManifest(name);
    if (!m) {
      continue;
    }
    const link = (to: string, kind: GraphEdgeKind) => {
      if (registrySet.has(to)) {
        addUndirectedEdge(edges, edgeKeys, name, to, kind);
      }
    };
    for (const k of Object.keys(m.peerDependencies ?? {})) {
      link(k, 'registry-peer');
    }
  }

  for (const n of registryNames) {
    const typed = `@types/${n}`;
    if (registrySet.has(typed)) {
      addUndirectedEdge(edges, edgeKeys, n, typed, 'types-pair');
    }
  }

  return { nodes, edges };
}

/**
 * Connected components (treat graph as undirected).
 */
export function findConnectedComponents(graph: DependencyGraph): string[][] {
  const names = [...graph.nodes.keys()];
  if (names.length === 0) {
    return [];
  }
  const uf = new UnionFind(names);
  for (const e of graph.edges) {
    uf.union(e.from, e.to);
  }
  const rootToMembers = new Map<string, string[]>();
  for (const n of names) {
    const r = uf.find(n);
    let list = rootToMembers.get(r);
    if (!list) {
      list = [];
      rootToMembers.set(r, list);
    }
    list.push(n);
  }
  const components = [...rootToMembers.values()].map((c) => c.sort((a, b) => a.localeCompare(b)));
  components.sort((a, b) => (a[0] ?? '').localeCompare(b[0] ?? ''));
  return components;
}
