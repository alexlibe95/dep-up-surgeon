/**
 * Unit tests for pnpm / Bun catalog load + write helpers.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import YAML from 'yaml';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const {
  parseCatalogSpec,
  isCatalogRange,
  loadCatalogIndex,
  resolveCatalogRange,
  catalogStyleRange,
  writeCatalogRange,
} = await import(path.join(root, 'dist', 'utils', 'catalog.js'));
const { runUpgradeFlow, restoreInitialFromBackup, CATALOG_BACKUP_FILENAME } = await import(
  path.join(root, 'dist', 'core', 'upgrader.js')
);
const { createRegistryCache } = await import(path.join(root, 'dist', 'utils', 'concurrency.js'));

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-catalog-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('parseCatalogSpec: default and named', () => {
  assert.deepStrictEqual(parseCatalogSpec('catalog:'), { kind: 'default' });
  assert.deepStrictEqual(parseCatalogSpec('catalog:react19'), { kind: 'named', name: 'react19' });
  assert.strictEqual(parseCatalogSpec('^18.2.0'), undefined);
  assert.strictEqual(isCatalogRange('catalog:'), true);
  assert.strictEqual(isCatalogRange('latest'), false);
});

test('loadCatalogIndex + writeCatalogRange: pnpm-workspace.yaml default catalog', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'pnpm-workspace.yaml'),
      ['packages:', '  - packages/*', 'catalog:', '  react: ^18.2.0', '  lodash: ^4.17.21', ''].join('\n'),
    );
    const index = await loadCatalogIndex(dir);
    assert.strictEqual(index.source, 'pnpm-workspace.yaml');
    assert.strictEqual(resolveCatalogRange(index, 'react', { kind: 'default' }), '^18.2.0');
    assert.strictEqual(catalogStyleRange(index, 'react', 'catalog:'), '^18.2.0');

    await writeCatalogRange(index, 'react', { kind: 'default' }, '^19.0.0');
    const raw = await fs.readFile(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');
    assert.match(raw, /react:\s*['"]?\^19\.0\.0['"]?/);
    assert.match(raw, /lodash:\s*['"]?\^4\.17\.21['"]?/);
    assert.strictEqual(resolveCatalogRange(index, 'react', { kind: 'default' }), '^19.0.0');
  });
});

test('loadCatalogIndex + writeCatalogRange: named catalogs in yaml', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'pnpm-workspace.yaml'),
      [
        'packages:',
        '  - packages/*',
        'catalogs:',
        '  react19:',
        '    react: ^18.2.0',
        '',
      ].join('\n'),
    );
    const index = await loadCatalogIndex(dir);
    const spec = { kind: 'named', name: 'react19' };
    assert.strictEqual(resolveCatalogRange(index, 'react', spec), '^18.2.0');
    await writeCatalogRange(index, 'react', spec, '^19.0.0');
    const raw = await fs.readFile(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');
    assert.match(raw, /react19:[\s\S]*react:\s*['"]?\^19\.0\.0['"]?/);
  });
});

test('loadCatalogIndex + writeCatalogRange: Bun package.json workspaces.catalog', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify(
        {
          name: 'root',
          workspaces: {
            packages: ['packages/*'],
            catalog: { chalk: '^5.0.0' },
            catalogs: { next: { react: '^18.0.0' } },
          },
        },
        null,
        2,
      ),
    );
    const index = await loadCatalogIndex(dir);
    assert.strictEqual(index.source, 'package.json');
    assert.strictEqual(resolveCatalogRange(index, 'chalk', { kind: 'default' }), '^5.0.0');
    assert.strictEqual(
      resolveCatalogRange(index, 'react', { kind: 'named', name: 'next' }),
      '^18.0.0',
    );

    await writeCatalogRange(index, 'chalk', { kind: 'default' }, '^5.4.0');
    await writeCatalogRange(index, 'react', { kind: 'named', name: 'next' }, '^19.0.0');
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.workspaces.catalog.chalk, '^5.4.0');
    assert.strictEqual(pkg.workspaces.catalogs.next.react, '^19.0.0');
  });
});

test('parseCatalogSpec: named catalog trims whitespace; empty name is default', () => {
  assert.deepStrictEqual(parseCatalogSpec('catalog: react19'), { kind: 'named', name: 'react19' });
  assert.deepStrictEqual(parseCatalogSpec('catalog:   '), { kind: 'default' });
  assert.deepStrictEqual(parseCatalogSpec('CATALOG:'), { kind: 'default' });
});

test('loadCatalogIndex: empty directory yields empty maps', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    const index = await loadCatalogIndex(dir);
    assert.strictEqual(index.default.size, 0);
    assert.strictEqual(index.named.size, 0);
    assert.strictEqual(index.file, undefined);
  });
});

test('loadCatalogIndex: pnpm-workspace.yaml wins over package.json catalogs', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: { catalog: { react: '^17.0.0' } } }),
    );
    await fs.writeFile(
      path.join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\ncatalog:\n  react: ^18.2.0\n',
    );
    const index = await loadCatalogIndex(dir);
    assert.strictEqual(index.source, 'pnpm-workspace.yaml');
    assert.strictEqual(resolveCatalogRange(index, 'react', { kind: 'default' }), '^18.2.0');
  });
});

test('catalogStyleRange: missing catalog entry keeps the pointer', () => {
  const index = { default: new Map(), named: new Map() };
  assert.strictEqual(catalogStyleRange(index, 'react', 'catalog:'), 'catalog:');
  assert.strictEqual(catalogStyleRange(undefined, 'react', 'catalog:'), 'catalog:');
  assert.strictEqual(catalogStyleRange(index, 'react', '^18.2.0'), '^18.2.0');
});

test('writeCatalogRange: no-op when index has no backing file', async () => {
  const index = { default: new Map(), named: new Map() };
  await writeCatalogRange(index, 'react', { kind: 'default' }, '^19.0.0');
  assert.strictEqual(index.default.get('react'), undefined);
});

test('restoreInitialFromBackup: restores pnpm-workspace.yaml from catalog bak', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'catalog:\n  react: ^19.0.0\n');
    await fs.writeFile(
      path.join(dir, CATALOG_BACKUP_FILENAME),
      'catalog:\n  react: ^18.2.0\n',
    );
    await restoreInitialFromBackup(dir);
    const raw = await fs.readFile(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');
    assert.match(raw, /\^18\.2\.0/);
  });
});

function seededCache(entries) {
  const cache = createRegistryCache();
  for (const [name, version] of Object.entries(entries)) {
    cache.latest.set(name, Promise.resolve(version));
  }
  return cache;
}

const dryRunOpts = {
  dryRun: true,
  interactive: false,
  force: false,
  jsonOutput: true,
  ignore: new Set(),
  fallbackStrategy: 'none',
  linkGroups: 'none',
  linkedGroupsConfig: [],
  validate: { skip: true },
};

test('runUpgradeFlow dry-run: catalog: reports catalog semver as from', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { react: 'catalog:' } }),
    );
    await fs.writeFile(
      path.join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\ncatalog:\n  react: ^18.2.0\n',
    );
    const report = await runUpgradeFlow({
      cwd: dir,
      ...dryRunOpts,
      registryCache: seededCache({ react: '19.0.0' }),
    });
    const row = report.upgraded.find((r) => r.name === 'react');
    assert.ok(row, `expected react row, got ${JSON.stringify(report.upgraded)}`);
    assert.strictEqual(row.skipped, true);
    assert.strictEqual(row.from, '^18.2.0');
    assert.strictEqual(row.to, '19.0.0');
    assert.strictEqual(row.detail, 'dry-run');
  });
});

test('runUpgradeFlow dry-run: catalog: without a matching entry is skipped', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { react: 'catalog:' } }),
    );
    const report = await runUpgradeFlow({
      cwd: dir,
      ...dryRunOpts,
      registryCache: seededCache({ react: '19.0.0' }),
    });
    const row = report.upgraded.find((r) => r.name === 'react');
    assert.ok(row);
    assert.strictEqual(row.skipped, true);
    assert.match(row.detail, /no matching catalog entry/);
  });
});

test('runUpgradeFlow dry-run: dist-tag without lockfile is planned, not parse-skipped', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { lodash: 'latest' } }),
    );
    const report = await runUpgradeFlow({
      cwd: dir,
      ...dryRunOpts,
      registryCache: seededCache({ lodash: '4.17.21' }),
    });
    const row = report.upgraded.find((r) => r.name === 'lodash');
    assert.ok(row, `expected lodash row, got ${JSON.stringify(report.upgraded)}`);
    assert.strictEqual(row.skipped, true);
    assert.notStrictEqual(row.detail, 'could not parse current version');
    assert.strictEqual(row.from, 'latest');
    assert.strictEqual(row.to, '4.17.21');
    assert.strictEqual(row.detail, 'dry-run');
  });
});

test('runUpgradeFlow dry-run: dist-tag already at lockfile latest is skipped', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { lodash: 'latest' } }),
    );
    const report = await runUpgradeFlow({
      cwd: dir,
      ...dryRunOpts,
      registryCache: seededCache({ lodash: '4.17.21' }),
      lockfileVersions: new Map([['lodash', new Set(['4.17.21'])]]),
    });
    const row = report.upgraded.find((r) => r.name === 'lodash');
    assert.ok(row);
    assert.strictEqual(row.skipped, true);
    assert.strictEqual(row.detail, 'already latest');
  });
});

test('runUpgradeFlow: catalog: rewrite leaves package.json pointer and updates yaml', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { react: 'catalog:' } }),
    );
    await fs.writeFile(
      path.join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\ncatalog:\n  react: ^18.2.0\n',
    );
    const report = await runUpgradeFlow({
      cwd: dir,
      dryRun: false,
      interactive: false,
      force: false,
      jsonOutput: true,
      ignore: new Set(),
      fallbackStrategy: 'none',
      linkGroups: 'none',
      linkedGroupsConfig: [],
      validate: { skip: true },
      registryCache: seededCache({ react: '19.0.0' }),
      installer: async () => ({ ok: true, output: '', exitCode: 0, command: 'pnpm install' }),
    });
    const row = report.upgraded.find((r) => r.name === 'react' && !r.skipped);
    assert.ok(row, `expected successful react upgrade, got ${JSON.stringify(report)}`);
    assert.strictEqual(row.from, '^18.2.0');
    assert.strictEqual(row.to, '^19.0.0');
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.dependencies.react, 'catalog:');
    const yaml = await fs.readFile(path.join(dir, 'pnpm-workspace.yaml'), 'utf8');
    assert.match(yaml, /react:\s*['"]?\^19\.0\.0['"]?/);
  });
});

test('runUpgradeFlow: dist-tag is pinned to a concrete version in package.json', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { lodash: 'latest' } }),
    );
    const report = await runUpgradeFlow({
      cwd: dir,
      dryRun: false,
      interactive: false,
      force: false,
      jsonOutput: true,
      ignore: new Set(),
      fallbackStrategy: 'none',
      linkGroups: 'none',
      linkedGroupsConfig: [],
      validate: { skip: true },
      registryCache: seededCache({ lodash: '4.17.21' }),
      installer: async () => ({ ok: true, output: '', exitCode: 0, command: 'npm install' }),
    });
    const row = report.upgraded.find((r) => r.name === 'lodash' && !r.skipped);
    assert.ok(row, `expected successful lodash upgrade, got ${JSON.stringify(report)}`);
    assert.strictEqual(row.from, 'latest');
    assert.strictEqual(row.to, '4.17.21');
    const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
    assert.strictEqual(pkg.dependencies.lodash, '4.17.21');
  });
});

// pnpm treats `catalog:` and `catalog:default` as the same catalog, which can be declared as
// top-level `catalog` or as `catalogs.default`.

test('parseCatalogSpec: catalog:default is the default catalog', () => {
  assert.deepStrictEqual(parseCatalogSpec('catalog:default'), { kind: 'default' });
  assert.deepStrictEqual(parseCatalogSpec('catalog: default'), { kind: 'default' });
});

test('resolveCatalogRange: catalog:default reads the top-level yaml catalog', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\ncatalog:\n  react: ^18.2.0\n',
    );
    const index = await loadCatalogIndex(dir);
    assert.strictEqual(resolveCatalogRange(index, 'react', parseCatalogSpec('catalog:default')), '^18.2.0');
    assert.strictEqual(catalogStyleRange(index, 'react', 'catalog:default'), '^18.2.0');
  });
});

test('loadCatalogIndex + writeCatalogRange: yaml catalogs.default is the default catalog', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'pnpm-workspace.yaml');
    await fs.writeFile(
      file,
      [
        'packages:',
        '  - packages/*',
        'catalogs:',
        '  default:',
        '    react: ^18.2.0',
        '  legacy:',
        '    react: ^17.0.2',
        '',
      ].join('\n'),
    );
    const index = await loadCatalogIndex(dir);
    assert.strictEqual(resolveCatalogRange(index, 'react', parseCatalogSpec('catalog:')), '^18.2.0');
    assert.strictEqual(resolveCatalogRange(index, 'react', parseCatalogSpec('catalog:default')), '^18.2.0');
    assert.strictEqual(resolveCatalogRange(index, 'react', parseCatalogSpec('catalog:legacy')), '^17.0.2');

    await writeCatalogRange(index, 'react', parseCatalogSpec('catalog:'), '^19.0.0');
    const doc = YAML.parse(await fs.readFile(file, 'utf8'));
    // pnpm rejects a default catalog declared both ways, so no top-level `catalog` may appear.
    assert.strictEqual(doc.catalog, undefined);
    assert.strictEqual(doc.catalogs.default.react, '^19.0.0');
    assert.strictEqual(doc.catalogs.legacy.react, '^17.0.2');
  });
});

test('loadCatalogIndex: numeric YAML catalog values are kept as strings', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'pnpm-workspace.yaml'),
      'catalog:\n  semver: 7\n  react: ^18.2.0\ncatalogs:\n  legacy:\n    semver: 6\n',
    );
    const index = await loadCatalogIndex(dir);
    assert.strictEqual(resolveCatalogRange(index, 'semver', { kind: 'default' }), '7');
    assert.strictEqual(resolveCatalogRange(index, 'semver', { kind: 'named', name: 'legacy' }), '6');
    assert.strictEqual(resolveCatalogRange(index, 'react', { kind: 'default' }), '^18.2.0');
  });
});

test('loadCatalogIndex + writeCatalogRange: Bun default catalog via workspaces.catalog or catalogs.default', async () => {
  const layouts = [
    { catalog: { chalk: '^5.0.0' } },
    { catalogs: { default: { chalk: '^5.0.0' }, next: { react: '^18.0.0' } } },
  ];
  for (const layout of layouts) {
    await withTempDir(async (dir) => {
      const file = path.join(dir, 'package.json');
      await fs.writeFile(
        file,
        JSON.stringify({ name: 'root', workspaces: { packages: ['packages/*'], ...layout } }, null, 2),
      );
      const index = await loadCatalogIndex(dir);
      assert.strictEqual(index.source, 'package.json');
      for (const pointer of ['catalog:', 'catalog:default']) {
        assert.strictEqual(resolveCatalogRange(index, 'chalk', parseCatalogSpec(pointer)), '^5.0.0', pointer);
      }

      await writeCatalogRange(index, 'chalk', parseCatalogSpec('catalog:default'), '^5.4.0');
      const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
      if (layout.catalog) {
        assert.strictEqual(pkg.workspaces.catalog.chalk, '^5.4.0');
        assert.strictEqual(pkg.workspaces.catalogs, undefined);
      } else {
        assert.strictEqual(pkg.workspaces.catalogs.default.chalk, '^5.4.0');
        assert.strictEqual(pkg.workspaces.catalogs.next.react, '^18.0.0');
        assert.strictEqual(pkg.workspaces.catalog, undefined);
      }
    });
  }
});

test('runUpgradeFlow dry-run: catalog: pointer resolves against catalogs.default', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { react: 'catalog:' } }),
    );
    await fs.writeFile(
      path.join(dir, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\ncatalogs:\n  default:\n    react: ^18.2.0\n',
    );
    const report = await runUpgradeFlow({
      cwd: dir,
      ...dryRunOpts,
      registryCache: seededCache({ react: '19.0.0' }),
    });
    const row = report.upgraded.find((r) => r.name === 'react');
    assert.ok(row, `expected react row, got ${JSON.stringify(report.upgraded)}`);
    assert.strictEqual(row.from, '^18.2.0');
    assert.strictEqual(row.to, '19.0.0');
    assert.strictEqual(row.detail, 'dry-run');
  });
});
