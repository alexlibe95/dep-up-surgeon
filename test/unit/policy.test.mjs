/**
 * Unit tests for the policy loader + rule evaluator.
 *
 * Coverage:
 *   - YAML + JSON loader paths
 *   - Freeze / maxVersion / allowMajorAfter normalization + warnings
 *   - Pattern matching (exact + `*` wildcards, incl. scoped names)
 *   - evaluatePolicy (frozen wins, tightest range, earliest date)
 *   - applyPolicyToTarget version capping + major demotion
 */
import assert from 'node:assert';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const pol = await import(path.join(root, 'dist/config/policy.js'));
const {
  loadPolicy,
  normalizePolicy,
  matchPattern,
  evaluatePolicy,
  applyPolicyToTarget,
  EMPTY_POLICY,
} = pol;

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-policy-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// matchPattern
// ---------------------------------------------------------------------------

test('matchPattern: exact match', () => {
  assert.strictEqual(matchPattern('react', 'react'), true);
  assert.strictEqual(matchPattern('react', 'react-dom'), false);
});

test('matchPattern: wildcard', () => {
  assert.strictEqual(matchPattern('eslint-plugin-*', 'eslint-plugin-react'), true);
  assert.strictEqual(matchPattern('eslint-plugin-*', 'eslint-config-next'), false);
  assert.strictEqual(matchPattern('@types/*', '@types/node'), true);
  assert.strictEqual(matchPattern('@types/*', '@types/react'), true);
  assert.strictEqual(matchPattern('@types/*', 'foo'), false);
});

test('matchPattern: wildcard does not span slashes', () => {
  assert.strictEqual(matchPattern('@types/*', '@types/foo/bar'), false);
});

// ---------------------------------------------------------------------------
// loadPolicy
// ---------------------------------------------------------------------------

test('loadPolicy: returns EMPTY_POLICY when no file present', async () => {
  await withTempDir(async (dir) => {
    const r = await loadPolicy(dir);
    assert.strictEqual(r.present, false);
    assert.strictEqual(r.policy.freeze.length, 0);
  });
});

test('loadPolicy: YAML file loads correctly', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, '.dep-up-surgeon.policy.yaml'),
      `freeze:
  - name: react
    reason: "pending audit"
  - name: "@types/*"

maxVersion:
  - name: eslint
    version: "8.x"

allowMajorAfter:
  - name: next
    date: "2026-06-01"

requireReviewers:
  major: 2
  minor: 1

autoMerge:
  patch: true
  include:
    - "eslint-plugin-*"
`,
    );
    const r = await loadPolicy(dir);
    assert.strictEqual(r.present, true);
    assert.strictEqual(r.policy.freeze.length, 2);
    assert.strictEqual(r.policy.freeze[0].pattern, 'react');
    assert.strictEqual(r.policy.freeze[0].reason, 'pending audit');
    assert.strictEqual(r.policy.freeze[1].pattern, '@types/*');
    assert.strictEqual(r.policy.maxVersion.length, 1);
    assert.strictEqual(r.policy.maxVersion[0].range, '8.x');
    assert.strictEqual(r.policy.allowMajorAfter.length, 1);
    assert.ok(r.policy.allowMajorAfter[0].date instanceof Date);
    assert.strictEqual(r.policy.requireReviewers.major, 2);
    assert.strictEqual(r.policy.autoMerge.patch, true);
    assert.deepStrictEqual(r.policy.autoMerge.include, ['eslint-plugin-*']);
  });
});

test('loadPolicy: JSON file loads correctly', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, '.dep-up-surgeon.policy.json'),
      JSON.stringify({
        freeze: ['react', { name: '@types/*', reason: 'legacy' }],
        maxVersion: [{ name: 'vue', version: '^3.0.0' }],
      }),
    );
    const r = await loadPolicy(dir);
    assert.strictEqual(r.present, true);
    assert.strictEqual(r.policy.freeze.length, 2);
  });
});

test('loadPolicy: collects warnings for bad shape', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, '.dep-up-surgeon.policy.yaml'),
      `freeze: not-an-array
maxVersion:
  - version: "1.x"
unknownKey: true
`,
    );
    const r = await loadPolicy(dir);
    assert.ok(r.policy.warnings.length >= 3);
    assert.ok(r.policy.warnings.some((w) => w.includes('freeze')));
    assert.ok(r.policy.warnings.some((w) => w.includes('maxVersion')));
    assert.ok(r.policy.warnings.some((w) => w.includes('unknown policy key')));
  });
});

