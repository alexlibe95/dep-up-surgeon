/**
 * Unit tests for `runUndo` — the reverse pass that `dep-up-surgeon undo` wires up.
 *
 * Coverage:
 *   - Happy path: dep ranges revert to `from`; override pins get dropped; install runs once.
 *   - Drift protection: when the current `package.json` doesn't match the recorded `to`, we
 *     skip the row with `reason: 'drifted'` — the user's later edit is preserved.
 *   - Restore-previous: when an override REPLACED an earlier pin, undo reinstates the
 *     earlier pin instead of deleting outright.
 *   - Parent-scoped override chain removal (npm nested object shape).
 *   - Missing persisted file → explicit error.
 *   - `--dry-run` planOnly → no writes, plan still reported.
 *   - Dry-run recorded runs → noop result.
 *
 * All I/O runs in temp dirs; install is injected so no network / process calls happen.
 */
import assert from 'node:assert';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const undoMod = await import(path.join(root, 'dist/cli/undo.js'));
const { runUndo } = undoMod;

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-undo-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function makeInstaller() {
  const calls = [];
  return {
    installer: async (cwd, manager, opts) => {
      calls.push({ cwd, manager, opts });
      return { ok: true, output: 'ok', exitCode: 0, command: `${manager} install` };
    },
    calls,
  };
}

async function writeLastRun(cwd, report) {
  await fs.writeFile(
    path.join(cwd, '.dep-up-surgeon.last-run.json'),
    JSON.stringify(
      {
        upgraded: [],
        skipped: [],
        failed: [],
        conflicts: [],
        unresolved: [],
        groups: [],
        targets: [{ label: 'root', cwd, packageJson: path.join(cwd, 'package.json') }],
        project: { manager: 'npm', managerSource: 'default', hasWorkspaces: false, workspaceGlobs: [], workspaceMembers: [] },
        installMode: 'root',
        finishedAt: new Date().toISOString(),
        toolVersion: 'test',
        cwd,
        dryRun: false,
        ...report,
      },
      null,
      2,
    ),
  );
}

test('runUndo: reverts dep ranges to `from` and runs one install', async () => {
  await withTempDir(async (cwd) => {
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        name: 'demo',
        dependencies: { lodash: '^4.17.21', 'left-pad': '^1.3.0' },
        devDependencies: { eslint: '^9.0.0' },
      }, null, 2),
    );
    await writeLastRun(cwd, {
      upgraded: [
        { name: 'lodash', success: true, from: '^4.17.19', to: '^4.17.21' },
        { name: 'eslint', success: true, from: '^8.57.0', to: '^9.0.0' },
      ],
    });
    const { installer, calls } = makeInstaller();
    const result = await runUndo({ cwd, installer, skipValidator: true });

    assert.equal(result.noop, false);
    assert.equal(result.reverts.length, 2);
    assert.ok(result.reverts.every((r) => r.ok));
    assert.equal(calls.length, 1, 'install runs exactly once per target');
    assert.equal(result.installs[0].ok, true);

    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies.lodash, '^4.17.19');
    assert.equal(pkg.devDependencies.eslint, '^8.57.0');
    assert.equal(pkg.dependencies['left-pad'], '^1.3.0', 'unrelated deps untouched');
  });
});

test('runUndo: drifted dep range is skipped with reason `drifted`', async () => {
  await withTempDir(async (cwd) => {
    // Run recorded `react: 17 → 18`, but the user since moved react to 19 manually. Undo
    // must NOT write 17 over 19 — that would erase a newer change.
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { react: '^19.0.0' } }, null, 2),
    );
    await writeLastRun(cwd, {
      upgraded: [{ name: 'react', success: true, from: '^17.0.0', to: '^18.0.0' }],
    });
    const { installer, calls } = makeInstaller();
    const result = await runUndo({ cwd, installer, skipValidator: true });

    assert.equal(result.reverts.length, 1);
    assert.equal(result.reverts[0].ok, false);
    assert.equal(result.reverts[0].skipped, true);
    assert.equal(result.reverts[0].reason, 'drifted');
    // No edits → no install needs to run. The reverse pass bails gracefully.
    assert.equal(calls.length, 0);
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies.react, '^19.0.0', 'current range preserved');
  });
});

test('runUndo: drops parent-scoped override chain and re-installs', async () => {
  await withTempDir(async (cwd) => {
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        name: 'demo',
        dependencies: {},
        overrides: { 'some-dep': { foo: '1.2.3' } },
      }, null, 2),
    );
    await writeLastRun(cwd, {
      upgraded: [],
      overrides: {
        field: 'overrides',
        attempts: [
          {
            name: 'foo',
            chain: ['some-dep', 'foo'],
            severity: 'high',
            ids: [],
            applied: '1.2.3',
            source: 'manual',
            ok: true,
            skipped: false,
          },
        ],
      },
    });
    const { installer, calls } = makeInstaller();
    const result = await runUndo({ cwd, installer, skipValidator: true });

    assert.equal(result.overrides.length, 1);
    assert.equal(result.overrides[0].ok, true);
    assert.equal(result.overrides[0].reason, 'dropped');
    assert.equal(calls.length, 1);
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    // With the sole override removed, the parent object should also be pruned.
    assert.equal(
      pkg.overrides,
      undefined,
      'overrides block removed when no pins remain',
    );
  });
});

