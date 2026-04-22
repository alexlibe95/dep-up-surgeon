import { execa } from 'execa';
import type { PackageJson } from '../types.js';
import { DEFAULT_OUTPUT_TAIL_LINES, tailLines } from '../utils/output.js';

export interface ValidationResult {
  ok: boolean;
  /** Command we attempted (for logging / report) */
  command: string;
  exitCode?: number;
  output?: string;
  /**
   * `true` when validation was deliberately skipped (no script or `--no-validate`).
   * `ok` is also `true` in that case.
   */
  skipped?: boolean;
  /**
   * Why we picked this validation strategy: explicit user command, package.json script,
   * or none.
   */
  source?: 'cli' | 'config' | 'package.json:test' | 'package.json:build' | 'none';
}

export interface ValidationOptions {
  /**
   * If set, run this exact command instead of `<manager> test` / `<manager> run build`. The
   * string is passed to `execa` with `shell: true`, so pipes and redirects work.
   * - `'cli'` source for CLI flag, `'config'` for `.dep-up-surgeonrc.validate`.
   */
  command?: string;
  source?: 'cli' | 'config';
  /** `true` to skip validation entirely. Result is reported as `skipped: true`. */
  skip?: boolean;
  /**
   * Package manager whose script-runner should be used for the default validator
   * (`<manager> test`, `<manager> run build`). Defaults to `npm`.
   */
  manager?: 'npm' | 'pnpm' | 'yarn';
  /**
   * Fired once the validator has decided which command to run, BEFORE it actually runs.
   * Used by callers (upgrader preflight, install/validate loop) to update a spinner with
   * the exact command string so the user can see what's executing. Omitted when validation
   * is skipped (no script, `--no-validate`).
   */
  onResolved?: (info: { command: string; source: ValidationResult['source'] }) => void;
}

// Re-export for external consumers that previously imported from validator.
export { DEFAULT_OUTPUT_TAIL_LINES };

const tail = tailLines;

/**
 * Resolve the validator command for this run.
 *
 * Order of precedence:
 *   1. `--no-validate`            → skip
 *   2. `--validate <cmd>`         → run that command
 *   3. `.dep-up-surgeonrc.validate` → run that command
 *   4. `npm test` if `scripts.test` is non-empty
 *   5. `npm run build` if `scripts.build` is non-empty
 *   6. otherwise: skip (no validator available)
 */
export async function validateProject(
  cwd: string,
  pkgJson: PackageJson,
  options: ValidationOptions = {},
): Promise<ValidationResult> {
  if (options.skip) {
    return { ok: true, skipped: true, command: '(validation disabled)', source: 'none' };
  }

  if (options.command && options.command.trim()) {
    const cmd = options.command.trim();
    options.onResolved?.({ command: cmd, source: options.source ?? 'cli' });
    const r = await execa(cmd, {
      cwd,
      reject: false,
      all: true,
      shell: true,
    });
    const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
    return {
      ok: r.exitCode === 0,
      command: cmd,
      exitCode: r.exitCode ?? undefined,
      output: tail(output),
      source: options.source ?? 'cli',
    };
  }

  const manager = options.manager ?? 'npm';
  // yarn classic uses `yarn test`/`yarn build` (no `run`); npm/pnpm both accept `run` for build,
  // but `<mgr> test` is the canonical short form for the test script.
  const testArgs = ['test'];
  const buildArgs = manager === 'yarn' ? ['build'] : ['run', 'build'];

  const scripts = pkgJson.scripts ?? {};
  const testScript = typeof scripts.test === 'string' ? scripts.test.trim() : '';
  if (testScript) {
    options.onResolved?.({
      command: `${manager} ${testArgs.join(' ')}`,
      source: 'package.json:test',
    });
    const r = await execa(manager, testArgs, { cwd, reject: false, all: true });
    const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
    return {
      ok: r.exitCode === 0,
      command: `${manager} ${testArgs.join(' ')}`,
      exitCode: r.exitCode ?? undefined,
      output: tail(output),
      source: 'package.json:test',
    };
  }

  const buildScript = typeof scripts.build === 'string' ? scripts.build.trim() : '';
  if (buildScript) {
    options.onResolved?.({
      command: `${manager} ${buildArgs.join(' ')}`,
      source: 'package.json:build',
    });
    const r = await execa(manager, buildArgs, { cwd, reject: false, all: true });
    const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
    return {
      ok: r.exitCode === 0,
      command: `${manager} ${buildArgs.join(' ')}`,
      exitCode: r.exitCode ?? undefined,
      output: tail(output),
      source: 'package.json:build',
    };
  }

  return {
    ok: true,
    skipped: true,
    command: '(no test/build script)',
    source: 'none',
  };
}
