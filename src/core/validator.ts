import execa from 'execa';
import type { PackageJson } from '../types';

export interface ValidationResult {
  ok: boolean;
  /** Command we attempted (for logging) */
  command: string;
  exitCode?: number;
  output?: string;
}

/**
 * Run `npm test` if a non-empty `test` script exists; otherwise `npm run build` if present.
 * If neither exists, validation is considered successful (nothing to run).
 */
export async function validateProject(cwd: string, pkgJson: PackageJson): Promise<ValidationResult> {
  const scripts = pkgJson.scripts ?? {};
  const testScript = typeof scripts.test === 'string' ? scripts.test.trim() : '';
  if (testScript) {
    const r = await execa('npm', ['test'], { cwd, reject: false, all: true });
    const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
    return {
      ok: r.exitCode === 0,
      command: 'npm test',
      exitCode: r.exitCode ?? undefined,
      output,
    };
  }

  const buildScript = typeof scripts.build === 'string' ? scripts.build.trim() : '';
  if (buildScript) {
    const r = await execa('npm', ['run', 'build'], { cwd, reject: false, all: true });
    const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
    return {
      ok: r.exitCode === 0,
      command: 'npm run build',
      exitCode: r.exitCode ?? undefined,
      output,
    };
  }

  return { ok: true, command: '(no test/build script)' };
}
