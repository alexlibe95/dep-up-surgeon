/**
 * Unit tests for the rc loader's overrides + merge logic and the override flow's `reason`
 * passthrough to attempt records. Covers:
 *   - normalizeRcOverrides: structured, selector, mixed, warnings on bad shapes
 *   - mergeOverrideSources: rc-only, CLI-only, CLI wins on chain conflict, malformed CLI
 *     selectors become warnings (not fatal), rc-only still applies
 *   - loadConfig: end-to-end rc file parsing with overrides + warnings
 *   - runOverrideFlow: `policyReason` flows from manual spec → attempt record
 */
import assert from 'node:assert';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const cfg = await import(path.join(root, 'dist/config/loadConfig.js'));
const { loadConfig, mergeOverrideSources, normalizeRcOverrides } = cfg;

const flow = await import(path.join(root, 'dist/cli/overrideFlow.js'));
const { runOverrideFlow } = flow;

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-rc-overrides-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// normalizeRcOverrides
// ---------------------------------------------------------------------------

test('normalizeRcOverrides: structured form with string + array chain', () => {
  const warnings = [];
  const out = normalizeRcOverrides(
    [
      { chain: 'lodash', range: '4.17.21' },
      { chain: ['some-dep', 'foo'], range: '1.2.3', reason: 'CVE-2025-1234' },
    ],
    warnings,
  );
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { chain: ['lodash'], range: '4.17.21' });
  assert.deepEqual(out[1], {
    chain: ['some-dep', 'foo'],
    range: '1.2.3',
    reason: 'CVE-2025-1234',
  });
  assert.deepEqual(warnings, []);
});

test('normalizeRcOverrides: selector form parses pnpm `>`, yarn `/`, and scoped names', () => {
  const warnings = [];
  const out = normalizeRcOverrides(
    [
      { selector: 'some-dep>foo@1.2.3', reason: 'vendor guidance' },
      { selector: 'parent/child@2.0.0' },
      { selector: '@scope/parent>@scope/child@3.0.0' },
      { selector: 'plain', range: '5.0.0' },
    ],
    warnings,
  );
  assert.equal(out.length, 4);
  assert.deepEqual(out[0].chain, ['some-dep', 'foo']);
  assert.equal(out[0].range, '1.2.3');
  assert.equal(out[0].reason, 'vendor guidance');
  assert.equal(out[0].source, 'some-dep>foo@1.2.3');
  assert.deepEqual(out[1].chain, ['parent', 'child']);
  assert.equal(out[1].range, '2.0.0');
  assert.deepEqual(out[2].chain, ['@scope/parent', '@scope/child']);
  assert.equal(out[2].range, '3.0.0');
  assert.deepEqual(out[3].chain, ['plain']);
  assert.equal(out[3].range, '5.0.0');
  assert.deepEqual(warnings, []);
});

test('normalizeRcOverrides: missing range / malformed entries become warnings (not throws)', () => {
  const warnings = [];
  const out = normalizeRcOverrides(
    [
      { chain: ['foo'] }, // no range
      { selector: '@@@' }, // malformed
      42, // not an object
      { chain: [], range: '1.0.0' }, // empty chain
      { chain: ['ok'], range: '1.0.0' }, // valid survivor
    ],
    warnings,
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].chain, ['ok']);
  assert.ok(warnings.length >= 4, `expected 4+ warnings, got ${warnings.length}`);
});

test('normalizeRcOverrides: rejects non-array root with warning', () => {
  const warnings = [];
  const out = normalizeRcOverrides({ 'foo': '1.0.0' }, warnings);
  assert.equal(out.length, 0);
  assert.ok(warnings[0]?.includes('must be an array'));
});

// ---------------------------------------------------------------------------
// mergeOverrideSources
// ---------------------------------------------------------------------------

test('mergeOverrideSources: rc-only entries survive unchanged', () => {
  const { entries, warnings } = mergeOverrideSources(
    [{ chain: ['foo'], range: '1.0.0', reason: 'rc-1' }],
    [],
  );
  assert.equal(entries.length, 1);
  assert.equal(entries[0].reason, 'rc-1');
  assert.deepEqual(warnings, []);
});

test('mergeOverrideSources: CLI wins on exact-chain conflict; non-colliding entries all appear', () => {
  const { entries, warnings } = mergeOverrideSources(
    [
      { chain: ['foo'], range: '1.0.0', reason: 'rc-old' },
      { chain: ['bar'], range: '2.0.0' },
    ],
    ['foo@1.5.0', 'baz@3.0.0'],
  );
  const byKey = Object.fromEntries(entries.map((e) => [e.chain.join('>'), e]));
  assert.equal(byKey.foo.range, '1.5.0', 'CLI override replaced rc entry for `foo`');
  assert.equal(byKey.foo.reason, undefined, 'CLI entries drop the rc reason on override');
  assert.equal(byKey.bar.range, '2.0.0');
  assert.equal(byKey.baz.range, '3.0.0');
  assert.deepEqual(warnings, []);
});

