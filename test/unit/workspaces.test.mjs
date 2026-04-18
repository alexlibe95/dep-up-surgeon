/**
 * Unit tests for workspace + package-manager detection. No network. Runs after `npm run build`.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import fssync from 'node:fs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { detectProjectInfo } = await import(path.join(root, 'dist/core/workspaces.js'));

async function makeTmp(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `dus-ws-${prefix}-`));
}

async function writeJson(file, data) {
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

test('detectProjectInfo: defaults to npm with no workspaces or lockfile', async () => {
  const dir = await makeTmp('plain');
  await writeJson(path.join(dir, 'package.json'), { name: 'plain', version: '0.0.1' });

  const info = await detectProjectInfo(dir);
  assert.strictEqual(info.manager, 'npm');
  assert.strictEqual(info.managerSource, 'default');
  assert.strictEqual(info.hasWorkspaces, false);
  assert.deepStrictEqual([...info.workspacePackageNames], []);
});

test('detectProjectInfo: parses packageManager field for pnpm', async () => {
  const dir = await makeTmp('pm-pnpm');
  await writeJson(path.join(dir, 'package.json'), {
    name: 'pm-pnpm',
    packageManager: 'pnpm@9.10.0',
  });

  const info = await detectProjectInfo(dir);
  assert.strictEqual(info.manager, 'pnpm');
  assert.strictEqual(info.managerVersion, '9.10.0');
  assert.strictEqual(info.managerSource, 'package.json:packageManager');
});

test('detectProjectInfo: pnpm-lock.yaml selects pnpm', async () => {
  const dir = await makeTmp('lock-pnpm');
  await writeJson(path.join(dir, 'package.json'), { name: 'lock-pnpm' });
  await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');

  const info = await detectProjectInfo(dir);
  assert.strictEqual(info.manager, 'pnpm');
  assert.strictEqual(info.managerSource, 'lockfile');
  assert.strictEqual(info.lockfile, 'pnpm-lock.yaml');
});

test('detectProjectInfo: yarn.lock selects yarn', async () => {
  const dir = await makeTmp('lock-yarn');
  await writeJson(path.join(dir, 'package.json'), { name: 'lock-yarn' });
  await fs.writeFile(path.join(dir, 'yarn.lock'), '# yarn lockfile v1\n');

  const info = await detectProjectInfo(dir);
  assert.strictEqual(info.manager, 'yarn');
  assert.strictEqual(info.lockfile, 'yarn.lock');
});

test('detectProjectInfo: cli override beats packageManager + lockfile', async () => {
  const dir = await makeTmp('cli-override');
  await writeJson(path.join(dir, 'package.json'), {
    name: 'cli',
    packageManager: 'pnpm@9.0.0',
  });
  await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');

  const info = await detectProjectInfo(dir, 'yarn');
  assert.strictEqual(info.manager, 'yarn');
  assert.strictEqual(info.managerSource, 'cli');
});

test('detectProjectInfo: expands npm-style workspaces and lists member names', async () => {
  const dir = await makeTmp('npm-ws');
  await writeJson(path.join(dir, 'package.json'), {
    name: 'root',
    private: true,
    workspaces: ['packages/*', 'apps/*'],
  });

  fssync.mkdirSync(path.join(dir, 'packages', 'lib-a'), { recursive: true });
  fssync.mkdirSync(path.join(dir, 'packages', 'lib-b'), { recursive: true });
  fssync.mkdirSync(path.join(dir, 'apps', 'web'), { recursive: true });
  fssync.mkdirSync(path.join(dir, 'apps', 'not-a-pkg'), { recursive: true });

  await writeJson(path.join(dir, 'packages', 'lib-a', 'package.json'), { name: '@scope/lib-a' });
  await writeJson(path.join(dir, 'packages', 'lib-b', 'package.json'), { name: '@scope/lib-b' });
  await writeJson(path.join(dir, 'apps', 'web', 'package.json'), { name: 'web' });

  const info = await detectProjectInfo(dir);
  assert.strictEqual(info.hasWorkspaces, true);
  const names = [...info.workspacePackageNames].sort();
  assert.deepStrictEqual(names, ['@scope/lib-a', '@scope/lib-b', 'web']);
});

test('detectProjectInfo: { packages: [...] } workspaces variant', async () => {
  const dir = await makeTmp('ws-object');
  await writeJson(path.join(dir, 'package.json'), {
    name: 'root',
    workspaces: { packages: ['libs/*'] },
  });

  fssync.mkdirSync(path.join(dir, 'libs', 'one'), { recursive: true });
  await writeJson(path.join(dir, 'libs', 'one', 'package.json'), { name: 'one' });

  const info = await detectProjectInfo(dir);
  assert.strictEqual(info.hasWorkspaces, true);
  assert.deepStrictEqual([...info.workspacePackageNames], ['one']);
});

test('detectProjectInfo: pnpm-workspace.yaml is parsed and forces pnpm', async () => {
  const dir = await makeTmp('pnpm-ws');
  await writeJson(path.join(dir, 'package.json'), { name: 'root' });
  await fs.writeFile(
    path.join(dir, 'pnpm-workspace.yaml'),
    'packages:\n  - "packages/*"\n  - "apps/*"\n',
  );

  fssync.mkdirSync(path.join(dir, 'packages', 'core'), { recursive: true });
  await writeJson(path.join(dir, 'packages', 'core', 'package.json'), { name: '@org/core' });

  const info = await detectProjectInfo(dir);
  assert.strictEqual(info.manager, 'pnpm');
  assert.strictEqual(info.managerSource, 'pnpm-workspace');
  assert.deepStrictEqual([...info.workspacePackageNames], ['@org/core']);
});

// ---------------------------------------------------------------------------
// Yarn capability probe (yarnMajorVersion + yarnSupportsFocus)
// ---------------------------------------------------------------------------
//
// `detectProjectInfo` shells out to `yarn --version` and `yarn workspaces focus --help` when the
// active manager is yarn AND the project has workspaces. To make these tests deterministic we
// install a temp `yarn` shim into a directory we then prepend onto PATH; each test gets its own
// shim that simulates the version + plugin combo we want to assert.

async function withYarnShim(scriptBody, fn) {
  const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-yarn-shim-'));
  const shimPath = path.join(shimDir, 'yarn');
  await fs.writeFile(shimPath, scriptBody);
  await fs.chmod(shimPath, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${originalPath ?? ''}`;
  try {
    return await fn();
  } finally {
    process.env.PATH = originalPath;
  }
}

async function makeYarnWorkspaceProject(prefix) {
  const dir = await makeTmp(prefix);
  await writeJson(path.join(dir, 'package.json'), {
    name: 'yarn-root',
    private: true,
    workspaces: ['packages/*'],
  });
  fssync.mkdirSync(path.join(dir, 'packages', 'web'), { recursive: true });
  await writeJson(path.join(dir, 'packages', 'web', 'package.json'), { name: '@y/web' });
  // Touching yarn.lock so the manager auto-detects to yarn.
  await fs.writeFile(path.join(dir, 'yarn.lock'), '# yarn lockfile v1\n');
  return dir;
}

test('detectProjectInfo: yarn classic (1.x) → yarnMajorVersion=1, yarnSupportsFocus=false', async () => {
  const dir = await makeYarnWorkspaceProject('yarn-classic');
  const info = await withYarnShim(
    `#!/bin/sh
case "$1" in
  --version) echo "1.22.22" ;;
  workspaces) echo "Usage: yarn workspaces <command>"; exit 1 ;;
  *) exit 0 ;;
esac
`,
    () => detectProjectInfo(dir),
  );
  assert.strictEqual(info.manager, 'yarn');
  assert.strictEqual(info.yarnMajorVersion, 1);
  assert.strictEqual(info.yarnSupportsFocus, false, 'yarn classic must not advertise focus');
});

test('detectProjectInfo: yarn berry + plugin → yarnMajorVersion=4, yarnSupportsFocus=true', async () => {
  const dir = await makeYarnWorkspaceProject('yarn-berry-plugin');
  const info = await withYarnShim(
    `#!/bin/sh
case "$1" in
  --version) echo "4.4.0" ;;
  workspaces)
    if [ "$2" = "focus" ] && [ "$3" = "--help" ]; then
      echo "yarn workspaces focus [--all] [--production] [...workspaces]"
      exit 0
    fi
    exit 1
    ;;
  *) exit 0 ;;
esac
`,
    () => detectProjectInfo(dir),
  );
  assert.strictEqual(info.manager, 'yarn');
  assert.strictEqual(info.yarnMajorVersion, 4);
  assert.strictEqual(info.yarnSupportsFocus, true, 'berry + plugin must advertise focus');
});

test('detectProjectInfo: yarn berry without plugin → yarnSupportsFocus=false', async () => {
  const dir = await makeYarnWorkspaceProject('yarn-berry-no-plugin');
  const info = await withYarnShim(
    `#!/bin/sh
case "$1" in
  --version) echo "3.6.4" ;;
  workspaces)
    # Simulate yarn berry without the workspace-tools plugin: focus subcommand is unknown.
    echo "Usage Error: Couldn't find a script named \\"focus\\"" >&2
    exit 1
    ;;
  *) exit 0 ;;
esac
`,
    () => detectProjectInfo(dir),
  );
  assert.strictEqual(info.manager, 'yarn');
  assert.strictEqual(info.yarnMajorVersion, 3);
  assert.strictEqual(info.yarnSupportsFocus, false, 'berry without plugin must NOT advertise focus');
});

test('detectProjectInfo: yarn capability fields are absent when manager is npm', async () => {
  const dir = await makeTmp('npm-ws');
  await writeJson(path.join(dir, 'package.json'), {
    name: 'npm-root',
    workspaces: ['packages/*'],
  });
  fssync.mkdirSync(path.join(dir, 'packages', 'a'), { recursive: true });
  await writeJson(path.join(dir, 'packages', 'a', 'package.json'), { name: 'a' });
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');

  const info = await detectProjectInfo(dir);
  assert.strictEqual(info.manager, 'npm');
  assert.strictEqual(info.yarnMajorVersion, undefined, 'no probe when manager is npm');
  assert.strictEqual(info.yarnSupportsFocus, undefined, 'no probe when manager is npm');
});

test('detectProjectInfo: yarn project WITHOUT workspaces does not probe', async () => {
  // No workspace globs → filtered installs are meaningless, so the probe is skipped (faster
  // startup for single-package yarn projects).
  const dir = await makeTmp('yarn-single');
  await writeJson(path.join(dir, 'package.json'), { name: 'single', version: '0.0.1' });
  await fs.writeFile(path.join(dir, 'yarn.lock'), '# v1\n');

  const info = await detectProjectInfo(dir);
  assert.strictEqual(info.manager, 'yarn');
  assert.strictEqual(info.hasWorkspaces, false);
  assert.strictEqual(info.yarnMajorVersion, undefined);
  assert.strictEqual(info.yarnSupportsFocus, undefined);
});

test('detectProjectInfo: yarn binary missing from PATH → capability fields stay undefined', async () => {
  // Worst-case-but-survivable scenario: detection runs in an environment where yarn isn't on
  // PATH. The probe must not throw, and must leave the capability fields undefined so the
  // caller falls back to a root install with the appropriate warning.
  const dir = await makeYarnWorkspaceProject('yarn-missing');
  const originalPath = process.env.PATH;
  // Tmp directory containing nothing — yarn should resolve to "command not found".
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-empty-path-'));
  process.env.PATH = emptyDir;
  try {
    const info = await detectProjectInfo(dir);
    assert.strictEqual(info.manager, 'yarn');
    assert.strictEqual(info.yarnMajorVersion, undefined);
    assert.strictEqual(info.yarnSupportsFocus, undefined);
  } finally {
    process.env.PATH = originalPath;
  }
});
