/**
 * Dedicated entry point for `dep-up-surgeon outdated`. Read-only report of installed vs
 * registry latest — no mutations. Exit 1 when any package is outdated (CI-friendly).
 */
import path from 'node:path';
import { Command } from 'commander';
import { log } from '../utils/logger.js';
import { renderOutdatedHuman, runOutdated } from './outdated.js';

export async function runOutdatedCommand(argv: string[], version: string): Promise<void> {
  const cmd = new Command();
  cmd
    .name('dep-up-surgeon outdated')
    .description(
      'Report which direct dependencies are behind registry @latest (installed version from ' +
        'the lockfile when available). Read-only. Exits 1 if any package is outdated, 0 otherwise. ' +
        'Use before an upgrade run, or in CI as a soft gate.',
    )
    .version(version)
    .option('--json', 'Emit the structured OutdatedReport as JSON on stdout.', false)
    .option(
      '--include-peers',
      'Include peerDependencies in the report (skipped by default).',
      false,
    )
    .option(
      '--package-manager <mgr>',
      'Override detected package manager: auto (default), npm, pnpm, or yarn.',
      'auto',
    )
    .option('--cwd <path>', 'Run against this directory instead of the current one.');

  const forwarded = [argv[0]!, argv[1]!, ...argv.slice(3)];
  cmd.parse(forwarded);
  const opts = cmd.opts<{
    json?: boolean;
    includePeers?: boolean;
    packageManager?: string;
    cwd?: string;
  }>();

  const cwd = opts.cwd ? path.resolve(process.cwd(), opts.cwd) : process.cwd();

  try {
    const report = await runOutdated({
      cwd,
      includePeers: Boolean(opts.includePeers),
      json: Boolean(opts.json),
      ...(opts.packageManager && opts.packageManager !== 'auto'
        ? { packageManager: opts.packageManager as 'npm' | 'pnpm' | 'yarn' }
        : {}),
    });

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(`${renderOutdatedHuman(report)}\n`);
    }
    process.exitCode = report.summary.outdated > 0 ? 1 : 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
    } else {
      log.error(msg);
    }
    process.exitCode = 2;
  }
}
