/**
 * Unit tests for the git integration:
 *
 *   1. Low-level helpers in `src/cli/git.ts` (isGitRepo, getUncommittedFiles, gitAdd, gitCommit,
 *      checkoutBranch) — exercised against a freshly initialized tmp git repo so we test the
 *      real binary, not a mock.
 *   2. Commit message formatters (formatPerSuccessMessage, formatPerTargetMessage,
 *      formatAllInOneMessage) — pure functions, snapshot-style assertions.
 *   3. The `createGitFlow` factory's pre-flight behavior:
 *        - returns a no-op controller when disabled,
 *        - refuses on a dirty tree (and the override works),
 *        - errors out outside a git repo,
 *        - silently no-ops in --dry-run.
 *
 * Every test uses its own temp directory so they can run in parallel safely.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execa } from 'execa';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  isGitRepo,
  getUncommittedFiles,
  getCurrentBranch,
  checkoutBranch,
  gitAdd,
  gitCommit,
  formatPerSuccessMessage,
  formatPerTargetMessage,
  formatAllInOneMessage,
  lockfileBasenameFor,
} = await import(path.join(root, 'dist/cli/git.js'));
const { createGitFlow } = await import(path.join(root, 'dist/cli/gitFlow.js'));

async function makeTmpRepo() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-git-'));
  // `-q` keeps stderr clean; `init.defaultBranch=main` to avoid the "hint:" noise on newer
  // git versions where `master` is deprecated.
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  // Local config so commit() succeeds even on machines without global user.email set.
  await execa('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execa('git', ['config', 'user.name', 'dep-up-surgeon test'], { cwd: dir });
  // commit.gpgsign=false so a host with global signing enabled doesn't break our tests.
  await execa('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  return dir;
}

async function makeNonRepo() {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'dus-nogit-'));
}

async function writeFile(file, contents) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents);
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

test('isGitRepo: true inside a repo, false outside', async () => {
  const repo = await makeTmpRepo();
  const notRepo = await makeNonRepo();
  assert.strictEqual(await isGitRepo(repo), true);
  assert.strictEqual(await isGitRepo(notRepo), false);
});

test('getUncommittedFiles: empty on clean tree, lists changes after edits', async () => {
  const repo = await makeTmpRepo();
  // Create + commit an initial file so the tree has a HEAD.
  await writeFile(path.join(repo, 'package.json'), '{"name":"x"}\n');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

  let dirty = await getUncommittedFiles(repo);
  assert.deepStrictEqual(dirty, [], 'clean tree should report no uncommitted files');

  // Modify + add an untracked file.
  await writeFile(path.join(repo, 'package.json'), '{"name":"x","v":1}\n');
  await writeFile(path.join(repo, 'untracked.txt'), 'hi\n');
  dirty = await getUncommittedFiles(repo);
  assert.ok(dirty.includes('package.json'), 'modified file must show up');
  assert.ok(dirty.includes('untracked.txt'), 'untracked file must show up');
});

test('checkoutBranch: creates a new branch and returns the previous one', async () => {
  const repo = await makeTmpRepo();
  await writeFile(path.join(repo, 'a.txt'), 'a\n');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

  const prev = await checkoutBranch(repo, 'feature/dep-up');
  assert.strictEqual(prev, 'main', 'previous branch should be the default `main`');
  const now = await getCurrentBranch(repo);
  assert.strictEqual(now, 'feature/dep-up');
});

test('checkoutBranch: switches to an existing branch instead of failing', async () => {
  const repo = await makeTmpRepo();
  await writeFile(path.join(repo, 'a.txt'), 'a\n');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  await execa('git', ['branch', 'existing'], { cwd: repo });

  await checkoutBranch(repo, 'existing');
  assert.strictEqual(await getCurrentBranch(repo), 'existing');
});

test('gitAdd + gitCommit: stage and commit only the named files', async () => {
  const repo = await makeTmpRepo();
  // Initial commit so HEAD exists.
  await writeFile(path.join(repo, 'README.md'), 'hi\n');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

  // Two changes, but we only want to commit one.
  const pkg = path.join(repo, 'package.json');
  const wip = path.join(repo, 'wip.txt');
  await writeFile(pkg, '{"name":"x","v":2}\n');
  await writeFile(wip, 'WIP\n');

  const staged = await gitAdd({ cwd: repo }, [pkg]);
  assert.deepStrictEqual(staged, ['package.json'], 'only the explicit file should be staged');

  const result = await gitCommit({ cwd: repo }, 'deps: bump x', staged);
  assert.strictEqual(result.ok, true, `commit should succeed; got: ${result.error}`);
  assert.ok(result.sha && /^[0-9a-f]{4,}$/.test(result.sha), 'must return a short SHA');

  // wip.txt MUST still be uncommitted.
  const dirty = await getUncommittedFiles(repo);
  assert.deepStrictEqual(dirty, ['wip.txt'], 'unrelated changes must NOT be swept into the commit');
});

test('gitCommit: returns ok:false (not throw) when nothing is staged', async () => {
  const repo = await makeTmpRepo();
  await writeFile(path.join(repo, 'a.txt'), 'a\n');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

  const result = await gitCommit({ cwd: repo }, 'deps: nothing', []);
  assert.strictEqual(result.ok, false);
  assert.match(result.error ?? '', /nothing to commit/i);
});

test('gitAdd: silently skips files that no longer exist', async () => {
  const repo = await makeTmpRepo();
  // No initial commit needed for this — gitAdd just shouldn't choke on a missing path.
  const ghost = path.join(repo, 'ghost-package-lock.json');
  const staged = await gitAdd({ cwd: repo }, [ghost]);
  assert.deepStrictEqual(staged, [], 'missing files must be silently dropped');
});

// ---------------------------------------------------------------------------
// Commit message formatters
// ---------------------------------------------------------------------------

test('formatPerSuccessMessage: single change → one-line message', () => {
  const msg = formatPerSuccessMessage('deps: ', [
    { name: 'axios', from: '^1.6.0', to: '^1.7.2', workspace: 'root' },
  ]);
  assert.strictEqual(msg, 'deps: bump axios from ^1.6.0 to ^1.7.2');
});

test('formatPerSuccessMessage: workspace tag is appended in parens', () => {
  const msg = formatPerSuccessMessage('deps: ', [
    { name: 'axios', from: '^1.6.0', to: '^1.7.2', workspace: '@org/web' },
  ]);
  assert.strictEqual(msg, 'deps: bump axios from ^1.6.0 to ^1.7.2 (@org/web)');
});

test('formatPerSuccessMessage: linked group → multi-line body', () => {
  const msg = formatPerSuccessMessage('deps: ', [
    { name: 'react', from: '^18.0.0', to: '^19.0.0', workspace: 'root', groupId: 'react-pair' },
    { name: 'react-dom', from: '^18.0.0', to: '^19.0.0', workspace: 'root', groupId: 'react-pair' },
  ]);
  assert.match(msg, /^deps: bump 2 linked packages\n\n- react: \^18\.0\.0 → \^19\.0\.0\n- react-dom: \^18\.0\.0 → \^19\.0\.0$/);
});

test('formatPerTargetMessage: header includes count + workspace', () => {
  const msg = formatPerTargetMessage('deps: ', '@org/web', [
    { name: 'axios', from: '^1.6.0', to: '^1.7.2' },
    { name: 'next', from: '14.0.0', to: '15.0.0' },
  ]);
  const lines = msg.split('\n');
  assert.strictEqual(lines[0], 'deps: 2 upgrades in @org/web');
  assert.strictEqual(lines[1], '');
  assert.strictEqual(lines[2], '- axios: ^1.6.0 → ^1.7.2');
  assert.strictEqual(lines[3], '- next: 14.0.0 → 15.0.0');
});

test('formatPerTargetMessage: root workspace omits the "in <ws>" tail', () => {
  const msg = formatPerTargetMessage('deps: ', 'root', [
    { name: 'axios', from: '^1.6.0', to: '^1.7.2' },
  ]);
  assert.strictEqual(msg.split('\n')[0], 'deps: 1 upgrade');
});

test('formatAllInOneMessage: single target → flat list', () => {
  const msg = formatAllInOneMessage('deps: ', [
    { name: 'axios', from: '^1.6.0', to: '^1.7.2', workspace: 'root' },
    { name: 'next', from: '14.0.0', to: '15.0.0', workspace: 'root' },
  ]);
  assert.strictEqual(
    msg,
    ['deps: 2 upgrades', '', '- axios: ^1.6.0 → ^1.7.2', '- next: 14.0.0 → 15.0.0'].join('\n'),
  );
});

test('formatAllInOneMessage: multiple targets → bracketed sections per workspace', () => {
  const msg = formatAllInOneMessage('deps: ', [
    { name: 'typescript', from: '^5.0.0', to: '^5.4.0', workspace: 'root' },
    { name: 'axios', from: '^1.6.0', to: '^1.7.2', workspace: '@org/web' },
    { name: 'next', from: '14.0.0', to: '15.0.0', workspace: '@org/web' },
  ]);
  assert.match(msg, /^deps: 3 upgrades across 2 targets\n\n\[root\]\n- typescript: /);
  assert.match(msg, /\[@org\/web\]\n- axios: \^1\.6\.0 → \^1\.7\.2\n- next: /);
});

test('lockfileBasenameFor: per-manager defaults', () => {
  assert.strictEqual(lockfileBasenameFor('npm'), 'package-lock.json');
  assert.strictEqual(lockfileBasenameFor('pnpm'), 'pnpm-lock.yaml');
  assert.strictEqual(lockfileBasenameFor('yarn'), 'yarn.lock');
});

// ---------------------------------------------------------------------------
// createGitFlow pre-flight
// ---------------------------------------------------------------------------

test('createGitFlow: disabled config returns a no-op controller', async () => {
  const repo = await makeTmpRepo();
  const setup = await createGitFlow(
    repo,
    { enabled: false, mode: 'per-success', prefix: 'deps: ', sign: false, allowDirty: false },
    true,
    false,
  );
  assert.strictEqual(setup.ok, true);
  assert.strictEqual(setup.controller.enabled, false);
  // Calling onUpgradeApplied / flush* must not throw.
  await setup.controller.onUpgradeApplied?.({});
  await setup.controller.flushAfterTarget('root', 'npm', repo);
  await setup.controller.flushAtEnd('npm', repo);
});

test('createGitFlow: --dry-run silently no-ops even when enabled', async () => {
  const repo = await makeTmpRepo();
  const setup = await createGitFlow(
    repo,
    { enabled: true, mode: 'per-success', prefix: 'deps: ', sign: false, allowDirty: false },
    true,
    true, // dryRun
  );
  assert.strictEqual(setup.ok, true);
  assert.strictEqual(setup.controller.enabled, false, 'dry-run must produce a no-op controller');
});

test('createGitFlow: errors out when not in a git repo', async () => {
  const dir = await makeNonRepo();
  const setup = await createGitFlow(
    dir,
    { enabled: true, mode: 'per-success', prefix: 'deps: ', sign: false, allowDirty: false },
    true,
    false,
  );
  assert.strictEqual(setup.ok, false);
  assert.match(setup.error, /not inside a git working tree/i);
});

test('createGitFlow: refuses to start on a dirty tree', async () => {
  const repo = await makeTmpRepo();
  await writeFile(path.join(repo, 'init.txt'), 'init\n');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

  // Now create dirty state.
  await writeFile(path.join(repo, 'wip.txt'), 'WIP\n');

  const setup = await createGitFlow(
    repo,
    { enabled: true, mode: 'per-success', prefix: 'deps: ', sign: false, allowDirty: false },
    true,
    false,
  );
  assert.strictEqual(setup.ok, false);
  assert.match(setup.error, /working tree is dirty/i);
  assert.match(setup.error, /--git-allow-dirty/i);
});

test('createGitFlow: --git-allow-dirty bypasses the dirty-tree check', async () => {
  const repo = await makeTmpRepo();
  await writeFile(path.join(repo, 'init.txt'), 'init\n');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repo });
  await writeFile(path.join(repo, 'wip.txt'), 'WIP\n'); // dirty

  const setup = await createGitFlow(
    repo,
    { enabled: true, mode: 'per-success', prefix: 'deps: ', sign: false, allowDirty: true },
    true,
    false,
  );
  assert.strictEqual(setup.ok, true);
  assert.strictEqual(setup.controller.enabled, true);
});

// ---------------------------------------------------------------------------
// per-success commit through the controller
// ---------------------------------------------------------------------------

test('createGitFlow: per-success commits land on the branch with the right message', async () => {
  const repo = await makeTmpRepo();
  // Seed the tree: package.json + dummy lockfile, both committed so the working tree starts
  // clean (matches real-world dep-up-surgeon entry conditions).
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', dependencies: { axios: '^1.0.0' } }));
  await writeFile(path.join(repo, 'package-lock.json'), '{}\n');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

  const setup = await createGitFlow(
    repo,
    { enabled: true, mode: 'per-success', prefix: 'deps: ', sign: false, allowDirty: false },
    true,
    false,
  );
  assert.strictEqual(setup.ok, true);
  const c = setup.controller;

  // Simulate: engine bumped axios — package.json AND lockfile changed.
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'x', dependencies: { axios: '^1.7.2' } }));
  await writeFile(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');

  await c.onUpgradeApplied({
    records: [{ name: 'axios', success: true, from: '^1.0.0', to: '^1.7.2' }],
    targetCwd: repo,
    installCwd: repo,
    manager: 'npm',
    workspace: 'root',
  });

  assert.strictEqual(c.commits.length, 1, 'one commit should have been recorded');
  assert.strictEqual(c.commits[0].ok, true, `commit must succeed: ${c.commits[0].error}`);
  assert.match(c.commits[0].message, /^deps: bump axios from \^1\.0\.0 to \^1\.7\.2$/);
  assert.ok(c.commits[0].files.includes('package.json'));
  assert.ok(c.commits[0].files.includes('package-lock.json'));

  // Working tree must be clean (everything committed).
  const dirty = await getUncommittedFiles(repo);
  assert.deepStrictEqual(dirty, []);
});

test('createGitFlow: per-target buffers per workspace and commits on flushAfterTarget', async () => {
  const repo = await makeTmpRepo();
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'root', workspaces: ['packages/*'] }));
  await writeFile(path.join(repo, 'package-lock.json'), '{}\n');
  await writeFile(path.join(repo, 'packages', 'web', 'package.json'), JSON.stringify({ name: '@org/web', dependencies: { axios: '^1.0.0' } }));
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

  const setup = await createGitFlow(
    repo,
    { enabled: true, mode: 'per-target', prefix: 'deps: ', sign: false, allowDirty: false },
    true,
    false,
  );
  const c = setup.controller;

  // Simulate two upgrades against the SAME workspace child.
  await writeFile(path.join(repo, 'packages', 'web', 'package.json'), JSON.stringify({ name: '@org/web', dependencies: { axios: '^1.7.2', next: '15.0.0' } }));
  await writeFile(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');

  await c.onUpgradeApplied({
    records: [{ name: 'axios', success: true, from: '^1.0.0', to: '^1.7.2' }],
    targetCwd: path.join(repo, 'packages', 'web'),
    installCwd: repo,
    manager: 'npm',
    workspace: '@org/web',
  });
  await c.onUpgradeApplied({
    records: [{ name: 'next', success: true, from: '14.0.0', to: '15.0.0' }],
    targetCwd: path.join(repo, 'packages', 'web'),
    installCwd: repo,
    manager: 'npm',
    workspace: '@org/web',
  });

  // Per-target mode buffers — no commits yet.
  assert.strictEqual(c.commits.length, 0);

  await c.flushAfterTarget('@org/web', 'npm', repo);
  assert.strictEqual(c.commits.length, 1, 'flushAfterTarget should produce ONE commit');
  assert.strictEqual(c.commits[0].ok, true, `commit must succeed: ${c.commits[0].error}`);
  assert.match(c.commits[0].message, /^deps: 2 upgrades in @org\/web/);
  assert.match(c.commits[0].message, /- axios: \^1\.0\.0 → \^1\.7\.2/);
  assert.match(c.commits[0].message, /- next: 14\.0\.0 → 15\.0\.0/);
});

test('createGitFlow: all mode commits exactly once at flushAtEnd', async () => {
  const repo = await makeTmpRepo();
  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'root', dependencies: { axios: '^1.0.0' } }));
  await writeFile(path.join(repo, 'package-lock.json'), '{}\n');
  await execa('git', ['add', '.'], { cwd: repo });
  await execa('git', ['commit', '-q', '-m', 'init'], { cwd: repo });

  const setup = await createGitFlow(
    repo,
    { enabled: true, mode: 'all', prefix: 'deps: ', sign: false, allowDirty: false },
    true,
    false,
  );
  const c = setup.controller;

  await writeFile(path.join(repo, 'package.json'), JSON.stringify({ name: 'root', dependencies: { axios: '^1.7.2' } }));
  await writeFile(path.join(repo, 'package-lock.json'), '{"lockfileVersion":3}\n');

  await c.onUpgradeApplied({
    records: [{ name: 'axios', success: true, from: '^1.0.0', to: '^1.7.2' }],
    targetCwd: repo,
    installCwd: repo,
    manager: 'npm',
    workspace: 'root',
  });
  // Per-target flush must NOT commit in 'all' mode (we test that with the count below).
  await c.flushAfterTarget('root', 'npm', repo);
  assert.strictEqual(c.commits.length, 0, 'all mode must not commit on per-target flush');

  await c.flushAtEnd('npm', repo);
  assert.strictEqual(c.commits.length, 1);
  assert.match(c.commits[0].message, /^deps: 1 upgrade/);
});

// ---------------------------------------------------------------------------
// Peer-resolved subject tag + footer (--resolve-peers integration)
// ---------------------------------------------------------------------------

test('formatPerSuccessMessage: resolvedPeer injects [peer-resolved] tag + footer', () => {
  const msg = formatPerSuccessMessage('deps: ', [
    {
      name: 'react',
      from: '^18.0.0',
      to: '^18.3.1',
      workspace: 'root',
      groupId: 'react-pair',
      resolvedPeer: { originalTarget: '^19.0.0', reason: 'peer-range intersection', tuplesExplored: 7 },
    },
    {
      name: 'react-dom',
      from: '^18.0.0',
      to: '^18.3.1',
      workspace: 'root',
      groupId: 'react-pair',
    },
  ]);
  assert.match(msg, /^deps: \[peer-resolved\] bump 2 linked packages/);
  assert.match(msg, /Peer-range resolutions \(kept linked group satisfiable\):/);
  assert.match(msg, /- react: requested \^19\.0\.0, installed \^18\.3\.1/);
});

test('formatPerSuccessMessage: [peer-resolved] comes AFTER [breaking] and BEFORE [security:*]', () => {
  const msg = formatPerSuccessMessage('deps: ', [
    {
      name: 'x',
      from: '^1',
      to: '^2',
      changelog: {
        source: 'github-release',
        body: 'BREAKING CHANGE: rewrote the API',
        breaking: { hasBreaking: true, matchedLines: ['BREAKING CHANGE: rewrote the API'], reasons: ['BREAKING CHANGE'] },
      },
      resolvedPeer: { originalTarget: '^3', reason: 'x', tuplesExplored: 1 },
      security: { severity: 'high', ids: ['CVE-2024-1234'] },
    },
  ]);
  const subject = msg.split('\n')[0];
  assert.match(subject, /^deps: \[breaking\] \[peer-resolved\] \[security:high\] bump x from \^1 to \^2/);
});

test('formatPerTargetMessage: resolvedPeer tag + footer appear together', () => {
  const msg = formatPerTargetMessage('deps: ', 'root', [
    {
      name: 'react',
      from: '^18',
      to: '^18.3.1',
      resolvedPeer: { originalTarget: '^19', reason: 'peer-range intersection', tuplesExplored: 4 },
    },
    { name: 'react-dom', from: '^18', to: '^18.3.1' },
  ]);
  assert.match(msg.split('\n')[0], /^deps: \[peer-resolved\] 2 upgrades/);
  assert.match(msg, /Peer-range resolutions \(kept linked group satisfiable\):/);
  assert.match(msg, /- react: requested \^19, installed \^18\.3\.1/);
});

test('formatPerSuccessMessage: no resolvedPeer → no tag, no footer', () => {
  const msg = formatPerSuccessMessage('deps: ', [
    { name: 'axios', from: '^1.6.0', to: '^1.7.2', workspace: 'root' },
  ]);
  assert.ok(!/peer-resolved/.test(msg), 'unexpected peer-resolved tag');
  assert.ok(!/Peer-range resolutions/.test(msg), 'unexpected peer-resolution footer');
});
