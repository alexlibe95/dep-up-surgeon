/**
 * Dedicated entry point for `dep-up-surgeon doctor`. We ship this as a separate commander
 * program rather than a subcommand of the main program because the doctor doesn't need (and
 * shouldn't inherit) the 70+ upgrade-flow options — and threading `--doctor` as a flag into
 * the main flow would force us to guard half of that logic against read-only mode.
 *
 * Exit-code contract (see `doctorExitCode`):
 *   - all green → 0
 *   - any red → 2
 *   - yellow only, `--strict` → 1; yellow only, no `--strict` → 0
 */
import path from 'node:path';
import { Command } from 'commander';
import { runDoctor } from './doctor.js';
import { doctorExitCode, renderDoctorHuman } from './doctorRenderer.js';
import { log } from '../utils/logger.js';

export async function runDoctorCommand(argv: string[], version: string): Promise<void> {
  const cmd = new Command();
  cmd
    .name('dep-up-surgeon doctor')
    .description(
      'Run a read-only diagnostic against the current project: manager + lockfile parse, pre-flight validator, peer-dep scan, audit dry-run, stale-transitive scan. No mutations. Exits 0 (green), 1 (yellow under --strict), or 2 (red). Pair with `--json` for machine-readable output in CI.',
    )
    .version(version)
    .option('--json', 'Emit the full `DoctorReport` as JSON on stdout instead of the human format.', false)
    .option('--strict', 'Treat yellow checks as failures (exit 1 instead of 0). Use for CI gates.', false)
    .option(
      '--no-validate',
      'Skip the pre-flight validator check. Use when the project has no test/build script yet or when you only care about lockfile / audit health.',
    )
    .option(
      '--validate <cmd>',
      'Override the validator command used by the pre-flight check (same semantics as the upgrade flow\'s `--validate`).',
    )
    .option('--skip-audit', 'Skip the `<mgr> audit` dry-run. Use for air-gapped CI / offline dev.', false)
    .option('--skip-peer-scan', 'Skip the `<mgr> ls` / `yarn check` peer-dep scan (slow on huge trees).', false)
    .option('--skip-stale-scan', 'Skip the registry-backed stale-transitive scan.', false)
    .option(
      '--package-manager <mgr>',
      'Override detected package manager: auto (default), npm, pnpm, yarn.',
      'auto',
    )
    .option('--cwd <path>', 'Run the diagnostic against this directory instead of the current one.');

  // Remove the `doctor` dispatch token so commander doesn't parse it as a positional.
  // `argv[0]` is node, `argv[1]` is the CLI entry, `argv[2]` is always `doctor` at this
  // point (we only get called when it matches).
  const forwarded = [argv[0]!, argv[1]!, ...argv.slice(3)];
  cmd.parse(forwarded);
  const opts = cmd.opts<{
    json?: boolean;
    strict?: boolean;
    validate?: string | boolean;
    skipAudit?: boolean;
    skipPeerScan?: boolean;
    skipStaleScan?: boolean;
    packageManager?: string;
    cwd?: string;
  }>();

  const cwd = opts.cwd ? path.resolve(process.cwd(), opts.cwd) : process.cwd();
  // commander turns `--no-validate` into `validate: false`; `--validate "<cmd>"` into a
  // string. Other invocations leave it undefined.
  const skipValidator = opts.validate === false;
  const validatorCommand = typeof opts.validate === 'string' ? opts.validate : undefined;

  try {
    const report = await runDoctor({
      cwd,
      toolVersion: version,
      skipValidator,
      ...(validatorCommand ? { validatorCommand } : {}),
      ...(opts.skipAudit ? { skipAudit: true } : {}),
      ...(opts.skipPeerScan ? { skipPeerScan: true } : {}),
      ...(opts.skipStaleScan ? { skipStaleScan: true } : {}),
      ...(opts.packageManager && opts.packageManager !== 'auto'
        ? { manager: opts.packageManager as 'npm' | 'pnpm' | 'yarn' }
        : {}),
    });

    if (opts.json) {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    } else {
      process.stdout.write(renderDoctorHuman(report) + '\n');
    }
    process.exit(doctorExitCode(report, Boolean(opts.strict)));
  } catch (e) {
    // Any error escaping the per-check try/catch is an internal bug — log it with the same
    // format as the main flow so CI bots can still pick it up.
    log.error(`doctor failed to run: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
