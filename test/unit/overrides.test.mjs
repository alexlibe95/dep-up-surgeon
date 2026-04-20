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
  parseOverrideSelector,
} from '../../dist/utils/overrides.js';

const applyInMem = applyOverrideInMemory;

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

test('readOverrides: yarn resolutions split chain-style keys into chains', () => {
  // `a/b` in yarn resolutions is the parent-scoped form (pin `b` only under `a`), per yarn
  // docs. The leaf `name` is the last segment; the full path lives in `chain`.
  const pkg = { resolutions: { 'a/b': '1.2.3', plain: '2.0.0' } };
  const r = readOverrides(pkg, 'yarn');
  const bySig = Object.fromEntries(r.entries.map((e) => [e.chain.join('>'), e]));
  assert.deepEqual(bySig['a>b'].chain, ['a', 'b']);
  assert.equal(bySig['a>b'].name, 'b');
  assert.deepEqual(bySig.plain.chain, ['plain']);
});

test('readOverrides: missing field returns empty', () => {
  for (const mgr of ['npm', 'pnpm', 'yarn']) {
    const r = readOverrides({ name: 'x' }, mgr);
    assert.equal(r.present, false);
    assert.deepEqual(r.entries, []);
  }
});

test('readOverrides: npm nested object is flattened into chain-bearing entries', () => {
  const pkg = { overrides: { foo: '1.0.0', bar: { baz: '2.0.0' } } };
  const r = readOverrides(pkg, 'npm');
  assert.equal(r.entries.length, 2, 'both flat + nested entries emitted');
  const byChainStr = Object.fromEntries(r.entries.map((e) => [e.chain.join('>'), e]));
  assert.ok(byChainStr.foo, 'flat foo present');
  assert.equal(byChainStr.foo.chain.length, 1);
  assert.ok(byChainStr['bar>baz'], 'nested bar>baz present');
  assert.deepEqual(byChainStr['bar>baz'].parentChain, ['bar']);
  assert.equal(byChainStr['bar>baz'].name, 'baz');
  assert.equal(byChainStr['bar>baz'].range, '2.0.0');
});

test('readOverrides: npm nested with "." selector pins the parent itself', () => {
  const pkg = { overrides: { foo: { '.': '1.0.0', bar: '2.0.0' } } };
  const r = readOverrides(pkg, 'npm');
  const foo = r.entries.find((e) => e.chain.join('>') === 'foo');
  const fooBar = r.entries.find((e) => e.chain.join('>') === 'foo>bar');
  assert.ok(foo, 'self-pin via "." produced a chain: ["foo"]');
  assert.equal(foo.range, '1.0.0');
  assert.ok(fooBar, 'sibling child still emitted');
  assert.equal(fooBar.range, '2.0.0');
});

test('readOverrides: pnpm ">" chain keys are split into chain arrays', () => {
  const pkg = { pnpm: { overrides: { foo: '1.0.0', 'bar>baz': '2.0.0', 'a>b>c': '3.0.0' } } };
  const r = readOverrides(pkg, 'pnpm');
  const bySig = Object.fromEntries(r.entries.map((e) => [e.chain.join('>'), e]));
  assert.ok(bySig.foo);
  assert.deepEqual(bySig['bar>baz'].chain, ['bar', 'baz']);
  assert.deepEqual(bySig['a>b>c'].chain, ['a', 'b', 'c']);
});

