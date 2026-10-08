/**
 * Unit tests for src/cli/lockfileFix.ts.
 *
 * We cover three tiers:
 *   1. Pure functions: `parseLockfileInstalledVersions` across npm v1/v2, pnpm v6/v9, yarn
 *      classic/berry; `diffLockfileTrees` for the merged / updated / added / removed cases.
 *   2. `dedupeCommandFor` — per-manager command selection and the yarn-classic skip.
 *   3. `runLockfileFix` orchestration against a temp dir: no-lockfile skip, unsupported skip,
 *      dry-run, and validator-rollback path (all without actually running `npm dedupe`).
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  parseLockfileInstalledVersions,
  diffLockfileTrees,
  dedupeCommandFor,
  runLockfileFix,
  isBinaryLockfile,
} = await import(path.join(root, 'dist/cli/lockfileFix.js'));

function mapToSortedObject(m) {
  const out = {};
  for (const [k, v] of m) out[k] = [...v].sort();
  return out;
}

test('parseLockfileInstalledVersions: npm v2 `packages` map', () => {
  const raw = JSON.stringify({
    lockfileVersion: 2,
    packages: {
      '': { name: 'root' },
      'node_modules/axios': { version: '1.6.4' },
      'node_modules/axios/node_modules/form-data': { version: '4.0.0' },
      'node_modules/debug': { version: '4.3.4' },
      'node_modules/pkg/node_modules/debug': { version: '4.3.2' },
      'node_modules/@types/node': { version: '20.4.5' },
    },
  });
  const got = mapToSortedObject(parseLockfileInstalledVersions(raw, 'npm'));
  assert.deepStrictEqual(got, {
    axios: ['1.6.4'],
    'form-data': ['4.0.0'],
    debug: ['4.3.2', '4.3.4'],
    '@types/node': ['20.4.5'],
  });
});

test('parseLockfileInstalledVersions: npm v1 recursive `dependencies`', () => {
  const raw = JSON.stringify({
    lockfileVersion: 1,
    dependencies: {
      axios: {
        version: '1.6.4',
        dependencies: { 'form-data': { version: '4.0.0' } },
      },
      debug: { version: '4.3.4' },
    },
  });
  const got = mapToSortedObject(parseLockfileInstalledVersions(raw, 'npm'));
  assert.deepStrictEqual(got, {
    axios: ['1.6.4'],
    debug: ['4.3.4'],
    'form-data': ['4.0.0'],
  });
});

test('parseLockfileInstalledVersions: npm aliases are keyed by the real package name', () => {
  // `"string-width-cjs": "npm:string-width@^4.2.0"` (pulled in by @isaacs/cliui).
  const v3 = JSON.stringify({
    lockfileVersion: 3,
    packages: {
      '': { name: 'root' },
      'packages/app': { name: '@demo/app', version: '1.0.0' },
      'node_modules/@demo/app': { resolved: 'packages/app', link: true },
      'node_modules/string-width': { version: '5.1.2' },
      'node_modules/string-width-cjs': { name: 'string-width', version: '4.2.3' },
      'node_modules/@isaacs/cliui/node_modules/wrap-ansi-cjs': { name: 'wrap-ansi', version: '7.0.0' },
    },
  });
  assert.deepStrictEqual(mapToSortedObject(parseLockfileInstalledVersions(v3, 'npm')), {
    'string-width': ['4.2.3', '5.1.2'],
    'wrap-ansi': ['7.0.0'],
  });

  const v1 = JSON.stringify({
    lockfileVersion: 1,
    dependencies: {
      'string-width': { version: '5.1.2' },
      'string-width-cjs': { version: 'npm:string-width@4.2.3' },
      'scoped-alias': { version: 'npm:@scope/real@1.0.0' },
    },
  });
  assert.deepStrictEqual(mapToSortedObject(parseLockfileInstalledVersions(v1, 'npm')), {
    'string-width': ['4.2.3', '5.1.2'],
    '@scope/real': ['1.0.0'],
  });
});

test('parseLockfileInstalledVersions: yarn alias headers resolve to the real package name', () => {
  const classic = [
    '"string-width-cjs@npm:string-width@^4.2.0":',
    '  version "4.2.3"',
    '',
    'string-width@^5.0.1:',
    '  version "5.1.2"',
    '',
    '"my-babel@npm:@babel/core@^7.22.0":',
    '  version "7.22.5"',
  ].join('\n');
  assert.deepStrictEqual(mapToSortedObject(parseLockfileInstalledVersions(classic, 'yarn')), {
    'string-width': ['4.2.3', '5.1.2'],
    '@babel/core': ['7.22.5'],
  });

  const berry = [
    '__metadata:',
    '  version: 8',
    '',
    '"string-width-cjs@npm:string-width@^4.2.0":',
    '  version: 4.2.3',
    '  resolution: "string-width@npm:4.2.3"',
    '',
    '"string-width@npm:^5.0.1":',
    '  version: 5.1.2',
    '  resolution: "string-width@npm:5.1.2"',
  ].join('\n');
  assert.deepStrictEqual(mapToSortedObject(parseLockfileInstalledVersions(berry, 'yarn')), {
    'string-width': ['4.2.3', '5.1.2'],
  });
});

test('parseLockfileInstalledVersions: pnpm v5 `/name/version[_peers]` keys', () => {
  const raw = [
    'lockfileVersion: 5.4',
    '',
    'specifiers:',
    '  react-dom: ^18.2.0',
    '',
    'packages:',
    '',
    '  /@babel/core/7.22.5:',
    '    resolution: {integrity: sha-a}',
    '    dependencies:',
    '      debug: 4.3.4',
    '',
    '  /react-dom/18.2.0_react@18.2.0:',
    '    resolution: {integrity: sha-b}',
    '',
    '  /@testing-library/react/14.0.0_biqbaboplfbrettd7655fr4n2y:',
    '    resolution: {integrity: sha-c}',
    '',
    '  /debug/4.3.4:',
    '    resolution: {integrity: sha-d}',
    '',
    '  /typescript/5.2.0-beta:',
    '    resolution: {integrity: sha-e}',
  ].join('\n');
  assert.deepStrictEqual(mapToSortedObject(parseLockfileInstalledVersions(raw, 'pnpm')), {
    '@babel/core': ['7.22.5'],
    'react-dom': ['18.2.0'],
    '@testing-library/react': ['14.0.0'],
    debug: ['4.3.4'],
    typescript: ['5.2.0-beta'],
  });
});

test('parseLockfileInstalledVersions: pnpm slashed + scoped keys', () => {
  const raw = [
    'lockfileVersion: 6.0',
    '',
    'packages:',
    '',
    '  /axios@1.6.4:',
    '    resolution: {integrity: sha-x}',
    '  /@types/node@20.4.5:',
    '    resolution: {integrity: sha-y}',
    "  /@babel/core@7.22.5(supports-color@5.5.0):",
    '    resolution: {integrity: sha-z}',
  ].join('\n');
  const got = mapToSortedObject(parseLockfileInstalledVersions(raw, 'pnpm'));
  assert.deepStrictEqual(got, {
    axios: ['1.6.4'],
    '@types/node': ['20.4.5'],
    '@babel/core': ['7.22.5'],
  });
});

test('parseLockfileInstalledVersions: yarn classic header + version lines', () => {
  const raw = [
    '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT.',
    '',
    '"axios@^1.6.0":',
    '  version "1.6.4"',
    '  resolved "https://registry.yarnpkg.com/axios/-/axios-1.6.4.tgz#sha"',
    '',
    '"@types/node@^20", "@types/node@^20.1.0":',
    '  version "20.4.5"',
    '',
    'debug@^4.3.0, debug@^4.3.4:',
    '  version "4.3.4"',
  ].join('\n');
  const got = mapToSortedObject(parseLockfileInstalledVersions(raw, 'yarn'));
  assert.deepStrictEqual(got, {
    axios: ['1.6.4'],
    '@types/node': ['20.4.5'],
    debug: ['4.3.4'],
  });
});

test('parseLockfileInstalledVersions: yarn berry `version:` lines, npm: descriptors, workspace entries skipped', () => {
  const raw = [
    '# This file is generated by running "yarn install" inside your project.',
    '# Manual changes might be lost - proceed with caution!',
    '',
    '__metadata:',
    '  version: 8',
    '  cacheKey: 10c0',
    '',
    '"@babel/core@npm:^7.0.0, @babel/core@npm:^7.23.9":',
    '  version: 7.24.0',
    '  resolution: "@babel/core@npm:7.24.0"',
    '  dependencies:',
    '    "@ampproject/remapping": "npm:^2.2.0"',
    '    debug: "npm:^4.1.0"',
    '  checksum: 10c0/fb0e1e5bd6a3eb1bcea7d58d8b3e0c4b9e6a8a3f2c1f7a0c6d5b4a3e2d1c0b9a8f7e6d5c4b3a2f1e0d9c8b7a6f5e4d3c2b1a0',
    '  languageName: node',
    '  linkType: hard',
    '',
    '"debug@npm:^4.1.0, debug@npm:^4.3.1":',
    '  version: 4.3.4',
    '  resolution: "debug@npm:4.3.4"',
    '  dependencies:',
    '    ms: "npm:2.1.2"',
    '  peerDependenciesMeta:',
    '    supports-color:',
    '      optional: true',
    '  checksum: 10c0/cedbec45298dd5c501d01b92b119cd3faebe5438c3917ff11ae1bff86a6c722930ac9c8659792824013168ba6db7c4668225d845c633fbdafbbf902a6389f736',
    '  languageName: node',
    '  linkType: hard',
    '',
    '"lodash@npm:^4.17.0, lodash@npm:^4.17.21":',
    '  version: 4.17.21',
    '  resolution: "lodash@npm:4.17.21"',
    '  checksum: 10c0/d8cbea072bb08655bb4c989da418994b073a608dffa608b09ac04b43a791b12aeae7cd7ad919aa4c925f33b48490b5cfe6c1f71d827956071dae2e7bb3a6b74c',
    '  languageName: node',
    '  linkType: hard',
    '',
    '"my-app@workspace:.":',
    '  version: 0.0.0-use.local',
    '  resolution: "my-app@workspace:."',
    '  dependencies:',
    '    "@babel/core": "npm:^7.23.9"',
    '    lodash: "npm:^4.17.21"',
    '  languageName: unknown',
    '  linkType: soft',
    '',
    '"resolve@npm:^1.22.1":',
    '  version: 1.22.8',
    '  resolution: "resolve@npm:1.22.8"',
    '  languageName: node',
    '  linkType: hard',
    '',
    '"resolve@patch:resolve@npm%3A^1.22.1#optional!builtin<compat/resolve>":',
    '  version: 1.22.8',
    '  resolution: "resolve@patch:resolve@npm%3A1.22.8#optional!builtin<compat/resolve>::version=1.22.8&hash=c3c19d"',
    '  languageName: node',
    '  linkType: hard',
  ].join('\n');
  const got = mapToSortedObject(parseLockfileInstalledVersions(raw, 'yarn'));
  assert.deepStrictEqual(got, {
    '@babel/core': ['7.24.0'],
    debug: ['4.3.4'],
    lodash: ['4.17.21'],
    resolve: ['1.22.8'],
  });
});

test('parseLockfileInstalledVersions: bun.lock JSONC packages list', () => {
  const raw = `{
    // bun lockfile
    "lockfileVersion": 1,
    "packages": {
      "lodash": ["lodash@4.17.21", "https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz", "sha512", {}],
      "@scope/pkg": ["@scope/pkg@1.2.3", "https://example.com/t.tgz", "sha", {}]
    }
  }`;
  const got = mapToSortedObject(parseLockfileInstalledVersions(raw, 'bun'));
  assert.deepStrictEqual(got, {
    lodash: ['4.17.21'],
    '@scope/pkg': ['1.2.3'],
  });
});

test('parseLockfileInstalledVersions: malformed input returns empty map without throwing', () => {
  const got = parseLockfileInstalledVersions('{not valid json', 'npm');
  assert.strictEqual(got.size, 0);
});

test('diffLockfileTrees: classifies merged / updated / added / removed', () => {
  const before = new Map([
    ['debug', new Set(['4.3.2', '4.3.4'])], // merged
    ['axios', new Set(['1.6.0'])], // updated
    ['gone', new Set(['1.0.0'])], // removed
    ['same', new Set(['2.0.0'])], // no-op (filtered out)
  ]);
  const after = new Map([
    ['debug', new Set(['4.3.4'])],
    ['axios', new Set(['1.6.4'])],
    ['same', new Set(['2.0.0'])],
    ['new-dep', new Set(['0.1.0'])], // added
  ]);
  const diff = diffLockfileTrees(before, after);
  const byName = Object.fromEntries(diff.map((c) => [c.name, c]));
  assert.deepStrictEqual(byName.debug.change, 'merged');
  assert.deepStrictEqual(byName.debug.before, ['4.3.2', '4.3.4']);
  assert.deepStrictEqual(byName.debug.after, ['4.3.4']);
  assert.strictEqual(byName.axios.change, 'updated');
  assert.strictEqual(byName['new-dep'].change, 'added');
  assert.strictEqual(byName.gone.change, 'removed');
  assert.ok(!byName.same, 'no-op rows must be filtered out');
  // Sort order: merged → updated → added → removed.
  assert.deepStrictEqual(diff.map((c) => c.change), ['merged', 'updated', 'added', 'removed']);
});

test('dedupeCommandFor: per-manager + yarn-classic returns undefined', () => {
  assert.deepStrictEqual(dedupeCommandFor('pnpm'), { bin: 'pnpm', args: ['dedupe'] });
  assert.deepStrictEqual(dedupeCommandFor('npm'), {
    bin: 'npm',
    args: ['dedupe', '--no-audit', '--loglevel', 'error'],
  });
  assert.deepStrictEqual(dedupeCommandFor('yarn', { yarnMajorVersion: 3 }), {
    bin: 'yarn',
    args: ['dedupe'],
  });
  assert.strictEqual(dedupeCommandFor('yarn', { yarnMajorVersion: 1 }), undefined);
  assert.strictEqual(dedupeCommandFor('yarn'), undefined, 'default (no version) = classic');
  assert.strictEqual(dedupeCommandFor('bun'), undefined);
});

test('runLockfileFix: skips with no-lockfile reason when lockfile missing', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-lockfix-'));
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  const r = await runLockfileFix({ cwd: dir, manager: 'npm', json: true });
  assert.strictEqual(r.report.status, 'skipped');
  assert.strictEqual(r.report.skipReason, 'no-lockfile');
  assert.strictEqual(r.report.manager, 'npm');
  assert.deepStrictEqual(r.report.dedupeChanges, []);
});

test('runLockfileFix: skips with unsupported reason on yarn classic', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-lockfix-'));
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  await fs.writeFile(path.join(dir, 'yarn.lock'), '# classic lockfile\n');
  const r = await runLockfileFix({
    cwd: dir,
    manager: 'yarn',
    yarnMajorVersion: 1,
    json: true,
  });
  assert.strictEqual(r.report.status, 'skipped');
  assert.strictEqual(r.report.skipReason, 'unsupported');
});

test('runLockfileFix: skips with unsupported reason on bun.lock', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-lockfix-'));
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  await fs.writeFile(path.join(dir, 'bun.lock'), '{ "lockfileVersion": 1, "packages": {} }\n');
  const r = await runLockfileFix({ cwd: dir, manager: 'bun', json: true });
  assert.strictEqual(r.report.status, 'skipped');
  assert.strictEqual(r.report.skipReason, 'unsupported');
  assert.strictEqual(r.report.lockfile, 'bun.lock');
});

test('runLockfileFix: skips with unsupported reason on bun.lockb', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-lockfix-'));
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  await fs.writeFile(path.join(dir, 'bun.lockb'), Buffer.from([0]));
  const r = await runLockfileFix({ cwd: dir, manager: 'bun', json: true });
  assert.strictEqual(r.report.status, 'skipped');
  assert.strictEqual(r.report.skipReason, 'unsupported');
  assert.strictEqual(r.report.lockfile, 'bun.lockb');
});

test('runLockfileFix: npm prefers npm-shrinkwrap.json over package-lock.json (as npm does)', async () => {
  const { createRegistryCache } = await import(path.join(root, 'dist/utils/concurrency.js'));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-lockfix-'));
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  const lock = (version) =>
    JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/uuid': { version } } });
  await fs.writeFile(path.join(dir, 'package-lock.json'), lock('11.0.5'));
  await fs.writeFile(path.join(dir, 'npm-shrinkwrap.json'), lock('8.3.2'));
  const registryCache = createRegistryCache();
  registryCache.latest.set('uuid', Promise.resolve('11.0.5'));
  const r = await runLockfileFix({ cwd: dir, manager: 'npm', json: true, dryRun: true, registryCache });
  assert.strictEqual(r.report.lockfile, 'npm-shrinkwrap.json');
  assert.deepStrictEqual(r.report.stale.map((s) => [s.name, s.installed]), [['uuid', ['8.3.2']]]);

  // Shrinkwrap alone still counts as a lockfile (no `no-lockfile` skip).
  await fs.rm(path.join(dir, 'package-lock.json'));
  const alone = await runLockfileFix({ cwd: dir, manager: 'npm', json: true, dryRun: true, registryCache });
  assert.strictEqual(alone.report.status, 'dry-run');
  assert.strictEqual(alone.report.lockfile, 'npm-shrinkwrap.json');
});

test('runLockfileFix: stale scan queries the real name of an aliased install', async () => {
  const { createRegistryCache } = await import(path.join(root, 'dist/utils/concurrency.js'));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-lockfix-'));
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  await fs.writeFile(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: { '': {}, 'node_modules/string-width-cjs': { name: 'string-width', version: '4.2.3' } },
    }),
  );
  const registryCache = createRegistryCache();
  const queried = [];
  const latest = registryCache.latest;
  // Only `string-width` is seeded; looking up the alias name would fall through to the network.
  latest.set('string-width', Promise.resolve('7.2.0'));
  const realGet = latest.get.bind(latest);
  latest.get = (name) => {
    queried.push(name);
    return realGet(name);
  };
  const r = await runLockfileFix({ cwd: dir, manager: 'npm', json: true, dryRun: true, registryCache });
  assert.deepStrictEqual(queried, ['string-width']);
  assert.deepStrictEqual(r.report.stale.map((s) => s.name), ['string-width']);
});

test('isBinaryLockfile: only bun.lockb', () => {
  assert.strictEqual(isBinaryLockfile('bun.lockb'), true);
  for (const name of ['bun.lock', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    assert.strictEqual(isBinaryLockfile(name), false, name);
  }
});

test('runLockfileFix: dry-run returns the command but never exec', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-lockfix-'));
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  await fs.writeFile(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({ lockfileVersion: 2, packages: {} }),
  );
  const r = await runLockfileFix({
    cwd: dir,
    manager: 'npm',
    json: true,
    dryRun: true,
  });
  assert.strictEqual(r.report.status, 'dry-run');
  assert.match(r.report.command ?? '', /^npm dedupe /);
  assert.deepStrictEqual(r.report.dedupeChanges, []);
});

test('runLockfileFix: stale report lists every installed version (including the highest)', async () => {
  const { createRegistryCache } = await import(path.join(root, 'dist/utils/concurrency.js'));
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-lockfix-'));
  await fs.writeFile(path.join(dir, 'package.json'), '{}');
  await fs.writeFile(
    path.join(dir, 'package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'app' },
        'node_modules/semver': { version: '7.5.0' },
        'node_modules/make-dir': { version: '3.1.0' },
        'node_modules/make-dir/node_modules/semver': { version: '6.3.1' },
        'node_modules/uuid': { version: '8.3.2' },
      },
    }),
  );
  const registryCache = createRegistryCache();
  for (const [name, latest] of Object.entries({ semver: '7.7.1', 'make-dir': '3.1.0', uuid: '11.0.5' })) {
    registryCache.latest.set(name, Promise.resolve(latest));
  }
  const r = await runLockfileFix({ cwd: dir, manager: 'npm', json: true, dryRun: true, registryCache });
  const byName = Object.fromEntries(r.report.stale.map((s) => [s.name, s]));
  assert.deepStrictEqual(byName.semver.installed, ['6.3.1', '7.5.0']);
  assert.deepStrictEqual(byName.uuid.installed, ['8.3.2']);
  assert.ok(!byName['make-dir'], 'up-to-date packages are not stale');
});
