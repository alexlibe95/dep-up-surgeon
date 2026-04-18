import { execa } from 'execa';
import pacote from 'pacote';
import type { RegistryCache } from './concurrency.js';

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
 * Detect ESM/CJS mismatch in npm install / lifecycle output (e.g. prepare → tsc → node).
 * When true, trying more versions in the same "family" is usually pointless — stop fallbacks.
 */
export function detectEsmCommonJsBlockage(output: string): boolean {
  const t = output || '';
  return (
    /ERR_REQUIRE_ESM/i.test(t) ||
    /require\(\) of ES Module/i.test(t) ||
    /Must use import to load ES Module/i.test(t) ||
    /Cannot use import statement outside a module/i.test(t)
  );
}

/**
 * Latest published version for a package name (respects dist-tags; default latest).
 *
 * When a `cache` is provided, concurrent or repeated requests for the same package name share
 * the same in-flight promise — this matters in monorepos where the same dependency appears in
 * many workspace members, and across `--concurrency > 1` runs.
 */
export async function fetchLatestVersion(
  packageName: string,
  cache?: RegistryCache,
): Promise<string> {
  if (cache) {
    const hit = cache.latest.get(packageName);
    if (hit) {
      return hit;
    }
    const p = pacote
      .manifest(`${packageName}@latest`, { fullMetadata: false })
      .then((m) => m.version);
    cache.latest.set(packageName, p);
    return p;
  }
  const manifest = await pacote.manifest(`${packageName}@latest`, {
    fullMetadata: false,
  });
  return manifest.version;
}

/**
 * All published version strings from the registry packument (includes prereleases). Same
 * caching semantics as `fetchLatestVersion`.
 */
export async function fetchAllPublishedVersions(
  packageName: string,
  cache?: RegistryCache,
): Promise<string[]> {
  if (cache) {
    const hit = cache.versions.get(packageName);
    if (hit) {
      return hit;
    }
    const p = pacote.packument(packageName).then((pack) => {
      const v = pack?.versions;
      if (!v || typeof v !== 'object') {
        return [] as string[];
      }
      return Object.keys(v);
    });
    cache.versions.set(packageName, p);
    return p;
  }
  const pack = await pacote.packument(packageName);
  const v = pack?.versions;
  if (!v || typeof v !== 'object') {
    return [];
  }
  return Object.keys(v);
}

export type InstallManager = 'npm' | 'pnpm' | 'yarn';

export interface InstallResult {
  ok: boolean;
  output: string;
  exitCode: number;
  command: string;
  /** True when the run was a workspace-filtered install (vs a full root install). */
  filtered?: boolean;
}

export interface InstallOptions {
  /**
   * Workspace member name (e.g. `@org/web`) to scope the install to. When set, the install
   * command is rewritten to a per-manager filtered form so only that workspace package is
   * resolved/installed instead of the entire monorepo.
   *
   *   - npm  → `npm install --workspace <filter>` (npm 7+)
   *   - pnpm → `pnpm install --filter <filter>`
   *   - yarn berry (v2+) **with `@yarnpkg/plugin-workspace-tools`** → `yarn workspaces focus <filter>`
   *   - yarn classic / berry without plugin → **fall back to a full install** (the lockfile is
   *     shared and we can't safely partial-install it without the plugin). The caller can
   *     detect this via `result.filtered === false`.
   */
  filter?: string;
  /**
   * True when the active yarn binary is yarn berry v2+ AND `@yarnpkg/plugin-workspace-tools` is
   * loaded. Detected once at startup (`detectProjectInfo` → `probeYarnCapabilities`) and threaded
   * through here so the install command for a yarn project becomes `yarn workspaces focus <name>`
   * instead of falling back to a full root install. Ignored for non-yarn managers.
   */
  yarnSupportsFocus?: boolean;
}

/**
 * Build the install command for the given manager + options. Returns `filtered: true` only when
 * the manager actually applied the filter (yarn classic / berry-without-plugin returns `false`).
 */
export function installCommand(
  manager: InstallManager,
  options: InstallOptions = {},
): { bin: string; args: string[]; filtered: boolean } {
  const { filter, yarnSupportsFocus } = options;
  switch (manager) {
    case 'pnpm':
      return filter
        ? { bin: 'pnpm', args: ['install', '--filter', filter], filtered: true }
        : { bin: 'pnpm', args: ['install'], filtered: false };
    case 'yarn':
      // Yarn classic (v1) has no clean per-workspace install path; we fall back to the full
      // install. Yarn berry (v2+) has `yarn workspaces focus <name>` BUT only when the
      // `@yarnpkg/plugin-workspace-tools` plugin is loaded — `detectProjectInfo` probes for
      // both and sets `yarnSupportsFocus` accordingly.
      if (filter && yarnSupportsFocus) {
        return {
          bin: 'yarn',
          args: ['workspaces', 'focus', filter],
          filtered: true,
        };
      }
      return { bin: 'yarn', args: ['install'], filtered: false };
    case 'npm':
    default:
      return filter
        ? { bin: 'npm', args: ['install', '--workspace', filter], filtered: true }
        : { bin: 'npm', args: ['install'], filtered: false };
  }
}

/**
 * Run an install in `cwd` using the detected (or overridden) package manager.
 * Returns combined output for peer / error parsing.
 */
export async function runInstall(
  cwd: string,
  manager: InstallManager = 'npm',
  options: InstallOptions = {},
): Promise<InstallResult> {
  const { bin, args, filtered } = installCommand(manager, options);
  const r = await execa(bin, args, { cwd, reject: false, all: true });
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
  return {
    ok: r.exitCode === 0,
    output,
    exitCode: r.exitCode ?? 1,
    command: `${bin} ${args.join(' ')}`,
    filtered,
  };
}

/**
 * Backwards-compatible alias for the previous `npm install` helper.
 * @deprecated use `runInstall(cwd, manager)`
 */
export async function runNpmInstall(cwd: string): Promise<{
  ok: boolean;
  output: string;
  exitCode: number;
}> {
  const { ok, output, exitCode } = await runInstall(cwd, 'npm');
  return { ok, output, exitCode };
}
