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
   * yarn, and probed for every yarn project: classic v1 vs berry v2+ decides dedupe support,
   * lockfile handling and the audit command.
   * `undefined` means we couldn't probe the binary (PATH miss, network-isolated CI,
   * etc.) — callers must treat that as "no capability".
   */
  yarnMajorVersion?: number;
  /**
   * True when the active yarn binary supports `yarn workspaces focus <name>` (i.e. yarn berry
   * v2+ AND `@yarnpkg/plugin-workspace-tools` is loaded). Only meaningful when `manager === 'yarn'`.
   * Always `false` for yarn classic; not probed (undefined) for berry projects without
   * workspaces. Reported only: upgrade installs never use `focus` (it doesn't write yarn.lock
   * and installs a partial tree), so `--install-mode filtered` always falls back to a full
   * root `yarn install`.
   */
  yarnSupportsFocus?: boolean;
  /**
   * True when every workspace member is an **independent install**: an install run inside one
   * member touches only that member's lockfile and `node_modules`. Detected when every member
   * directory contains its own lockfile of the right kind (`package-lock.json` /
   * `pnpm-lock.yaml` / `yarn.lock` / `bun.lock`) AND the manager wouldn't resolve a shared
   * workspace root from inside a member (no root `workspaces` for npm/yarn/bun, no
   * `pnpm-workspace.yaml` for pnpm). This is the "folder of independent projects" case; rare
   * but it shows up in corporate monorepos.
   *
   * Separate lockfiles alone are not enough: pnpm's `shared-workspace-lockfile=false` /
   * `sharedWorkspaceLockfile: false` gives each member its own `pnpm-lock.yaml`, but
   * `pnpm install` anywhere under `pnpm-workspace.yaml` is recursive and installs every
   * project, so those workspaces stay `false`.
   *
   * When true, the upgrader's keyed install mutex lets different workspace targets install
   * **concurrently** — the install steps don't race. When false (or in single-package
   * projects), every install keys off the root `cwd` and behaves exactly as before (fully
   * serialized).
   */
  isolatedLockfiles?: boolean;
  /**
   * Reason / source for `isolatedLockfiles === true`, surfaced in the structured report so
   * users can see why the tool chose parallel installs. Never populated when
   * `isolatedLockfiles` is false / undefined.
   */
  isolatedLockfilesSource?: 'per-workspace-lockfiles';
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

/** Every lockfile name a supported manager writes at the project root, in detection order. */
export const ROOT_LOCKFILE_NAMES: readonly RootLockfile[] = ROOT_LOCKFILES.map(([file]) => file);

/**
 * Root lockfiles on disk, split by whether installing with `manager` rewrites them. Another
 * manager's lockfile (e.g. `package-lock.json` next to `bun.lock`) is never touched by an upgrade
 * run, so it drifts from package.json while CI or a host may still install from it.
 */
export function describeRootLockfiles(
  cwd: string,
  manager: PackageManager,
): { updated: RootLockfile[]; stale: RootLockfile[] } {
  const updated: RootLockfile[] = [];
  const stale: RootLockfile[] = [];
  const bunWritesYarnLock = manager === 'bun' && bunPrintsYarnLockfile(cwd);
  for (const [file, owner] of ROOT_LOCKFILES) {
    if (fs.existsSync(path.join(cwd, file))) {
      const written = owner === manager || (bunWritesYarnLock && file === 'yarn.lock');
      (written ? updated : stale).push(file);
    }
  }
  return { updated, stale };
}

/** bunfig.toml `[install.lockfile] print = "yarn"`: every `bun install` also writes a yarn.lock. */
function bunPrintsYarnLockfile(cwd: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(cwd, 'bunfig.toml'), 'utf8');
    return /^\s*print\s*=\s*["']yarn["']/m.test(raw);
  } catch {
    return false;
  }
}

function detectFromLockfile(cwd: string): { manager?: PackageManager; lockfileName?: RootLockfile } {
  const present = ROOT_LOCKFILES.filter(([file]) => fs.existsSync(path.join(cwd, file)));
  // A yarn.lock next to bun.lock / bun.lockb is usually bun's own (bunfig `print = "yarn"`), so
  // the bun lockfile decides. An explicit `packageManager` field still wins over both.
  const bunLock =
    present[0]?.[0] === 'yarn.lock' ? present.find(([, manager]) => manager === 'bun') : undefined;
  const hit = bunLock ?? present[0];
  return hit ? { manager: hit[1], lockfileName: hit[0] } : {};
}

