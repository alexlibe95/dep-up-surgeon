/**
 * `sideEffects.ts` against real `git` in tmp repos: a run may leave only dependency files changed.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execa } from 'execa';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { captureWorktree, restoreSideEffects } = await import(path.join(root, 'dist/cli/sideEffects.js'));

async function makeRepo(files) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-side-'));
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'dep-up-surgeon test'], { cwd: dir });
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

const read = (dir, name) => fs.readFile(path.join(dir, name), 'utf8');

test('restoreSideEffects: puts back files the run rewrote; keeps dependency files and earlier edits', async () => {
  const repo = await makeRepo({
    'package.json': '{"name":"x"}\n',
    'bun.lock': 'v1\n',
    'tsconfig.json': '{"jsx":"preserve"}\n',
    'notes.md': 'draft\n',
  });
  await fs.writeFile(path.join(repo, 'notes.md'), 'my wip\n'); // the user's edit before the run
  const before = await captureWorktree(repo);

  // The run: the upgrade, `next build` rewriting tsconfig.json, more user edits, generated files.
  await fs.writeFile(path.join(repo, 'package.json'), '{"name":"x","v":2}\n');
  await fs.writeFile(path.join(repo, 'bun.lock'), 'v2\n');
  await fs.writeFile(path.join(repo, 'tsconfig.json'), '{"jsx":"react-jsx"}\n');
  await fs.writeFile(path.join(repo, 'notes.md'), 'my wip, still editing\n');
  await fs.writeFile(path.join(repo, 'next-env.d.ts'), '// generated\n');
  await fs.writeFile(path.join(repo, 'package.json.dep-up-surgeon.bak'), '{}\n');

  const result = await restoreSideEffects(before);

  assert.deepStrictEqual(result.restored, ['tsconfig.json']);
  assert.deepStrictEqual(result.untracked, ['next-env.d.ts']);
  assert.strictEqual(await read(repo, 'tsconfig.json'), '{"jsx":"preserve"}\n');
  // The run's version is kept, in case it was the user's own edit made while the run was going.
  assert.strictEqual(await fs.readFile(path.join(result.backupDir, 'tsconfig.json'), 'utf8'), '{"jsx":"react-jsx"}\n');
  assert.strictEqual(await read(repo, 'package.json'), '{"name":"x","v":2}\n');
  assert.strictEqual(await read(repo, 'bun.lock'), 'v2\n');
  assert.strictEqual(await read(repo, 'notes.md'), 'my wip, still editing\n', 'a file dirty before the run is never touched');
  assert.strictEqual(await read(repo, 'next-env.d.ts'), '// generated\n', 'untracked files are never deleted');
});

test('restoreSideEffects: stays inside the project dir; keeps --summary-file and yarn PnP files', async () => {
  const repo = await makeRepo({
    'app/package.json': '{"name":"app"}\n',
    'app/tsconfig.json': '{"a":1}\n',
    'app/DEPS.md': 'old\n',
    'app/.pnp.cjs': '// pnp v1\n',
    'other/notes.md': 'draft\n',
  });
  const app = path.join(repo, 'app');
  const before = await captureWorktree(app);

  await fs.writeFile(path.join(app, 'tsconfig.json'), '{"a":2}\n');
  await fs.writeFile(path.join(app, 'DEPS.md'), 'new summary\n');
  await fs.writeFile(path.join(app, '.pnp.cjs'), '// pnp v2\n');
  await fs.writeFile(path.join(repo, 'other/notes.md'), 'edited in another project\n');

  const result = await restoreSideEffects(before, { keep: [path.join(app, 'DEPS.md')] });

  assert.deepStrictEqual(result.restored, ['app/tsconfig.json']);
  assert.strictEqual(await read(app, 'DEPS.md'), 'new summary\n');
  assert.strictEqual(await read(app, '.pnp.cjs'), '// pnp v2\n');
  assert.strictEqual(await read(repo, 'other/notes.md'), 'edited in another project\n');
});

test('captureWorktree: outside a git repo there is nothing to restore', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-side-nogit-'));
  assert.strictEqual(await captureWorktree(dir), undefined);
});
