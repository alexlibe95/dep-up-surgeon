/**
 * pnpm / Bun catalog protocol (`catalog:` / `catalog:<name>`).
 *
 * The declared range in package.json is a pointer; the real semver lives in
 * `pnpm-workspace.yaml` (`catalog` / `catalogs`) or in `package.json`
 * `workspaces.catalog` / `workspaces.catalogs` (Bun). The default catalog (`catalog:` or
 * `catalog:default`) may be declared either as `catalog` or as `catalogs.default`.
 *
 * Upgrades rewrite the catalog entry and leave the package.json pointer intact so
 * every workspace member that shares the catalog stays in sync.
 */
import path from 'node:path';
import fs from 'fs-extra';
import YAML from 'yaml';
import { writeJsonLike } from './jsonFile.js';

export type CatalogSpec = { kind: 'default' } | { kind: 'named'; name: string };

export interface CatalogIndex {
  /** Default catalog: top-level `catalog` merged with `catalogs.default`. */
  default: Map<string, string>;
  /** Named catalogs (`default` is folded into `default` above). */
  named: Map<string, Map<string, string>>;
  /** Where the maps were loaded from. */
  source?: 'pnpm-workspace.yaml' | 'package.json';
  /** Absolute path of the file we write back. */
  file?: string;
}

const CATALOG_RE = /^catalog:(.*)$/i;
const DEFAULT_CATALOG = 'default';

/** `catalog:` / `catalog:default` (default) or `catalog:<name>` (named). */
export function parseCatalogSpec(range: string): CatalogSpec | undefined {
  const t = range.trim();
  const m = CATALOG_RE.exec(t);
  if (!m) return undefined;
  const name = (m[1] ?? '').trim();
  return name && name !== DEFAULT_CATALOG ? { kind: 'named', name } : { kind: 'default' };
}

export function isCatalogRange(range: string): boolean {
  return parseCatalogSpec(range) !== undefined;
}

/** Named catalog a spec points at; `undefined` for the default one (incl. hand-built `named: 'default'`). */
function namedCatalog(spec: CatalogSpec): string | undefined {
  return spec.kind === 'named' && spec.name !== DEFAULT_CATALOG ? spec.name : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asRangeMap(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // YAML reads an unquoted `semver: 7` as a number.
    if (typeof v === 'number') out.set(k, String(v));
    else if (typeof v === 'string' && v.trim()) out.set(k, v);
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

/** Split a `{ catalog, catalogs }` container into the default catalog and the named ones. */
function readCatalogs(container: unknown): {
  def: Map<string, string>;
  named: Map<string, Map<string, string>>;
} {
  const obj = isRecord(container) ? container : {};
  const named = asNamedCatalogs(obj.catalogs);
  const def = named.get(DEFAULT_CATALOG) ?? new Map<string, string>();
  named.delete(DEFAULT_CATALOG);
  for (const [k, v] of asRangeMap(obj.catalog)) def.set(k, v);
  return { def, named };
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
      // logLevel 'error': yaml would otherwise print document warnings via process.emitWarning.
      const { def, named } = readCatalogs(YAML.parse(raw, { logLevel: 'error' }));
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
      const { def, named } = readCatalogs(workspacesObject(pkg));
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
  const name = namedCatalog(spec);
  if (name === undefined) return index.default.get(packageName);
  return index.named.get(name)?.get(packageName);
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

  const name = namedCatalog(spec);
  if (name === undefined) {
    index.default.set(packageName, range);
  } else {
    const inner = index.named.get(name) ?? new Map<string, string>();
    inner.set(packageName, range);
    index.named.set(name, inner);
  }

  if (index.source === 'pnpm-workspace.yaml') {
    await writePnpmWorkspaceCatalog(index.file, name, packageName, range);
    return;
  }
  await writePackageJsonCatalog(index.file, name, packageName, range);
}

/** `catalogName` undefined = default catalog. */
async function writePnpmWorkspaceCatalog(
  file: string,
  catalogName: string | undefined,
  packageName: string,
  range: string,
): Promise<void> {
  const raw = await fs.readFile(file, 'utf8');
  const doc = YAML.parseDocument(raw);
  const catalogs = doc.get('catalogs');
  if (catalogName === undefined) {
    const top = doc.get('catalog');
    const nested = YAML.isMap(catalogs) ? catalogs.get(DEFAULT_CATALOG) : undefined;
    // Stay in `catalogs.default` when that's where the default catalog lives: pnpm rejects a
    // default catalog declared both ways.
    const target = YAML.isMap(top) ? top : YAML.isMap(nested) ? nested : undefined;
    if (target) {
      target.set(packageName, range);
    } else {
      doc.set('catalog', doc.createNode({ [packageName]: range }));
    }
  } else {
    if (!YAML.isMap(catalogs)) {
      doc.set('catalogs', doc.createNode({ [catalogName]: { [packageName]: range } }));
    } else {
      const named = catalogs.get(catalogName);
      if (!YAML.isMap(named)) {
        catalogs.set(catalogName, doc.createNode({ [packageName]: range }));
      } else {
        named.set(packageName, range);
      }
    }
  }
  await fs.writeFile(file, String(doc), 'utf8');
}

/** `catalogName` undefined = default catalog. */
async function writePackageJsonCatalog(
  file: string,
  catalogName: string | undefined,
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
  const catalogs = isRecord(obj.catalogs)
    ? { ...(obj.catalogs as Record<string, Record<string, string>>) }
    : {};
  // Same rule as the yaml writer: `catalogs.default` only when there's no top-level `catalog`.
  const target =
    catalogName ??
    (!isRecord(obj.catalog) && isRecord(catalogs[DEFAULT_CATALOG]) ? DEFAULT_CATALOG : undefined);
  if (target === undefined) {
    const catalog = isRecord(obj.catalog) ? { ...(obj.catalog as Record<string, string>) } : {};
    catalog[packageName] = range;
    obj.catalog = catalog;
  } else {
    const inner = { ...(catalogs[target] ?? {}) };
    inner[packageName] = range;
    catalogs[target] = inner;
    obj.catalogs = catalogs;
  }
  await writeJsonLike(file, pkg);
}
