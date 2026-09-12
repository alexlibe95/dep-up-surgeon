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
const { detectProjectInfo, parsePackageManagerOption, isPackageManager } = await import(
  path.join(root, 'dist/core/workspaces.js')
);

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

test('detectProjectInfo: bun.lock selects bun', async () => {
  const dir = await makeTmp('lock-bun');
  await writeJson(path.join(dir, 'package.json'), { name: 'lock-bun' });
  await fs.writeFile(path.join(dir, 'bun.lock'), '{ "lockfileVersion": 1, "packages": {} }\n');

  const info = await detectProjectInfo(dir);
  assert.strictEqual(info.manager, 'bun');
  assert.strictEqual(info.managerSource, 'lockfile');
  assert.strictEqual(info.lockfile, 'bun.lock');
});

test('detectProjectInfo: parses packageManager field for bun', async () => {
  const dir = await makeTmp('pm-bun');
  await writeJson(path.join(dir, 'package.json'), {
    name: 'pm-bun',
    packageManager: 'bun@1.2.0',
  });

  const info = await detectProjectInfo(dir);
  assert.strictEqual(info.manager, 'bun');
  assert.strictEqual(info.managerVersion, '1.2.0');
  assert.strictEqual(info.managerSource, 'package.json:packageManager');
});

test('detectProjectInfo: bun.lockb selects bun when bun.lock is absent', async () => {
  const dir = await makeTmp('lock-bunb');
  await writeJson(path.join(dir, 'package.json'), { name: 'lock-bunb' });
  await fs.writeFile(path.join(dir, 'bun.lockb'), Buffer.from([0, 1, 2, 3]));

  const info = await detectProjectInfo(dir);
  assert.strictEqual(info.manager, 'bun');
  assert.strictEqual(info.managerSource, 'lockfile');
  assert.strictEqual(info.lockfile, 'bun.lockb');
});

