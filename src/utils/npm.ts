import execa from 'execa';
import pacote from 'pacote';

/**
 * Regex / heuristics for npm stderr+stdout (install, ci, etc.).
 * npm wording changes between versions; we match several patterns.
 */
const PEER_PATTERNS: RegExp[] = [
  /ERESOLVE/i,
  /peer dep/i,
  /peer depend/i,
  /unmet peer/i,
  /incorrect peer dependency/i,
  /Could not resolve dependency/i,
  /conflicting peer dependency/i,
  /peer .* is not installed/i,
];

/**
 * Returns true if combined npm output suggests peer-related resolution issues.
 */
export function detectPeerConflictFromOutput(output: string): boolean {
  const text = output || '';
  return PEER_PATTERNS.some((re) => re.test(text));
}

/**
 * Latest published version for a package name (respects dist-tags; default latest).
 */
export async function fetchLatestVersion(packageName: string): Promise<string> {
  const manifest = await pacote.manifest(`${packageName}@latest`, {
    fullMetadata: false,
  });
  return manifest.version;
}

/**
 * Run `npm install` in cwd; returns combined output for peer / error parsing.
 */
export async function runNpmInstall(cwd: string): Promise<{
  ok: boolean;
  output: string;
  exitCode: number;
}> {
  const r = await execa('npm', ['install'], { cwd, reject: false, all: true });
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
  return {
    ok: r.exitCode === 0,
    output,
    exitCode: r.exitCode ?? 1,
  };
}
