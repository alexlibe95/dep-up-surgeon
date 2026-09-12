import path from 'node:path';
import fs from 'fs-extra';
import { execa } from 'execa';
import YAML from 'yaml';
import type { PackageJson } from '../types.js';

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export const PACKAGE_MANAGERS: readonly PackageManager[] = ['npm', 'pnpm', 'yarn', 'bun'];

export function isPackageManager(value: string): value is PackageManager {
  return (PACKAGE_MANAGERS as readonly string[]).includes(value);
}

/** CLI `--package-manager` helper: unknown values fall back to `auto`. */
export function parsePackageManagerOption(raw: string | undefined): PackageManager | 'auto' {
  const v = String(raw ?? 'auto').toLowerCase();
  return isPackageManager(v) ? v : 'auto';
}

export type PackageManagerSource =
  | 'cli'
  // Also used for `devEngines.packageManager`; the report type has no separate value for it.
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
  /**
   * Lockfile detected at the project root (if any). `npm-shrinkwrap.json` is only reported via
   * `lockfileName`, so this union (mirrored by the JSON report type) stays unchanged.
   */
  lockfile?: 'package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock' | 'bun.lock' | 'bun.lockb';
  /** Basename of the root lockfile detection keyed off: same as `lockfile`, plus `npm-shrinkwrap.json`. */
  lockfileName?:
    | 'package-lock.json'
    | 'npm-shrinkwrap.json'
    | 'pnpm-lock.yaml'
    | 'yarn.lock'
    | 'bun.lock'
    | 'bun.lockb';
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
   * yarn, and probed for every yarn project: classic v1 vs berry v2+ decides filtered installs
   * (`workspaces focus`), dedupe support, lockfile handling and the audit command.
   * `undefined` means we couldn't probe the binary (PATH miss, network-isolated CI,
   * etc.) — callers must treat that as "no capability" and fall back to a full install.
   */
  yarnMajorVersion?: number;
  /**
   * True when the active yarn binary supports `yarn workspaces focus <name>` (i.e. yarn berry
   * v2+ AND `@yarnpkg/plugin-workspace-tools` is loaded). Only meaningful when `manager === 'yarn'`.
   * Always `false` for yarn classic; not probed (undefined) for berry projects without
   * workspaces. When this is true, `--install-mode filtered` runs the
   * focused install instead of falling back to a root install.
   */
  yarnSupportsFocus?: boolean;
  /**
   * True when the project is set up with **per-workspace lockfiles** rather than a single
   * shared one at the root (aka "nohoist" / isolated-lockfile monorepo). Detected for:
   *
   *   - **pnpm**: `shared-workspace-lockfile=false` in the root `.npmrc`, or
   *     `sharedWorkspaceLockfile: false` in `pnpm-workspace.yaml` (user-level config is
   *     ignored — we can only see what's committed).
   *   - **any manager**: every workspace member directory contains its own lockfile of the
   *     right kind (`package-lock.json` / `pnpm-lock.yaml` / `yarn.lock`) AND the manager
   *     wouldn't resolve a shared workspace root from inside a member (no root `workspaces`
   *     for npm/yarn/bun, no `pnpm-workspace.yaml` for pnpm). This is the "folder of
   *     independent projects" case; rare but it shows up in corporate monorepos.
   *
   * When true, the upgrader's keyed install mutex lets different workspace targets install
   * **concurrently** — since each has its own lockfile, the install steps don't race.
   * When false (or in single-package projects), every install keys off the root `cwd` and
   * behaves exactly as before (fully serialized).
   */
  isolatedLockfiles?: boolean;
  /**
   * Reason / source for `isolatedLockfiles === true`. `'pnpm-npmrc'` covers both pnpm settings
   * (`.npmrc` and `pnpm-workspace.yaml`). Surfaced in the structured report so
   * users can see why the tool chose parallel installs. Never populated when
   * `isolatedLockfiles` is false / undefined.
   */
  isolatedLockfilesSource?: 'pnpm-npmrc' | 'per-workspace-lockfiles';
}

