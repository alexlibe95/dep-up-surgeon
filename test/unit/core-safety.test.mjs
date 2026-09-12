/**
 * Core engine safety regressions:
 *   - rollback restores package.json AND the lockfile byte-for-byte (formatting included);
 *   - a signal handler can undo the attempt that is mid-install;
 *   - GitHub shorthands / tarballs / dist-tags are never rewritten to registry versions;
 *   - a security "preferred" version below the installed one never causes a downgrade;
 *   - the dev copy of a dev+peer dependency is upgraded;
 *   - a single workspace target labels its rows (git per-target commits + undo rely on it);
 *   - helpers: npm's placeholder test script, prerelease current versions, runWithConcurrency.
 *
 * Hermetic like `security-only.test.mjs`: installer stub, pre-seeded registry cache, validators
 * are node one-liners.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const upgrader = await import(path.join(root, 'dist/core/upgrader.js'));
const { createRegistryCache, runWithConcurrency } = await import(
  path.join(root, 'dist/utils/concurrency.js')
);
const { isRegistryRange } = await import(path.join(root, 'dist/core/scanner.js'));
const { validateProject } = await import(path.join(root, 'dist/core/validator.js'));
const { buildLineFallbackOrder } = await import(path.join(root, 'dist/utils/versionFallback.js'));
const { dedupeScannedByName } = await import(path.join(root, 'dist/core/scannedDedup.js'));

const OK_INSTALL = { ok: true, output: '', exitCode: 0, command: 'npm install', filtered: false };

async function project(pkgText, extraFiles = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-core-'));
  await fs.writeFile(path.join(dir, 'package.json'), pkgText);
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
    fallbackStrategy: 'none',
    linkGroups: 'none',
    linkedGroupsConfig: [],
    resolvePeers: false,
    validate: { skip: true },
    ...overrides,
  };
}

function cacheWithLatest(entries) {
  const cache = createRegistryCache();
  for (const [name, version] of Object.entries(entries)) {
    cache.latest.set(name, Promise.resolve(version));
  }
  return cache;
}

const readText = (dir, name = 'package.json') => fs.readFile(path.join(dir, name), 'utf8');

test('rollback restores package.json and the lockfile byte-for-byte', async () => {
  const pkgText = '{\n    "name": "app",\n    "dependencies": {\n        "axios": "^1.0.0"\n    }\n}\n';
  const lockText =
    '{\n  "lockfileVersion": 3,\n  "packages": {\n    "node_modules/axios": { "version": "1.0.0" }\n  }\n}\n';
  const dir = await project(pkgText, { 'package-lock.json': lockText });
  // The "install" re-resolves the lockfile like npm would: only a bumped range rewrites it, so
  // re-writing the old range afterwards (the previous rollback) left 1.7.0 locked.
  const installer = async (cwd) => {
    const { dependencies } = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    if (dependencies.axios !== '^1.0.0') {
      await fs.writeFile(
        path.join(cwd, 'package-lock.json'),
        '{"lockfileVersion":3,"packages":{"node_modules/axios":{"version":"1.7.0"}}}',
      );
    }
    return OK_INSTALL;
  };
  // Passes on the untouched tree (pre-flight), fails once axios moved.
  const validate = {
    command: `node -e "process.exit(require('./package.json').dependencies.axios === '^1.0.0' ? 0 : 1)"`,
    source: 'cli',
  };

  const report = await upgrader.runUpgradeFlow(
    flowOpts(dir, { validate, installer, registryCache: cacheWithLatest({ axios: '1.7.0' }) }),
  );

  assert.strictEqual(report.failed[0]?.name, 'axios', JSON.stringify(report.failed));
  assert.strictEqual(await readText(dir), pkgText);
  assert.strictEqual(await readText(dir, 'package-lock.json'), lockText);
});

test("a kept upgrade keeps the manifest's own indentation and line endings", async () => {
  const dir = await project('{\r\n\t"name": "app",\r\n\t"dependencies": {\r\n\t\t"axios": "^1.0.0"\r\n\t}\r\n}\r\n');
  await upgrader.runUpgradeFlow(
    flowOpts(dir, { installer: async () => OK_INSTALL, registryCache: cacheWithLatest({ axios: '1.7.0' }) }),
  );
  assert.strictEqual(
    await readText(dir),
    '{\r\n\t"name": "app",\r\n\t"dependencies": {\r\n\t\t"axios": "^1.7.0"\r\n\t}\r\n}\r\n',
  );
});

test('rollbackInFlightAttemptsSync undoes the attempt that is mid-install (signal path)', async () => {
  const pkgText = '{\n  "name": "app",\n  "dependencies": {\n    "axios": "^1.0.0"\n  }\n}\n';
  const dir = await project(pkgText);
  let duringInstall = '';
  let undone;
  const installer = async (cwd) => {
    if (undone === undefined) {
      duringInstall = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
      undone = upgrader.rollbackInFlightAttemptsSync();
    }
    return { ok: false, output: 'interrupted', exitCode: 130, command: 'npm install', filtered: false };
  };

  await upgrader.runUpgradeFlow(
    flowOpts(dir, { installer, registryCache: cacheWithLatest({ axios: '1.7.0' }) }),
  );

  assert.match(duringInstall, /\^1\.7\.0/, 'the bump was on disk while installing');
  assert.strictEqual(undone, 1);
  assert.strictEqual(await readText(dir), pkgText);
});

test('isRegistryRange: git shorthands, URLs, tarballs and local paths are not registry ranges', () => {
  for (const spec of [
    'github:me/lib#v1.2.3',
    'me/lib#1.2.3',
    'git@github.com:me/lib.git#v1.0.0',
    'ssh://git@github.com/me/lib#1.0.0',
    'gitlab:me/lib',
    'bitbucket:me/lib',
    '../vendor/lib-1.2.3.tgz',
    './local-pkg',
    'jsr:@std/path@^1.0.0',
  ]) {
    assert.strictEqual(isRegistryRange(spec), false, spec);
  }
  for (const spec of ['^1.2.3', '~1.2', '1.x', '>=1.2.0 <2', '1.2.3', 'latest']) {
    assert.strictEqual(isRegistryRange(spec), true, spec);
  }
});

test('a GitHub-shorthand dependency is skipped, never swapped for the registry package', async () => {
  const pkgText = '{\n  "name": "app",\n  "dependencies": {\n    "mylib": "github:me/mylib#v1.2.3"\n  }\n}\n';
  const dir = await project(pkgText);
  let installs = 0;
  const report = await upgrader.runUpgradeFlow(
    flowOpts(dir, {
      installer: async () => (installs++, OK_INSTALL),
      registryCache: cacheWithLatest({ mylib: '5.0.0' }),
    }),
  );
  assert.strictEqual(installs, 0);
  assert.strictEqual(await readText(dir), pkgText);
  assert.ok(report.upgraded.some((r) => r.name === 'mylib' && r.skipped));
});

test('a dist-tag spec with nothing installed tries latest only — no walk down every major', async () => {
  const pkgText = '{\n  "name": "app",\n  "dependencies": {\n    "react": "latest"\n  }\n}\n';
  const dir = await project(pkgText);
  const cache = cacheWithLatest({ react: '19.1.0' });
  cache.versions.set('react', Promise.resolve(['15.7.0', '16.14.0', '17.0.2', '18.3.1', '19.1.0']));
  const attempted = [];
  const installer = async (cwd) => {
    const { react } = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')).dependencies;
    if (react !== 'latest') attempted.push(react);
    return OK_INSTALL;
  };
  await upgrader.runUpgradeFlow(
    flowOpts(dir, {
      installer,
      registryCache: cache,
      fallbackStrategy: 'major-lines',
      // Passes on the untouched tree, fails for any pinned version.
      validate: {
        command: `node -e "process.exit(require('./package.json').dependencies.react === 'latest' ? 0 : 1)"`,
        source: 'cli',
      },
    }),
  );
  assert.deepStrictEqual(attempted, ['19.1.0']);
  assert.strictEqual(await readText(dir), pkgText);
});

test('a preferred (security) version below the installed one never causes a downgrade', async () => {
  const lock = { lockfileVersion: 3, packages: { '': {}, 'node_modules/qs': { version: '6.12.5' } } };
  const dir = await project('{\n  "name": "app",\n  "dependencies": {\n    "qs": "^6.12.0"\n  }\n}\n', {
    'package-lock.json': JSON.stringify(lock, null, 2),
  });
  const attempted = [];
  const installer = async (cwd) => {
    attempted.push(JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8')).dependencies.qs);
    return OK_INSTALL;
  };
  await upgrader.runUpgradeFlow(
    flowOpts(dir, {
      installer,
      registryCache: cacheWithLatest({ qs: '6.14.1' }),
      // npm sometimes reports the PARENT's fix version for a transitive advisory.
      preferredTargets: new Map([['qs', '4.22.2']]),
    }),
  );
  assert.deepStrictEqual(attempted, ['^6.14.1']);
});

test('a dependency declared in devDependencies AND peerDependencies upgrades the dev copy', async () => {
  const dir = await project(
    JSON.stringify(
      { name: 'lib', peerDependencies: { react: '^17 || ^18' }, devDependencies: { react: '^18.2.0' } },
      null,
      2,
    ) + '\n',
  );
  await upgrader.runUpgradeFlow(
    flowOpts(dir, { installer: async () => OK_INSTALL, registryCache: cacheWithLatest({ react: '18.3.1' }) }),
  );
  const after = JSON.parse(await readText(dir));
  assert.strictEqual(after.devDependencies.react, '^18.3.1');
  assert.strictEqual(after.peerDependencies.react, '^17 || ^18', 'the peer contract is untouched');

  const picked = dedupeScannedByName([
    { name: 'react', section: 'peerDependencies', currentRange: '^17 || ^18' },
    { name: 'react', section: 'devDependencies', currentRange: '^18.2.0' },
  ]);
  assert.deepStrictEqual(picked.map((p) => p.section), ['devDependencies']);
});

test('a single workspace target labels its rows with the member name', async () => {
  const dir = await project(
    JSON.stringify({ name: 'mono', private: true, workspaces: ['packages/*'] }, null, 2),
    {
      'packages/web/package.json': JSON.stringify(
        { name: '@org/web', version: '1.0.0', dependencies: { axios: '^1.0.0' } },
        null,
        2,
      ),
    },
  );
  const report = await upgrader.runUpgradeFlow(
    flowOpts(dir, {
      dryRun: true,
      workspaceMode: ['@org/web'],
      registryCache: cacheWithLatest({ axios: '1.7.0' }),
    }),
  );
  const row = report.upgraded.find((r) => r.name === 'axios');
  assert.strictEqual(row?.workspace, '@org/web', JSON.stringify(report.upgraded));
});

test("validateProject: npm init's placeholder test script is not a validator", async () => {
  const placeholder = 'echo "Error: no test specified" && exit 1';
  const onlyPlaceholder = await validateProject(os.tmpdir(), { scripts: { test: placeholder } }, {});
  assert.strictEqual(onlyPlaceholder.skipped, true);

  const scripts = { test: placeholder, build: 'node -e "process.exit(0)"' };
  const dir = await project(JSON.stringify({ name: 'x', version: '1.0.0', scripts }));
  const withBuild = await validateProject(dir, { scripts }, { manager: 'npm' });
  assert.strictEqual(withBuild.ok, true, withBuild.output);
  assert.strictEqual(withBuild.source, 'package.json:build');
});

test('buildLineFallbackOrder: a prerelease current version still sees the stable release', () => {
  assert.deepStrictEqual(
    buildLineFallbackOrder('2.0.0-beta.3', '2.0.0', ['1.9.0', '2.0.0-beta.3', '2.0.0'], 'major'),
    ['2.0.0'],
  );
});

test('buildLineFallbackOrder: never offers versions above the latest dist-tag', () => {
  assert.deepStrictEqual(
    buildLineFallbackOrder('1.0.0', '3.0.0', ['1.0.0', '2.0.0', '3.0.0', '4.0.0'], 'major'),
    ['3.0.0', '2.0.0'],
  );
});

test('runWithConcurrency: stops handing out items once a worker throws', async () => {
  const started = [];
  await assert.rejects(
    runWithConcurrency([1, 2, 3, 4, 5, 6], 2, async (n) => {
      started.push(n);
      if (n === 1) throw new Error('boom');
      await new Promise((r) => setTimeout(r, 20));
      return n;
    }),
    /boom/,
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.deepStrictEqual(started, [1, 2]);
});

test('runWithConcurrency: a NaN limit still processes every item', async () => {
  assert.deepStrictEqual(await runWithConcurrency([1, 2, 3], Number.NaN, async (n) => n * 2), [2, 4, 6]);
});
