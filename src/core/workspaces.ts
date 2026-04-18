import path from 'node:path';
import fs from 'fs-extra';
import { execa } from 'execa';
import type { PackageJson } from '../types.js';

export type PackageManager = 'npm' | 'pnpm' | 'yarn';

export type PackageManagerSource =
  | 'cli'
  | 'package.json:packageManager'
  | 'lockfile'
  | 'pnpm-workspace'
  | 'default';

export interface WorkspaceMember {
  name: string;
  /** Absolute path to the workspace package directory */
  dir: string;
}

export interface ProjectInfo {
  cwd: string;
  manager: PackageManager;
  managerVersion?: string;
  managerSource: PackageManagerSource;
  /** Lockfile detected at the project root (if any) */
  lockfile?: 'package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock';
  /** True when `package.json` declares `workspaces` (or pnpm-workspace.yaml is present). */
  hasWorkspaces: boolean;
  /** Raw workspace globs as configured (npm/yarn `workspaces`, pnpm-workspace `packages`). */
  workspaceGlobs: string[];
  /** Resolved local workspace member packages (read from each child `package.json`). */
  workspaceMembers: WorkspaceMember[];
  /** Quick lookup of workspace package names — used to skip workspace-internal deps. */
  workspacePackageNames: Set<string>;
  /**
   * Resolved major version of the active package manager binary. Currently only populated for
   * yarn (the only manager whose filtered-install behavior depends on the major: classic v1 has
   * no `workspaces focus`, berry v2+ does — but only when `@yarnpkg/plugin-workspace-tools` is
   * installed). `undefined` means we couldn't probe the binary (PATH miss, network-isolated CI,
   * etc.) — callers must treat that as "no capability" and fall back to a full install.
   */
  yarnMajorVersion?: number;
  /**
   * True when the active yarn binary supports `yarn workspaces focus <name>` (i.e. yarn berry
   * v2+ AND `@yarnpkg/plugin-workspace-tools` is loaded). Only meaningful when `manager === 'yarn'`.
   * Always `false` for yarn classic. When this is true, `--install-mode filtered` runs the
   * focused install instead of falling back to a root install.
   */
  yarnSupportsFocus?: boolean;
}

const PNPM_WORKSPACE_FILE = 'pnpm-workspace.yaml';

function parsePackageManagerField(field: unknown):
  | { manager: PackageManager; version?: string }
  | undefined {
  if (typeof field !== 'string') {
    return undefined;
  }
  // packageManager: "<name>@<version>"
  const m = field.match(/^(npm|pnpm|yarn)(?:@([^+]+))?/i);
  if (!m) {
    return undefined;
  }
  return { manager: m[1]!.toLowerCase() as PackageManager, version: m[2] };
}

function detectFromLockfile(cwd: string): {
  manager?: PackageManager;
  lockfile?: ProjectInfo['lockfile'];
} {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) {
    return { manager: 'pnpm', lockfile: 'pnpm-lock.yaml' };
  }
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) {
    return { manager: 'yarn', lockfile: 'yarn.lock' };
  }
  if (fs.existsSync(path.join(cwd, 'package-lock.json'))) {
    return { manager: 'npm', lockfile: 'package-lock.json' };
  }
  return {};
}

function readWorkspaceGlobs(pkg: PackageJson, cwd: string): { globs: string[]; pnpmFile: boolean } {
  let globs: string[] = [];
  // Support npm + yarn (string array, or { packages: [...] })
  const ws = (pkg as PackageJson & { workspaces?: unknown }).workspaces;
  if (Array.isArray(ws)) {
    globs = ws.filter((g): g is string => typeof g === 'string');
  } else if (ws && typeof ws === 'object') {
    const inner = (ws as { packages?: unknown }).packages;
    if (Array.isArray(inner)) {
      globs = inner.filter((g): g is string => typeof g === 'string');
    }
  }

  let pnpmFile = false;
  const pnpmYaml = path.join(cwd, PNPM_WORKSPACE_FILE);
  if (fs.existsSync(pnpmYaml)) {
    pnpmFile = true;
    try {
      const raw = fs.readFileSync(pnpmYaml, 'utf8');
      // Minimal yaml parser: collect lines under `packages:` that look like `- "<glob>"` / `- <glob>`.
      const lines = raw.split(/\r?\n/);
      let inPackages = false;
      for (const line of lines) {
        if (/^\s*packages\s*:/.test(line)) {
          inPackages = true;
          continue;
        }
        if (inPackages) {
          const m = line.match(/^\s*-\s*['"]?([^'"#\s]+)['"]?/);
          if (m && m[1]) {
            globs.push(m[1]);
            continue;
          }
          // Stop collecting at the next top-level key.
          if (/^\S/.test(line) && !/^\s*-/.test(line)) {
            inPackages = false;
          }
        }
      }
    } catch {
      // best-effort; ignore unreadable yaml
    }
  }

  return { globs: Array.from(new Set(globs)), pnpmFile };
}

