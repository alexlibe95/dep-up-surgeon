/**
 * Linked groups that can't move as a whole:
 *   - a breaking member (eslint 9 → 10) is held back and the rest of the group (an
 *     eslint-config-next patch) still upgrades;
 *   - when the peer-range resolver settles every member on what's installed, nothing is
 *     installed again, and the "no change" rows name the package whose peer range blocked them.
 *
 * Hermetic: custom linked groups (no registry graph), pre-seeded registry cache, installer stub,
 * node one-liner validators.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { runUpgradeFlow } = await import(path.join(root, 'dist/core/upgrader.js'));
const { createRegistryCache } = await import(path.join(root, 'dist/utils/concurrency.js'));

const OK_INSTALL = { ok: true, output: '', exitCode: 0, command: 'npm install' };

async function project(pkg, extraFiles = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-holdback-'));
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  for (const [name, content] of Object.entries(extraFiles)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  return dir;
}

function flowOpts(dir, overrides = {}) {
  return {
    cwd: dir,
    dryRun: false,
    interactive: false,
    force: false,
    jsonOutput: true,
    ignore: new Set(),
    fallbackStrategy: 'major-lines',
    linkGroups: 'auto',
    linkedGroupsConfig: [],
    resolvePeers: false,
    ...overrides,
  };
}

const readPkg = async (dir) => JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8'));

function lintCache() {
  const cache = createRegistryCache();
  cache.latest.set('eslint', Promise.resolve('10.10.0'));
  cache.latest.set('eslint-config-next', Promise.resolve('16.3.5'));
  cache.versions.set('eslint', Promise.resolve(['9.39.5', '10.10.0']));
  cache.versions.set('eslint-config-next', Promise.resolve(['16.3.1', '16.3.5']));
  return cache;
}

// "lint" crashes (exit 2) once eslint is on 10, like eslint-plugin-react does.
const LINT = {
  command: `node -e "process.exit(require('./package.json').devDependencies.eslint.startsWith('^10') ? 2 : 0)"`,
  source: 'cli',
};

const LINT_PKG = { name: 'app', devDependencies: { eslint: '^9.39.5', 'eslint-config-next': '^16.3.1' } };
const LINT_GROUP = [{ id: 'lint', packages: ['eslint', 'eslint-config-next'] }];

test('linked group: the breaking member is held back and the rest of the group upgrades', async () => {
  const dir = await project(LINT_PKG);
  const report = await runUpgradeFlow(
    flowOpts(dir, {
      linkedGroupsConfig: LINT_GROUP,
      validate: LINT,
      installer: async () => OK_INSTALL,
      registryCache: lintCache(),
    }),
  );

  const upgraded = report.upgraded.filter((r) => r.success && !r.skipped);
  assert.deepStrictEqual(
    upgraded.map((r) => [r.name, r.from, r.to]),
    [['eslint-config-next', '^16.3.1', '^16.3.5']],
    JSON.stringify(report, null, 2),
  );
  assert.match(upgraded[0].detail, /without eslint@10\.10\.0, which failed with the whole group/);

  assert.strictEqual(report.failed.length, 1, JSON.stringify(report.failed, null, 2));
  const failure = report.failed[0];
  assert.strictEqual(failure.name, 'eslint');
  assert.strictEqual(failure.reason, 'validation-script');
  assert.strictEqual(failure.previousVersion, '^9.39.5');
  assert.strictEqual(failure.attemptedVersion, '10.10.0');
  assert.strictEqual(failure.requestedLatest, '10.10.0');
  assert.strictEqual(failure.linkedGroupId, 'lint');
  assert.match(
    failure.message,
    /^node -e .* failed \(exit 2\) with the whole linked group; eslint-config-next was upgraded without it\./,
  );

  assert.deepStrictEqual((await readPkg(dir)).devDependencies, {
    eslint: '^9.39.5',
    'eslint-config-next': '^16.3.5',
  });
});

test('linked group: --fallback-strategy none keeps the all-or-nothing failure', async () => {
  const dir = await project(LINT_PKG);
  const report = await runUpgradeFlow(
    flowOpts(dir, {
      fallbackStrategy: 'none',
      linkedGroupsConfig: LINT_GROUP,
      validate: LINT,
      installer: async () => OK_INSTALL,
      registryCache: lintCache(),
    }),
  );
  assert.deepStrictEqual(report.upgraded.filter((r) => r.success && !r.skipped), []);
  assert.strictEqual(report.failed.length, 1);
  assert.strictEqual(report.failed[0].name, '[group:lint]');
  assert.strictEqual(report.failed[0].attemptedVersion, 'eslint@10.10.0, eslint-config-next@16.3.5');
  assert.strictEqual(report.failed[0].requestedLatest, 'eslint@10.10.0, eslint-config-next@16.3.5');
  assert.deepStrictEqual((await readPkg(dir)).devDependencies, LINT_PKG.devDependencies);
});

test('linked group: nothing breaking to hold back → the group fails as a whole', async () => {
  const dir = await project(LINT_PKG);
  const cache = lintCache();
  cache.latest.set('eslint', Promise.resolve('9.40.0'));
  cache.versions.set('eslint', Promise.resolve(['9.39.5', '9.40.0']));
  const failEverything = { command: `node -e "process.exit(require('./package.json').devDependencies.eslint === '^9.39.5' ? 0 : 1)"`, source: 'cli' };
  const report = await runUpgradeFlow(
    flowOpts(dir, { linkedGroupsConfig: LINT_GROUP, validate: failEverything, installer: async () => OK_INSTALL, registryCache: cache }),
  );
  assert.strictEqual(report.failed.length, 1);
  assert.strictEqual(report.failed[0].name, '[group:lint]');
});

test('peer-range resolver keeping installed versions: no reinstall, and the blocker is named', async () => {
  const fiber = { name: 'fiber', version: '9.7.0', peerDependencies: { react: '>=19 <19.3', 'react-dom': '>=19 <19.3' } };
  const dir = await project(
    { name: 'app', dependencies: { react: '^19.2.8', 'react-dom': '^19.2.8', fiber: '^9.7.0' } },
    {
      'node_modules/react/package.json': JSON.stringify({ name: 'react', version: '19.2.8' }),
      'node_modules/react-dom/package.json': JSON.stringify({ name: 'react-dom', version: '19.2.8', peerDependencies: { react: '^19.2.8' } }),
      'node_modules/fiber/package.json': JSON.stringify(fiber),
    },
  );
  let installs = 0;
  // Installs exactly what package.json asks for, without checking peers (like bun).
  const installer = async (cwd) => {
    installs++;
    const { dependencies } = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    for (const name of ['react', 'react-dom']) {
      const file = path.join(cwd, 'node_modules', name, 'package.json');
      const manifest = JSON.parse(await fs.readFile(file, 'utf8'));
      manifest.version = dependencies[name].replace(/^\^/, '');
      if (name === 'react-dom') manifest.peerDependencies = { react: `^${manifest.version}` };
      await fs.writeFile(file, JSON.stringify(manifest));
    }
    return OK_INSTALL;
  };
  const cache = createRegistryCache();
  cache.latest.set('react', Promise.resolve('19.3.0'));
  cache.latest.set('react-dom', Promise.resolve('19.3.0'));
  cache.latest.set('fiber', Promise.resolve('9.7.0'));
  cache.peers.set('react', Promise.resolve(new Map([['19.2.8', { peerDependencies: {} }], ['19.3.0', { peerDependencies: {} }]])));
  cache.peers.set(
    'react-dom',
    Promise.resolve(
      new Map([
        ['19.2.8', { peerDependencies: { react: '^19.2.8' } }],
        ['19.3.0', { peerDependencies: { react: '^19.3.0' } }],
      ]),
    ),
  );

  const report = await runUpgradeFlow(
    flowOpts(dir, {
      fallbackStrategy: 'none',
      resolvePeers: true,
      linkedGroupsConfig: [
        { id: 'react', packages: ['react', 'react-dom'] },
        { id: 'fiber', packages: ['fiber'] },
      ],
      validate: { skip: true },
      installer,
      registryCache: cache,
    }),
  );

  assert.deepStrictEqual(report.failed, [], JSON.stringify(report.failed, null, 2));
  // The 19.3.0 attempt and its rollback. The 19.2.8 tuple is what's installed: no third install.
  assert.strictEqual(installs, 2);
  for (const name of ['react', 'react-dom']) {
    const row = report.upgraded.find((r) => r.name === name);
    assert.strictEqual(row?.skipped, true, JSON.stringify(report.upgraded, null, 2));
    assert.strictEqual(row.requestedLatest, '19.3.0');
    assert.deepStrictEqual(row.blockedBy, [{ name: 'fiber', version: '9.7.0', range: '>=19 <19.3' }]);
    assert.match(row.detail, new RegExp(`^no change: the peer-range resolver kept 19\\.2\\.8 for linked group \\[react\\] \\(fiber needs ${name} >=19 <19\\.3\\)$`));
  }
  assert.deepStrictEqual((await readPkg(dir)).dependencies, { react: '^19.2.8', 'react-dom': '^19.2.8', fiber: '^9.7.0' });
});