interface WorkspaceConfig {
  globs: string[];
  /** `pnpm-workspace.yaml` exists at the root. */
  pnpmFile: boolean;
  /** Root `package.json` declares `workspaces` — what npm/yarn/bun resolve the workspace root from. */
  rootWorkspacesField: boolean;
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
  const pnpmYaml = path.join(cwd, PNPM_WORKSPACE_FILE);
  if (fs.existsSync(pnpmYaml)) {
    pnpmFile = true;
    try {
      // logLevel 'error': yaml would otherwise print document warnings via process.emitWarning.
      const doc: unknown = YAML.parse(fs.readFileSync(pnpmYaml, 'utf8'), { logLevel: 'error' });
      if (doc && typeof doc === 'object') {
        globs.push(...stringList((doc as Record<string, unknown>).packages));
      }
    } catch {
      // best-effort; ignore unreadable yaml
    }
  }

  return {
    globs: Array.from(new Set(globs)),
    pnpmFile,
    rootWorkspacesField: fromPackageJson.length > 0,
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

function compileWorkspaceGlobs(globs: string[]): { include: GlobSegment[][]; exclude: GlobSegment[][] } {
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
  return { include, exclude };
}

/** True for the workspace root itself and for paths a `!` negation removes. */
function droppedMember(cwd: string, dir: string, exclude: GlobSegment[][]): boolean {
  if (path.resolve(dir) === path.resolve(cwd)) {
    return true;
  }
  const parts = path.relative(cwd, dir).split(path.sep);
  return exclude.some((segments) => matchesGlob(segments, parts));
}

/**
 * Expand workspace globs without pulling a glob dependency (and without `fs.globSync`, which
 * prints an ExperimentalWarning on some supported Node versions).
 *
 * Supported: `*` / `?` within a segment (incl. prefixes/suffixes like `eslint-plugin-*`), `**`
 * across segments, `{a,b}` alternatives, and `!` negations (applied to every match, like pnpm).
 * Only directories with a `package.json` count, `node_modules` is never entered, and the
 * workspace root itself (e.g. `.`) is dropped — it's always its own target.
 *
 * `includeBare` also keeps matched directories WITHOUT a `package.json` (for
 * `findWorkspaceProblems`), except below a `**`, which is meant to search a tree.
 */
function expandWorkspaceGlobs(
  cwd: string,
  globs: string[],
  opts: { includeBare?: boolean } = {},
): string[] {
  const { include, exclude } = compileWorkspaceGlobs(globs);

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
  const visit = (
    dir: string,
    segments: GlobSegment[],
    globstarDepth: number,
    belowGlobstar: boolean,
  ): void => {
    if (segments.length === 0) {
      if ((opts.includeBare && !belowGlobstar) || fs.existsSync(path.join(dir, 'package.json'))) {
        found.add(dir);
      }
      return;
    }
    const [head, ...rest] = segments;
    if (head!.kind === 'globstar') {
      visit(dir, rest, 0, true);
      if (globstarDepth < MAX_GLOBSTAR_DEPTH) {
        for (const name of childDirs(dir)) {
          if (!name.startsWith('.')) {
            visit(path.join(dir, name), segments, globstarDepth + 1, true);
          }
        }
      }
      return;
    }
    if (head!.kind === 'literal') {
      const next = path.join(dir, head!.value);
      if (head!.value !== 'node_modules' && isDirectory(next)) {
        visit(next, rest, 0, belowGlobstar);
      }
      return;
    }
    for (const name of childDirs(dir)) {
      if (segmentMatches(head!, name)) {
        visit(path.join(dir, name), rest, 0, belowGlobstar);
      }
    }
  };

  for (const segments of include) {
    visit(cwd, segments, 0, false);
  }

  return [...found].filter((dir) => !droppedMember(cwd, dir, exclude));
}

export type WorkspaceProblemKind =
  | 'missing-package-json'
  | 'unreadable-package-json'
  | 'missing-name'
  | 'missing-path';

export interface WorkspaceProblem {
  /** Absolute path of the declared member directory. */
  dir: string;
  problem: WorkspaceProblemKind;
}

/**
 * Declared workspace entries that don't resolve to a usable member — everything
 * `detectProjectInfo` silently leaves out of `workspaceMembers`:
 *
 *   - `missing-path`: a literal (non-glob) entry such as `packages/app` that isn't a directory.
 *   - `missing-package-json`: a directory matched by an entry has no `package.json`
 *     (directories reached through `**` are skipped: that pattern is meant to search a tree).
 *   - `unreadable-package-json`: its `package.json` doesn't parse as a JSON object.
 *   - `missing-name`: its `package.json` has no `name`.
 *
 * Same globs, negations and `node_modules` / root handling as member detection. Sorted by `dir`;
 * empty for single-package projects.
 */
export async function findWorkspaceProblems(cwd: string): Promise<WorkspaceProblem[]> {
  let pkg: PackageJson = {};
  try {
    pkg = (await fs.readJson(path.join(cwd, 'package.json'))) as PackageJson;
  } catch {
    // Missing / unreadable root package.json: pnpm-workspace.yaml can still declare members.
  }
  const { globs } = readWorkspaceConfig(pkg, cwd);
  const { include, exclude } = compileWorkspaceGlobs(globs);
  const problems: WorkspaceProblem[] = [];

  const missing = new Set<string>();
  for (const segments of include) {
    const literal = segments.every(
      (s): s is Extract<GlobSegment, { kind: 'literal' }> => s.kind === 'literal',
    );
    if (!literal || segments.length === 0) {
      continue;
    }
    const dir = path.join(cwd, ...segments.map((s) => s.value));
    if (!isDirectory(dir) && !droppedMember(cwd, dir, exclude)) {
      missing.add(dir);
    }
  }
  for (const dir of missing) {
    problems.push({ dir, problem: 'missing-path' });
  }

  for (const dir of expandWorkspaceGlobs(cwd, globs, { includeBare: true })) {
    const member = readMember(dir);
    if ('problem' in member) {
      problems.push({ dir, problem: member.problem });
    }
  }
  return problems.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Probe the active `yarn` binary's version and `workspaces focus` support (the latter is only
 * reported — see `ProjectInfo.yarnSupportsFocus`).
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
export async function probeYarnCapabilities(
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

function readMember(
  dir: string,
): { name: string } | { problem: Exclude<WorkspaceProblemKind, 'missing-path'> } {
  const file = path.join(dir, 'package.json');
  if (!fs.existsSync(file)) {
    return { problem: 'missing-package-json' };
  }
  let pkg: unknown;
  try {
    pkg = fs.readJsonSync(file);
  } catch {
    return { problem: 'unreadable-package-json' };
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) {
    return { problem: 'unreadable-package-json' };
  }
  const { name } = pkg as PackageJson;
  return typeof name === 'string' && name ? { name } : { problem: 'missing-name' };
}

function readMemberName(dir: string): string | undefined {
  const member = readMember(dir);
  return 'name' in member ? member.name : undefined;
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

  // Probe yarn for every yarn project: the major decides dedupe support, lockfile handling and
  // the audit command. The `workspaces focus` probe (reported only) means nothing without
  // workspaces, so that extra spawn is skipped otherwise.
  let yarnMajorVersion: number | undefined;
  let yarnSupportsFocus: boolean | undefined;
  if (manager === 'yarn') {
    const probe = await probeYarnCapabilities(cwd, { probeFocus: globs.length > 0 });
    yarnMajorVersion = probe.major;
    yarnSupportsFocus = probe.supportsFocus;
  }

  const isolated = detectIsolatedLockfiles(manager, workspaceMembers, config);

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
 * Decide whether each workspace member installs independently of the others.
 *
 * Only on-disk evidence counts: every workspace member already has its own lockfile of the
 * matching kind AND the manager doesn't resolve a shared workspace root from inside a member.
 * This catches the "folder of independent projects accidentally treated as workspaces" case.
 *
 * pnpm's `shared-workspace-lockfile=false` (`.npmrc`) / `sharedWorkspaceLockfile: false`
 * (`pnpm-workspace.yaml`) deliberately does NOT count: it splits the lockfile per project,
 * but `pnpm install` run anywhere under `pnpm-workspace.yaml` still installs every project,
 * so parallel per-member installs would race on shared `node_modules` and on each other's
 * lockfiles.
 *
 * Returns `{ isolated: false }` when that doesn't hold OR when `hasWorkspaces` is false.
 */
function detectIsolatedLockfiles(
  manager: PackageManager,
  members: WorkspaceMember[],
  config: WorkspaceConfig,
): { isolated: false } | { isolated: true; source: 'per-workspace-lockfiles' } {
  if (members.length === 0) {
    return { isolated: false };
  }

  // Running an install inside a member still resolves the workspace root here (npm/yarn/bun via
  // root `workspaces`, pnpm via pnpm-workspace.yaml — whatever its lockfile settings), so
  // "per-member" installs would all race on the root install. Member lockfiles are stale, or
  // (pnpm without a shared lockfile) written by that same recursive install.
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