test('mergeOverrideSources: CLI parent-scoped chain does NOT collide with rc flat pin of the leaf', () => {
  // rc pins flat `foo@1.0.0`; CLI pins `some-dep>foo@1.5.0`. These are structurally different
  // chains and both must survive — this is the whole point of parent-scoped overrides.
  const { entries } = mergeOverrideSources(
    [{ chain: ['foo'], range: '1.0.0' }],
    ['some-dep>foo@1.5.0'],
  );
  assert.equal(entries.length, 2);
  const byKey = Object.fromEntries(entries.map((e) => [e.chain.join('>'), e]));
  assert.ok(byKey.foo);
  assert.ok(byKey['some-dep>foo']);
});

test('mergeOverrideSources: malformed CLI selector is a warning, not fatal — rc entries still apply', () => {
  const { entries, warnings } = mergeOverrideSources(
    [{ chain: ['rc-good'], range: '1.0.0', reason: 'keep me' }],
    ['bad-no-at', 'good@2.0.0'],
  );
  assert.equal(entries.length, 2, 'rc entry + valid CLI entry both present');
  const byKey = Object.fromEntries(entries.map((e) => [e.chain.join('>'), e]));
  assert.equal(byKey['rc-good'].reason, 'keep me');
  assert.equal(byKey.good.range, '2.0.0');
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('bad-no-at'));
});

// ---------------------------------------------------------------------------
// loadConfig end-to-end
// ---------------------------------------------------------------------------

test('loadConfig: parses overrides block alongside ignore/validate', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, '.dep-up-surgeonrc'),
      JSON.stringify(
        {
          ignore: ['react'],
          overrides: [
            { selector: 'some-dep>foo@1.2.3', reason: 'CVE-XYZ' },
            { chain: ['flat'], range: '2.0.0' },
          ],
        },
        null,
        2,
      ),
    );
    const config = await loadConfig(dir);
    assert.deepEqual(config.ignore, ['react']);
    assert.equal(config.overrides?.length, 2);
    assert.equal(config.overrides[0].reason, 'CVE-XYZ');
    assert.deepEqual(config.overrides[0].chain, ['some-dep', 'foo']);
    assert.deepEqual(config.overrides[1].chain, ['flat']);
    assert.equal(config.warnings, undefined);
  });
});

test('loadConfig: overrides warnings are surfaced on the rc object', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, '.dep-up-surgeonrc'),
      JSON.stringify({
        overrides: [
          { chain: ['missing-range'] },
          { chain: ['ok'], range: '1.0.0' },
        ],
      }),
    );
    const config = await loadConfig(dir);
    assert.equal(config.overrides?.length, 1);
    assert.ok(config.warnings && config.warnings.length >= 1);
    assert.ok(config.warnings[0].includes('missing'));
  });
});

test('loadConfig: empty overrides array yields no overrides field', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, '.dep-up-surgeonrc'), JSON.stringify({ overrides: [] }));
    const config = await loadConfig(dir);
    assert.equal(config.overrides, undefined);
  });
});

// ---------------------------------------------------------------------------
// runOverrideFlow: policyReason passthrough
// ---------------------------------------------------------------------------

async function stageWorkspace(packageJson) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-flow-reason-'));
  await fs.writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify(packageJson, null, 2),
    'utf8',
  );
  return dir;
}

function makeInstaller() {
  const calls = [];
  return {
    installer: async (cwd, manager) => {
      calls.push({ cwd, manager });
      return { ok: true, command: 'npm install', exitCode: 0, lastLines: '' };
    },
    calls,
  };
}

test('runOverrideFlow: manual spec with reason propagates to attempts[].policyReason', async () => {
  const cwd = await stageWorkspace({ name: 'x', dependencies: {} });
  const { installer } = makeInstaller();
  const result = await runOverrideFlow({
    cwd,
    manager: 'npm',
    advisories: [],
    upgradedNames: new Set(),
    directDepNames: new Set(),
    manualOverrides: [
      {
        chain: ['some-dep', 'foo'],
        range: '1.2.3',
        source: 'some-dep>foo@1.2.3',
        reason: 'CVE-2025-1234',
      },
    ],
    installer,
    json: true,
  });
  assert.equal(result.attempts.length, 1);
  const rec = result.attempts[0];
  assert.equal(rec.ok, true);
  assert.equal(rec.source, 'manual');
  assert.equal(rec.policyReason, 'CVE-2025-1234');
  await fs.rm(cwd, { recursive: true, force: true });
});

test('runOverrideFlow: manual spec WITHOUT reason leaves policyReason undefined', async () => {
  const cwd = await stageWorkspace({ name: 'x', dependencies: {} });
  const { installer } = makeInstaller();
  const result = await runOverrideFlow({
    cwd,
    manager: 'npm',
    advisories: [],
    upgradedNames: new Set(),
    directDepNames: new Set(),
    manualOverrides: [
      { chain: ['bar'], range: '1.0.0', source: 'bar@1.0.0' },
    ],
    installer,
    json: true,
  });
  assert.equal(result.attempts.length, 1);
  assert.equal(result.attempts[0].policyReason, undefined);
  await fs.rm(cwd, { recursive: true, force: true });
});