/**
 * Expand workspace globs without pulling a glob dependency.
 *
 * Supported patterns:
 *   - `<dir>` or `<dir>/`          → that directory only
 *   - `<dir>/*`                    → immediate children of `<dir>`
 *   - `<dir>/**`                   → recursive descendants of `<dir>` (capped depth)
 *
 * Anything more exotic (negation, brace expansion) is intentionally not supported here; it
 * would only matter for selecting *which* workspaces, which this tool doesn't need.
 */
function expandWorkspaceGlobs(cwd: string, globs: string[]): string[] {
  const MAX_DEPTH = 6;
  const results = new Set<string>();

  const isPkgDir = (dir: string): boolean => fs.existsSync(path.join(dir, 'package.json'));

  const walkChildren = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) {
        continue;
      }
      if (e.name === 'node_modules' || e.name.startsWith('.')) {
        continue;
      }
      const child = path.join(dir, e.name);
      if (isPkgDir(child)) {
        results.add(child);
      }
      walkChildren(child, depth + 1);
    }
  };

  for (const raw of globs) {
    const g = raw.trim();
    if (!g || g.startsWith('!')) {
      continue;
    }

    if (g.endsWith('/**') || g.endsWith('/**/*')) {
      const base = g.replace(/\/\*\*(?:\/\*)?$/, '');
      const baseDir = path.join(cwd, base);
      if (fs.existsSync(baseDir)) {
        if (isPkgDir(baseDir)) {
          results.add(baseDir);
        }
        walkChildren(baseDir, 1);
      }
      continue;
    }

    if (g.endsWith('/*')) {
      const base = g.slice(0, -2);
      const baseDir = path.join(cwd, base);
      if (!fs.existsSync(baseDir)) {
        continue;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(baseDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        if (!e.isDirectory()) {
          continue;
        }
        if (e.name === 'node_modules' || e.name.startsWith('.')) {
          continue;
        }
        const dir = path.join(baseDir, e.name);
        if (isPkgDir(dir)) {
          results.add(dir);
        }
      }
      continue;
    }

    // Exact directory entry
    const dir = path.join(cwd, g.replace(/\/$/, ''));
    if (isPkgDir(dir)) {
      results.add(dir);
    }
  }

  return [...results];
}

/**
 * Probe the active `yarn` binary for capabilities relevant to filtered installs.
 *
 *   - `yarn --version` gives us the major (`1.x` → classic, `2+` → berry).
 *   - For berry, we additionally check whether `workspaces focus` is exposed by the loaded
 *     plugin set: `yarn workspaces focus --help` exits 0 when the plugin is installed and
 *     non-zero (or prints "Couldn't find a script") when it isn't. We deliberately avoid
 *     parsing `yarn plugin runtime --json` because its output schema changed between berry
 *     minor versions; the help-probe is forward-compatible.
 *
 * Every probe uses `reject: false` and a tight per-call timeout — yarn missing from PATH or a
 * yarn binary that hangs (rare but seen on misconfigured corp CI) must NEVER block the upgrade
 * loop. On any failure we return `{ }` and the caller treats it as "no capability".
 */
