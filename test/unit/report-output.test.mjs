/**
 * Output hygiene: free text can't split a markdown table row with `|`, and `--json` sends log
 * lines to stderr so stdout is nothing but the report.
 */
import assert from 'node:assert';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { renderSummaryMarkdown } = await import(path.join(root, 'dist/cli/summary.js'));

test('renderSummaryMarkdown: a `|` in a failure message does not add table columns', () => {
  const md = renderSummaryMarkdown(
    {
      upgraded: [],
      skipped: [],
      conflicts: [],
      unresolved: [],
      groups: [],
      ignored: [],
      failed: [
        {
          name: 'react-dom',
          reason: 'peer',
          previousVersion: '^17.0.2',
          attemptedVersion: '19.0.0',
          message: 'peer react@"^16.8.0 || ^17.0.0 || ^18.0.0" from @testing-library/react@14.0.0',
        },
      ],
    },
    '0.0.0-test',
  );
  const row = md.split('\n').find((l) => l.includes('react-dom'));
  assert.ok(row, md);
  // Five cells → six unescaped pipes.
  assert.strictEqual((row.match(/(?<!\\)\|/g) ?? []).length, 6, row);
  assert.ok(row.includes('^16.8.0 \\|\\| ^17.0.0'), row);
});

test('setLogToStderr: log lines go to stderr and stdout stays valid JSON', () => {
  const logger = pathToFileURL(path.join(root, 'dist/utils/logger.js')).href;
  const script = [
    `const { log, setLogToStderr } = await import(${JSON.stringify(logger)});`,
    'setLogToStderr(true);',
    "log.warn('careful');",
    "log.error('bad');",
    'console.log(JSON.stringify({ ok: true }));',
  ].join('\n');
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(JSON.parse(r.stdout), { ok: true });
  assert.match(r.stderr, /careful/);
  assert.match(r.stderr, /bad/);
});
