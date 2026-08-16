/**
 * pnpm / Bun catalog protocol (`catalog:` / `catalog:<name>`).
 *
 * The declared range in package.json is a pointer; the real semver lives in
 * `pnpm-workspace.yaml` (`catalog` / `catalogs`) or in `package.json`
 * `workspaces.catalog` / `workspaces.catalogs` (Bun).
 *
 * Upgrades rewrite the catalog entry and leave the package.json pointer intact so
 * every workspace member that shares the catalog stays in sync.
 */
import path from 'node:path';
import fs from 'fs-extra';
import YAML from 'yaml';

export type CatalogSpec = { kind: 'default' } | { kind: 'named'; name: string };

export interface CatalogIndex {
  default: Map<string, string>;
  named: Map<string, Map<string, string>>;
  /** Where the maps were loaded from. */
  source?: 'pnpm-workspace.yaml' | 'package.json';
  /** Absolute path of the file we write back. */
  file?: string;
}

const CATALOG_RE = /^catalog:(.*)$/i;

/** `catalog:` (default) or `catalog:<name>` (named). */
export function parseCatalogSpec(range: string): CatalogSpec | undefined {
  const t = range.trim();
  const m = CATALOG_RE.exec(t);
  if (!m) return undefined;
  const name = (m[1] ?? '').trim();
  return name ? { kind: 'named', name } : { kind: 'default' };
}

export function isCatalogRange(range: string): boolean {
  return parseCatalogSpec(range) !== undefined;
}

function asRangeMap(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) out.set(k, v);
  }
  return out;
}

function asNamedCatalogs(value: unknown): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [name, inner] of Object.entries(value as Record<string, unknown>)) {
    const map = asRangeMap(inner);
    if (map.size > 0) out.set(name, map);
  }
  return out;
}

function workspacesObject(pkg: unknown): Record<string, unknown> | undefined {
  if (!pkg || typeof pkg !== 'object') return undefined;
  const ws = (pkg as { workspaces?: unknown }).workspaces;
  if (!ws || typeof ws !== 'object' || Array.isArray(ws)) return undefined;
  return ws as Record<string, unknown>;
}

/**
 * Load catalog maps from `pnpm-workspace.yaml` (preferred) or `package.json` workspaces.
 * Missing files yield an empty index (not an error).
 */
export async function loadCatalogIndex(cwd: string): Promise<CatalogIndex> {
  const yamlPath = path.join(cwd, 'pnpm-workspace.yaml');
  if (await fs.pathExists(yamlPath)) {
    try {
      const raw = await fs.readFile(yamlPath, 'utf8');
      const doc = YAML.parse(raw) as Record<string, unknown> | null;
      const def = asRangeMap(doc?.catalog);
      const named = asNamedCatalogs(doc?.catalogs);
      if (def.size > 0 || named.size > 0) {
        return { default: def, named, source: 'pnpm-workspace.yaml', file: yamlPath };
      }
    } catch {
      /* unreadable yaml — fall through to package.json */
    }
  }

  const pkgPath = path.join(cwd, 'package.json');
  if (await fs.pathExists(pkgPath)) {
    try {
      const pkg = (await fs.readJson(pkgPath)) as Record<string, unknown>;
      const ws = workspacesObject(pkg);
      const def = asRangeMap(ws?.catalog);
      const named = asNamedCatalogs(ws?.catalogs);
      if (def.size > 0 || named.size > 0) {
        return { default: def, named, source: 'package.json', file: pkgPath };
      }
    } catch {
      /* ignore */
    }
  }

  return { default: new Map(), named: new Map() };
}

export function resolveCatalogRange(
  index: CatalogIndex,
  packageName: string,
  spec: CatalogSpec,
): string | undefined {
  if (spec.kind === 'default') return index.default.get(packageName);
  return index.named.get(spec.name)?.get(packageName);
}

/**
 * Style source for `formatUpgradeRange`: the catalog's current semver, else the declared
 * pointer (`catalog:`), which pins exact.
 */
export function catalogStyleRange(
  index: CatalogIndex | undefined,
  packageName: string,
  declaredRange: string,
): string {
  const spec = parseCatalogSpec(declaredRange);
  if (!spec || !index) return declaredRange;
  return resolveCatalogRange(index, packageName, spec) ?? declaredRange;
}

/**
 * Write `range` into the catalog file and keep the in-memory index in sync.
 * No-op when the index has no backing file.
 */
export async function writeCatalogRange(
  index: CatalogIndex,
  packageName: string,
  spec: CatalogSpec,
  range: string,
): Promise<void> {
  if (!index.file || !index.source) return;

  if (spec.kind === 'default') {
    index.default.set(packageName, range);
  } else {
    const inner = index.named.get(spec.name) ?? new Map<string, string>();
    inner.set(packageName, range);
    index.named.set(spec.name, inner);
  }

  if (index.source === 'pnpm-workspace.yaml') {
    await writePnpmWorkspaceCatalog(index.file, spec, packageName, range);
    return;
  }
  await writePackageJsonCatalog(index.file, spec, packageName, range);
}

async function writePnpmWorkspaceCatalog(
  file: string,
  spec: CatalogSpec,
  packageName: string,
  range: string,
): Promise<void> {
  const raw = await fs.readFile(file, 'utf8');
  const doc = YAML.parseDocument(raw);
  if (spec.kind === 'default') {
    const existing = doc.get('catalog');
    if (!YAML.isMap(existing)) {
      doc.set('catalog', doc.createNode({ [packageName]: range }));
    } else {
      existing.set(packageName, range);
    }
  } else {
    const catalogs = doc.get('catalogs');
    if (!YAML.isMap(catalogs)) {
      doc.set('catalogs', doc.createNode({ [spec.name]: { [packageName]: range } }));
    } else {
      const named = catalogs.get(spec.name);
      if (!YAML.isMap(named)) {
        catalogs.set(spec.name, doc.createNode({ [packageName]: range }));
      } else {
        named.set(packageName, range);
      }
    }
  }
  await fs.writeFile(file, String(doc), 'utf8');
}

async function writePackageJsonCatalog(
  file: string,
  spec: CatalogSpec,
  packageName: string,
  range: string,
): Promise<void> {
  const pkg = (await fs.readJson(file)) as Record<string, unknown>;
  let ws = pkg.workspaces;
  if (Array.isArray(ws)) {
    ws = { packages: ws };
    pkg.workspaces = ws;
  }
  if (!ws || typeof ws !== 'object') {
    ws = {};
    pkg.workspaces = ws;
  }
  const obj = ws as Record<string, unknown>;
  if (spec.kind === 'default') {
    const catalog =
      obj.catalog && typeof obj.catalog === 'object' && !Array.isArray(obj.catalog)
        ? { ...(obj.catalog as Record<string, string>) }
        : {};
    catalog[packageName] = range;
    obj.catalog = catalog;
  } else {
    const catalogs =
      obj.catalogs && typeof obj.catalogs === 'object' && !Array.isArray(obj.catalogs)
        ? { ...(obj.catalogs as Record<string, Record<string, string>>) }
        : {};
    const inner = { ...(catalogs[spec.name] ?? {}) };
    inner[packageName] = range;
    catalogs[spec.name] = inner;
    obj.catalogs = catalogs;
  }
  await fs.writeJson(file, pkg, { spaces: 2 });
}
