/**
 * Unit tests for the persisted last-run report and the `--retry-failed` ignore computation.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const {
  LAST_RUN_FILENAME,
  TERMINAL_RETRY_REASONS,
  computeRetryFailedIgnores,
  loadLastRunReport,
  persistLastRunReport,
} = await import(path.join(root, 'dist/cli/lastRun.js'));

async function makeTmp(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `dus-lr-${prefix}-`));
}

test('TERMINAL_RETRY_REASONS only freezes peer + validation-script', () => {
  assert.ok(TERMINAL_RETRY_REASONS.has('peer'));
  assert.ok(TERMINAL_RETRY_REASONS.has('validation-script'));
  for (const r of ['install', 'validation-conflicts', 'versions', 'unknown']) {
    assert.ok(!TERMINAL_RETRY_REASONS.has(r), `${r} must be retryable`);
  }
});

test('persist + load round-trip', async () => {
  const dir = await makeTmp('roundtrip');
  const structured = {
    upgraded: [{ name: 'axios', success: true, from: '1.0.0', to: '1.6.0' }],
    skipped: [],
    failed: [],
    conflicts: [],
    unresolved: [],
    groups: [],
  };
  const written = await persistLastRunReport(structured, {
    cwd: dir,
    toolVersion: '9.9.9',
    dryRun: false,
  });
  assert.strictEqual(written, path.join(dir, LAST_RUN_FILENAME));

  const loaded = await loadLastRunReport(dir);
  assert.ok(loaded);
  assert.strictEqual(loaded.toolVersion, '9.9.9');
  assert.strictEqual(loaded.dryRun, false);
  assert.strictEqual(loaded.cwd, dir);
  assert.strictEqual(loaded.upgraded[0].name, 'axios');
  assert.match(loaded.finishedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('load returns undefined when file is missing', async () => {
  const dir = await makeTmp('missing');
  const loaded = await loadLastRunReport(dir);
  assert.strictEqual(loaded, undefined);
});

test('computeRetryFailedIgnores: freezes successes + terminal failures, retries the rest', () => {
  const last = {
    upgraded: [
      { name: 'axios', success: true, from: '1.0.0', to: '1.6.0' },
      { name: 'lodash', success: true, skipped: true, reason: 'skipped' },
    ],
    failed: [
      { name: 'react', reason: 'peer', previousVersion: '17.0.0' },
      { name: 'next', reason: 'validation-script', previousVersion: '14.0.0' },
      { name: 'esbuild', reason: 'install', previousVersion: '0.20.0' },
      { name: 'typescript', reason: 'validation-conflicts', previousVersion: '5.0.0' },
      { name: 'rollup', reason: 'unknown', previousVersion: '4.0.0' },
    ],
    groups: [],
    finishedAt: new Date().toISOString(),
    toolVersion: '0.0.0',
    cwd: '/tmp/x',
    dryRun: false,
    skipped: [],
    conflicts: [],
    unresolved: [],
  };

  const r = computeRetryFailedIgnores(last);
  assert.deepStrictEqual([...r.added].sort(), ['axios', 'next', 'react'].sort());
  assert.strictEqual(r.succeededLastRun, 1);
  assert.strictEqual(r.terminalFailuresLastRun, 2);
  assert.deepStrictEqual(r.retryableLastRun.sort(), ['esbuild', 'rollup', 'typescript'].sort());
});

test('computeRetryFailedIgnores: expands [group:<id>] failures to all member packages', () => {
  const last = {
    upgraded: [],
    failed: [
      {
        name: '[group:react-stack]',
        reason: 'peer',
        previousVersion: 'react@17, react-dom@17',
        linkedGroupId: 'react-stack',
      },
      {
        name: '[group:lint-stack]',
        reason: 'install',
        previousVersion: 'eslint@8, prettier@3',
        linkedGroupId: 'lint-stack',
      },
    ],
    groups: [
      { id: 'react-stack', packages: ['react', 'react-dom', '@types/react'] },
      { id: 'workspace::lint-stack', packages: ['eslint', 'prettier'] },
    ],
    finishedAt: new Date().toISOString(),
    toolVersion: '0.0.0',
    cwd: '/tmp/x',
    dryRun: false,
    skipped: [],
    conflicts: [],
    unresolved: [],
  };

  const r = computeRetryFailedIgnores(last);
  // Terminal `peer` group is fully frozen -> all 3 members added.
  // Retryable `install` group keeps its members for retry -> NOT added.
  assert.deepStrictEqual([...r.added].sort(), ['@types/react', 'react', 'react-dom']);
  assert.strictEqual(r.terminalFailuresLastRun, 1);
  assert.deepStrictEqual(r.retryableLastRun, ['[group:lint-stack]']);
});

test('computeRetryFailedIgnores: matches workspace-namespaced group ids on the bare id too', () => {
  // When --workspaces is used, group ids are persisted as `<workspace>::<id>` but the failure
  // row is keyed on `[group:<id>]`. The helper must still find the members.
  const last = {
    upgraded: [],
    failed: [
      {
        name: '[group:tooling]',
        reason: 'peer',
        previousVersion: 'eslint@8, prettier@3',
        linkedGroupId: 'tooling',
      },
    ],
    groups: [{ id: '@org/web::tooling', packages: ['eslint', 'prettier'] }],
    finishedAt: new Date().toISOString(),
    toolVersion: '0.0.0',
    cwd: '/tmp/x',
    dryRun: false,
    skipped: [],
    conflicts: [],
    unresolved: [],
  };
  const r = computeRetryFailedIgnores(last);
  assert.deepStrictEqual([...r.added].sort(), ['eslint', 'prettier']);
});