const PNPM_WORKSPACE_FILE = 'pnpm-workspace.yaml';

function parsePackageManagerField(field: unknown):
  | { manager: PackageManager; version?: string }
  | undefined {
  if (typeof field !== 'string') {
    return undefined;
  }
  // packageManager: "<name>@<version>"
  const m = field.match(/^(npm|pnpm|yarn|bun)(?:@([^+]+))?/i);
  if (!m) {
    return undefined;
  }
  return { manager: m[1]!.toLowerCase() as PackageManager, version: m[2] };
}

/** `devEngines.packageManager` (npm 10.9+): `{ name, version? }` or an array of them (first wins). */
function parseDevEnginesPackageManager(devEngines: unknown):
  | { manager: PackageManager; version?: string }
  | undefined {
  if (!devEngines || typeof devEngines !== 'object') {
    return undefined;
  }
  const raw = (devEngines as { packageManager?: unknown }).packageManager;
  const entry: unknown = Array.isArray(raw) ? raw[0] : raw;
  if (!entry || typeof entry !== 'object') {
    return undefined;
  }
  const { name, version } = entry as { name?: unknown; version?: unknown };
  const manager = typeof name === 'string' ? name.toLowerCase() : '';
  if (!isPackageManager(manager)) {
    return undefined;
  }
  return { manager, version: typeof version === 'string' && version ? version : undefined };
}

type RootLockfile = NonNullable<ProjectInfo['lockfileName']>;

/** Checked in order, so the first hit wins when several lockfiles exist. */
const ROOT_LOCKFILES: ReadonlyArray<readonly [RootLockfile, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  // npm itself prefers npm-shrinkwrap.json over package-lock.json.
  ['npm-shrinkwrap.json', 'npm'],
  ['package-lock.json', 'npm'],
];

function detectFromLockfile(cwd: string): { manager?: PackageManager; lockfileName?: RootLockfile } {
  for (const [file, manager] of ROOT_LOCKFILES) {
    if (fs.existsSync(path.join(cwd, file))) {
      return { manager, lockfileName: file };
    }
  }
  return {};
}

interface WorkspaceConfig {
  globs: string[];
  /** `pnpm-workspace.yaml` exists at the root. */
  pnpmFile: boolean;
  /** Root `package.json` declares `workspaces` — what npm/yarn/bun resolve the workspace root from. */
  rootWorkspacesField: boolean;
  /** `sharedWorkspaceLockfile` from `pnpm-workspace.yaml` (pnpm 10 settings), as written. */
  pnpmSharedWorkspaceLockfile?: unknown;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((g): g is string => typeof g === 'string' && g.trim() !== '').map((g) => g.trim());
}

function readWorkspaceConfig(pkg: PackageJson, cwd: string): WorkspaceConfig {
  // Support npm + yarn + bun (string array, or { packages: [...] })
  const ws = (pkg as PackageJson & { workspaces?: unknown }).workspaces;
  const fromPackageJson = stringList(
    ws && typeof ws === 'object' && !Array.isArray(ws) ? (ws as { packages?: unknown }).packages : ws,
  );
  const globs = [...fromPackageJson];

  let pnpmFile = false;
  let pnpmSharedWorkspaceLockfile: unknown;
  const pnpmYaml = path.join(cwd, PNPM_WORKSPACE_FILE);
  if (fs.existsSync(pnpmYaml)) {
    pnpmFile = true;
    try {
      // logLevel 'error': yaml would otherwise print document warnings via process.emitWarning.
      const doc: unknown = YAML.parse(fs.readFileSync(pnpmYaml, 'utf8'), { logLevel: 'error' });
      if (doc && typeof doc === 'object') {
        const record = doc as Record<string, unknown>;
        globs.push(...stringList(record.packages));
        pnpmSharedWorkspaceLockfile = record.sharedWorkspaceLockfile;
      }
    } catch {
      // best-effort; ignore unreadable yaml
    }
  }

  return {
    globs: Array.from(new Set(globs)),
    pnpmFile,
    rootWorkspacesField: fromPackageJson.length > 0,
    pnpmSharedWorkspaceLockfile,
  };
}