async function probeYarnCapabilities(
  cwd: string,
): Promise<{ major?: number; supportsFocus?: boolean }> {
  const versionRes = await execa('yarn', ['--version'], {
    cwd,
    reject: false,
    timeout: 5000,
  }).catch(() => undefined);
  if (!versionRes || versionRes.exitCode !== 0) {
    return {};
  }
  const versionStr = versionRes.stdout.trim();
  const m = versionStr.match(/^(\d+)\./);
  if (!m) {
    return {};
  }
  const major = Number.parseInt(m[1]!, 10);
  if (!Number.isFinite(major)) {
    return { major: undefined };
  }
  if (major < 2) {
    return { major, supportsFocus: false };
  }

  // Berry: probe the plugin. `yarn workspaces focus --help` exits 0 only when the plugin is
  // loaded; without the plugin yarn responds with "Couldn't find a script named" or
  // "Usage Error: Couldn't find a workspace named" depending on the version.
  const focusRes = await execa('yarn', ['workspaces', 'focus', '--help'], {
    cwd,
    reject: false,
    timeout: 5000,
  }).catch(() => undefined);
  const supportsFocus = Boolean(
    focusRes &&
      focusRes.exitCode === 0 &&
      // Belt-and-braces: also confirm the help text actually describes the focus subcommand.
      // A future yarn version that ships its own dummy `focus` would still need to produce
      // help text that mentions the verb.
      /focus/i.test([focusRes.stdout, focusRes.stderr].filter(Boolean).join('\n')),
  );

  return { major, supportsFocus };
}

function readMemberName(dir: string): string | undefined {
  try {
    const pkg = fs.readJsonSync(path.join(dir, 'package.json')) as PackageJson;
    return typeof pkg.name === 'string' && pkg.name ? pkg.name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Detect package manager + workspace info for `cwd`. CLI overrides take precedence.
 */
export async function detectProjectInfo(
  cwd: string,
  cliOverride?: PackageManager | 'auto',
): Promise<ProjectInfo> {
  const pkgPath = path.join(cwd, 'package.json');
  const pkg: PackageJson = (await fs.pathExists(pkgPath))
    ? ((await fs.readJson(pkgPath)) as PackageJson)
    : {};

  // Resolve manager
  const fromField = parsePackageManagerField(
    (pkg as PackageJson & { packageManager?: unknown }).packageManager,
  );
  const fromLock = detectFromLockfile(cwd);

  let manager: PackageManager;
  let managerVersion: string | undefined;
  let managerSource: PackageManagerSource;

  if (cliOverride && cliOverride !== 'auto') {
    manager = cliOverride;
    managerSource = 'cli';
  } else if (fromField) {
    manager = fromField.manager;
    managerVersion = fromField.version;
    managerSource = 'package.json:packageManager';
  } else if (fromLock.manager) {
    manager = fromLock.manager;
    managerSource = 'lockfile';
  } else {
    manager = 'npm';
    managerSource = 'default';
  }

  const { globs, pnpmFile } = readWorkspaceGlobs(pkg, cwd);
  if (pnpmFile && !cliOverride && !fromField && !fromLock.manager) {
    manager = 'pnpm';
    managerSource = 'pnpm-workspace';
  }

  const memberDirs = expandWorkspaceGlobs(cwd, globs);
  const workspaceMembers: WorkspaceMember[] = [];
  for (const dir of memberDirs) {
    const name = readMemberName(dir);
    if (name) {
      workspaceMembers.push({ name, dir });
    }
  }

  // Only probe yarn when it's the active manager AND the project actually has workspaces (the
  // capability only matters for filtered installs of child workspaces; single-package yarn
  // projects don't care). Running the probe is a couple of subprocess spawns + ~5s worth of
  // worst-case timeout — cheap, but worthless for pure-npm projects.
  let yarnMajorVersion: number | undefined;
  let yarnSupportsFocus: boolean | undefined;
  if (manager === 'yarn' && globs.length > 0) {
    const probe = await probeYarnCapabilities(cwd);
    yarnMajorVersion = probe.major;
    yarnSupportsFocus = probe.supportsFocus;
  }

  return {
    cwd,
    manager,
    managerVersion,
    managerSource,
    lockfile: fromLock.lockfile,
    hasWorkspaces: globs.length > 0,
    workspaceGlobs: globs,
    workspaceMembers,
    workspacePackageNames: new Set(workspaceMembers.map((m) => m.name)),
    ...(yarnMajorVersion !== undefined ? { yarnMajorVersion } : {}),
    ...(yarnSupportsFocus !== undefined ? { yarnSupportsFocus } : {}),
  };
}
