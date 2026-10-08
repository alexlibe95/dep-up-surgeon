/**
 * Engine regressions found in a review pass:
 *   - policy `maxVersion` caps linked groups and dry-run plans, not only single upgrades;
 *   - a workspace member's own lockfile is restored when a root install rolls back;
 *   - the ad-hoc peer resolver keeping the installed version is a failure, not a no-op "success";
 *   - `runWithConcurrency` waits for in-flight workers before it rejects;
 *   - a workspace target that throws becomes a failure row instead of discarding the report.
 *
 * Hermetic: custom linked groups (no registry graph), pre-seeded registry cache, installer stubs,
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
const { createRegistryCache, runWithConcurrency } = await import(
  path.join(root, 'dist/utils/concurrency.js')
);
const { normalizePolicy } = await import(path.join(root, 'dist/config/policy.js'));

const OK_INSTALL = { ok: true, output: '', exitCode: 0, command: 'npm install', filtered: false };

async function project(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-engine-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
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
    fallbackStrategy: 'none',
    linkGroups: 'none',
    linkedGroupsConfig: [],
    resolvePeers: false,
    validate: { skip: true },
    ...overrides,
  };
}

function cache({ latest = {}, versions = {}, peers = {} }) {
  const c = createRegistryCache();
  for (const [name, v] of Object.entries(latest)) c.latest.set(name, Promise.resolve(v));
  for (const [name, list] of Object.entries(versions)) c.versions.set(name, Promise.resolve(list));
  for (const [name, byVersion] of Object.entries(peers)) {
    c.peers.set(
      name,
      Promise.resolve(
        new Map(Object.entries(byVersion).map(([v, p]) => [v, { peerDependencies: p }])),
      ),
    );
  }
  return c;
}

const readJson = async (dir, name = 'package.json') =>
  JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));

test('policy maxVersion caps a linked group member (real run and dry-run)', async () => {
  const pkg = { name: 'app', devDependencies: { eslint: '^9.39.5', 'eslint-config-next': '^16.3.1' } };
  const policy = normalizePolicy({ maxVersion: [{ pattern: 'eslint', range: '<10' }] });
  const registry = () =>
    cache({
      latest: { eslint: '10.10.0', 'eslint-config-next': '16.3.5' },
      versions: { eslint: ['9.39.5', '9.40.0', '10.10.0'], 'eslint-config-next': ['16.3.1', '16.3.5'] },
    });
  const opts = (dir, extra) =>
    flowOpts(dir, {
      linkGroups: 'auto',
      linkedGroupsConfig: [{ id: 'lint', packages: ['eslint', 'eslint-config-next'] }],
      policy,
      installer: async () => OK_INSTALL,
      registryCache: registry(),
      ...extra,
    });

  const planDir = await project({ 'package.json': pkg });
  const plan = await runUpgradeFlow(opts(planDir, { dryRun: true }));
  assert.deepStrictEqual(
    plan.upgraded.map((r) => [r.name, r.to]),
    [['eslint', '9.40.0'], ['eslint-config-next', '16.3.5']],
    JSON.stringify(plan.upgraded, null, 2),
  );

  const dir = await project({ 'package.json': pkg });
  const report = await runUpgradeFlow(opts(dir));
  assert.deepStrictEqual((await readJson(dir)).devDependencies, {
    eslint: '^9.40.0',
    'eslint-config-next': '^16.3.5',
  });
  assert.strictEqual(report.failed.length, 0, JSON.stringify(report.failed, null, 2));
});

test('policy maxVersion caps a single dry-run plan, or skips it when nothing newer is allowed', async () => {
  const policy = normalizePolicy({
    maxVersion: [
      { pattern: 'axios', range: '<1.7' },
      { pattern: 'lodash', range: '<4.17.21' },
    ],
  });
  const dir = await project({ 'package.json': { name: 'app', dependencies: { axios: '^1.0.0', lodash: '4.17.20' } } });
  const report = await runUpgradeFlow(
    flowOpts(dir, {
      dryRun: true,
      policy,
      registryCache: cache({
        latest: { axios: '1.7.0', lodash: '4.17.21' },
        versions: { axios: ['1.0.0', '1.6.8', '1.7.0'], lodash: ['4.17.20', '4.17.21'] },
      }),
    }),
  );
  const axios = report.upgraded.find((r) => r.name === 'axios');
  assert.strictEqual(axios?.to, '1.6.8', JSON.stringify(report.upgraded, null, 2));
  assert.match(axios.detail, /capped by policy/);
  const lodash = report.upgraded.find((r) => r.name === 'lodash');
  assert.strictEqual(lodash?.reason, 'policy');
});

test("rollback restores a workspace member's own lockfile, not only the root one", async () => {
  const memberLock = '{"lockfileVersion":3,"packages":{"node_modules/lodash":{"version":"4.17.0"}}}\n';
  const dir = await project({
    'package.json': { name: 'root', workspaces: ['packages/*'] },
    'package-lock.json': '{"lockfileVersion":3,"packages":{}}\n',
    'packages/web/package.json': { name: 'web', dependencies: { lodash: '^4.17.0' } },
    'packages/web/package-lock.json': memberLock,
  });
  // A root install that also rewrites the member's lockfile.
  const installer = async (cwd) => {
    const member = await readJson(cwd, 'packages/web/package.json');
    if (member.dependencies.lodash !== '^4.17.0') {
      await fs.writeFile(path.join(cwd, 'packages/web/package-lock.json'), '{"rejected":"4.17.21"}\n');
    }
    return OK_INSTALL;
  };
  const report = await runUpgradeFlow(
    flowOpts(dir, {
      workspaceMode: ['web'],
      installer,
      validate: {
        command: `node -e "process.exit(require('./packages/web/package.json').dependencies.lodash === '^4.17.0' ? 0 : 1)"`,
        source: 'cli',
      },
      registryCache: cache({ latest: { lodash: '4.17.21' } }),
    }),
  );
  assert.strictEqual(report.failed[0]?.name, 'lodash', JSON.stringify(report.failed, null, 2));
  assert.strictEqual(await fs.readFile(path.join(dir, 'packages/web/package-lock.json'), 'utf8'), memberLock);
});

test('ad-hoc peer resolver that can only keep the installed version reports the failure', async () => {
  const pkgText = JSON.stringify({ name: 'app', dependencies: { react: '19.2.4', fiber: '^9.7.0' } }, null, 2);
  const dir = await project({
    'package.json': pkgText,
    'node_modules/react/package.json': { name: 'react', version: '19.2.4' },
    'node_modules/fiber/package.json': {
      name: 'fiber',
      version: '9.7.0',
      peerDependencies: { react: '>=19 <19.3' },
    },
  });
  // Installs what package.json asks for without checking peers, like npm with a lockfile or bun.
  const installer = async (cwd) => {
    const { dependencies } = await readJson(cwd);
    await fs.writeFile(
      path.join(cwd, 'node_modules/react/package.json'),
      JSON.stringify({ name: 'react', version: dependencies.react }),
    );
    return OK_INSTALL;
  };
  const report = await runUpgradeFlow(
    flowOpts(dir, {
      resolvePeers: true,
      installer,
      registryCache: cache({
        latest: { react: '19.3.0', fiber: '9.7.0' },
        versions: { react: ['19.2.4', '19.3.0'], fiber: ['9.7.0'] },
        peers: { react: { '19.2.4': {}, '19.3.0': {} }, fiber: { '9.7.0': { react: '>=19 <19.3' } } },
      }),
    }),
  );
  assert.ok(
    !report.upgraded.some((r) => r.name === 'react' && r.success && !r.skipped),
    JSON.stringify(report.upgraded, null, 2),
  );
  assert.strictEqual(report.failed.find((f) => f.name === 'react')?.reason, 'peer');
  assert.strictEqual(await fs.readFile(path.join(dir, 'package.json'), 'utf8'), pkgText);
});

test('runWithConcurrency waits for in-flight workers before it rejects', async () => {
  let slowFinished = false;
  await assert.rejects(
    runWithConcurrency([0, 1], 2, async (i) => {
      if (i === 0) throw new Error('boom');
      await new Promise((r) => setTimeout(r, 50));
      slowFinished = true;
    }),
    /boom/,
  );
  assert.strictEqual(slowFinished, true);
});

test('a workspace target that throws is a failure row; earlier targets stay in the report', async () => {
  const dir = await project({
    'package.json': { name: 'root', workspaces: ['packages/*'] },
    'package-lock.json': '{"lockfileVersion":3,"packages":{}}\n',
    'packages/a/package.json': { name: 'a', dependencies: { axios: '^1.0.0' } },
    'packages/b/package.json': { name: 'b', dependencies: { lodash: '^4.0.0' } },
  });
  // The first install (target a) corrupts b's manifest, so b's engine throws on read.
  const installer = async (cwd) => {
    await fs.writeFile(path.join(cwd, 'packages/b/package.json'), '{ not json');
    return OK_INSTALL;
  };
  const report = await runUpgradeFlow(
    flowOpts(dir, {
      workspaceMode: 'workspaces-only',
      installer,
      registryCache: cache({ latest: { axios: '1.7.0', lodash: '4.17.21' } }),
    }),
  );
  assert.ok(
    report.upgraded.some((r) => r.name === 'axios' && r.success && !r.skipped),
    JSON.stringify(report, null, 2),
  );
  assert.ok(report.failed.some((f) => f.name === '[target:b]'), JSON.stringify(report.failed, null, 2));
});