/** How deep a `**` segment may descend — keeps a stray `**` from walking a huge tree. */
const MAX_GLOBSTAR_DEPTH = 8;

type GlobSegment =
  | { kind: 'globstar' }
  | { kind: 'literal'; value: string }
  | { kind: 'wildcard'; re: RegExp; dot: boolean };

/** Expand `{a,b}` alternatives; innermost groups first, so nesting works. */
function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]*,[^{}]*)\}/.exec(pattern);
  if (!m) {
    return [pattern];
  }
  const head = pattern.slice(0, m.index);
  const tail = pattern.slice(m.index + m[0].length);
  return m[1]!.split(',').flatMap((alt) => expandBraces(head + alt + tail));
}

function compileGlob(pattern: string): GlobSegment[] {
  const segments: GlobSegment[] = [];
  for (const part of pattern.split('/')) {
    if (part === '' || part === '.') {
      continue;
    }
    if (part === '**') {
      // Repeated `**` match the same paths and would only multiply the walk.
      if (segments.at(-1)?.kind !== 'globstar') {
        segments.push({ kind: 'globstar' });
      }
      continue;
    }
    if (!/[*?]/.test(part)) {
      segments.push({ kind: 'literal', value: part });
      continue;
    }
    const source = part
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*+/g, '[^/]*')
      .replace(/\?/g, '[^/]');
    segments.push({ kind: 'wildcard', re: new RegExp(`^${source}$`), dot: part.startsWith('.') });
  }
  return segments;
}

function segmentMatches(segment: GlobSegment, name: string): boolean {
  if (segment.kind === 'literal') {
    return segment.value === name;
  }
  if (segment.kind === 'wildcard') {
    // Like npm's and pnpm's globbing, wildcards skip dot-directories unless the pattern names them.
    return (segment.dot || !name.startsWith('.')) && segment.re.test(name);
  }
  return false;
}

/** Match relative path segments against a compiled glob; `**` spans zero or more segments. */
function matchesGlob(segments: GlobSegment[], parts: string[]): boolean {
  if (segments.length === 0) {
    return parts.length === 0;
  }
  const [head, ...rest] = segments;
  if (head!.kind === 'globstar') {
    for (let i = 0; i <= parts.length; i++) {
      if (matchesGlob(rest, parts.slice(i))) {
        return true;
      }
    }
    return false;
  }
  return parts.length > 0 && segmentMatches(head!, parts[0]!) && matchesGlob(rest, parts.slice(1));
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Expand workspace globs without pulling a glob dependency (and without `fs.globSync`, which
 * prints an ExperimentalWarning on some supported Node versions).
 *
 * Supported: `*` / `?` within a segment (incl. prefixes/suffixes like `eslint-plugin-*`), `**`
 * across segments, `{a,b}` alternatives, and `!` negations (applied to every match, like pnpm).
 * Only directories with a `package.json` count, `node_modules` is never entered, and the
 * workspace root itself (e.g. `.`) is dropped — it's always its own target.
 */
function expandWorkspaceGlobs(cwd: string, globs: string[]): string[] {
  const include: GlobSegment[][] = [];
  const exclude: GlobSegment[][] = [];
  for (const raw of globs) {
    const negated = raw.startsWith('!');
    const pattern = (negated ? raw.slice(1) : raw).trim();
    if (!pattern) {
      continue;
    }
    for (const expanded of expandBraces(pattern)) {
      (negated ? exclude : include).push(compileGlob(expanded));
    }
  }

  const childDirCache = new Map<string, string[]>();
  const childDirs = (dir: string): string[] => {
    let names = childDirCache.get(dir);
    if (!names) {
      try {
        names = fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && e.name !== 'node_modules')
          .map((e) => e.name)
          .sort();
      } catch {
        names = [];
      }
      childDirCache.set(dir, names);
    }
    return names;
  };

  const found = new Set<string>();
  const visit = (dir: string, segments: GlobSegment[], globstarDepth: number): void => {
    if (segments.length === 0) {
      if (fs.existsSync(path.join(dir, 'package.json'))) {
        found.add(dir);
      }
      return;
    }
    const [head, ...rest] = segments;
    if (head!.kind === 'globstar') {
      visit(dir, rest, 0);
      if (globstarDepth < MAX_GLOBSTAR_DEPTH) {
        for (const name of childDirs(dir)) {
          if (!name.startsWith('.')) {
            visit(path.join(dir, name), segments, globstarDepth + 1);
          }
        }
      }
      return;
    }
    if (head!.kind === 'literal') {
      const next = path.join(dir, head!.value);
      if (head!.value !== 'node_modules' && isDirectory(next)) {
        visit(next, rest, 0);
      }
      return;
    }
    for (const name of childDirs(dir)) {
      if (segmentMatches(head!, name)) {
        visit(path.join(dir, name), rest, 0);
      }
    }
  };

  for (const segments of include) {
    visit(cwd, segments, 0);
  }

  const root = path.resolve(cwd);
  return [...found].filter((dir) => {
    if (path.resolve(dir) === root) {
      return false;
    }
    const parts = path.relative(cwd, dir).split(path.sep);
    return !exclude.some((segments) => matchesGlob(segments, parts));
  });
}

