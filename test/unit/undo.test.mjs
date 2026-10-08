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
 *   - Override pins: drift check, newest-first unwinding, `"."` collapse, pnpm-workspace.yaml
 *     restores, `lockfile-update` fixes left to the lockfile restore.
 *   - Reports replayed in another checkout / from the legacy root location; recorded sections.
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

/** A run that moved `next` from ^16.3.1 to ^16.3.5 — a range the old one still satisfies. */
async function recordBunRun(dir) {
  const lastRun = await import(path.join(root, 'dist/cli/lastRun.js'));
  const pkg = (range) => JSON.stringify({ name: 'app', dependencies: { next: range } }, null, 2);
  await fs.writeFile(path.join(dir, 'package.json'), pkg('^16.3.1'));
  await fs.writeFile(path.join(dir, 'bun.lock'), 'next@16.3.1\n');
  const lockfilesBefore = await lastRun.captureRootLockfiles(dir);

  await fs.writeFile(path.join(dir, 'package.json'), pkg('^16.3.5'));
  await fs.writeFile(path.join(dir, 'bun.lock'), 'next@16.3.5\n');
  const structured = {
    upgraded: [{ name: 'next', success: true, from: '^16.3.1', to: '^16.3.5' }],
    skipped: [],
    failed: [],
    conflicts: [],
    unresolved: [],
    groups: [],
    project: { manager: 'bun', managerSource: 'lockfile', hasWorkspaces: false, workspaceGlobs: [], workspaceMembers: [] },
  };
  await lastRun.persistLastRunReport(structured, { cwd: dir, toolVersion: 'test', dryRun: false, lockfilesBefore });
}

test('undo: restores the pre-run lockfile bytes, so versions the old range still allows revert too', async () => {
  await withTempDir(async (dir) => {
    await recordBunRun(dir);
    const { installer, calls } = makeInstaller();
    const result = await runUndo({ cwd: dir, installer, skipValidator: true });
    assert.deepStrictEqual(result.lockfiles, [{ file: 'bun.lock', restored: true }]);
    assert.strictEqual(await fs.readFile(path.join(dir, 'bun.lock'), 'utf8'), 'next@16.3.1\n');
    assert.strictEqual(calls.length, 1, 'install still runs so node_modules follows the lockfile');
  });
});

test('undo: a lockfile edited after the run is left alone', async () => {
  await withTempDir(async (dir) => {
    await recordBunRun(dir);
    await fs.writeFile(path.join(dir, 'bun.lock'), 'next@16.4.0\n');
    const { installer } = makeInstaller();
    const result = await runUndo({ cwd: dir, installer, skipValidator: true });
    assert.strictEqual(result.lockfiles?.[0]?.restored, false);
    assert.match(result.lockfiles[0].detail, /changed since the run/);
    assert.strictEqual(await fs.readFile(path.join(dir, 'bun.lock'), 'utf8'), 'next@16.4.0\n');
  });
});

