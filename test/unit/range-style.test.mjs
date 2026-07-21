/**
 * Unit tests for range-style preservation helpers.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const { detectRangeStyle, formatUpgradeRange } = await import(
  path.join(root, 'dist', 'utils', 'rangeStyle.js')
);

test('detectRangeStyle: caret / tilde / exact / other', () => {
  assert.strictEqual(detectRangeStyle('^1.2.3'), 'caret');
  assert.strictEqual(detectRangeStyle('~1.2.3'), 'tilde');
  assert.strictEqual(detectRangeStyle('1.2.3'), 'exact');
  assert.strictEqual(detectRangeStyle('>=1.2.3 <2'), 'other');
  assert.strictEqual(detectRangeStyle('*'), 'other');
});

test('formatUpgradeRange: preserves caret and tilde', () => {
  assert.strictEqual(formatUpgradeRange('^1.0.0', '2.0.0'), '^2.0.0');
  assert.strictEqual(formatUpgradeRange('~1.0.0', '1.5.0'), '~1.5.0');
  assert.strictEqual(formatUpgradeRange('1.0.0', '1.5.0'), '1.5.0');
  assert.strictEqual(formatUpgradeRange('>=1.0.0', '2.0.0'), '2.0.0');
});