/**
 * Probe the active `yarn` binary for capabilities relevant to filtered installs.
 *
 *   - `yarn --version` gives us the major (`1.x` → classic, `2+` → berry).
 *   - For berry, we additionally check whether `workspaces focus` is exposed by the loaded
 *     plugin set: `yarn workspaces focus --help` exits 0 when the plugin is installed and
 *     non-zero (or prints "Couldn't find a script") when it isn't. We deliberately avoid
 *     parsing `yarn plugin runtime --json` because its output schema changed between berry
 *     minor versions; the help-probe is forward-compatible. Skipped when `probeFocus` is false.
 *
 * Every probe uses `reject: false` and a tight per-call timeout — yarn missing from PATH or a
 * yarn binary that hangs (rare but seen on misconfigured corp CI) must NEVER block the upgrade
 * loop. On any failure we return `{ }` and the caller treats it as "no capability".
 */
async function probeYarnCapabilities(
  cwd: string,
  opts: { probeFocus: boolean },
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
  if (!opts.probeFocus) {
    return { major };
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

  // `'auto'` (what the CLI always passes) means "detect", exactly like no override.
  const override = cliOverride && cliOverride !== 'auto' ? cliOverride : undefined;

  // Resolve manager
  const declared = pkg as PackageJson & { packageManager?: unknown; devEngines?: unknown };
  const fromField =
    parsePackageManagerField(declared.packageManager) ??
    parseDevEnginesPackageManager(declared.devEngines);
  const fromLock = detectFromLockfile(cwd);

  let manager: PackageManager;
  let managerVersion: string | undefined;
  let managerSource: PackageManagerSource;

  if (override) {
    manager = override;
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

  const config = readWorkspaceConfig(pkg, cwd);
  const { globs } = config;
  if (config.pnpmFile && !override && !fromField && !fromLock.manager) {
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

  // Probe yarn for every yarn project: besides filtered installs, the major decides dedupe
  // support, lockfile handling and the audit command. The `workspaces focus` probe only
  // matters with workspaces, so that extra spawn is skipped otherwise.
  let yarnMajorVersion: number | undefined;
  let yarnSupportsFocus: boolean | undefined;
  if (manager === 'yarn') {
    const probe = await probeYarnCapabilities(cwd, { probeFocus: globs.length > 0 });
    yarnMajorVersion = probe.major;
    yarnSupportsFocus = probe.supportsFocus;
  }

  const isolated = detectIsolatedLockfiles(cwd, manager, workspaceMembers, config);

  return {
    cwd,
    manager,
    managerVersion,
    managerSource,
    lockfile: fromLock.lockfileName === 'npm-shrinkwrap.json' ? undefined : fromLock.lockfileName,
    lockfileName: fromLock.lockfileName,
    hasWorkspaces: globs.length > 0,
    workspaceGlobs: globs,
    workspaceMembers,
    workspacePackageNames: new Set(workspaceMembers.map((m) => m.name)),
    ...(yarnMajorVersion !== undefined ? { yarnMajorVersion } : {}),
    ...(yarnSupportsFocus !== undefined ? { yarnSupportsFocus } : {}),
    ...(isolated.isolated ? { isolatedLockfiles: true, isolatedLockfilesSource: isolated.source } : {}),
  };
}

/**
 * Decide whether this project has per-workspace lockfiles rather than a single shared one.
 *
 * Two detection paths:
 *
 *   1. **pnpm opt-out**: `shared-workspace-lockfile=false` in the root `.npmrc`, or
 *      `sharedWorkspaceLockfile: false` in `pnpm-workspace.yaml`, makes pnpm generate a
 *      `pnpm-lock.yaml` in each workspace member. We don't need to verify the lockfiles exist
 *      on disk — the setting IS the contract. (This also covers the pre-install case where
 *      members don't have their lockfiles yet.)
 *   2. **On-disk evidence**: if every workspace member already has its own lockfile of the
 *      matching kind, we treat the project as isolated-lockfile — unless the manager resolves
 *      a shared workspace root from inside a member, in which case those lockfiles are stale.
 *      This catches the "folder of independent projects accidentally treated as workspaces" case.
 *
 * Returns `{ isolated: false }` when neither applies OR when `hasWorkspaces` is false.
 */
function detectIsolatedLockfiles(
  cwd: string,
  manager: PackageManager,
  members: WorkspaceMember[],
  config: WorkspaceConfig,
): { isolated: false } | { isolated: true; source: 'pnpm-npmrc' | 'per-workspace-lockfiles' } {
  if (members.length === 0) {
    return { isolated: false };
  }

  if (manager === 'pnpm') {
    const yamlSetting = config.pnpmSharedWorkspaceLockfile;
    if (yamlSetting === false || yamlSetting === 'false') {
      return { isolated: true, source: 'pnpm-npmrc' };
    }

    // Look for the canonical `.npmrc` opt-out. We parse conservatively — a commented-out line
    // (`# shared-workspace-lockfile=false`) shouldn't trigger detection.
    const npmrc = path.join(cwd, '.npmrc');
    try {
      if (fs.existsSync(npmrc)) {
        const raw = fs.readFileSync(npmrc, 'utf8');
        for (const line of raw.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith(';')) continue;
          const m = trimmed.match(/^shared-workspace-lockfile\s*=\s*(false|no|0)$/i);
          if (m) {
            return { isolated: true, source: 'pnpm-npmrc' };
          }
        }
      }
    } catch {
      // Unreadable .npmrc is effectively absent — fall through.
    }
  }

  // Running an install inside a member still resolves the workspace root here (npm/yarn/bun via
  // root `workspaces`, pnpm via pnpm-workspace.yaml), so "per-member" installs would all race on
  // the root lockfile + node_modules. Member lockfiles are just stale.
  const resolvesSharedRoot = manager === 'pnpm' ? config.pnpmFile : config.rootWorkspacesField;
  if (resolvesSharedRoot) {
    return { isolated: false };
  }

  // Generic path: every workspace member has its own lockfile of the matching kind.
  const expected =
    manager === 'pnpm'
      ? ['pnpm-lock.yaml']
      : manager === 'yarn'
        ? ['yarn.lock']
        : manager === 'bun'
          ? ['bun.lock', 'bun.lockb']
          : ['package-lock.json', 'npm-shrinkwrap.json'];
  const allPresent = members.every((m) =>
    expected.some((file) => fs.existsSync(path.join(m.dir, file))),
  );
  if (allPresent) {
    return { isolated: true, source: 'per-workspace-lockfiles' };
  }
  return { isolated: false };
}