async function writeLastRun(cwd, report) {
  await fs.mkdir(path.join(cwd, 'node_modules', '.cache', 'dep-up-surgeon'), { recursive: true });
  await fs.writeFile(
    path.join(cwd, 'node_modules', '.cache', 'dep-up-surgeon', 'last-run.json'),
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

test('runUndo: catalog: pointer stays; catalog file range reverts', async () => {
  await withTempDir(async (cwd) => {
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { react: 'catalog:' } }, null, 2),
    );
    await fs.writeFile(
      path.join(cwd, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\ncatalog:\n  react: ^19.0.0\n',
    );
    await writeLastRun(cwd, {
      upgraded: [{ name: 'react', success: true, from: '^18.2.0', to: '^19.0.0' }],
      project: {
        manager: 'pnpm',
        managerSource: 'lockfile',
        hasWorkspaces: true,
        workspaceGlobs: ['packages/*'],
        workspaceMembers: [],
      },
    });
    const { installer } = makeInstaller();
    const result = await runUndo({ cwd, installer, skipValidator: true });
    assert.equal(result.reverts[0].ok, true);
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies.react, 'catalog:');
    const yaml = await fs.readFile(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8');
    assert.match(yaml, /react:\s*['"]?\^18\.2\.0['"]?/);
    assert.doesNotMatch(yaml, /\^19\.0\.0/);
  });
});

test('runUndo: catalog drift skips without rewriting the catalog file', async () => {
  await withTempDir(async (cwd) => {
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { react: 'catalog:' } }, null, 2),
    );
    await fs.writeFile(
      path.join(cwd, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\ncatalog:\n  react: ^19.1.0\n',
    );
    await writeLastRun(cwd, {
      upgraded: [{ name: 'react', success: true, from: '^18.2.0', to: '^19.0.0' }],
    });
    const { installer } = makeInstaller();
    const result = await runUndo({ cwd, installer, skipValidator: true });
    assert.equal(result.reverts[0].ok, false);
    assert.equal(result.reverts[0].reason, 'drifted');
    const yaml = await fs.readFile(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8');
    assert.match(yaml, /\^19\.1\.0/);
  });
});

test('runUndo: planOnly does not write catalog file', async () => {
  await withTempDir(async (cwd) => {
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { react: 'catalog:' } }, null, 2),
    );
    await fs.writeFile(
      path.join(cwd, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\ncatalog:\n  react: ^19.0.0\n',
    );
    await writeLastRun(cwd, {
      upgraded: [{ name: 'react', success: true, from: '^18.2.0', to: '^19.0.0' }],
    });
    const { installer, calls } = makeInstaller();
    const result = await runUndo({ cwd, installer, planOnly: true, skipValidator: true });
    assert.equal(result.reverts[0].ok, true);
    assert.equal(calls.length, 0);
    const yaml = await fs.readFile(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8');
    assert.match(yaml, /\^19\.0\.0/);
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies.react, 'catalog:');
  });
});

test('runUndo: named catalog: pointer reverts the named map', async () => {
  await withTempDir(async (cwd) => {
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'demo', dependencies: { react: 'catalog:react19' } }, null, 2),
    );
    await fs.writeFile(
      path.join(cwd, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\ncatalogs:\n  react19:\n    react: ^19.0.0\n',
    );
    await writeLastRun(cwd, {
      upgraded: [{ name: 'react', success: true, from: '^18.2.0', to: '^19.0.0' }],
    });
    const { installer } = makeInstaller();
    const result = await runUndo({ cwd, installer, skipValidator: true });
    assert.equal(result.reverts[0].ok, true);
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies.react, 'catalog:react19');
    const yaml = await fs.readFile(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8');
    assert.match(yaml, /react:\s*['"]?\^18\.2\.0['"]?/);
  });
});

function overrideAttempt(fields) {
  return { severity: 'high', ids: [], source: 'manual', ok: true, skipped: false, ...fields };
}

test('runUndo: restores a replaced pnpm pin inside pnpm-workspace.yaml, not package.json', async () => {
  await withTempDir(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'demo' }, null, 2) + '\n');
    await fs.writeFile(path.join(cwd, 'pnpm-workspace.yaml'), 'overrides:\n  qs: 6.14.1 # security\n');
    const pkgBefore = await fs.readFile(path.join(cwd, 'package.json'), 'utf8');
    await writeLastRun(cwd, {
      project: { manager: 'pnpm', managerSource: 'lockfile', hasWorkspaces: false, workspaceGlobs: [], workspaceMembers: [] },
      overrides: {
        field: 'pnpm.overrides',
        attempts: [overrideAttempt({ name: 'qs', applied: '6.14.1', previous: '6.7.2', source: 'advisory' })],
      },
    });
    const { installer } = makeInstaller();
    const result = await runUndo({ cwd, installer, skipValidator: true });
    assert.equal(result.overrides[0].reason, 'restored-previous');
    assert.equal(await fs.readFile(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8'), 'overrides:\n  qs: 6.7.2 # security\n');
    assert.equal(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'), pkgBefore, 'package.json untouched');
  });
});

test('runUndo: an override pin changed since the run is skipped as drifted', async () => {
  await withTempDir(async (cwd) => {
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'demo', overrides: { qs: '6.15.0' } }, null, 2),
    );
    await writeLastRun(cwd, {
      overrides: { field: 'overrides', attempts: [overrideAttempt({ name: 'qs', applied: '6.14.1' })] },
    });
    const { installer, calls } = makeInstaller();
    const result = await runUndo({ cwd, installer, skipValidator: true });
    assert.equal(result.overrides[0].ok, false);
    assert.equal(result.overrides[0].reason, 'drifted');
    assert.match(result.overrides[0].detail, /6\.15\.0/);
    assert.equal(calls.length, 0);
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.overrides, { qs: '6.15.0' }, 'later pin kept');
  });
});

