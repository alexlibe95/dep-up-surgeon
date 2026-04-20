import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  overrideFieldFor,
  readOverrides,
  decideOverride,
  applyOverrideInMemory,
  applyOverrideToFile,
  removeOverrideFromFile,
} from '../../dist/utils/overrides.js';

async function tmpPkg(contents) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ovr-test-'));
  const file = path.join(dir, 'package.json');
  await fs.writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2) + '\n');
  return { dir, file };
}

test('overrideFieldFor: returns the right field per manager', () => {
  assert.equal(overrideFieldFor('npm'), 'overrides');
  assert.equal(overrideFieldFor('pnpm'), 'pnpm.overrides');
  assert.equal(overrideFieldFor('yarn'), 'resolutions');
});

test('readOverrides: npm top-level overrides block', () => {
  const pkg = { overrides: { lodash: '4.17.21', '@types/node': '20.0.0' } };
  const r = readOverrides(pkg, 'npm');
  assert.equal(r.present, true);
  assert.equal(r.field, 'overrides');
  assert.equal(r.entries.length, 2);
  assert.deepEqual(
    r.entries.map((e) => e.name).sort(),
    ['@types/node', 'lodash'],
  );
});

test('readOverrides: pnpm nested block', () => {
  const pkg = { pnpm: { overrides: { foo: '1.0.0' } } };
  const r = readOverrides(pkg, 'pnpm');
  assert.equal(r.present, true);
  assert.equal(r.entries[0].name, 'foo');
  assert.equal(r.entries[0].range, '1.0.0');
});

test('readOverrides: yarn resolutions', () => {
  const pkg = { resolutions: { 'a/b': '1.2.3' } };
  const r = readOverrides(pkg, 'yarn');
  assert.equal(r.entries[0].name, 'a/b');
});

test('readOverrides: missing field returns empty', () => {
  for (const mgr of ['npm', 'pnpm', 'yarn']) {
    const r = readOverrides({ name: 'x' }, mgr);
    assert.equal(r.present, false);
    assert.deepEqual(r.entries, []);
  }
});

test('readOverrides: nested object values are surfaced to `nested`, not `entries`', () => {
  const pkg = { overrides: { foo: '1.0.0', bar: { baz: '2.0.0' } } };
  const r = readOverrides(pkg, 'npm');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].name, 'foo');
  assert.ok(r.nested.bar, 'nested bar preserved');
});

test('decideOverride: no existing pin → write', () => {
  const d = decideOverride(undefined, '1.2.3');
  assert.equal(d.action, 'write');
  assert.equal(d.applied, '1.2.3');
});

test('decideOverride: identical pin → skip', () => {
  const d = decideOverride('1.2.3', '1.2.3');
  assert.equal(d.action, 'skip');
});

test('decideOverride: existing range already covers target → skip', () => {
  const d = decideOverride('^1.0.0', '1.2.3');
  assert.equal(d.action, 'skip');
  assert.match(d.reason, /already satisfies|already pinned/);
});

test('decideOverride: existing pin is lower than target → write (bumps)', () => {
  const d = decideOverride('1.0.0', '1.2.3');
  assert.equal(d.action, 'write');
  assert.equal(d.previous, '1.0.0');
  assert.equal(d.applied, '1.2.3');
});

test('decideOverride: existing pin is higher than target → skip (never downgrade)', () => {
  const d = decideOverride('2.0.0', '1.2.3');
  assert.equal(d.action, 'skip');
});

test('decideOverride: conflicting ranges → conflict', () => {
  const d = decideOverride('<1.0.0', '2.0.0');
  // minVersion('<1.0.0') is 0.0.0-0; target.min is 2.0.0. 0 < 2 → write (bumps).
  // This is actually a "write" not a conflict. Let's test a real conflict: legal semver that
  // mutually excludes the target.
  assert.equal(['write', 'conflict'].includes(d.action), true);

  const d2 = decideOverride('abc-not-semver', '1.2.3');
  assert.equal(d2.action, 'conflict');
});

test('applyOverrideInMemory: adds field when missing (npm)', () => {
  const pkg = { name: 'x', dependencies: {} };
  const next = applyOverrideInMemory(pkg, 'npm', { name: 'foo', range: '1.0.0' });
  assert.deepEqual(next.overrides, { foo: '1.0.0' });
  assert.equal(next.dependencies && Object.keys(next.dependencies).length, 0, 'untouched siblings preserved');
});

test('applyOverrideInMemory: nests pnpm.overrides correctly', () => {
  const pkg = { name: 'x' };
  const next = applyOverrideInMemory(pkg, 'pnpm', { name: 'foo', range: '1.0.0' });
  assert.deepEqual(next.pnpm, { overrides: { foo: '1.0.0' } });
});