test('parsePackageManagerOption: known managers vs auto fallback', () => {
  assert.strictEqual(parsePackageManagerOption(undefined), 'auto');
  assert.strictEqual(parsePackageManagerOption('auto'), 'auto');
  assert.strictEqual(parsePackageManagerOption('npm'), 'npm');
  assert.strictEqual(parsePackageManagerOption('pnpm'), 'pnpm');
  assert.strictEqual(parsePackageManagerOption('yarn'), 'yarn');
  assert.strictEqual(parsePackageManagerOption('bun'), 'bun');
  assert.strictEqual(parsePackageManagerOption('BUN'), 'bun');
  assert.strictEqual(parsePackageManagerOption('deno'), 'auto');
  assert.strictEqual(isPackageManager('bun'), true);
  assert.strictEqual(isPackageManager('deno'), false);
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
// `detectProjectInfo` shells out to `yarn --version` whenever the active manager is yarn, plus
// `yarn workspaces focus --help` when the project has workspaces. To make these tests deterministic we
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

test('detectProjectInfo: yarn project WITHOUT workspaces still probes the yarn major', async () => {
  // The major drives more than filtered installs (dedupe support, lockfile handling, audit
  // command), so a single-package Berry project must not be treated like classic. Only the
  // focus probe is skipped — `workspaces focus` means nothing without workspaces.
  const dir = await makeTmp('yarn-single');
  await writeJson(path.join(dir, 'package.json'), { name: 'single', version: '0.0.1' });
  await fs.writeFile(path.join(dir, 'yarn.lock'), '# v1\n');

  const info = await withYarnShim(
    `#!/bin/sh
case "$1" in
  --version) echo "4.4.0" ;;
  *) exit 1 ;;
esac
`,
    () => detectProjectInfo(dir),
  );
  assert.strictEqual(info.manager, 'yarn');
  assert.strictEqual(info.hasWorkspaces, false);
  assert.strictEqual(info.yarnMajorVersion, 4);
  assert.strictEqual(info.yarnSupportsFocus, undefined);
});

test('detectProjectInfo: yarn binary missing from PATH → capability fields stay undefined', async () => {
  // Worst-case-but-survivable scenario: detection runs in an environment where yarn isn't on
  // PATH. The probe must not throw, and must leave the capability fields undefined so the
  // caller falls back to a root install with the appropriate warning.
  const wsDir = await makeYarnWorkspaceProject('yarn-missing');
  const singleDir = await makeTmp('yarn-missing-single');
  await writeJson(path.join(singleDir, 'package.json'), { name: 'single' });
  await fs.writeFile(path.join(singleDir, 'yarn.lock'), '# v1\n');
  const originalPath = process.env.PATH;
  // Tmp directory containing nothing — yarn should resolve to "command not found".
  const emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-empty-path-'));
  process.env.PATH = emptyDir;
  try {
    for (const dir of [wsDir, singleDir]) {
      const info = await detectProjectInfo(dir);
      assert.strictEqual(info.manager, 'yarn');
      assert.strictEqual(info.yarnMajorVersion, undefined);
      assert.strictEqual(info.yarnSupportsFocus, undefined);
    }
  } finally {
    process.env.PATH = originalPath;
  }
});

// ---------------------------------------------------------------------------
// Manager resolution: 'auto' override, devEngines.packageManager, npm-shrinkwrap.json
// ---------------------------------------------------------------------------

test("detectProjectInfo: pnpm-workspace.yaml selects pnpm for both undefined and 'auto' override", async () => {
  // The CLI always passes 'auto'; doctor passes nothing. Both must resolve the same manager.
  const dir = await makeTmp('pnpm-ws-auto');
  await writeJson(path.join(dir, 'package.json'), { name: 'root' });
  await fs.writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');

  for (const override of [undefined, 'auto']) {
    const info = await detectProjectInfo(dir, override);
    assert.strictEqual(info.manager, 'pnpm', `override=${override}`);
    assert.strictEqual(info.managerSource, 'pnpm-workspace', `override=${override}`);
  }
});

test('detectProjectInfo: devEngines.packageManager object beats lockfiles', async () => {
  const dir = await makeTmp('dev-engines');
  await writeJson(path.join(dir, 'package.json'), {
    name: 'dev-engines',
    devEngines: { packageManager: { name: 'pnpm', version: '^10.0.0', onFail: 'error' } },
  });
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{}');

  const info = await detectProjectInfo(dir, 'auto');
  assert.strictEqual(info.manager, 'pnpm');
  assert.strictEqual(info.managerVersion, '^10.0.0');
  assert.strictEqual(info.managerSource, 'package.json:packageManager');
});

test('detectProjectInfo: devEngines.packageManager array uses the first entry; packageManager field wins', async () => {
  const dir = await makeTmp('dev-engines-arr');
  await writeJson(path.join(dir, 'package.json'), {
    name: 'dev-engines-arr',
    devEngines: { packageManager: [{ name: 'bun' }, { name: 'npm' }] },
  });
  const info = await detectProjectInfo(dir);
  assert.strictEqual(info.manager, 'bun');
  assert.strictEqual(info.managerVersion, undefined);
  assert.strictEqual(info.managerSource, 'package.json:packageManager');

  await writeJson(path.join(dir, 'package.json'), {
    name: 'dev-engines-arr',
    packageManager: 'npm@11.0.0',
    devEngines: { packageManager: [{ name: 'bun' }] },
  });
  const withField = await detectProjectInfo(dir);
  assert.strictEqual(withField.manager, 'npm');
  assert.strictEqual(withField.managerVersion, '11.0.0');
});

test('detectProjectInfo: npm-shrinkwrap.json is an npm lockfile; lockfile precedence is kept', async () => {
  const dir = await makeTmp('shrinkwrap');
  await writeJson(path.join(dir, 'package.json'), { name: 'shrinkwrap' });
  await fs.writeFile(path.join(dir, 'npm-shrinkwrap.json'), '{"lockfileVersion":3,"packages":{}}');
  await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
  // Without the lockfile signal the workspace file would infer pnpm.
  await fs.writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n');

  const info = await detectProjectInfo(dir, 'auto');
  assert.strictEqual(info.manager, 'npm');
  assert.strictEqual(info.managerSource, 'lockfile');
  assert.strictEqual(info.lockfileName, 'npm-shrinkwrap.json');

  await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  const withPnpmLock = await detectProjectInfo(dir);
  assert.strictEqual(withPnpmLock.manager, 'pnpm');
  assert.strictEqual(withPnpmLock.lockfile, 'pnpm-lock.yaml');
  assert.strictEqual(withPnpmLock.lockfileName, 'pnpm-lock.yaml');
});

// ---------------------------------------------------------------------------
// Workspace discovery: glob shapes, negations, pnpm-workspace.yaml parsing
// ---------------------------------------------------------------------------

async function writeMember(dir, rel, name) {
  fssync.mkdirSync(path.join(dir, rel), { recursive: true });
  await writeJson(path.join(dir, rel, 'package.json'), { name });
}

function memberNames(info) {
  return info.workspaceMembers.map((m) => m.name).sort();
}

test('detectProjectInfo: negated globs exclude matching packages', async () => {
  const dir = await makeTmp('ws-negate');
  await writeJson(path.join(dir, 'package.json'), { name: 'root' });
  await fs.writeFile(
    path.join(dir, 'pnpm-workspace.yaml'),
    "packages:\n  - 'packages/**'\n  - '!**/test/**'\n",
  );
  await writeMember(dir, 'packages/core', '@org/core');
  await writeMember(dir, 'packages/core/test/fixtures/app', 'fixture-app');
  await writeMember(dir, 'packages/tools/test', 'test-helpers');

  const info = await detectProjectInfo(dir);
  assert.deepStrictEqual(memberNames(info), ['@org/core']);
  assert.deepStrictEqual(info.workspaceGlobs, ['packages/**', '!**/test/**']);
});

test("detectProjectInfo: '.' in workspaces does not add the root as a member", async () => {
  const dir = await makeTmp('ws-dot');
  await writeJson(path.join(dir, 'package.json'), { name: 'root', workspaces: ['.', './packages/*'] });
  await writeMember(dir, 'packages/a', 'a');

  const info = await detectProjectInfo(dir);
  assert.deepStrictEqual(memberNames(info), ['a']);
  assert.ok(!info.workspacePackageNames.has('root'));
});

test('detectProjectInfo: pnpm-workspace.yaml flow sequences and column-0 comments are parsed', async () => {
  const dir = await makeTmp('ws-yaml-shapes');
  await writeJson(path.join(dir, 'package.json'), { name: 'root' });
  await writeMember(dir, 'packages/a', 'a');
  await writeMember(dir, 'apps/web', 'web');

  await fs.writeFile(path.join(dir, 'pnpm-workspace.yaml'), "packages: ['packages/*', \"apps/*\"]\n");
  assert.deepStrictEqual(memberNames(await detectProjectInfo(dir)), ['a', 'web']);

  await fs.writeFile(
    path.join(dir, 'pnpm-workspace.yaml'),
    ['packages:', '  - packages/*', '# deployed separately, still workspaces', '  - apps/*', ''].join('\n'),
  );
  assert.deepStrictEqual(memberNames(await detectProjectInfo(dir)), ['a', 'web']);
});

test('detectProjectInfo: prefix/suffix wildcards and wildcards in middle segments expand', async () => {
  const dir = await makeTmp('ws-wildcards');
  await writeJson(path.join(dir, 'package.json'), {
    name: 'root',
    workspaces: { packages: ['plugins/eslint-plugin-*', 'apps/*/packages/*', 'libs/{ui,api}'] },
  });
  await writeMember(dir, 'plugins/eslint-plugin-foo', 'eslint-plugin-foo');
  await writeMember(dir, 'plugins/prettier-plugin-bar', 'prettier-plugin-bar');
  await writeMember(dir, 'apps/site/packages/ui', '@site/ui');
  await writeMember(dir, 'apps/admin/packages/api', '@admin/api');
  await writeMember(dir, 'apps/admin', 'admin-app');
  await writeMember(dir, 'libs/ui', '@libs/ui');
  await writeMember(dir, 'libs/legacy', '@libs/legacy');

  const info = await detectProjectInfo(dir);
  assert.deepStrictEqual(memberNames(info), ['@admin/api', '@libs/ui', '@site/ui', 'eslint-plugin-foo']);
});

test('detectProjectInfo: packages/** finds nested packages but skips node_modules', async () => {
  const dir = await makeTmp('ws-globstar');
  await writeJson(path.join(dir, 'package.json'), { name: 'root', workspaces: ['packages/**'] });
  await writeMember(dir, 'packages/a', 'a');
  await writeMember(dir, 'packages/group/b', 'b');
  await writeMember(dir, 'packages/a/node_modules/dep', 'dep');
  await writeMember(dir, 'node_modules/other', 'other');

  const info = await detectProjectInfo(dir);
  assert.deepStrictEqual(memberNames(info), ['a', 'b']);
});

// ---------------------------------------------------------------------------
// Isolated lockfiles
// ---------------------------------------------------------------------------

async function makeMembersWithLockfiles(dir, lockfile, contents) {
  for (const name of ['a', 'b']) {
    await writeMember(dir, `packages/${name}`, `@org/${name}`);
    await fs.writeFile(path.join(dir, 'packages', name, lockfile), contents);
  }
}

test('detectProjectInfo: root `workspaces` + stale member lockfiles is NOT isolated (npm, bun)', async () => {
  // npm/yarn/bun resolve the workspace root from a member dir, so "per-member" installs would
  // all hit the root lockfile + node_modules concurrently.
  const cases = [
    ['npm', 'package-lock.json', '{"lockfileVersion":3,"packages":{}}'],
    ['bun', 'bun.lock', '{ "lockfileVersion": 1, "packages": {} }\n'],
  ];
  for (const [manager, lockfile, contents] of cases) {
    const dir = await makeTmp(`isol-root-ws-${manager}`);
    await writeJson(path.join(dir, 'package.json'), { name: 'mono', private: true, workspaces: ['packages/*'] });
    await fs.writeFile(path.join(dir, lockfile), contents);
    await makeMembersWithLockfiles(dir, lockfile, contents);

    const info = await detectProjectInfo(dir, 'auto');
    assert.strictEqual(info.manager, manager);
    assert.strictEqual(info.workspaceMembers.length, 2);
    assert.ok(!info.isolatedLockfiles, `${manager}: must not flag isolated lockfiles`);
    assert.strictEqual(info.isolatedLockfilesSource, undefined);
  }
});

test('detectProjectInfo: pnpm-workspace.yaml + stale member pnpm-lock.yaml files is NOT isolated', async () => {
  // pnpm also resolves the workspace root (via pnpm-workspace.yaml) and uses the shared lockfile.
  const dir = await makeTmp('isol-pnpm-shared');
  await writeJson(path.join(dir, 'package.json'), { name: 'mono', private: true });
  await fs.writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
  await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await makeMembersWithLockfiles(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n');

  const info = await detectProjectInfo(dir, 'auto');
  assert.strictEqual(info.manager, 'pnpm');
  assert.ok(!info.isolatedLockfiles);
});

test('detectProjectInfo: pnpm-workspace.yaml sharedWorkspaceLockfile: false → isolatedLockfiles', async () => {
  const dir = await makeTmp('isol-pnpm-yaml');
  await writeJson(path.join(dir, 'package.json'), { name: 'mono', private: true });
  await fs.writeFile(
    path.join(dir, 'pnpm-workspace.yaml'),
    'packages:\n  - packages/*\nsharedWorkspaceLockfile: false\n',
  );
  await writeMember(dir, 'packages/a', '@org/a');

  const info = await detectProjectInfo(dir, 'auto');
  assert.strictEqual(info.manager, 'pnpm');
  assert.strictEqual(info.isolatedLockfiles, true);
  // Reported under the existing pnpm-setting source so the report type stays unchanged.
  assert.strictEqual(info.isolatedLockfilesSource, 'pnpm-npmrc');
});

test('detectProjectInfo: pnpm without pnpm-workspace.yaml + per-member lockfiles stays isolated', async () => {
  // pnpm ignores package.json `workspaces`, so each member really is an independent project.
  const dir = await makeTmp('isol-pnpm-independent');
  await writeJson(path.join(dir, 'package.json'), { name: 'mono', private: true, workspaces: ['packages/*'] });
  await fs.writeFile(path.join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  await makeMembersWithLockfiles(dir, 'pnpm-lock.yaml', 'lockfileVersion: 9.0\n');

  const info = await detectProjectInfo(dir, 'auto');
  assert.strictEqual(info.manager, 'pnpm');
  assert.strictEqual(info.isolatedLockfiles, true);
  assert.strictEqual(info.isolatedLockfilesSource, 'per-workspace-lockfiles');
});
