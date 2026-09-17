/**
 * A registry `latest` dist-tag that lags behind the installed major (DefinitelyTyped published
 * `@types/node@22.20.3` seconds after `26.6.1` and `latest` moved to 22.20.3) must not hide the
 * newer release of the installed major. Hermetic: pre-seeded registry cache, installer stub.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { newestInMajor, correctLaggingLatest } = await import(path.join(root, 'dist/utils/latestTag.js'));
const { runOutdated } = await import(path.join(root, 'dist/cli/outdated.js'));
const { runUpgradeFlow } = await import(path.join(root, 'dist/core/upgrader.js'));
const { createRegistryCache } = await import(path.join(root, 'dist/utils/concurrency.js'));

const TYPES_NODE_VERSIONS = ['22.20.2', '22.20.3', '26.5.1', '26.6.0', '26.6.1', '27.0.0-beta.1'];

function laggingCache() {
  const cache = createRegistryCache();
  cache.latest.set('@types/node', Promise.resolve('22.20.3'));
  cache.versions.set('@types/node', Promise.resolve(TYPES_NODE_VERSIONS));
  return cache;
}

async function project(pkg) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-latest-tag-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  return dir;
}

test('newestInMajor: newest stable release of the installed major, if newer', () => {
  assert.strictEqual(newestInMajor('26.5.1', TYPES_NODE_VERSIONS), '26.6.1');
  assert.strictEqual(newestInMajor('26.6.1', TYPES_NODE_VERSIONS), undefined);
  assert.strictEqual(newestInMajor('27.0.0-alpha.1', TYPES_NODE_VERSIONS), undefined); // beta is a prerelease
  assert.strictEqual(newestInMajor('not-a-version', TYPES_NODE_VERSIONS), undefined);
});

test('correctLaggingLatest: only kicks in when the install is newer than the tag', async () => {
  const cache = laggingCache();
  assert.deepStrictEqual(await correctLaggingLatest('@types/node', '26.5.1', '22.20.3', cache), {
    latest: '26.6.1',
    laggingTag: '22.20.3',
  });
  assert.deepStrictEqual(await correctLaggingLatest('@types/node', '22.20.2', '22.20.3', cache), { latest: '22.20.3' });
  // Truly ahead (nothing newer in the installed major): the tag stays.
  assert.deepStrictEqual(await correctLaggingLatest('@types/node', '26.6.1', '22.20.3', cache), { latest: '22.20.3' });
  assert.deepStrictEqual(await correctLaggingLatest('@types/node', undefined, '22.20.3', cache), { latest: '22.20.3' });
});

test('correctLaggingLatest: a failed version lookup keeps the tag', async () => {
  const cache = createRegistryCache();
  const offline = Promise.reject(new Error('ENOTFOUND'));
  offline.catch(() => {});
  cache.versions.set('@types/node', offline);
  assert.deepStrictEqual(await correctLaggingLatest('@types/node', '26.5.1', '22.20.3', cache), { latest: '22.20.3' });
});

test('runOutdated: a lagging tag reports the newer release of the installed major as outdated', async () => {
  const dir = await project({ name: 'app', devDependencies: { '@types/node': '^26.5.1' } });
  const report = await runOutdated({ cwd: dir, registryCache: laggingCache() });
  assert.deepStrictEqual(report.rows[0], {
    name: '@types/node',
    section: 'devDependencies',
    declared: '^26.5.1',
    status: 'outdated',
    installed: '26.5.1',
    latest: '26.6.1',
    latestTag: '22.20.3',
  });
  assert.strictEqual(report.summary.ahead, 0);
});

test('runOutdated: truly ahead of the tag stays "ahead"', async () => {
  const dir = await project({ name: 'app', devDependencies: { '@types/node': '^26.6.1' } });
  const report = await runOutdated({ cwd: dir, registryCache: laggingCache() });
  assert.strictEqual(report.rows[0].status, 'ahead');
  assert.strictEqual(report.rows[0].latest, '22.20.3');
  assert.strictEqual(report.rows[0].latestTag, undefined);
});

test('upgrade: a lagging tag upgrades within the installed major instead of skipping "ahead of latest"', async () => {
  const dir = await project({ name: 'app', devDependencies: { '@types/node': '^26.5.1' } });
  const report = await runUpgradeFlow({
    cwd: dir,
    dryRun: false,
    interactive: false,
    force: false,
    jsonOutput: true,
    ignore: new Set(),
    fallbackStrategy: 'major-lines',
    linkGroups: 'none',
    linkedGroupsConfig: [],
    resolvePeers: false,
    validate: { skip: true },
    installer: async () => ({ ok: true, output: '', exitCode: 0, command: 'npm install' }),
    registryCache: laggingCache(),
  });
  assert.deepStrictEqual(report.failed, []);
  const row = report.upgraded.find((r) => r.name === '@types/node');
  assert.strictEqual(row?.skipped, undefined, JSON.stringify(report.upgraded));
  assert.strictEqual(row.to, '^26.6.1');
  assert.strictEqual(row.requestedLatest, '26.6.1');
  assert.match(row.detail, /"latest" tag \(22\.20\.3\) is behind the installed major/);
  const pkg = JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));
  assert.strictEqual(pkg.devDependencies['@types/node'], '^26.6.1');
});
