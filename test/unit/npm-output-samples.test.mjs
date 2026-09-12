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
const {
  classifiedHasPeerLikeFailure,
  extractClassifiedConflicts,
  mergeParsedConflicts,
  shouldRollbackAfterSuccessfulInstall,
} = await import(path.join(root, 'dist/core/conflictAnalyzer.js'));

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

// npm exit 0 + only override warnings: keep the install (do not post-install roll back)
test('shouldRollbackAfterSuccessfulInstall: false for npm ERESOLVE override warnings', () => {
  const out = [
    'npm warn ERESOLVE overriding peer dependency',
    'npm warn While resolving: eslint-plugin-react@7.37.5',
    'npm warn peer eslint@"^3" from eslint-plugin-react@7.37.5',
  ].join('\n');
  const c = extractClassifiedConflicts(out);
  assert.ok(c.length > 0);
  assert.strictEqual(shouldRollbackAfterSuccessfulInstall(out, c, false, 'npm'), false);
});

test('shouldRollbackAfterSuccessfulInstall: true when npm hard ERESOLVE even if override text appears', () => {
  const out = [
    'npm warn ERESOLVE overriding peer dependency',
    'npm error code ERESOLVE',
    'npm error ERESOLVE unable to resolve dependency tree',
  ].join('\n');
  const c = extractClassifiedConflicts(out);
  assert.ok(c.length > 0);
  assert.strictEqual(shouldRollbackAfterSuccessfulInstall(out, c, false, 'npm'), true);
});

test('shouldRollbackAfterSuccessfulInstall: no override keyword in log → still roll back', () => {
  const out = 'npm warn peer eslint@"9" from eslint-plugin@1.0.0';
  const c = extractClassifiedConflicts(out);
  assert.ok(c.length > 0, 'expected peer tuple');
  assert.strictEqual(shouldRollbackAfterSuccessfulInstall(out, c, false, 'npm'), true);
});

// ---------------------------------------------------------------------------
// Engine warnings: npm prints EBADENGINE for ANY package in the tree whose `engines` doesn't
// match, on installs that exit 0. They are reported, but must never undo the install.
// ---------------------------------------------------------------------------

test('shouldRollbackAfterSuccessfulInstall: npm EBADENGINE warning alone does not roll back', () => {
  const out = [
    'npm warn EBADENGINE Unsupported engine {',
    "npm warn EBADENGINE   package: 'undici@7.16.0',",
    "npm warn EBADENGINE   required: { node: '>=20.18.1' },",
    "npm warn EBADENGINE   current: { node: 'v18.20.4', npm: '10.8.2' }",
    'npm warn EBADENGINE }',
    '',
    'changed 1 package, and audited 412 packages in 3s',
  ].join('\n');
  const c = extractClassifiedConflicts(out);
  assert.ok(c.some((x) => x.category === 'incompatibleEngine'), 'engine row is still reported');
  assert.strictEqual(shouldRollbackAfterSuccessfulInstall(out, c, false, 'npm'), false);
});

test('shouldRollbackAfterSuccessfulInstall: pnpm Unsupported engine warning alone does not roll back', () => {
  const out = [
    ' WARN  Unsupported engine: wanted: {"node":">=18"} (current: {"node":"v16.20.0","pnpm":"9.0.0"})',
    'Packages: +1',
    'Done in 1.2s',
  ].join('\n');
  const c = extractClassifiedConflicts(out);
  assert.ok(c.some((x) => x.category === 'incompatibleEngine'), 'engine row is still reported');
  assert.strictEqual(shouldRollbackAfterSuccessfulInstall(out, c, false, 'pnpm'), false);
});

test('shouldRollbackAfterSuccessfulInstall: an engine warning does not mask a real npm peer row', () => {
  const out = [
    'npm warn EBADENGINE Unsupported engine {',
    "npm warn EBADENGINE   package: 'undici@7.16.0',",
    'npm warn EBADENGINE }',
    'npm warn peer eslint@"9" from eslint-plugin@1.0.0',
  ].join('\n');
  const c = extractClassifiedConflicts(out);
  assert.strictEqual(shouldRollbackAfterSuccessfulInstall(out, c, false, 'npm'), true);
});