test('runUndo: a slot pinned twice in one run unwinds newest-first to its pre-run state (plan included)', async () => {
  await withTempDir(async (cwd) => {
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'demo', overrides: { qs: '6.15.0', keep: '1.0.0' } }, null, 2),
    );
    await writeLastRun(cwd, {
      overrides: {
        field: 'overrides',
        attempts: [
          overrideAttempt({ name: 'qs', applied: '6.14.1', source: 'advisory' }),
          overrideAttempt({ name: 'qs', applied: '6.15.0', previous: '6.14.1' }),
        ],
      },
    });
    const { installer } = makeInstaller();
    const plan = await runUndo({ cwd, installer, skipValidator: true, planOnly: true });
    assert.deepEqual(plan.overrides.map((o) => [o.ok, o.reason]), [[true, 'restored-previous'], [true, 'dropped']]);

    const result = await runUndo({ cwd, installer, skipValidator: true });
    assert.deepEqual(result.overrides.map((o) => [o.ok, o.reason]), [[true, 'restored-previous'], [true, 'dropped']]);
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.overrides, { keep: '1.0.0' });
  });
});

test('runUndo: dropping a child pin collapses the parent the run promoted back to its plain pin', async () => {
  await withTempDir(async (cwd) => {
    // Before the run: `"foo": "1.0.0"`. The run's `foo>bar` pin promoted it to `{".": …}`.
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'demo', overrides: { foo: { '.': '1.0.0', bar: '2.0.0' } } }, null, 2),
    );
    await writeLastRun(cwd, {
      overrides: {
        field: 'overrides',
        attempts: [overrideAttempt({ name: 'bar', chain: ['foo', 'bar'], applied: '2.0.0' })],
      },
    });
    const { installer } = makeInstaller();
    const result = await runUndo({ cwd, installer, skipValidator: true });
    assert.equal(result.overrides[0].reason, 'dropped');
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.overrides, { foo: '1.0.0' });
  });
});

test('runUndo: a lockfile-update fix is left to the lockfile restore, not treated as a pin', async () => {
  await withTempDir(async (dir) => {
    await recordBunRun(dir);
    const reportPath = path.join(dir, 'node_modules', '.cache', 'dep-up-surgeon', 'last-run.json');
    const report = JSON.parse(await fs.readFile(reportPath, 'utf8'));
    report.overrides = {
      field: 'overrides',
      attempts: [overrideAttempt({ name: 'qs', applied: '6.14.2', method: 'lockfile-update', source: 'advisory' })],
    };
    await fs.writeFile(reportPath, JSON.stringify(report));
    const { installer } = makeInstaller();
    const result = await runUndo({ cwd: dir, installer, skipValidator: true });
    assert.deepEqual(result.overrides, []);
    assert.deepEqual(result.lockfiles, [{ file: 'bun.lock', restored: true }]);
    assert.strictEqual(await fs.readFile(path.join(dir, 'bun.lock'), 'utf8'), 'next@16.3.1\n');
  });
});

test('runUndo: a fallback to the legacy root report is flagged with its path, age and version', async () => {
  await withTempDir(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'demo', dependencies: { a: '^2.0.0' } }));
    const legacy = path.join(cwd, '.dep-up-surgeon.last-run.json');
    await fs.writeFile(
      legacy,
      JSON.stringify({
        upgraded: [{ name: 'a', success: true, from: '^1.0.0', to: '^2.0.0' }],
        finishedAt: '2026-01-02T03:04:05.000Z',
        toolVersion: '3.0.0',
        cwd,
        dryRun: false,
      }),
    );
    const { installer } = makeInstaller();
    const result = await runUndo({ cwd, installer, skipValidator: true, json: true });
    assert.equal(result.sourceFile, legacy);
    assert.equal(result.warnings?.length, 1);
    assert.ok(result.warnings[0].includes(legacy), result.warnings[0]);
    assert.match(result.warnings[0], /2026-01-02T03:04:05\.000Z/);
    assert.match(result.warnings[0], /3\.0\.0/);
  });
});

