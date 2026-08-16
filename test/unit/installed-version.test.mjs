/**
 * Unit tests for installed-version resolution and scanned-section dedupe.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const installed = await import(path.join(root, 'dist', 'utils', 'installedVersion.js'));
const dedup = await import(path.join(root, 'dist', 'core', 'scannedDedup.js'));
const scanner = await import(path.join(root, 'dist', 'core', 'scanner.js'));

const { resolveInstalledVersion, highestInstalledVersion } = installed;
const { dedupeScannedByName, preferSection } = dedup;
const { isRegistryRange, isDistTag, scanProject } = scanner;

test('resolveInstalledVersion: prefers lockfile over declared floor', () => {
  const tree = new Map([['lodash', new Set(['4.17.21', '4.17.20'])]]);
  assert.strictEqual(
    resolveInstalledVersion({
      name: 'lodash',
      declaredRange: '^4.0.0',
      lockfileVersions: tree,
    }),
    '4.17.21',
  );
});

test('resolveInstalledVersion: falls back to coerce of declared range', () => {
  assert.strictEqual(
    resolveInstalledVersion({ name: 'x', declaredRange: '^1.2.3' }),
    '1.2.3',
  );
});

test('highestInstalledVersion: picks semver-max', () => {
  const tree = new Map([['a', ['1.0.0', '2.0.0', '1.5.0']]]);
  assert.strictEqual(highestInstalledVersion(tree, 'a'), '2.0.0');
});

test('preferSection: dependencies beat peers', () => {
  assert.strictEqual(preferSection('dependencies', 'peerDependencies'), 'dependencies');
  assert.strictEqual(preferSection('peerDependencies', 'devDependencies'), 'peerDependencies');
});

test('dedupeScannedByName: keeps dependencies over peerDependencies', () => {
  const rows = [
    { name: 'react', section: 'peerDependencies', currentRange: '^18.0.0' },
    { name: 'react', section: 'dependencies', currentRange: '^18.2.0' },
    { name: 'lodash', section: 'devDependencies', currentRange: '^4.0.0' },
  ];
  const out = dedupeScannedByName(rows);
  assert.strictEqual(out.length, 2);
  const react = out.find((r) => r.name === 'react');
  assert.strictEqual(react.section, 'dependencies');
  assert.strictEqual(react.currentRange, '^18.2.0');
});

test('isDistTag: identifiers that are not semver ranges', () => {
  assert.strictEqual(isDistTag('latest'), true);
  assert.strictEqual(isDistTag('next'), true);
  assert.strictEqual(isDistTag('canary'), true);
  assert.strictEqual(isDistTag('beta'), true);
  assert.strictEqual(isDistTag('^1.2.3'), false);
  assert.strictEqual(isDistTag('1.2.3'), false);
  assert.strictEqual(isDistTag('catalog:'), false);
  assert.strictEqual(isDistTag('workspace:foo'), false);
});

test('isRegistryRange: accepts catalog and dist-tags; rejects npm/portal/patch', () => {
  assert.strictEqual(isRegistryRange('catalog:'), true);
  assert.strictEqual(isRegistryRange('catalog:react19'), true);
  assert.strictEqual(isRegistryRange('latest'), true);
  assert.strictEqual(isRegistryRange('next'), true);
  assert.strictEqual(isRegistryRange('npm:lodash@4'), false);
  assert.strictEqual(isRegistryRange('portal:../foo'), false);
  assert.strictEqual(isRegistryRange('patch:lodash@1'), false);
  assert.strictEqual(isRegistryRange('workspace:*'), false);
  assert.strictEqual(isRegistryRange('link:../lib'), false);
  assert.strictEqual(isRegistryRange('file:../lib'), false);
  assert.strictEqual(isRegistryRange('git+https://github.com/a/b.git'), false);
  assert.strictEqual(isRegistryRange('^1.2.3'), true);
});

test('resolveInstalledVersion: dist-tag without lockfile cannot coerce', () => {
  assert.strictEqual(
    resolveInstalledVersion({ name: 'lodash', declaredRange: 'latest' }),
    undefined,
  );
});

test('scanProject: includes catalog: and dist-tag entries', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-scan-'));
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({
      name: 'scan',
      dependencies: { react: 'catalog:', lodash: 'latest', leftpad: 'file:../x' },
      devDependencies: { typescript: '^5.0.0' },
    }),
  );
  try {
    const rows = await scanProject(dir);
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    assert.strictEqual(byName.react.currentRange, 'catalog:');
    assert.strictEqual(byName.lodash.currentRange, 'latest');
    assert.strictEqual(byName.leftpad.currentRange, 'file:../x');
    assert.strictEqual(byName.typescript.section, 'devDependencies');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