// ---------------------------------------------------------------------------
// pnpm / yarn / bun unmet-peer warnings are routine on exit 0 (like npm's "overriding peer
// dependency"). They must classify a NON-zero exit as a peer failure (resolver runs) but
// must not roll back an install that succeeded.
// ---------------------------------------------------------------------------

test('pnpm peer issues on exit 0: peer-like rows, but no rollback', () => {
  const out = [
    'Progress: resolved 312, reused 290, downloaded 0, added 0, done',
    ' WARN  Issues with peer dependencies found',
    '.',
    '└─┬ @testing-library/react 16.0.0',
    '  ├── ✕ missing peer react-dom@"^18.0.0"',
    '  └── ✕ unmet peer react@"^18.0.0": found 17.0.2',
    '',
    'Done in 2.1s',
  ].join('\n');
  const c = extractClassifiedConflicts(out);
  assert.ok(classifiedHasPeerLikeFailure(c));
  assert.strictEqual(shouldRollbackAfterSuccessfulInstall(out, c, false, 'pnpm'), false);
});

test('pnpm ERR_PNPM_PEER_DEP_ISSUES: peer-like failure, and strict if it ever shows on exit 0', () => {
  const out = [
    ' ERR_PNPM_PEER_DEP_ISSUES  Unmet peer dependencies',
    '',
    '.',
    '└─┬ @testing-library/react 16.0.0',
    '  └── ✕ unmet peer react@"^18.0.0": found 17.0.2',
  ].join('\n');
  const c = extractClassifiedConflicts(out);
  assert.ok(classifiedHasPeerLikeFailure(c));
  assert.strictEqual(shouldRollbackAfterSuccessfulInstall(out, c, false, 'pnpm'), true);
  const truncated = ' ERR_PNPM_PEER_DEP_ISSUES  Unmet peer dependencies';
  assert.ok(classifiedHasPeerLikeFailure(extractClassifiedConflicts(truncated)));
});

test('yarn classic peer warnings on exit 0: peer-like rows, but no rollback', () => {
  const out = [
    'yarn install v1.22.22',
    '[3/4] Linking dependencies...',
    'warning " > @testing-library/react@16.0.0" has unmet peer dependency "react-dom@^18.0.0".',
    'warning " > @testing-library/react@16.0.0" has incorrect peer dependency "react@^18.0.0".',
    '[4/4] Building fresh packages...',
    'Done in 3.42s.',
  ].join('\n');
  const c = extractClassifiedConflicts(out);
  assert.ok(classifiedHasPeerLikeFailure(c));
  assert.strictEqual(shouldRollbackAfterSuccessfulInstall(out, c, false, 'yarn'), false);
});

test('yarn berry YN0060 / YN0002 / YN0086 on exit 0: peer-like rows, but no rollback', () => {
  const out = [
    '➤ YN0000: ┌ Resolution step',
    "➤ YN0060: │ react is listed by your project with version 17.0.2 (p1a2b3), which doesn't satisfy what @testing-library/react requests (^18.0.0).",
    "➤ YN0002: │ my-app@workspace:. doesn't provide react-dom (p4c5d6), requested by @testing-library/react.",
    '➤ YN0086: │ Some peer dependencies are incorrectly met by dependencies; run yarn explain peer-requirements for details.',
    '➤ YN0000: └ Completed in 0s 412ms',
    '➤ YN0000: · Done with warnings in 2s 104ms',
  ].join('\n');
  const c = extractClassifiedConflicts(out, { rootPackageName: 'my-app' });
  assert.ok(classifiedHasPeerLikeFailure(c));
  assert.strictEqual(shouldRollbackAfterSuccessfulInstall(out, c, false, 'yarn'), false);
});

test('bun incorrect peer dependency on exit 0: peer-like rows, but no rollback', () => {
  const out = [
    'bun install v1.2.19 (aad3abea)',
    'warn: incorrect peer dependency "react@17.0.2"',
    '',
    '+ @testing-library/react@16.0.0',
    '',
    '1 package installed [812.00ms]',
  ].join('\n');
  const c = extractClassifiedConflicts(out);
  assert.ok(classifiedHasPeerLikeFailure(c));
  assert.strictEqual(shouldRollbackAfterSuccessfulInstall(out, c, false, 'bun'), false);
});
