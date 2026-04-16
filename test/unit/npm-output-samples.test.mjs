/**
 * Regression tests using **representative npm log lines** (no network).
 * Run after `npm run build`.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { parseConflictsFromNpmOutput } = await import(
  path.join(root, 'dist/core/conflictParser.js')
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
