/**
 * Unit tests for installed-version resolution and scanned-section dedupe.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const installed = await import(path.join(root, 'dist', 'utils', 'installedVersion.js'));
const dedup = await import(path.join(root, 'dist', 'core', 'scannedDedup.js'));
const scanner = await import(path.join(root, 'dist', 'core', 'scanner.js'));

const { resolveInstalledVersion, highestInstalledVersion } = installed;
const { dedupeScannedByName, preferSection } = dedup;
const { isRegistryRange } = scanner;

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

test('isRegistryRange: rejects catalog/npm/portal/patch protocols', () => {
  assert.strictEqual(isRegistryRange('catalog:'), false);
  assert.strictEqual(isRegistryRange('npm:lodash@4'), false);
  assert.strictEqual(isRegistryRange('portal:../foo'), false);
  assert.strictEqual(isRegistryRange('patch:lodash@1'), false);
  assert.strictEqual(isRegistryRange('^1.2.3'), true);
});