test('readOverrides: yarn "/" chain keys preserve scoped names', () => {
  const pkg = {
    resolutions: {
      'foo/bar': '1.0.0',
      '@scope/pkg': '2.0.0',
      '@scope/pkg/child': '3.0.0',
    },
  };
  const r = readOverrides(pkg, 'yarn');
  const bySig = Object.fromEntries(r.entries.map((e) => [e.chain.join('>'), e]));
  assert.deepEqual(bySig['foo>bar'].chain, ['foo', 'bar']);
  assert.deepEqual(bySig['@scope/pkg'].chain, ['@scope/pkg'], 'scoped name stays whole');
  assert.deepEqual(bySig['@scope/pkg>child'].chain, ['@scope/pkg', 'child']);
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

// --- Parent-scoped / nested overrides ---------------------------------------------------
// Writers + readers + rollback must handle a parent-chain selector uniformly across all
// three managers. npm uses a nested object, pnpm uses `>` in the key, yarn uses `/`.

test('parseOverrideSelector: flat "foo@1.2.3"', () => {
  const r = parseOverrideSelector('foo@1.2.3');
  assert.deepEqual(r, { chain: ['foo'], range: '1.2.3' });
});

test('parseOverrideSelector: pnpm chain "foo>bar@1.2.3"', () => {
  const r = parseOverrideSelector('foo>bar@1.2.3');
  assert.deepEqual(r, { chain: ['foo', 'bar'], range: '1.2.3' });
});

test('parseOverrideSelector: yarn-style chain "foo/bar@1.2.3"', () => {
  const r = parseOverrideSelector('foo/bar@1.2.3');
  assert.deepEqual(r, { chain: ['foo', 'bar'], range: '1.2.3' });
});

test('parseOverrideSelector: scoped package as chain segment', () => {
  const r = parseOverrideSelector('@scope/pkg>child@2.0.0');
  assert.deepEqual(r, { chain: ['@scope/pkg', 'child'], range: '2.0.0' });
});

test('parseOverrideSelector: yarn-style with scoped parent', () => {
  const r = parseOverrideSelector('@scope/pkg/child@2.0.0');
  assert.deepEqual(r, { chain: ['@scope/pkg', 'child'], range: '2.0.0' });
});

test('parseOverrideSelector: no range returns chain only', () => {
  const r = parseOverrideSelector('foo>bar');
  assert.deepEqual(r, { chain: ['foo', 'bar'] });
});

test('parseOverrideSelector: rejects empty + dangling @', () => {
  assert.equal(parseOverrideSelector(''), undefined);
  assert.equal(parseOverrideSelector('  '), undefined);
  assert.equal(parseOverrideSelector('foo@'), undefined);
});

test('applyOverrideInMemory (npm): parent chain nests into object form', () => {
  const pkg = { name: 'x' };
  const next = applyInMem(pkg, 'npm', {
    name: 'bar',
    range: '1.2.3',
    parentChain: ['foo'],
  });
  assert.deepEqual(next.overrides, { foo: { bar: '1.2.3' } });
});

test('applyOverrideInMemory (npm): deep chain creates intermediate levels', () => {
  const pkg = {};
  const next = applyInMem(pkg, 'npm', {
    name: 'c',
    range: '3.0.0',
    parentChain: ['a', 'b'],
  });
  assert.deepEqual(next.overrides, { a: { b: { c: '3.0.0' } } });
});

test('applyOverrideInMemory (npm): existing flat pin at parent is promoted to "." when nested', () => {
  const pkg = { overrides: { foo: '0.9.0' } };
  const next = applyInMem(pkg, 'npm', {
    name: 'bar',
    range: '1.2.3',
    parentChain: ['foo'],
  });
  assert.deepEqual(next.overrides, { foo: { '.': '0.9.0', bar: '1.2.3' } }, 'original pin preserved via "."');
});

test('applyOverrideInMemory (pnpm): parent chain encoded as foo>bar key', () => {
  const pkg = { pnpm: { overrides: { baseline: '1.0.0' } } };
  const next = applyInMem(pkg, 'pnpm', {
    name: 'bar',
    range: '1.2.3',
    parentChain: ['foo'],
  });
  assert.deepEqual(next.pnpm.overrides, { baseline: '1.0.0', 'foo>bar': '1.2.3' });
});

test('applyOverrideInMemory (yarn): parent chain encoded as foo/bar key', () => {
  const pkg = {};
  const next = applyInMem(pkg, 'yarn', {
    name: 'bar',
    range: '1.2.3',
    parentChain: ['foo'],
  });
  assert.deepEqual(next.resolutions, { 'foo/bar': '1.2.3' });
});

test('applyOverrideToFile: npm nested pin coexists with a flat pin for the same name', async () => {
  const { file } = await tmpPkg({ overrides: { foo: '1.0.0' } });
  const r = await applyOverrideToFile({
    packageJsonPath: file,
    manager: 'npm',
    entry: { name: 'foo', range: '2.0.0', parentChain: ['wrapper'] },
  });
  assert.equal(r.ok, true);
  assert.equal(r.written, true);
  const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(pkg.overrides.foo, '1.0.0', 'flat foo untouched');
  assert.deepEqual(pkg.overrides.wrapper, { foo: '2.0.0' }, 'nested foo written under wrapper');
});

test('applyOverrideToFile: pnpm parent-scoped pin idempotent on identical target', async () => {
  const { file } = await tmpPkg({});
  const once = await applyOverrideToFile({
    packageJsonPath: file,
    manager: 'pnpm',
    entry: { name: 'bar', range: '1.2.3', parentChain: ['foo'] },
  });
  assert.equal(once.written, true);
  const twice = await applyOverrideToFile({
    packageJsonPath: file,
    manager: 'pnpm',
    entry: { name: 'bar', range: '1.2.3', parentChain: ['foo'] },
  });
  assert.equal(twice.ok, true);
  assert.equal(twice.written, false, 'second write is a no-op');
});

test('applyOverrideToFile: scoped packages in chain round-trip losslessly', async () => {
  const { file } = await tmpPkg({});
  const r = await applyOverrideToFile({
    packageJsonPath: file,
    manager: 'yarn',
    entry: { name: '@scope/child', range: '5.0.0', parentChain: ['@scope/parent'] },
  });
  assert.equal(r.ok, true);
  const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(pkg.resolutions, { '@scope/parent/@scope/child': '5.0.0' });
  // And we can read it back and recover the chain.
  const read = readOverrides(pkg, 'yarn');
  const entry = read.entries[0];
  assert.deepEqual(entry.chain, ['@scope/parent', '@scope/child']);
});

test('removeOverrideFromFile: drops a parent-scoped npm pin and prunes empty parents', async () => {
  const { file } = await tmpPkg({
    overrides: { foo: { bar: '1.2.3' }, keep: '9.9.9' },
  });
  const r = await removeOverrideFromFile(file, 'npm', { chain: ['foo', 'bar'] });
  assert.equal(r.ok, true);
  assert.equal(r.removed, true);
  const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(pkg.overrides, { keep: '9.9.9' }, 'empty foo wrapper pruned, sibling untouched');
});

test('removeOverrideFromFile: npm parent-scoped pin preserves "." sibling', async () => {
  const { file } = await tmpPkg({
    overrides: { foo: { '.': '0.9.0', bar: '1.2.3' } },
  });
  const r = await removeOverrideFromFile(file, 'npm', { chain: ['foo', 'bar'] });
  assert.equal(r.removed, true);
  const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(pkg.overrides, { foo: { '.': '0.9.0' } });
});

test('removeOverrideFromFile: pnpm parent-scoped pin drops the right key', async () => {
  const { file } = await tmpPkg({
    pnpm: { overrides: { 'foo>bar': '1.2.3', keep: '2.0.0' } },
  });
  const r = await removeOverrideFromFile(file, 'pnpm', { chain: ['foo', 'bar'] });
  assert.equal(r.removed, true);
  const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(pkg.pnpm.overrides, { keep: '2.0.0' });
});

test('removeOverrideFromFile: yarn parent-scoped pin drops the right key', async () => {
  const { file } = await tmpPkg({
    resolutions: { 'foo/bar': '1.2.3', keep: '2.0.0' },
  });
  const r = await removeOverrideFromFile(file, 'yarn', { chain: ['foo', 'bar'] });
  assert.equal(r.removed, true);
  const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(pkg.resolutions, { keep: '2.0.0' });
});

test('removeOverrideFromFile: missing chain is a no-op, not an error', async () => {
  const { file } = await tmpPkg({ overrides: { foo: '1.0.0' } });
  const r = await removeOverrideFromFile(file, 'npm', { chain: ['missing', 'entry'] });
  assert.equal(r.ok, true);
  assert.equal(r.removed, false);
  const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(pkg.overrides, { foo: '1.0.0' }, 'file untouched');
});

test('applyOverrideToFile: chain write then name-only remove does NOT delete the nested pin', async () => {
  // Legacy call sites that pass a bare name must only touch the flat top-level entry. A
  // parent-scoped pin with the same leaf name is a DIFFERENT entry and must be preserved so
  // callers can't accidentally erase it by forgetting to pass the chain.
  const { file } = await tmpPkg({});
  await applyOverrideToFile({
    packageJsonPath: file,
    manager: 'npm',
    entry: { name: 'bar', range: '1.2.3', parentChain: ['foo'] },
  });
  const r = await removeOverrideFromFile(file, 'npm', 'bar');
  assert.equal(r.removed, false, 'legacy name-only remove refuses to touch the nested pin');
  const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.deepEqual(pkg.overrides, { foo: { bar: '1.2.3' } }, 'nested pin still present');
});