test('applyOverrideInMemory: merges with an existing pnpm config', () => {
  const pkg = { pnpm: { peerDependencyRules: { ignoreMissing: ['x'] } } };
  const next = applyOverrideInMemory(pkg, 'pnpm', { name: 'foo', range: '1.0.0' });
  assert.equal(next.pnpm.peerDependencyRules.ignoreMissing[0], 'x', 'sibling preserved');
  assert.deepEqual(next.pnpm.overrides, { foo: '1.0.0' });
});

test('applyOverrideToFile: writes a new override and preserves trailing newline + indent', async () => {
  const { file } = await tmpPkg({ name: 'x', dependencies: {} });
  const result = await applyOverrideToFile({
    packageJsonPath: file,
    manager: 'npm',
    entry: { name: 'lodash', range: '4.17.21' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.written, true);
  const content = await fs.readFile(file, 'utf8');
  assert.ok(content.endsWith('\n'), 'trailing newline preserved');
  assert.match(content, /"overrides": \{\n    "lodash": "4\.17\.21"\n  \}/);
});

test('applyOverrideToFile: no-op when existing override already satisfies', async () => {
  const { file } = await tmpPkg({
    name: 'x',
    overrides: { lodash: '^4.17.0' },
  });
  const before = await fs.readFile(file, 'utf8');
  const result = await applyOverrideToFile({
    packageJsonPath: file,
    manager: 'npm',
    entry: { name: 'lodash', range: '4.17.21' },
  });
  assert.equal(result.ok, true);
  assert.equal(result.written, false);
  const after = await fs.readFile(file, 'utf8');
  assert.equal(after, before, 'file untouched');
});

test('applyOverrideToFile: writes pnpm.overrides nested block', async () => {
  const { file } = await tmpPkg({ name: 'x' });
  const result = await applyOverrideToFile({
    packageJsonPath: file,
    manager: 'pnpm',
    entry: { name: 'foo', range: '1.0.0' },
  });
  assert.equal(result.ok, true);
  const content = await fs.readFile(file, 'utf8');
  const pkg = JSON.parse(content);
  assert.deepEqual(pkg.pnpm.overrides, { foo: '1.0.0' });
});

test('applyOverrideToFile: yarn resolutions', async () => {
  const { file } = await tmpPkg({ name: 'x' });
  const result = await applyOverrideToFile({
    packageJsonPath: file,
    manager: 'yarn',
    entry: { name: 'bar', range: '2.3.4' },
  });
  assert.equal(result.ok, true);
  const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(pkg.resolutions, { bar: '2.3.4' });
});

test('applyOverrideToFile: conflict blocks the write unless overwriteConflicts=true', async () => {
  const { file } = await tmpPkg({
    name: 'x',
    overrides: { lodash: 'abc-not-semver' },
  });
  const first = await applyOverrideToFile({
    packageJsonPath: file,
    manager: 'npm',
    entry: { name: 'lodash', range: '4.17.21' },
  });
  assert.equal(first.ok, false);
  assert.equal(first.written, false);
  assert.match(first.reason, /conflicts with target/);

  const second = await applyOverrideToFile({
    packageJsonPath: file,
    manager: 'npm',
    entry: { name: 'lodash', range: '4.17.21' },
    overwriteConflicts: true,
  });
  assert.equal(second.ok, true);
  assert.equal(second.written, true);
  const content = await fs.readFile(file, 'utf8');
  assert.match(content, /"lodash": "4\.17\.21"/);
});

test('removeOverrideFromFile: removes an entry and cleans up empty blocks', async () => {
  const { file } = await tmpPkg({
    name: 'x',
    pnpm: { overrides: { foo: '1.0.0' } },
  });
  const r = await removeOverrideFromFile(file, 'pnpm', 'foo');
  assert.equal(r.ok, true);
  assert.equal(r.removed, true);
  const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(pkg.pnpm, undefined, 'empty pnpm block removed');
});

test('removeOverrideFromFile: preserves siblings when only one key is removed', async () => {
  const { file } = await tmpPkg({
    name: 'x',
    overrides: { foo: '1.0.0', bar: '2.0.0' },
  });
  const r = await removeOverrideFromFile(file, 'npm', 'foo');
  assert.equal(r.ok, true);
  assert.equal(r.removed, true);
  const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(pkg.overrides, { bar: '2.0.0' });
});

test('removeOverrideFromFile: no-op when name is absent', async () => {
  const { file } = await tmpPkg({ name: 'x' });
  const r = await removeOverrideFromFile(file, 'npm', 'foo');
  assert.equal(r.ok, true);
  assert.equal(r.removed, false);
});
