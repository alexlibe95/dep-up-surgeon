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

test('--json --progress: progress lines go to stderr, stdout is only the report', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-progress-'));
  // No dependencies and no validator script: no registry access, and pre-flight has something to say.
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app', version: '1.0.0' }));
  const cli = path.join(root, 'dist/cli.js');
  const run = (...flags) =>
    spawnSync(process.execPath, [cli, '--cwd', dir, '--json', ...flags], {
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    });

  const quiet = run();
  assert.strictEqual(quiet.status, 0, quiet.stderr);
  assert.ok(JSON.parse(quiet.stdout).upgraded);
  assert.doesNotMatch(quiet.stderr, /No test, build, lint or typecheck script/);

  const progress = run('--progress');
  assert.strictEqual(progress.status, 0, progress.stderr);
  assert.ok(JSON.parse(progress.stdout).upgraded);
  assert.match(progress.stderr, /No test, build, lint or typecheck script/);
  assert.match(progress.stderr, /for undo \/ --retry-failed \/ CI/);
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
