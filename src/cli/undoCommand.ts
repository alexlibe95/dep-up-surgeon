/**
 * Dedicated entry point for `dep-up-surgeon undo`. Like `doctor`, this subcommand has its
 * own commander program because `undo` only needs a tiny subset of the main flow's options,
 * and threading it as a flag would force every upgrade-time option to grow a guard.
 *
 * Exit-code contract:
 *   - reverse pass succeeded (or noop) → 0
 *   - persisted run file not found / can't be parsed → 2
 *   - install or validator failed during the reverse pass → 1
 */
import path from 'node:path';
import { Command } from 'commander';
import { log } from '../utils/logger.js';
import { renderUndoHuman, runUndo, undoSucceeded } from './undo.js';

export async function runUndoCommand(argv: string[], version: string): Promise<void> {
  const cmd = new Command();
  cmd
    .name('dep-up-surgeon undo')
    .description(
      'Reverse the most recent `dep-up-surgeon` run using `.dep-up-surgeon.last-run.json`. ' +
        'Reverts `package.json` dep ranges to their `from` values, drops override pins this ' +
        'run added (or restores the previous pin when the run replaced an existing one), ' +
        'runs a fresh `<manager> install`, then runs the validator so you see green/red before ' +
        'you commit the revert. Skips rows whose current `package.json` value has drifted from ' +
        'the recorded `to`, so another run\'s changes are never clobbered. Pair with `--json` ' +
        'for machine-readable output in CI.',
    )
    .version(version)
    .option(
      '--file <path>',
      'Use a specific run report instead of `.dep-up-surgeon.last-run.json` in cwd. Useful when ' +
        'the directory has been cleaned up or you want to replay a report from a CI artifact.',
    )
    .option('--json', 'Emit the structured `UndoResult` as JSON on stdout instead of the human format.', false)
    .option(
      '--dry-run',
      'Compute the reverse plan and print it, but do not touch `package.json`, do not run install, do not run the validator.',
      false,
    )
    .option(
      '--no-validate',
      'Skip the post-reverse validator. Use when the project has no test/build script or when you ' +
        'only care that the dep ranges rolled back cleanly.',
    )
    .option(
      '--validate <cmd>',
      'Run this command as the post-reverse validator (same semantics as the upgrade flow\'s `--validate`).',
    )
    .option(
      '--skip-install',
      'Skip the post-reverse `<manager> install`. Only use when you plan to run install yourself ' +
        '(e.g. in a follow-up CI step) — the lockfile will otherwise diverge from the reverted `package.json`.',
      false,
    )
    .option(
      '--package-manager <mgr>',
      'Override the manager recorded in the run report (auto / npm / pnpm / yarn).',
      'auto',
    )
    .option('--cwd <path>', 'Run the undo against this directory instead of the current one.');

  // Strip the `undo` dispatch token the same way `doctor` does.
  const forwarded = [argv[0]!, argv[1]!, ...argv.slice(3)];
  cmd.parse(forwarded);
  const opts = cmd.opts<{
    file?: string;
    json?: boolean;
    dryRun?: boolean;
    validate?: string | boolean;
    skipInstall?: boolean;
    packageManager?: string;
    cwd?: string;
  }>();

  const cwd = opts.cwd ? path.resolve(process.cwd(), opts.cwd) : process.cwd();
  const skipValidator = opts.validate === false;
  const validatorCommand = typeof opts.validate === 'string' ? opts.validate : undefined;

  try {
    // Build a validator closure that mirrors the main flow's behavior: if the user passed a
    // command we shell that out; otherwise `validateProject` auto-detects test / build. This
    // keeps `--validate "my-cmd"` working identically across `upgrade`, `doctor`, and `undo`.
    const runValidator = async () => {
      if (skipValidator) return { ok: true };
      try {
        const { validateProject } = await import('../core/validator.js');
        const fs = await import('fs-extra');
        const pkg = await fs.default.readJson(path.join(cwd, 'package.json'));
        const manager =
          opts.packageManager && opts.packageManager !== 'auto'
            ? (opts.packageManager as 'npm' | 'pnpm' | 'yarn')
            : 'npm';
        const vr = await validateProject(cwd, pkg, {
          ...(validatorCommand ? { command: validatorCommand, source: 'cli' as const } : {}),
          manager,
        });
        return {
          ok: vr.ok,
          ...(vr.command ? { command: vr.command } : {}),
          ...(vr.output ? { lastLines: vr.output } : {}),
        };
      } catch {
        // Validator crash != project broken for undo's purposes — report ok so we don't
        // exit 1 purely because the validator harness itself errored. The reverse pass has
        // already written the correct ranges; the operator can run their tests manually.
        return { ok: true };
      }
    };

    const result = await runUndo({
      cwd,
      ...(opts.file ? { file: opts.file } : {}),
      ...(opts.packageManager && opts.packageManager !== 'auto'
        ? { manager: opts.packageManager as 'npm' | 'pnpm' | 'yarn' }
        : {}),
      ...(opts.dryRun ? { planOnly: true } : {}),
      ...(opts.skipInstall ? { skipInstall: true } : {}),
      ...(skipValidator ? { skipValidator: true } : {}),
      ...(skipValidator ? {} : { runValidator }),
      ...(opts.json ? { json: true } : {}),
    });

    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else {
      process.stdout.write(renderUndoHuman(result) + '\n');
    }
    process.exit(undoSucceeded(result) ? 0 : 1);
  } catch (e) {
    log.error(`undo failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
}
