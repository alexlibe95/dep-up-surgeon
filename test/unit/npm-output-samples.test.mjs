/**
 * Regression tests using **representative npm log lines** (no network).
 * Run after `npm run build`.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { parseConflictsFromNpmOutput, parseEresolveFallback } = await import(
  path.join(root, 'dist/core/conflictParser.js')
);
const { classifiedHasPeerLikeFailure, extractClassifiedConflicts, mergeParsedConflicts } = await import(
  path.join(root, 'dist/core/conflictAnalyzer.js')
);

test('parse npm ERR! Could not resolve tail: pkg@range (no space before @)', () => {
  const line =
    'npm ERR! Could not resolve dependency: peer react@"^18.2.0" from react-dom@18.2.0';
  const a = parseConflictsFromNpmOutput(line);
  assert.ok(a.length === 0 || a[0].rawMessage.includes('Could not resolve'));
});

test('parse conflicting peer dependency: name@version', () => {
  const line = 'npm ERR! conflicting peer dependency: react@18.2.0';
  const a = parseConflictsFromNpmOutput(line);
  assert.ok(a.length >= 1);
  assert.strictEqual(a[0].dependency, 'react');
});

// ---------------------------------------------------------------------------
// npm 10 ERESOLVE: indented `peer <pkg>@"<range>" from <dep>@<ver>` blocks
// These are the lines we were dropping on Angular 21 + TS 6 (and any similar
// peer-lag mono-framework failure). Each line carries the full (dependent, peer,
// range) tuple we need to drive the peer-range intersection resolver.
// ---------------------------------------------------------------------------

test('parse npm 10 indented peer tuple: scoped dependent', () => {
  const line = '  peer typescript@">=5.9 <6.0" from @angular/build@21.2.8';
  const a = parseConflictsFromNpmOutput(line);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].dependency, 'typescript');
  assert.strictEqual(a[0].requiredRange, '>=5.9 <6.0');
  assert.strictEqual(a[0].depender, '@angular/build@21.2.8');
});

test('parse npm 10 indented peerOptional tuple: scoped peer + scoped dependent', () => {
  const line = '  peerOptional @types/react@">=18.2" from @scope/widget@3.1.0';
  const a = parseConflictsFromNpmOutput(line);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].dependency, '@types/react');
  assert.strictEqual(a[0].requiredRange, '>=18.2');
  assert.strictEqual(a[0].depender, '@scope/widget@3.1.0');
});

test('parse npm 10 indented peer tuple with `npm error` prefix', () => {
  const line = 'npm error   peer react@"^18.2.0" from react-dom@18.2.0';
  const a = parseConflictsFromNpmOutput(line);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].dependency, 'react');
  assert.strictEqual(a[0].requiredRange, '^18.2.0');
  assert.strictEqual(a[0].depender, 'react-dom@18.2.0');
});

test('parseEresolveFallback extracts peer-from tuples from a full ERESOLVE block', () => {
  const block = [
    'npm error code ERESOLVE',
    'npm error ERESOLVE unable to resolve dependency tree',
    'npm error',
    'npm error While resolving: myapp@0.0.0',
    'npm error Found: typescript@6.0.3',
    'npm error node_modules/typescript',
    'npm error   dev typescript@"6.0.3" from the root project',
    'npm error   peerOptional typescript@">=5.9 <6.1" from @angular/compiler-cli@21.2.10',
    'npm error   peer typescript@">=5.9 <6.0" from @angular/build@21.2.8',
    'npm error',
    'npm error Could not resolve dependency:',
    'npm error peer typescript@">=5.9 <6.0" from @angular/build@21.2.8',
  ].join('\n');
  const a = parseEresolveFallback(block);
  // At minimum: both Angular peers extracted (peer + peerOptional, dedup'd by raw line).
  const byDep = a.filter((c) => c.dependency === 'typescript');
  assert.ok(byDep.length >= 2, `expected >=2 typescript tuples, got ${byDep.length}`);
  const ranges = new Set(byDep.map((c) => c.requiredRange));
  assert.ok(ranges.has('>=5.9 <6.0'), 'missing @angular/build peer range');
  assert.ok(ranges.has('>=5.9 <6.1'), 'missing @angular/compiler-cli peerOptional range');
});

test('parseEresolveFallback falls back to unknown marker when no peer tuples match', () => {
  const block = [
    'npm error code ERESOLVE',
    'npm error ERESOLVE unable to resolve dependency tree',
    'npm error some unrelated text with no structured peer lines',
  ].join('\n');
  const a = parseEresolveFallback(block);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].dependency, 'unknown');
});

// ---------------------------------------------------------------------------
// `classifiedHasPeerLikeFailure` — the helper the upgrade engine uses to
// promote a non-zero install exit with peer diagnostics from `kind: 'install'`
// (resolver ignored) to `kind: 'peer'` (resolver invoked). This is the fix for
// the "my Angular 21 bump silently failed with ERESOLVE and nothing retried"
// regression path.
// ---------------------------------------------------------------------------

test('classifiedHasPeerLikeFailure: true for Angular-style ERESOLVE block', () => {
  const block = [
    'npm error code ERESOLVE',
    'npm error ERESOLVE unable to resolve dependency tree',
    'npm error   peer typescript@">=5.9 <6.0" from @angular/build@21.2.8',
    'npm error Could not resolve dependency:',
    'npm error peer typescript@">=5.9 <6.0" from @angular/build@21.2.8',
  ].join('\n');
  const classified = extractClassifiedConflicts(block);
  assert.ok(classifiedHasPeerLikeFailure(classified));
});

test('classifiedHasPeerLikeFailure: false for empty input', () => {
  assert.strictEqual(classifiedHasPeerLikeFailure([]), false);
});

test('classifiedHasPeerLikeFailure: false for engine-only conflicts', () => {
  // EBADENGINE is a node-version mismatch, not something the peer resolver can fix.
  const block = [
    'npm error code EBADENGINE',
    'npm error EBADENGINE Unsupported engine',
  ].join('\n');
  const classified = extractClassifiedConflicts(block);
  assert.strictEqual(classifiedHasPeerLikeFailure(classified), false);
});

// npm warn + exit 0: peer tuples must win over "Conflicting peer dependency: <pkg>@<ver>"
// (hypothetical resolution, wrong `need` label) and "While resolving" (removed; was noise).
test('parse npm warn peer from + npm warn prefix (Next.js / eslint-config-next style)', () => {
  const line =
    'npm warn   peer typescript@">=4.8.4 <6.0.0" from @typescript-eslint/utils@8.56.0';
  const a = parseConflictsFromNpmOutput(line);
  assert.strictEqual(a.length, 1);
  assert.strictEqual(a[0].dependency, 'typescript');
  assert.strictEqual(a[0].depender, '@typescript-eslint/utils@8.56.0');
  assert.match(a[0].requiredRange, /4\.8\.4/);
});

test('parseEresolveFallback picks peer-from tuples with no "npm error" / hard ERESOLVE', () => {
  const onlyWarn = [
    'npm warn peer typescript@">=4.8.4 <6.0.0" from @typescript-eslint/utils@8.56.0',
    'npm warn Conflicting peer dependency: typescript@5.9.3',
  ].join('\n');
  const b = parseEresolveFallback(onlyWarn);
  assert.ok(b.length >= 1);
  assert.ok(b.some((c) => c.dependency === 'typescript' && c.depender.includes('utils@8.56')));
  assert.ok(
    !b.some((c) => c.dependency === 'unknown' && c.depender === 'unknown'),
  );
});

test('merge: suppress unknown-depender “Conflicting peer” when peer-from exists', () => {
  const block = [
    'npm warn peer typescript@">=4.8.4 <6.0.0" from @typescript-eslint/utils@8.56.0',
    'npm warn Conflicting peer dependency: typescript@5.9.3',
  ].join('\n');
  const merged = mergeParsedConflicts(block);
  const hasTuple = merged.some(
    (c) => c.dependency === 'typescript' && c.depender.includes('@typescript-eslint'),
  );
  assert.ok(hasTuple, 'expected peer-from edge');
  const spurious = merged.find(
    (c) => c.dependency === 'typescript' && c.requiredRange === '5.9.3',
  );
  assert.strictEqual(spurious, undefined);
});

test('merge dedupes identical peer edges (line + global extract)', () => {
  const line = 'npm warn peer eslint@"^3" from eslint-plugin-react@7.37.5';
  const block = [line, line, line].join('\n');
  const merged = mergeParsedConflicts(block);
  assert.ok(
    merged.filter(
      (c) =>
        c.dependency === 'eslint' && c.depender === 'eslint-plugin-react@7.37.5' && c.requiredRange === '^3',
    ).length === 1,
  );
});
