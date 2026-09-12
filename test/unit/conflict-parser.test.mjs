/**
 * Unit tests (no network). Run after `npm run build`.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { parseConflictsFromNpmOutput } = await import(
  path.join(root, 'dist/core/conflictParser.js')
);
const { extractClassifiedConflicts } = await import(
  path.join(root, 'dist/core/conflictAnalyzer.js')
);

test('parseConflictsFromNpmOutput skips root package name when configured', () => {
  const line =
    'npm ERR! requires a peer of crypto-market-dashboard@0.0.0 but none is installed';
  const skip = new Set(['crypto-market-dashboard']);
  const a = parseConflictsFromNpmOutput(line, { skipDependencyNames: skip });
  assert.strictEqual(a.length, 0);
});

test('parseConflictsFromNpmOutput still parses real package lines', () => {
  const line =
    'npm ERR! Conflicting peer dependency: react@18.2.0';
  const a = parseConflictsFromNpmOutput(line);
  assert.ok(a.length >= 1);
  assert.ok(a[0].dependency.includes('react') || a[0].rawMessage.includes('react'));
});

test('extractClassifiedConflicts passes rootPackageName through', () => {
  const out = [
    'npm ERR! requires a peer of my-app@0.0.0 but none is installed',
    'npm ERR! Conflicting peer dependency: foo@1.0.0',
  ].join('\n');
  const c = extractClassifiedConflicts(out, { rootPackageName: 'my-app' });
  const deps = c.map((x) => x.dependency);
  assert.ok(!deps.includes('my-app'));
  assert.ok(deps.includes('foo'));
});

// ---------------------------------------------------------------------------
// pnpm / yarn / bun peer diagnostics (formats taken from pnpm 9 render-peer-issues, yarn
// 1.22 `unmetPeer` / `incorrectPeer`, yarn berry YN0060 / YN0002 / YN0086, bun `warn:`).
// ---------------------------------------------------------------------------

const find = (rows, dependency, depender) =>
  rows.find((c) => c.dependency === dependency && c.depender === depender);

test('pnpm peer issues tree: depender is the enclosing ┬ node, not just the previous one', () => {
  const out = [
    'Progress: resolved 412, reused 398, downloaded 0, added 2, done',
    ' WARN  Issues with peer dependencies found',
    '.',
    '├─┬ @storybook/react 8.4.7',
    '│ ├─┬ @storybook/react-dom-shim 8.4.7',
    '│ │ └── ✕ unmet peer react@"^16.8.0 || ^17.0.0 || ^18.0.0": found 19.0.0',
    '│ └── ✕ unmet peer react-dom@"^16.8.0 || ^17.0.0 || ^18.0.0": found 19.0.0',
    '└─┬ @testing-library/react 16.0.0',
    '  ├── ✕ missing peer @testing-library/dom@^10.0.0',
    '  └── ✕ unmet peer react@^18.0.0: found 17.0.2 in react-dom',
    '',
    'devDependencies:',
    '+ @testing-library/react 16.0.0',
    '',
    'Done in 2.3s',
  ].join('\n');
  const rows = parseConflictsFromNpmOutput(out);
  assert.equal(rows.length, 4);
  const shim = find(rows, 'react', '@storybook/react-dom-shim@8.4.7');
  assert.equal(shim?.requiredRange, '^16.8.0 || ^17.0.0 || ^18.0.0');
  assert.equal(shim?.installedVersion, '19.0.0');
  assert.equal(
    find(rows, 'react-dom', '@storybook/react@8.4.7')?.requiredRange,
    '^16.8.0 || ^17.0.0 || ^18.0.0',
  );
  assert.equal(find(rows, '@testing-library/dom', '@testing-library/react@16.0.0')?.requiredRange, '^10.0.0');
  const tl = find(rows, 'react', '@testing-library/react@16.0.0');
  assert.equal(tl?.requiredRange, '^18.0.0');
  assert.equal(tl?.installedVersion, '17.0.2');
});

test('pnpm peer issues tree: ANSI colors (FORCE_COLOR) do not break parsing', () => {
  const out = [
    '\x1b[33m WARN \x1b[39m Issues with peer dependencies found',
    '.',
    '└─┬ @testing-library/react \x1b[90m16.0.0\x1b[39m',
    '  └── \x1b[93m✕ unmet peer\x1b[39m react@"^18.0.0": found 17.0.2',
  ].join('\n');
  const rows = parseConflictsFromNpmOutput(out);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].depender, '@testing-library/react@16.0.0');
  assert.equal(rows[0].dependency, 'react');
  assert.equal(rows[0].requiredRange, '^18.0.0');
});

test('pnpm strict mode ERR_PNPM_PEER_DEP_ISSUES: structured rows, no catch-all marker', () => {
  const out = [
    ' ERR_PNPM_PEER_DEP_ISSUES  Unmet peer dependencies',
    '',
    '.',
    '└─┬ @testing-library/react 16.0.0',
    '  ├── ✕ missing peer react-dom@"^18.0.0"',
    '  └── ✕ unmet peer react@"^18.0.0": found 17.0.2',
    '',
    'hint: If you want peer dependencies issues to be automatically installed, add "auto-install-peers=true" to an .npmrc file at the root of your project.',
    'hint: If you don\'t want pnpm to fail on peer dependency issues, add "strict-peer-dependencies=false" to an .npmrc file at the root of your project.',
  ].join('\n');
  const c = extractClassifiedConflicts(out);
  assert.equal(c.length, 2);
  const missing = find(c, 'react-dom', '@testing-library/react@16.0.0');
  assert.equal(missing?.requiredRange, '^18.0.0');
  assert.equal(missing?.category, 'missingDependency');
  const unmet = find(c, 'react', '@testing-library/react@16.0.0');
  assert.equal(unmet?.installedVersion, '17.0.2');
  assert.equal(unmet?.category, 'peerDependencyMismatch');
});

test('pnpm ERR_PNPM_PEER_DEP_ISSUES without the tree (truncated log) still yields a row', () => {
  const c = extractClassifiedConflicts(' ERR_PNPM_PEER_DEP_ISSUES  Unmet peer dependencies');
  assert.equal(c.length, 1);
  assert.equal(c[0].dependency, 'unknown');
  assert.notEqual(c[0].category, 'incompatibleEngine');
});

test('yarn classic: unmet / incorrect peer dependency warnings', () => {
  const out = [
    'yarn install v1.22.22',
    '[1/4] Resolving packages...',
    '[2/4] Fetching packages...',
    '[3/4] Linking dependencies...',
    'warning " > @testing-library/react@16.0.0" has unmet peer dependency "@testing-library/dom@^10.0.0".',
    'warning " > @testing-library/react@16.0.0" has incorrect peer dependency "react@^18.0.0".',
    'warning "@storybook/react > @storybook/react-dom-shim@8.4.7" has incorrect peer dependency "react@^16.8.0 || ^17.0.0 || ^18.0.0".',
    '[4/4] Building fresh packages...',
    'success Saved lockfile.',
    'Done in 3.42s.',
  ].join('\n');
  const c = extractClassifiedConflicts(out);
  assert.equal(c.length, 3);
  const dom = find(c, '@testing-library/dom', '@testing-library/react@16.0.0');
  assert.equal(dom?.requiredRange, '^10.0.0');
  assert.equal(dom?.category, 'missingDependency');
  const react = find(c, 'react', '@testing-library/react@16.0.0');
  assert.equal(react?.requiredRange, '^18.0.0');
  assert.equal(react?.category, 'peerDependencyMismatch');
  assert.equal(
    find(c, 'react', '@storybook/react-dom-shim@8.4.7')?.requiredRange,
    '^16.8.0 || ^17.0.0 || ^18.0.0',
  );
});

test('yarn berry: YN0060 / YN0002 / YN0086 peer warnings', () => {
  const out = [
    '➤ YN0000: · Yarn 4.9.1',
    '➤ YN0000: ┌ Resolution step',
    "➤ YN0060: │ react is listed by your project with version 17.0.2 (p1a2b3), which doesn't satisfy what @testing-library/react requests (^18.0.0).",
    "➤ YN0002: │ my-app@workspace:. doesn't provide react-dom (p4c5d6), requested by @testing-library/react.",
    '➤ YN0086: │ Some peer dependencies are incorrectly met by dependencies; run yarn explain peer-requirements for details.',
    '➤ YN0000: └ Completed in 0s 412ms',
    '➤ YN0000: · Done with warnings in 2s 104ms',
  ].join('\n');
  const c = extractClassifiedConflicts(out, { rootPackageName: 'my-app' });
  assert.equal(c.length, 3);
  const incompatible = find(c, 'react', '@testing-library/react');
  assert.equal(incompatible?.requiredRange, '^18.0.0');
  assert.equal(incompatible?.installedVersion, '17.0.2');
  assert.equal(incompatible?.category, 'peerDependencyMismatch');
  const missing = find(c, 'react-dom', '@testing-library/react');
  assert.ok(missing);
  assert.equal(missing.category, 'missingDependency');
  const pointer = c.find((x) => /YN0086/.test(x.rawMessage));
  assert.ok(pointer);
  assert.equal(pointer.category, 'peerDependencyMismatch');
});

test('bun: incorrect peer dependency warning', () => {
  const out = [
    'bun install v1.2.19 (aad3abea)',
    '',
    'warn: incorrect peer dependency "react@17.0.2"',
    'warn: incorrect peer dependency "@types/react@17.0.83"',
    '',
    '+ @testing-library/react@16.0.0',
    '',
    '2 packages installed [1.12s]',
  ].join('\n');
  const c = extractClassifiedConflicts(out);
  assert.equal(c.length, 2);
  assert.equal(find(c, 'react', 'unknown')?.installedVersion, '17.0.2');
  assert.equal(find(c, '@types/react', 'unknown')?.installedVersion, '17.0.83');
  assert.ok(c.every((x) => x.category === 'peerDependencyMismatch'));
});
