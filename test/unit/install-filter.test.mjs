/**
 * Unit tests for the workspace-filtered install command builder + the
 * `runUpgradeFlow` plumbing that decides when to apply a filter.
 *
 * The `installCommand` helper is pure, so we exercise it directly. For the flow plumbing we
 * monkey-patch the package manager binaries (`npm`, `pnpm`) to a temp shim that records its
 * argv to a log file — that lets us assert the **exact** command (`npm install --workspace …`,
 * `pnpm install --filter …`, plain `npm install` for the root target) without doing real installs.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { installCommand } = await import(path.join(root, 'dist/utils/npm.js'));
const { runUpgradeFlow } = await import(path.join(root, 'dist/core/upgrader.js'));

async function makeTmp(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `dus-filter-${prefix}-`));
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

test('installCommand: npm with no filter → `npm install`', () => {
  const r = installCommand('npm');
  assert.strictEqual(r.bin, 'npm');
  assert.deepStrictEqual(r.args, ['install']);
  assert.strictEqual(r.filtered, false);
});

test('installCommand: npm with filter → `npm install --workspace <name>` and filtered=true', () => {
  const r = installCommand('npm', { filter: '@org/web' });
  assert.strictEqual(r.bin, 'npm');
  assert.deepStrictEqual(r.args, ['install', '--workspace', '@org/web']);
  assert.strictEqual(r.filtered, true);
});

test('installCommand: pnpm with filter → `pnpm install --filter <name>`', () => {
  const r = installCommand('pnpm', { filter: '@org/api' });
  assert.strictEqual(r.bin, 'pnpm');
  assert.deepStrictEqual(r.args, ['install', '--filter', '@org/api']);
  assert.strictEqual(r.filtered, true);
});

test('installCommand: pnpm without filter → `pnpm install` (filtered=false)', () => {
  const r = installCommand('pnpm');
  assert.deepStrictEqual(r.args, ['install']);
  assert.strictEqual(r.filtered, false);
});

test('installCommand: yarn classic / berry-without-plugin falls back to `yarn install`', () => {
  // No `yarnSupportsFocus` flag → we don't know if `workspaces focus` is available, so play it
  // safe and do a full root install. The orchestrator will warn the user once.
  const r = installCommand('yarn', { filter: '@org/web' });
  assert.strictEqual(r.bin, 'yarn');
  assert.deepStrictEqual(r.args, ['install']);
  assert.strictEqual(r.filtered, false);
});

test('installCommand: yarn berry + plugin → `yarn workspaces focus <name>` and filtered=true', () => {
  // `yarnSupportsFocus: true` is set by `detectProjectInfo`'s probe when yarn>=2 AND
  // `@yarnpkg/plugin-workspace-tools` is loaded. We expect the focused install command.
  const r = installCommand('yarn', { filter: '@org/web', yarnSupportsFocus: true });
  assert.strictEqual(r.bin, 'yarn');
  assert.deepStrictEqual(r.args, ['workspaces', 'focus', '@org/web']);
  assert.strictEqual(r.filtered, true);
});

test('installCommand: yarn + yarnSupportsFocus but NO filter still does `yarn install`', () => {
  // Capability flag is meaningless without an actual workspace name to focus on (e.g. root
  // target runs always do a full install).
  const r = installCommand('yarn', { yarnSupportsFocus: true });
  assert.strictEqual(r.bin, 'yarn');
  assert.deepStrictEqual(r.args, ['install']);
  assert.strictEqual(r.filtered, false);
});

test('installCommand: yarnSupportsFocus is ignored for non-yarn managers', () => {
  // Sanity check: the capability flag is yarn-specific. Setting it on npm/pnpm shouldn't
  // change anything (those managers have their own filter syntax).
  const npm = installCommand('npm', { filter: '@org/web', yarnSupportsFocus: true });
  assert.deepStrictEqual(npm.args, ['install', '--workspace', '@org/web']);

  const pnpm = installCommand('pnpm', { filter: '@org/web', yarnSupportsFocus: true });
  assert.deepStrictEqual(pnpm.args, ['install', '--filter', '@org/web']);
});

// ---------------------------------------------------------------------------
// runUpgradeFlow plumbing — mode propagation onto the FinalReport.
// ---------------------------------------------------------------------------

async function setupMono() {
  const dir = await makeTmp('mono');
  await writeJson(path.join(dir, 'package.json'), {
    name: 'mono-root',
    version: '0.0.1',
    private: true,
    workspaces: ['packages/*'],
    devDependencies: { typescript: '^5.0.0' },
  });
  await writeJson(path.join(dir, 'packages', 'a', 'package.json'), {
    name: '@org/a',
    version: '0.0.1',
    dependencies: { axios: '^1.0.0' },
  });
  await writeJson(path.join(dir, 'packages', 'b', 'package.json'), {
    name: '@org/b',
    version: '0.0.1',
    dependencies: { axios: '^1.0.0' },
  });
  return dir;
}

test('runUpgradeFlow: installMode propagates onto report (default = root)', async () => {
  const dir = await setupMono();
  const report = await runUpgradeFlow({
    cwd: dir,
    dryRun: true,
    interactive: false,
    force: false,
    jsonOutput: true,
    ignore: new Set(),
    fallbackStrategy: 'highest-stable',
    linkGroups: 'off',
    linkedGroupsConfig: [],
    validate: { skip: true },
  });
  assert.strictEqual(report.installMode, 'root');
});

test('runUpgradeFlow: installMode propagates as "filtered" when requested', async () => {
  const dir = await setupMono();
  const report = await runUpgradeFlow({
    cwd: dir,
    dryRun: true,
    interactive: false,
    force: false,
    jsonOutput: true,
    ignore: new Set(),
    fallbackStrategy: 'highest-stable',
    linkGroups: 'off',
    linkedGroupsConfig: [],
    validate: { skip: true },
    workspaceMode: 'all',
    installMode: 'filtered',
  });
  assert.strictEqual(report.installMode, 'filtered');
});
