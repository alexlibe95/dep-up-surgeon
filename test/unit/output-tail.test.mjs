/**
 * Unit tests for the shared tail() helper used by install + validation diagnostics.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { tailLines, DEFAULT_OUTPUT_TAIL_LINES } = await import(
  path.join(root, 'dist/utils/output.js')
);

test('tailLines: returns undefined for empty input', () => {
  assert.strictEqual(tailLines(undefined), undefined);
  assert.strictEqual(tailLines(''), undefined);
});

test('tailLines: returns full text when fewer than n lines', () => {
  const txt = 'one\ntwo\nthree';
  assert.strictEqual(tailLines(txt, 10), txt);
});

test('tailLines: keeps last n lines when output is longer', () => {
  const txt = Array.from({ length: 60 }, (_, i) => `line${i + 1}`).join('\n');
  const out = tailLines(txt, 5);
  assert.strictEqual(out, 'line56\nline57\nline58\nline59\nline60');
});

test('tailLines: defaults to DEFAULT_OUTPUT_TAIL_LINES', () => {
  assert.strictEqual(typeof DEFAULT_OUTPUT_TAIL_LINES, 'number');
  assert.ok(DEFAULT_OUTPUT_TAIL_LINES >= 20 && DEFAULT_OUTPUT_TAIL_LINES <= 100);
  const txt = Array.from({ length: DEFAULT_OUTPUT_TAIL_LINES + 5 }, (_, i) => `l${i}`).join('\n');
  const out = tailLines(txt);
  assert.strictEqual(out.split('\n').length, DEFAULT_OUTPUT_TAIL_LINES);
});

test('tailLines: handles \\r\\n line endings', () => {
  const txt = 'a\r\nb\r\nc\r\nd';
  assert.strictEqual(tailLines(txt, 2), 'c\nd');
});