test('loadPolicy: malformed YAML is swallowed into a warning', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, '.dep-up-surgeon.policy.yaml'), 'this: is\nnot: [valid yaml');
    const r = await loadPolicy(dir);
    assert.strictEqual(r.present, false);
    assert.ok(r.policy.warnings[0].includes('failed to parse'));
  });
});

test('loadPolicy: invalid semver range recorded as warning, rule dropped', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, '.dep-up-surgeon.policy.yaml'),
      `maxVersion:
  - name: eslint
    version: "not a range"
`,
    );
    const r = await loadPolicy(dir);
    assert.strictEqual(r.policy.maxVersion.length, 0);
    assert.ok(r.policy.warnings.some((w) => w.includes('not a valid semver')));
  });
});

// ---------------------------------------------------------------------------
// evaluatePolicy
// ---------------------------------------------------------------------------

test('evaluatePolicy: freeze wins over everything', () => {
  const policy = normalizePolicy({
    freeze: [{ name: 'react', reason: 'pending audit' }],
    maxVersion: [{ name: 'react', version: '18.x' }],
  });
  const d = evaluatePolicy(policy, 'react');
  assert.strictEqual(d.frozen, true);
  assert.match(d.reason, /pending audit/);
});

test('evaluatePolicy: no rules → default decision', () => {
  const d = evaluatePolicy(EMPTY_POLICY, 'react');
  assert.strictEqual(d.frozen, false);
  assert.strictEqual(d.maxRange, undefined);
  assert.strictEqual(d.reason, undefined);
});

test('evaluatePolicy: maxRange captures tightest range when multiple match', () => {
  const policy = normalizePolicy({
    maxVersion: [
      { name: '*', version: '<10.0.0' },
      { name: 'react', version: '^18.0.0' },
    ],
  });
  const d = evaluatePolicy(policy, 'react');
  assert.ok(d.maxRange);
  assert.match(d.reason, /capped/);
});

test('evaluatePolicy: blockedMajorUntil picks earliest future date', () => {
  const policy = normalizePolicy({
    allowMajorAfter: [
      { name: 'react', date: '2030-01-01' },
      { name: 'react', date: '2027-06-01' },
    ],
  });
  const d = evaluatePolicy(policy, 'react', new Date('2026-01-01'));
  assert.ok(d.blockedMajorUntil);
  assert.strictEqual(d.blockedMajorUntil.toISOString().slice(0, 10), '2027-06-01');
});

test('evaluatePolicy: allowMajorAfter in the past is a no-op', () => {
  const policy = normalizePolicy({
    allowMajorAfter: [{ name: 'react', date: '2020-01-01' }],
  });
  const d = evaluatePolicy(policy, 'react', new Date('2026-01-01'));
  assert.strictEqual(d.blockedMajorUntil, undefined);
});

// ---------------------------------------------------------------------------
// applyPolicyToTarget
// ---------------------------------------------------------------------------

const AVAILABLE = ['18.0.0', '18.1.0', '18.2.0', '19.0.0', '19.1.0'];

test('applyPolicyToTarget: frozen returns undefined', () => {
  const out = applyPolicyToTarget({ frozen: true }, '17.0.0', '19.0.0', AVAILABLE);
  assert.strictEqual(out, undefined);
});

test('applyPolicyToTarget: target within maxRange is unchanged', () => {
  const out = applyPolicyToTarget({ frozen: false, maxRange: '^18.0.0' }, '17.0.0', '18.1.0', AVAILABLE);
  assert.strictEqual(out, '18.1.0');
});

test('applyPolicyToTarget: target outside maxRange is demoted to highest in range', () => {
  const out = applyPolicyToTarget({ frozen: false, maxRange: '^18.0.0' }, '17.0.0', '19.0.0', AVAILABLE);
  assert.strictEqual(out, '18.2.0');
});

test('applyPolicyToTarget: no in-range version returns undefined', () => {
  const out = applyPolicyToTarget(
    { frozen: false, maxRange: '^20.0.0' },
    '17.0.0',
    '19.0.0',
    AVAILABLE,
  );
  assert.strictEqual(out, undefined);
});

test('applyPolicyToTarget: blockedMajorUntil demotes cross-major bump', () => {
  const out = applyPolicyToTarget(
    { frozen: false, blockedMajorUntil: new Date('2030-01-01') },
    '18.0.0',
    '19.1.0',
    AVAILABLE,
  );
  assert.strictEqual(out, '18.2.0');
});

test('applyPolicyToTarget: combined maxRange + blockedMajorUntil', () => {
  const out = applyPolicyToTarget(
    { frozen: false, maxRange: '^18.0.0', blockedMajorUntil: new Date('2030-01-01') },
    '18.0.0',
    '19.1.0',
    AVAILABLE,
  );
  assert.strictEqual(out, '18.2.0');
});
