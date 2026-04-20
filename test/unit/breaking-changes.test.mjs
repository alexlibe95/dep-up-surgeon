import test from 'node:test';
import assert from 'node:assert/strict';

import { scanForBreakingChanges } from '../../dist/utils/changelog.js';

test('scanForBreakingChanges: empty / undefined body returns no hits', () => {
  for (const body of [undefined, '', '   \n\n  ']) {
    const r = scanForBreakingChanges(body);
    assert.equal(r.hasBreaking, false);
    assert.deepEqual(r.matchedLines, []);
    assert.deepEqual(r.reasons, []);
  }
});

test('scanForBreakingChanges: Conventional Commits BREAKING CHANGE footer', () => {
  const body = [
    '### Features',
    '- add new API',
    '',
    'BREAKING CHANGE: the old `foo()` signature has been replaced.',
  ].join('\n');
  const r = scanForBreakingChanges(body);
  assert.equal(r.hasBreaking, true);
  assert.equal(r.matchedLines.length, 1);
  assert.equal(r.reasons[0], 'BREAKING CHANGE');
  assert.match(r.matchedLines[0], /BREAKING CHANGE/);
});

test('scanForBreakingChanges: 💥 emoji convention (changesets / tsup style)', () => {
  const body = '* 💥 drop ESM-only export in favor of dual-package';
  const r = scanForBreakingChanges(body);
  assert.equal(r.hasBreaking, true);
  assert.equal(r.reasons[0], 'breaking-change emoji');
  // Leading list bullet stripped, prefix emoji preserved.
  assert.match(r.matchedLines[0], /^💥 drop ESM-only/);
});

test('scanForBreakingChanges: Node version drops', () => {
  const r1 = scanForBreakingChanges('- drop support for Node 16');
  assert.equal(r1.hasBreaking, true);
  assert.equal(r1.reasons[0], 'drops Node version');

  const r2 = scanForBreakingChanges('Minimum Node is 20');
  assert.equal(r2.hasBreaking, true);
  assert.equal(r2.reasons[0], 'raises minimum Node');

  const r3 = scanForBreakingChanges('Requires Node >= 18.0.0');
  assert.equal(r3.hasBreaking, true);
  assert.equal(r3.reasons[0], 'raises minimum Node');
});

test('scanForBreakingChanges: API removal / renaming markers', () => {
  const r1 = scanForBreakingChanges('- Removed the deprecated `foo()` export');
  assert.equal(r1.hasBreaking, true);
  assert.equal(r1.reasons[0], 'removed API');

  const r2 = scanForBreakingChanges('`oldName` is no longer exported');
  assert.equal(r2.hasBreaking, true);
  assert.equal(r2.reasons[0], 'no longer supported');

  const r3 = scanForBreakingChanges('- Renamed `foo` to `bar`');
  assert.equal(r3.hasBreaking, true);
  assert.equal(r3.reasons[0], 'renamed export');
});

test('scanForBreakingChanges: non-breaking prose is NOT flagged', () => {
  const body = [
    '### Features',
    '- Added a new option',
    '- Improved performance',
    '- Fixed a deprecation warning emitted on Node 20',
    '- We have removed the bug that caused crashes',
  ].join('\n');
  const r = scanForBreakingChanges(body);
  // "fixed a deprecation" + "removed the bug" should NOT match: no API/option/flag follow-up.
  assert.equal(r.hasBreaking, false, 'false positive on feature prose');
});

test('scanForBreakingChanges: caps at 10 matches + dedupes identical lines', () => {
  const repeated = Array.from({ length: 20 }, () => 'BREAKING CHANGE: foo is gone').join('\n');
  const r = scanForBreakingChanges(repeated);
  assert.equal(r.hasBreaking, true);
  assert.equal(r.matchedLines.length, 1, 'exact dupes collapse to one');
});

test('scanForBreakingChanges: caps at 10 matches for diverse lines', () => {
  const body = Array.from({ length: 15 }, (_, i) => `BREAKING CHANGE #${i}: remove api${i}`).join(
    '\n',
  );
  const r = scanForBreakingChanges(body);
  assert.equal(r.hasBreaking, true);
  assert.equal(r.matchedLines.length, 10, 'hard cap honored');
});

test('scanForBreakingChanges: strips markdown markup from surfaced line', () => {
  const body = '- **BREAKING CHANGE**: use `*new*` API';
  const r = scanForBreakingChanges(body);
  assert.equal(r.hasBreaking, true);
  assert.ok(!r.matchedLines[0].startsWith('-'), 'bullet stripped');
  assert.ok(!r.matchedLines[0].includes('**'), 'bold markers stripped');
  assert.ok(!r.matchedLines[0].includes('`'), 'inline code stripped');
});

test('scanForBreakingChanges: multi-pattern body returns first-match per line', () => {
  const body = [
    'BREAKING CHANGE: drop Node 16',
    '💥 removed the `config` option',
    'Renamed `initV1` to `init`',
  ].join('\n');
  const r = scanForBreakingChanges(body);
  assert.equal(r.matchedLines.length, 3);
  // Labels are per-line; pattern order defines which wins.
  assert.equal(r.reasons[0], 'BREAKING CHANGE');
  assert.equal(r.reasons[1], 'breaking-change emoji');
  assert.equal(r.reasons[2], 'renamed export');
});

test('scanForBreakingChanges: very long lines are truncated', () => {
  const long = 'BREAKING CHANGE: ' + 'x'.repeat(500);
  const r = scanForBreakingChanges(long);
  assert.equal(r.hasBreaking, true);
  assert.ok(r.matchedLines[0].length <= 200, 'line clipped to 200 chars');
  assert.ok(r.matchedLines[0].endsWith('…'));
});

test('scanForBreakingChanges: case-insensitive matching on BREAKING', () => {
  for (const body of ['breaking change: x', 'Breaking Change: y', 'BREAKING_CHANGES: z']) {
    const r = scanForBreakingChanges(body);
    assert.equal(r.hasBreaking, true, `matched "${body}"`);
  }
});
