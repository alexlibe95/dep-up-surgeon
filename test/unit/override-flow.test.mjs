/**
 * End-to-end-ish coverage for `runOverrideFlow`, the orchestrator behind `--apply-overrides`
 * and `--override`. Exercises:
 *   - Manual parent-scoped pins: write to the right slot, install + validator, success.
 *   - Validator failure → rollback wipes the nested pin AND re-runs install.
 *   - Advisory + manual pins coexist in a single run with independent outcomes.
 *   - Idempotent re-run: running the same pin twice does not re-install the second time.
 *
 * Hermetic: we inject a fake `installer` so no network, no real npm/pnpm/yarn calls. The
 * validator is a deterministic function of package.json state written by the flow, so a
 * rollback is observable purely by re-reading the file.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import { runOverrideFlow } from '../../dist/cli/overrideFlow.js';

async function stageWorkspace(pkg) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ovr-flow-'));
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(pkg, null, 2) + '\n',
  );
  return dir;
}

function makeInstaller() {
  const calls = [];
  const installer = async (cwd, manager, options) => {
    calls.push({ cwd, manager, options });
    return { ok: true, output: '', exitCode: 0, command: `${manager} install` };
  };
  return { installer, calls };
}

function failingInstaller() {
  const calls = [];
  const installer = async (cwd, manager, options) => {
    calls.push({ cwd, manager, options });
    return {
      ok: false,
      output: 'simulated install failure',
      exitCode: 1,
      command: `${manager} install`,
    };
  };
  return { installer, calls };
}

test('runOverrideFlow: manual parent-scoped pin writes + reports chain', async () => {
  const cwd = await stageWorkspace({ name: 'x', dependencies: {} });
  const { installer, calls } = makeInstaller();

  const result = await runOverrideFlow({
    cwd,
    manager: 'npm',
    advisories: [],
    upgradedNames: new Set(),
    directDepNames: new Set(),
    manualOverrides: [
      { chain: ['some-dep', 'foo'], range: '1.2.3', source: 'some-dep>foo@1.2.3' },
    ],
    installer,
    json: true,
  });

  assert.equal(result.attempts.length, 1);
  const rec = result.attempts[0];
  assert.equal(rec.ok, true);
  assert.equal(rec.source, 'manual');
  assert.deepEqual(rec.chain, ['some-dep', 'foo']);
  assert.equal(rec.applied, '1.2.3');

  const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.overrides, { 'some-dep': { foo: '1.2.3' } });
  assert.equal(calls.length, 1, 'install runs exactly once per successful pin');
});

test('runOverrideFlow: pnpm manual pin emits a foo>bar chain key', async () => {
  const cwd = await stageWorkspace({ name: 'x' });
  const { installer } = makeInstaller();

  await runOverrideFlow({
    cwd,
    manager: 'pnpm',
    advisories: [],
    upgradedNames: new Set(),
    directDepNames: new Set(),
    manualOverrides: [{ chain: ['foo', 'bar'], range: '1.2.3' }],
    installer,
    json: true,
  });

  const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.pnpm.overrides, { 'foo>bar': '1.2.3' });
});

test('runOverrideFlow: validator failure rolls back the nested pin AND re-installs', async () => {
  const cwd = await stageWorkspace({
    name: 'x',
    overrides: { keep: '9.9.9' }, // unrelated sibling must survive the rollback
  });
  const { installer, calls } = makeInstaller();

  // Validator fails iff the nested pin was just written. We read the file each call — this
  // is the deterministic equivalent of a real-world validator whose pass/fail depends on the
  // installed state.
  let validatorCalls = 0;
  const runValidator = async () => {
    validatorCalls++;
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    const nested = pkg.overrides?.wrapper?.victim;
    return nested ? { ok: false, message: 'nested pin is bad' } : { ok: true };
  };

  const result = await runOverrideFlow({
    cwd,
    manager: 'npm',
    advisories: [],
    upgradedNames: new Set(),
    directDepNames: new Set(),
    manualOverrides: [{ chain: ['wrapper', 'victim'], range: '2.0.0' }],
    installer,
    runValidator,
    json: true,
  });

  const rec = result.attempts[0];
  assert.equal(rec.ok, false);
  assert.equal(rec.rolledBack, true);
  assert.match(rec.reason, /validator failed/);

  const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
  assert.deepEqual(
    pkg.overrides,
    { keep: '9.9.9' },
    'wrapper.victim removed, untouched sibling preserved',
  );
  assert.equal(validatorCalls, 1);
  assert.equal(calls.length, 2, 'install once after pin, once on rollback');
});

test('runOverrideFlow: failing install triggers rollback without running validator', async () => {
  const cwd = await stageWorkspace({ name: 'x' });
  const { installer, calls } = failingInstaller();
  let validatorCalls = 0;
  const runValidator = async () => {
    validatorCalls++;
    return { ok: true };
  };

  const result = await runOverrideFlow({
    cwd,
    manager: 'pnpm',
    advisories: [],
    upgradedNames: new Set(),
    directDepNames: new Set(),
    manualOverrides: [{ chain: ['foo', 'bar'], range: '1.0.0' }],
    installer,
    runValidator,
    json: true,
  });

  const rec = result.attempts[0];
  assert.equal(rec.ok, false);
  assert.equal(rec.rolledBack, true);
  assert.match(rec.reason, /install failed/);
  assert.equal(validatorCalls, 0, 'validator not invoked when install itself failed');
  assert.equal(calls.length, 2, 'pin install + rollback install = 2');

  const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
  assert.equal(pkg.pnpm, undefined, 'pnpm.overrides block pruned on rollback');
});

test('runOverrideFlow: running the same pin twice is idempotent (no second install)', async () => {
  const cwd = await stageWorkspace({ name: 'x' });
  const { installer, calls } = makeInstaller();

  const opts = {
    cwd,
    manager: 'npm',
    advisories: [],
    upgradedNames: new Set(),
    directDepNames: new Set(),
    manualOverrides: [{ chain: ['a', 'b'], range: '1.0.0' }],
    installer,
    json: true,
  };
  const first = await runOverrideFlow(opts);
  assert.equal(first.attempts[0].ok, true);
  assert.equal(first.attempts[0].skipped, false);

  const second = await runOverrideFlow(opts);
  assert.equal(second.attempts[0].ok, true);
  assert.equal(second.attempts[0].skipped, true, 'second pass is a no-op');
  assert.equal(calls.length, 1, 'second pass does not re-run install');
});

test('runOverrideFlow: advisory + manual pins coexist with independent outcomes', async () => {
  const cwd = await stageWorkspace({ name: 'x' });
  const { installer, calls } = makeInstaller();

  // The validator rejects the MANUAL pin (nested `bad>pkg`) but accepts the flat advisory pin
  // (`lodash`). We expect one ok attempt (lodash), one rolled-back attempt (bad>pkg), and the
  // file to end up containing only the lodash pin.
  const runValidator = async () => {
    const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
    if (pkg.overrides?.bad?.pkg) return { ok: false, message: 'nested bad pkg blocked' };
    return { ok: true };
  };

  const result = await runOverrideFlow({
    cwd,
    manager: 'npm',
    advisories: [
      {
        name: 'lodash',
        severity: 'moderate',
        ids: ['GHSA-test'],
        recommendedVersion: '4.17.21',
      },
    ],
    upgradedNames: new Set(),
    directDepNames: new Set(), // lodash NOT a direct dep → treated as transitive
    manualOverrides: [{ chain: ['bad', 'pkg'], range: '2.0.0' }],
    installer,
    runValidator,
    json: true,
  });

  const byName = Object.fromEntries(result.attempts.map((a) => [a.name, a]));
  assert.equal(byName.lodash.ok, true);
  assert.equal(byName.lodash.source, 'advisory');
  assert.equal(byName.pkg.ok, false);
  assert.equal(byName.pkg.source, 'manual');
  assert.equal(byName.pkg.rolledBack, true);

  const pkg = JSON.parse(await fs.readFile(path.join(cwd, 'package.json'), 'utf8'));
  assert.deepEqual(pkg.overrides, { lodash: '4.17.21' }, 'only the accepted pin survives');
  // Installs: 1 for lodash, 1 for bad>pkg (pin attempt), 1 for rollback = 3.
  assert.equal(calls.length, 3);
});
