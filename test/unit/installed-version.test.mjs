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

const { resolveInstalledVersion, highestInstalledVersion, loadLockfileVersionTree } = installed;
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

test('preferSection: installed copies beat the peer contract', () => {
  assert.strictEqual(preferSection('dependencies', 'peerDependencies'), 'dependencies');
  // A library's dev copy is what gets upgraded; its peer range is left alone (--include-peers).
  assert.strictEqual(preferSection('peerDependencies', 'devDependencies'), 'devDependencies');
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

async function withLockfile(basename, contents, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-installed-'));
  try {
    await fs.writeFile(path.join(dir, basename), contents);
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// Direct `debug@^2.6.9` stays on 2.6.9 while `send` pulls its own nested debug@4.
const NPM_NESTED_LOCK = JSON.stringify({
  name: 'app',
  version: '1.0.0',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'app', version: '1.0.0', dependencies: { debug: '^2.6.9', send: '^1.1.0' } },
    'node_modules/debug': {
      version: '2.6.9',
      resolved: 'https://registry.npmjs.org/debug/-/debug-2.6.9.tgz',
      integrity: 'sha512-bC7ElrdJaJnPbAP+1EotYvqZsb3ecl5wi6Bfi6BJTUcNowp6cvspg0jXznRTKDjm/E7AdgFBVeAPVMNcKGsHMA==',
      license: 'MIT',
      dependencies: { ms: '2.0.0' },
    },
    'node_modules/ms': { version: '2.0.0', license: 'MIT' },
    'node_modules/send': {
      version: '1.1.0',
      license: 'MIT',
      dependencies: { debug: '^4.3.5', ms: '^2.1.3' },
    },
    'node_modules/send/node_modules/debug': {
      version: '4.4.0',
      license: 'MIT',
      dependencies: { ms: '^2.1.3' },
    },
    'node_modules/send/node_modules/ms': { version: '2.1.3', license: 'MIT' },
  },
});

test('resolveInstalledVersion: npm direct copy wins over a newer nested copy', async () => {
  await withLockfile('package-lock.json', NPM_NESTED_LOCK, async (dir) => {
    const tree = await loadLockfileVersionTree(dir, 'npm');
    assert.strictEqual(
      resolveInstalledVersion({ name: 'debug', declaredRange: '^2.6.9', lockfileVersions: tree }),
      '2.6.9',
    );
    assert.strictEqual(
      resolveInstalledVersion({ name: 'send', declaredRange: '^1.1.0', lockfileVersions: tree }),
      '1.1.0',
    );
  });
});

const NPM_WORKSPACE_LOCK = JSON.stringify({
  name: 'monorepo',
  lockfileVersion: 3,
  requires: true,
  packages: {
    '': { name: 'monorepo', workspaces: ['packages/*'], devDependencies: { debug: '^2.6.9' } },
    'node_modules/@demo/a': { resolved: 'packages/a', link: true },
    'node_modules/@demo/b': { resolved: 'packages/b', link: true },
    'node_modules/debug': { version: '2.6.9', dev: true },
    'node_modules/send': { version: '1.1.0' },
    'node_modules/send/node_modules/debug': { version: '4.4.0' },
    'packages/a': { name: '@demo/a', version: '1.0.0', dependencies: { debug: '^4.0.0', send: '^1.1.0' } },
    'packages/a/node_modules/debug': { version: '4.3.7' },
    'packages/b': { name: '@demo/b', version: '1.0.0', dependencies: { debug: '^2.6.0' } },
  },
});

test('resolveInstalledVersion: npm workspace member uses its own copy, else the hoisted one', async () => {
  await withLockfile('package-lock.json', NPM_WORKSPACE_LOCK, async (dir) => {
    const tree = await loadLockfileVersionTree(dir, 'npm');
    const resolve = (declaredRange, memberRelDir) =>
      resolveInstalledVersion({ name: 'debug', declaredRange, lockfileVersions: tree, memberRelDir });
    assert.strictEqual(resolve('^2.6.9'), '2.6.9');
    assert.strictEqual(resolve('^4.0.0', 'packages/a'), '4.3.7');
    assert.strictEqual(resolve('^2.6.0', 'packages/b'), '2.6.9', 'no nested copy → hoisted root entry');
  });
});

const PNPM_V9_LOCK = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    dependencies:
      debug:
        specifier: ^2.6.9
        version: 2.6.9
      send:
        specifier: ^1.1.0
        version: 1.1.0

  packages/web:
    dependencies:
      '@demo/shared':
        specifier: workspace:*
        version: link:../shared
      react:
        specifier: ^18.2.0
        version: 18.3.1
      react-dom:
        specifier: ^18.2.0
        version: 18.3.1(react@18.3.1)
    devDependencies:
      debug:
        specifier: ^4.0.0
        version: 4.3.7

packages:

  debug@2.6.9:
    resolution: {integrity: sha512-bC7ElrdJaJnPbAP+1EotYvqZsb3ecl5wi6Bfi6BJTUcNowp6cvspg0jXznRTKDjm/E7AdgFBVeAPVMNcKGsHMA==}

  debug@4.3.7:
    resolution: {integrity: sha512-Er2nc/H7RrMXZBFCEim6TCmMk02Z8vLC2Rbi1KEBggpo0fS6l0S1nnapwmIi3yW/+GOJap1Krg4w0Hg80oCqgQ==}
    engines: {node: '>=6.0'}
    peerDependencies:
      supports-color: '*'
    peerDependenciesMeta:
      supports-color:
        optional: true

  debug@4.4.0:
    resolution: {integrity: sha512-6WTZ/IxCY/T6BALoZHaE4ctp9xm+Z5kY/pzYaCHRFeyVhojxlrm+46y68HA6hr0TcwEssoxNiDEUJQjfPZ/RYA==}
    engines: {node: '>=6.0'}

  react-dom@18.3.1:
    resolution: {integrity: sha512-5m4nQKp+rZRb09LNH59GM4BxTh9251/ylbKIbpe7TpGxfJ+9kv6BLkLBXIjjspbgbnIBNqlI23tRnTWT0snUIw==}
    peerDependencies:
      react: ^18.3.1

  react@18.3.1:
    resolution: {integrity: sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==}

  send@1.1.0:
    resolution: {integrity: sha512-v67WcEouB5GxbTWL/4NeToqcZiAWEq90N888fczVArY8A79J0L4FD7vj5hm3eUMua5EpoQ59wa/oovY6TLvRUA==}
    engines: {node: '>= 18'}

snapshots:

  debug@2.6.9:
    dependencies:
      ms: 2.0.0

  debug@4.4.0:
    dependencies:
      ms: 2.1.3

  react-dom@18.3.1(react@18.3.1):
    dependencies:
      loose-envify: 1.4.0
      react: 18.3.1
      scheduler: 0.23.2

  send@1.1.0:
    dependencies:
      debug: 4.4.0
`;

test('resolveInstalledVersion: pnpm v9 reads the importer entry (root + member, peer suffix stripped)', async () => {
  await withLockfile('pnpm-lock.yaml', PNPM_V9_LOCK, async (dir) => {
    const tree = await loadLockfileVersionTree(dir, 'pnpm');
    const resolve = (name, declaredRange, memberRelDir) =>
      resolveInstalledVersion({ name, declaredRange, lockfileVersions: tree, memberRelDir });
    assert.strictEqual(resolve('debug', '^2.6.9'), '2.6.9');
    assert.strictEqual(resolve('debug', '^4.0.0', 'packages/web'), '4.3.7');
    assert.strictEqual(resolve('react-dom', '^18.2.0', 'packages/web'), '18.3.1');
  });
});

test('resolveInstalledVersion: pnpm v6 single-project top-level dependencies', async () => {
  const raw = `lockfileVersion: '6.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

dependencies:
  debug:
    specifier: ^2.6.9
    version: 2.6.9
  send:
    specifier: ^1.1.0
    version: 1.1.0

packages:

  /debug@2.6.9:
    resolution: {integrity: sha512-bC7ElrdJaJnPbAP+1EotYvqZsb3ecl5wi6Bfi6BJTUcNowp6cvspg0jXznRTKDjm/E7AdgFBVeAPVMNcKGsHMA==}
    dependencies:
      ms: 2.0.0
    dev: false

  /debug@4.4.0:
    resolution: {integrity: sha512-6WTZ/IxCY/T6BALoZHaE4ctp9xm+Z5kY/pzYaCHRFeyVhojxlrm+46y68HA6hr0TcwEssoxNiDEUJQjfPZ/RYA==}
    engines: {node: '>=6.0'}
    dependencies:
      ms: 2.1.3
    dev: false
`;
  await withLockfile('pnpm-lock.yaml', raw, async (dir) => {
    const tree = await loadLockfileVersionTree(dir, 'pnpm');
    assert.strictEqual(
      resolveInstalledVersion({ name: 'debug', declaredRange: '^2.6.9', lockfileVersions: tree }),
      '2.6.9',
    );
  });
});

const YARN_CLASSIC_NESTED_LOCK = `# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.
# yarn lockfile v1


debug@^2.6.9:
  version "2.6.9"
  resolved "https://registry.yarnpkg.com/debug/-/debug-2.6.9.tgz#5d128515df134ff327e90a4c93f4e077a536341f"
  integrity sha512-bC7ElrdJaJnPbAP+1EotYvqZsb3ecl5wi6Bfi6BJTUcNowp6cvspg0jXznRTKDjm/E7AdgFBVeAPVMNcKGsHMA==
  dependencies:
    ms "2.0.0"

debug@^4.3.5:
  version "4.4.0"
  resolved "https://registry.yarnpkg.com/debug/-/debug-4.4.0.tgz#2b3f2aea2ffeb776477460267377dc8710faba8a"
  integrity sha512-6WTZ/IxCY/T6BALoZHaE4ctp9xm+Z5kY/pzYaCHRFeyVhojxlrm+46y68HA6hr0TcwEssoxNiDEUJQjfPZ/RYA==
  dependencies:
    ms "^2.1.3"
`;

test('resolveInstalledVersion: yarn picks the highest version satisfying the declared range', async () => {
  await withLockfile('yarn.lock', YARN_CLASSIC_NESTED_LOCK, async (dir) => {
    const tree = await loadLockfileVersionTree(dir, 'yarn');
    assert.strictEqual(
      resolveInstalledVersion({ name: 'debug', declaredRange: '^2.6.9', lockfileVersions: tree }),
      '2.6.9',
    );
    // Nothing in the lockfile satisfies the range → declared floor, not an unrelated copy.
    assert.strictEqual(
      resolveInstalledVersion({ name: 'debug', declaredRange: '^3.1.0', lockfileVersions: tree }),
      '3.1.0',
    );
  });
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