test('runUndo --file: a report recorded in another checkout edits this checkout, never the recorded one', async () => {
  await withTempDir(async (base) => {
    const recorded = path.join(base, 'ci', 'app');
    const here = path.join(base, 'local', 'app');
    for (const root of [recorded, here]) {
      await fs.mkdir(path.join(root, 'packages', 'a'), { recursive: true });
      await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'root', dependencies: { r: '^2.0.0' } }));
      await fs.writeFile(
        path.join(root, 'packages', 'a', 'package.json'),
        JSON.stringify({ name: '@demo/a', dependencies: { lodash: '^4.17.21' } }),
      );
    }
    const report = path.join(base, 'artifact.json');
    await fs.writeFile(
      report,
      JSON.stringify({
        upgraded: [
          { name: 'r', success: true, from: '^1.0.0', to: '^2.0.0', workspace: 'root' },
          { name: 'lodash', success: true, from: '^4.17.19', to: '^4.17.21', workspace: '@demo/a' },
        ],
        targets: [
          { label: 'root', cwd: recorded, packageJson: path.join(recorded, 'package.json') },
          { label: '@demo/a', cwd: path.join(recorded, 'packages', 'a'), packageJson: path.join(recorded, 'packages', 'a', 'package.json') },
        ],
        cwd: recorded,
        dryRun: false,
      }),
    );
    const { installer, calls } = makeInstaller();
    const result = await runUndo({ cwd: here, file: report, installer, skipValidator: true });
    assert.ok(result.reverts.every((r) => r.ok));
    assert.deepEqual(calls.map((c) => c.cwd).sort(), [here, path.join(here, 'packages', 'a')].sort());
    const member = JSON.parse(await fs.readFile(path.join(here, 'packages', 'a', 'package.json'), 'utf8'));
    assert.equal(member.dependencies.lodash, '^4.17.19');
    const untouched = JSON.parse(await fs.readFile(path.join(recorded, 'packages', 'a', 'package.json'), 'utf8'));
    assert.equal(untouched.dependencies.lodash, '^4.17.21', 'the recorded checkout is left alone');
  });
});

test('undoSucceeded: false when the report names rows but none of their files exist here', async () => {
  await withTempDir(async (cwd) => {
    const report = path.join(cwd, 'artifact.json');
    await fs.writeFile(
      report,
      JSON.stringify({
        upgraded: [{ name: 'lodash', success: true, from: '^4.17.19', to: '^4.17.21', workspace: '@demo/a' }],
        targets: [{ label: '@demo/a', cwd: '/elsewhere/packages/a', packageJson: '/elsewhere/packages/a/package.json' }],
        cwd: '/elsewhere',
        dryRun: false,
      }),
    );
    const { installer } = makeInstaller();
    const result = await runUndo({ cwd, file: report, installer, skipValidator: true });
    assert.equal(result.reverts[0].reason, 'missing');
    assert.equal(undoMod.undoSucceeded(result), false);
  });
});

test('runUndo: reverts the recorded section, or scans every section for the recorded `to`', async () => {
  await withTempDir(async (cwd) => {
    // `typescript` sits in peerDependencies (left alone, scanned first) and
    // optionalDependencies (bumped); `react` in dependencies (left alone) and devDependencies.
    await fs.writeFile(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        name: 'demo',
        dependencies: { react: '^18.0.0' },
        devDependencies: { react: '^19.0.0' },
        peerDependencies: { typescript: '>=5' },
        optionalDependencies: { typescript: '^5.6.0' },
      }, null, 2),
    );
    await writeLastRun(cwd, {
      upgraded: [
        { name: 'typescript', success: true, from: '^5.4.0', to: '^5.6.0' },
        { name: 'react', success: true, from: '^18.3.0', to: '^19.0.0', section: 'devDependencies' },
      ],
    });
    const { installer } = makeInstaller();
    const result = await runUndo({ cwd, installer, skipValidator: true });
    assert.deepEqual(result.reverts.map((r) => [r.name, r.ok, r.section]), [
      ['typescript', true, 'optionalDependencies'],
      ['react', true, 'devDependencies'],
    ]);
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    assert.deepEqual(pkg.dependencies, { react: '^18.0.0' });
    assert.deepEqual(pkg.devDependencies, { react: '^18.3.0' });
    assert.deepEqual(pkg.peerDependencies, { typescript: '>=5' });
    assert.deepEqual(pkg.optionalDependencies, { typescript: '^5.4.0' });
  });
});
