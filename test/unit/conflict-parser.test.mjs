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
