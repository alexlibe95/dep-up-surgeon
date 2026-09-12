/**
 * Git integration safety regressions (real `git` in tmp repos):
 *   - an invalid `--git-branch` can never fall back to `git checkout <file>`;
 *   - a gitignored lockfile doesn't make every commit fail;
 *   - a commit refused by a hook doesn't leave files staged for the next commit;
 *   - the tool's own report / summary / backup files don't count as a dirty tree;
 *   - `bun.lockb` is committed with package.json.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execa } from 'execa';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { checkoutBranch, getCurrentBranch, gitAdd, lockfileBasenamesFor } = await import(
  path.join(root, 'dist/cli/git.js')
);
const { createGitFlow } = await import(path.join(root, 'dist/cli/gitFlow.js'));

const FLOW = { enabled: true, mode: 'per-success', prefix: 'deps: ', sign: false, allowDirty: false };
const BUMPED = '{"name":"x","dependencies":{"a":"^2.0.0"}}\n';

async function makeRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-gitsafe-'));
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'dep-up-surgeon test'], { cwd: dir });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  await fs.writeFile(path.join(dir, 'package.json'), '{"name":"x","dependencies":{"a":"^1.0.0"}}\n');
  await fs.writeFile(path.join(dir, 'yarn.lock'), '# lockfile v1\n');
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

function upgradeEvent(repo, manager) {
  return {
    records: [{ name: 'a', success: true, from: '^1.0.0', to: '^2.0.0' }],
    targetCwd: repo,
    installCwd: repo,
    manager,
  };
}

test('checkoutBranch: an invalid name is rejected and a same-named file is left untouched', async () => {
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, 'yarn.lock'), '# user edit\n');
  // `yarn.lock` can't be a branch (refs may not end in `.lock`); the old fallback then ran
  // `git checkout yarn.lock`, silently discarding the edit above.
  await assert.rejects(() => checkoutBranch(repo, 'yarn.lock'), /not a valid git branch name/);
  assert.strictEqual(await fs.readFile(path.join(repo, 'yarn.lock'), 'utf8'), '# user edit\n');
  assert.strictEqual(await getCurrentBranch(repo), 'main');
});

test('checkoutBranch: option-looking names never reach git as flags', async () => {
  const repo = await makeRepo();
  await assert.rejects(() => checkoutBranch(repo, '--orphan'), /not a valid git branch name/);
  assert.strictEqual(await getCurrentBranch(repo), 'main');
});

test('gitAdd: a gitignored lockfile is skipped instead of failing the commit', async () => {
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, '.gitignore'), 'package-lock.json\n');
  await execa('git', ['add', '.gitignore'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'ignore lockfile'], { cwd: repo });
  await fs.writeFile(path.join(repo, 'package.json'), BUMPED);
  await fs.writeFile(path.join(repo, 'package-lock.json'), '{}\n');

  const staged = await gitAdd({ cwd: repo }, [
    path.join(repo, 'package.json'),
    path.join(repo, 'package-lock.json'),
  ]);
  assert.deepStrictEqual(staged, ['package.json']);
});

test('gitFlow: a commit refused by a hook leaves nothing staged', async () => {
  const repo = await makeRepo();
  const hook = path.join(repo, '.git', 'hooks', 'pre-commit');
  await fs.writeFile(hook, '#!/bin/sh\nexit 1\n');
  await fs.chmod(hook, 0o755);

  const setup = await createGitFlow(repo, FLOW, true, false);
  assert.ok(setup.ok, setup.error);
  await fs.writeFile(path.join(repo, 'package.json'), BUMPED);
  await setup.controller.onUpgradeApplied(upgradeEvent(repo, 'yarn'));

  assert.strictEqual(setup.controller.commits[0].ok, false);
  const { stdout } = await execa('git', ['diff', '--cached', '--name-only'], { cwd: repo });
  assert.strictEqual(stdout.trim(), '', 'the refused change must not ride along with the next commit');
});

test("gitFlow: the tool's own output files don't make --git-commit refuse", async () => {
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, '.dep-up-surgeon.last-run.json'), '{}\n');
  await fs.writeFile(path.join(repo, 'dep-up-surgeon-summary.md'), '# summary\n');
  await fs.writeFile(path.join(repo, 'package.json.dep-up-surgeon.bak'), '{}\n');

  const clean = await createGitFlow(repo, FLOW, true, false);
  assert.strictEqual(clean.ok, true, clean.error);

  await fs.writeFile(path.join(repo, 'notes.txt'), 'wip\n');
  const dirty = await createGitFlow(repo, FLOW, true, false);
  assert.strictEqual(dirty.ok, false);
  assert.match(dirty.error, /notes\.txt/);
});

test('gitFlow: bun.lockb is committed together with package.json', async () => {
  const repo = await makeRepo();
  await fs.writeFile(path.join(repo, 'bun.lockb'), Buffer.from([0, 1, 2]));
  await execa('git', ['add', 'bun.lockb'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'binary lockfile'], { cwd: repo });

  const setup = await createGitFlow(repo, FLOW, true, false);
  assert.ok(setup.ok, setup.error);
  await fs.writeFile(path.join(repo, 'package.json'), BUMPED);
  await fs.writeFile(path.join(repo, 'bun.lockb'), Buffer.from([3, 4, 5]));
  await setup.controller.onUpgradeApplied(upgradeEvent(repo, 'bun'));

  const commit = setup.controller.commits[0];
  assert.strictEqual(commit.ok, true, commit.error);
  assert.deepStrictEqual([...commit.files].sort(), ['bun.lockb', 'package.json']);
});

test('lockfileBasenamesFor: includes bun.lockb and npm-shrinkwrap.json', () => {
  assert.deepStrictEqual(lockfileBasenamesFor('bun'), ['bun.lock', 'bun.lockb']);
  assert.deepStrictEqual(lockfileBasenamesFor('npm'), ['package-lock.json', 'npm-shrinkwrap.json']);
  assert.deepStrictEqual(lockfileBasenamesFor('pnpm'), ['pnpm-lock.yaml']);
});
