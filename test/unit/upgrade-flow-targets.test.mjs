/**
 * Unit tests for the workspace target resolution exposed via `runUpgradeFlow`.
 *
 * We exercise the orchestrator's target selection + workspace tagging without doing real network
 * installs by passing `dryRun: true` and `validate: { skip: true }`. That short-circuits install
 * and validation but still walks every `package.json` (root + members) and tags rows by
 * workspace label.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { runUpgradeFlow } = await import(path.join(root, 'dist/core/upgrader.js'));

async function makeTmp(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `dus-flow-${prefix}-`));
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function setupMonorepo() {
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

test('runUpgradeFlow: root-only mode reports a single target', async () => {
  const dir = await setupMonorepo();
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
  assert.ok(report.targets);
  assert.strictEqual(report.targets.length, 1);
  assert.strictEqual(report.targets[0].label, 'root');
  assert.strictEqual(report.targets[0].cwd, dir);
});

test('runUpgradeFlow: --workspaces traverses root + every member with prefixed group ids', async () => {
  const dir = await setupMonorepo();
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
  });
  const labels = report.targets.map((t) => t.label).sort();
  assert.deepStrictEqual(labels, ['@org/a', '@org/b', 'root']);
  // Every group plan id from a child target is namespaced with the workspace label.
  const childGroups = (report.groupPlan ?? []).filter((g) => g.id.startsWith('@org/'));
  assert.ok(childGroups.length > 0, 'expected at least one workspace-prefixed group plan id');
});

test('runUpgradeFlow: --workspaces-only skips the root target', async () => {
  const dir = await setupMonorepo();
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
    workspaceMode: 'workspaces-only',
  });
  const labels = report.targets.map((t) => t.label).sort();
  assert.deepStrictEqual(labels, ['@org/a', '@org/b']);
});

test('runUpgradeFlow: --workspace explicit name list filters and validates names', async () => {
  const dir = await setupMonorepo();
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
    workspaceMode: ['@org/a', 'root'],
  });
  const labels = report.targets.map((t) => t.label).sort();
  assert.deepStrictEqual(labels, ['@org/a', 'root']);

  await assert.rejects(
    runUpgradeFlow({
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
      workspaceMode: ['@org/missing'],
    }),
    /unknown workspace member/i,
  );
});
