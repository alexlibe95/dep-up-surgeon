import { execa } from 'execa';
import type { PackageJson } from '../types.js';
import type { PackageManager } from './workspaces.js';
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
   * or none. `package.json:script` is an extra check script (`lint`, `typecheck`, …).
   */
  source?: 'cli' | 'config' | 'package.json:test' | 'package.json:build' | 'package.json:script' | 'none';
}

/** An extra check script and the exit code it had on the unchanged tree. */
export interface ExtraCheck {
  script: string;
  /**
   * `0` for a script that passed pre-flight. A script that already failed (e.g. ESLint exit 1 for
   * existing lint errors) keeps running, and only fails validation when an upgrade changes its
   * exit code (ESLint exit 2: it crashed).
   */
  baselineExitCode: number;
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
  manager?: PackageManager;
  /**
   * Extra check scripts (see {@link EXTRA_CHECK_SCRIPTS}) run after the default `test` / `build`
   * validator, so a `build`-only validator can't wave through an upgrade that breaks `lint` or
   * `typecheck`. Pre-flight fills this with each script's exit code on the unchanged tree.
   * Ignored when `command` or `skip` is set.
   */
  extraChecks?: readonly ExtraCheck[];
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
 * Scripts that catch breakage a build can miss — e.g. TypeScript 7 drops the JS API that
 * typescript-eslint loads, so `next build` passes while `lint` crashes.
 */
export const EXTRA_CHECK_SCRIPTS = ['lint', 'typecheck', 'type-check'] as const;

/** The {@link EXTRA_CHECK_SCRIPTS} this package.json actually defines, in that order. */
export function detectExtraCheckScripts(pkgJson: PackageJson): string[] {
  const scripts = pkgJson.scripts ?? {};
  return EXTRA_CHECK_SCRIPTS.filter((name) => {
    const script = scripts[name];
    return typeof script === 'string' && script.trim() !== '';
  });
}

/**
 * Environment for the `test` script. Runners like Create React App's `react-scripts test` (Jest)
 * start in watch mode unless `CI` is set, which would hang the validator forever. A `CI` value the
 * user already exported is kept as-is.
 */
export function testScriptEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return base.CI === undefined ? { CI: 'true' } : {};
}

/** The script `npm init` writes: `echo "Error: no test specified" && exit 1`. */
function isPlaceholderTestScript(script: string): boolean {
  return /no test specified/i.test(script) && /\bexit 1\b/.test(script);
}

async function runValidatorProcess(
  cwd: string,
  manager: PackageManager,
  args: string[],
  source: ValidationResult['source'],
  onResolved: ValidationOptions['onResolved'],
  env?: NodeJS.ProcessEnv,
): Promise<ValidationResult> {
  const command = `${manager} ${args.join(' ')}`;
  onResolved?.({ command, source });
  const r = await execa(manager, args, { cwd, reject: false, all: true, env });
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
  return {
    ok: r.exitCode === 0,
    command,
    exitCode: r.exitCode ?? undefined,
    output: tail(output),
    source,
  };
}

/** Run one package.json script as an extra check (`<manager> run <script>`; yarn: `yarn <script>`). */
export function runPackageScript(
  cwd: string,
  script: string,
  manager: PackageManager = 'npm',
  onResolved?: ValidationOptions['onResolved'],
): Promise<ValidationResult> {
  const args = manager === 'yarn' ? [script] : ['run', script];
  return runValidatorProcess(cwd, manager, args, 'package.json:script', onResolved);
}

/**
 * Resolve the validator command for this run.
 *
 * Order of precedence:
 *   1. `--no-validate`            → skip
 *   2. `--validate <cmd>`         → run that command
 *   3. `.dep-up-surgeonrc.validate` → run that command
 *   4. `npm test` if `scripts.test` is non-empty (npm init's always-failing placeholder doesn't count)
 *   5. `npm run build` if `scripts.build` is non-empty
 *   6. otherwise: skip (no validator available)
 *
 * With the default validator (4–6), `extraChecks` then run in order; validation fails on the first
 * one that exits with neither 0 nor its pre-flight exit code.
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
  // yarn classic uses `yarn test`/`yarn build` (no `run`).
  // bun's `bun test` is the bun test runner, NOT package.json scripts — use `bun run test`.
  const testArgs = manager === 'bun' ? ['run', 'test'] : ['test'];
  const buildArgs = manager === 'yarn' ? ['build'] : ['run', 'build'];

  const scripts = pkgJson.scripts ?? {};
  const rawTestScript = typeof scripts.test === 'string' ? scripts.test.trim() : '';
  // `npm init` writes a test script that always exits 1; treating it as a real validator would
  // abort every run at pre-flight, so fall through to `build` instead.
  const testScript = isPlaceholderTestScript(rawTestScript) ? '' : rawTestScript;
  const buildScript = typeof scripts.build === 'string' ? scripts.build.trim() : '';

  let primary: ValidationResult | undefined;
  if (testScript) {
    primary = await runValidatorProcess(
      cwd,
      manager,
      testArgs,
      'package.json:test',
      options.onResolved,
      testScriptEnv(),
    );
  } else if (buildScript) {
    primary = await runValidatorProcess(cwd, manager, buildArgs, 'package.json:build', options.onResolved);
  }
  if (primary && !primary.ok) {
    return primary;
  }

  // Scripts can't change mid-run, but only run what this package.json still defines.
  const present = new Set(detectExtraCheckScripts(pkgJson));
  const checks = (options.extraChecks ?? []).filter((check) => present.has(check.script));
  if (checks.length === 0) {
    return (
      primary ?? {
        ok: true,
        skipped: true,
        command: '(no test/build script)',
        source: 'none',
      }
    );
  }

  const commands = primary ? [primary.command] : [];
  for (const check of checks) {
    const r = await runPackageScript(cwd, check.script, manager, options.onResolved);
    // Exit 0 always passes (an upgrade may fix a failing script); otherwise the code must match.
    if (!r.ok && r.exitCode !== check.baselineExitCode) {
      if (check.baselineExitCode === 0) {
        return r;
      }
      return {
        ...r,
        output: tail(
          `${r.output ?? ''}\n→ exit ${r.exitCode ?? '?'} differs from pre-flight (exit ${check.baselineExitCode} on the unchanged tree)`,
        ),
      };
    }
    commands.push(r.command);
  }
  return {
    ok: true,
    command: commands.join(' && '),
    output: primary?.output,
    source: primary?.source ?? 'package.json:script',
  };
}
