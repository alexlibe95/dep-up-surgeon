/**
 * Unit tests for src/cli/lockfileSync.ts: other managers' root lockfiles are re-resolved after
 * the run (package-lock.json next to bun.lock, ...).
 *
 *   1. `lockfileSyncCommand` — lockfile-only command per manager, yarn classic / 2 skipped.
 *   2. `syncStaleLockfiles` with an injected runner — updated / unchanged / failed (restored) /
 *      missing binary / dry-run / single lockfile.
 *   3. One run against the real npm binary on a dependency-free project (no network needed).
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { lockfileSyncCommand, syncStaleLockfiles, describeLockfileSync } = await import(
  path.join(root, 'dist/cli/lockfileSync.js')
);

async function project(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-lock-sync-'));
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
  return dir;
}

const BUN_AND_NPM = {
  'package.json': { name: 'site', version: '1.0.0', devDependencies: { '@types/node': '^26.6.5' } },
  'bun.lock': '{"lockfileVersion":1}',
  'package-lock.json': '{"lockfileVersion":3,"packages":{"":{"devDependencies":{"@types/node":"^20"}}}}',
};

test('lockfileSyncCommand: lockfile-only installs per manager', () => {
  assert.deepStrictEqual(lockfileSyncCommand('npm').args, [
    'install',
    '--package-lock-only',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ]);
  assert.deepStrictEqual(lockfileSyncCommand('pnpm').args, [
    'install',
    '--lockfile-only',
    '--ignore-scripts',
    '--no-frozen-lockfile',
  ]);
  assert.deepStrictEqual(lockfileSyncCommand('bun').args, ['install', '--lockfile-only', '--ignore-scripts']);
  assert.deepStrictEqual(lockfileSyncCommand('yarn', 4).args, ['install', '--mode=update-lockfile']);
  assert.strictEqual(lockfileSyncCommand('yarn', 1), undefined);
  assert.strictEqual(lockfileSyncCommand('yarn', 2), undefined);
  assert.strictEqual(lockfileSyncCommand('yarn'), undefined);
});

test('syncStaleLockfiles: bun project re-resolves package-lock.json with npm', async () => {
  const dir = await project(BUN_AND_NPM);
  const calls = [];
  const entries = await syncStaleLockfiles({
    cwd: dir,
    manager: 'bun',
    run: async (command, cwd) => {
      calls.push({ bin: command.bin, cwd });
      await fs.writeFile(path.join(cwd, 'package-lock.json'), '{"lockfileVersion":3,"synced":true}');
      return { exitCode: 0, output: '' };
    },
  });
  assert.deepStrictEqual(calls, [{ bin: 'npm', cwd: dir }]);
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].lockfile, 'package-lock.json');
  assert.strictEqual(entries[0].manager, 'npm');
  assert.strictEqual(entries[0].status, 'updated');
  assert.match(entries[0].command, /^npm install --package-lock-only/);
  // The run's own lockfile is never touched.
  assert.strictEqual(await fs.readFile(path.join(dir, 'bun.lock'), 'utf8'), BUN_AND_NPM['bun.lock']);
});

test('syncStaleLockfiles: a lockfile that already matched is reported unchanged', async () => {
  const dir = await project(BUN_AND_NPM);
  const entries = await syncStaleLockfiles({
    cwd: dir,
    manager: 'bun',
    run: async () => ({ exitCode: 0, output: 'up to date' }),
  });
  assert.strictEqual(entries[0].status, 'unchanged');
});

test('syncStaleLockfiles: a failed command leaves the lockfile exactly as it was', async () => {
  const dir = await project(BUN_AND_NPM);
  const entries = await syncStaleLockfiles({
    cwd: dir,
    manager: 'bun',
    run: async (_command, cwd) => {
      await fs.writeFile(path.join(cwd, 'package-lock.json'), '{"half-written":');
      return { exitCode: 1, output: 'npm error code ERESOLVE\nnpm error could not resolve' };
    },
  });
  assert.strictEqual(entries[0].status, 'failed');
  assert.strictEqual(entries[0].exitCode, 1);
  assert.match(entries[0].lastLines, /ERESOLVE/);
  assert.strictEqual(
    await fs.readFile(path.join(dir, 'package-lock.json'), 'utf8'),
    BUN_AND_NPM['package-lock.json'],
  );
  assert.match(describeLockfileSync(entries[0]), /left as it was/);
});

test('syncStaleLockfiles: a manager that is not installed is skipped', async () => {
  const dir = await project({
    'package.json': { name: 'app', version: '1.0.0' },
    'package-lock.json': '{"lockfileVersion":3}',
    'bun.lock': '{"lockfileVersion":1}',
  });
  const entries = await syncStaleLockfiles({
    cwd: dir,
    manager: 'npm',
    run: async () => ({ exitCode: 1, output: '', missingBinary: true }),
  });
  assert.deepStrictEqual(
    entries.map((e) => [e.lockfile, e.manager, e.status, e.skipReason]),
    [['bun.lock', 'bun', 'skipped', 'missing-binary']],
  );
});

test('syncStaleLockfiles: yarn classic is skipped as unsupported without running anything', async () => {
  const dir = await project({
    'package.json': { name: 'app', version: '1.0.0' },
    'package-lock.json': '{"lockfileVersion":3}',
    'yarn.lock': '# yarn lockfile v1\n',
  });
  const entries = await syncStaleLockfiles({
    cwd: dir,
    manager: 'npm',
    yarnMajorVersion: 1,
    run: async () => assert.fail('must not run'),
  });
  assert.deepStrictEqual(
    entries.map((e) => [e.lockfile, e.status, e.skipReason]),
    [['yarn.lock', 'skipped', 'unsupported']],
  );
});

test('syncStaleLockfiles: dry-run lists the command and changes nothing', async () => {
  const dir = await project(BUN_AND_NPM);
  const entries = await syncStaleLockfiles({
    cwd: dir,
    manager: 'bun',
    dryRun: true,
    run: async () => assert.fail('must not run'),
  });
  assert.strictEqual(entries[0].status, 'dry-run');
  assert.match(describeLockfileSync(entries[0]), /would be updated/);
});

test('syncStaleLockfiles: a project with one lockfile has nothing to sync', async () => {
  const dir = await project({
    'package.json': { name: 'app', version: '1.0.0' },
    'bun.lock': '{"lockfileVersion":1}',
  });
  const entries = await syncStaleLockfiles({
    cwd: dir,
    manager: 'bun',
    run: async () => assert.fail('must not run'),
  });
  assert.deepStrictEqual(entries, []);
});

test('syncStaleLockfiles: real npm rewrites a stale package-lock.json next to bun.lock', async () => {
  // No dependencies, so npm resolves without the registry.
  const dir = await project({
    'package.json': { name: 'site', version: '2.0.0' },
    'bun.lock': '{"lockfileVersion":1}',
    'package-lock.json': JSON.stringify(
      { name: 'site', version: '1.0.0', lockfileVersion: 3, requires: true, packages: { '': { name: 'site', version: '1.0.0' } } },
      null,
      2,
    ),
  });
  const entries = await syncStaleLockfiles({ cwd: dir, manager: 'bun' });
  assert.strictEqual(entries[0].status, 'updated', JSON.stringify(entries[0]));
  const lock = JSON.parse(await fs.readFile(path.join(dir, 'package-lock.json'), 'utf8'));
  assert.strictEqual(lock.version, '2.0.0');
  assert.strictEqual(lock.packages[''].version, '2.0.0');
  // Lockfile-only: npm never created node_modules.
  await assert.rejects(fs.access(path.join(dir, 'node_modules')));
});