test('runUndo: restores previous override value when the run replaced one', async () => {
  await withTempDir(async (cwd) => {
    // Current state: lodash pinned to 4.17.21 (the run replaced 4.17.19). Undo should write
    // 4.17.19 back rather than deleting the pin.
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        name: 'demo',
        dependencies: {},
        overrides: { lodash: '4.17.21' },
      }, null, 2),
    );
    await writeLastRun(cwd, {
      upgraded: [],
      overrides: {
        field: 'overrides',
        attempts: [
          {
            name: 'lodash',
            severity: 'high',
            ids: ['CVE-xxx'],
            applied: '4.17.21',
            previous: '4.17.19',
            source: 'advisory',
            ok: true,
            skipped: false,
          },
        ],
      },
    });
    const { installer } = makeInstaller();
    const result = await runUndo({ cwd, installer, skipValidator: true });

    assert.equal(result.overrides[0].reason, 'restored-previous');
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    assert.equal(pkg.overrides.lodash, '4.17.19', 'previous pin restored, not deleted');
  });
});

test('runUndo: missing persisted file throws with clear message', async () => {
  await withTempDir(async (cwd) => {
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: {} }),
    );
    await assert.rejects(
      runUndo({ cwd, skipValidator: true }),
      /no run report found/,
    );
  });
});

test('runUndo: dry-run recorded runs are a noop', async () => {
  await withTempDir(async (cwd) => {
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { lodash: '^4.17.21' } }, null, 2),
    );
    await writeLastRun(cwd, {
      dryRun: true,
      upgraded: [{ name: 'lodash', success: true, from: '^4.17.19', to: '^4.17.21' }],
    });
    const { installer, calls } = makeInstaller();
    const result = await runUndo({ cwd, installer, skipValidator: true });
    assert.equal(result.noop, true);
    assert.equal(result.reverts.length, 0);
    assert.equal(calls.length, 0);
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies.lodash, '^4.17.21', 'package.json untouched');
  });
});

test('runUndo: planOnly reports the plan without touching disk or running install', async () => {
  await withTempDir(async (cwd) => {
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { lodash: '^4.17.21' } }, null, 2),
    );
    await writeLastRun(cwd, {
      upgraded: [{ name: 'lodash', success: true, from: '^4.17.19', to: '^4.17.21' }],
    });
    const { installer, calls } = makeInstaller();
    const result = await runUndo({ cwd, installer, planOnly: true, skipValidator: true });
    assert.equal(result.reverts.length, 1);
    assert.equal(result.reverts[0].ok, true, 'plan row reports what would happen');
    assert.equal(calls.length, 0, 'planOnly never invokes the installer');
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies.lodash, '^4.17.21', 'disk untouched in planOnly mode');
  });
});

test('runUndo: workspace rows revert the correct workspace package.json', async () => {
  await withTempDir(async (cwd) => {
    const memberDir = path.join(cwd, 'packages', 'a');
    await fs.mkdir(memberDir, { recursive: true });
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'root', workspaces: ['packages/*'] }, null, 2),
    );
    await fs.writeFile(
      path.join(memberDir, 'package.json'),
      JSON.stringify({ name: '@demo/a', dependencies: { lodash: '^4.17.21' } }, null, 2),
    );
    await fs.writeFile(
      path.join(cwd, '.dep-up-surgeon.last-run.json'),
      JSON.stringify({
        upgraded: [{ name: 'lodash', success: true, from: '^4.17.19', to: '^4.17.21', workspace: '@demo/a' }],
        skipped: [],
        failed: [],
        conflicts: [],
        unresolved: [],
        groups: [],
        targets: [
          { label: 'root', cwd, packageJson: path.join(cwd, 'package.json') },
          { label: '@demo/a', cwd: memberDir, packageJson: path.join(memberDir, 'package.json') },
        ],
        project: { manager: 'npm', managerSource: 'default', hasWorkspaces: true, workspaceGlobs: ['packages/*'], workspaceMembers: [] },
        installMode: 'root',
        finishedAt: new Date().toISOString(),
        toolVersion: 'test',
        cwd,
        dryRun: false,
      }, null, 2),
    );
    const { installer, calls } = makeInstaller();
    const result = await runUndo({ cwd, installer, skipValidator: true });

    assert.equal(result.reverts[0].ok, true);
    assert.equal(result.reverts[0].workspace, '@demo/a');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cwd, memberDir, 'install runs against the workspace member');
    const pkg = JSON.parse(await fs.readFile(path.join(memberDir, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies.lodash, '^4.17.19');
  });
});
