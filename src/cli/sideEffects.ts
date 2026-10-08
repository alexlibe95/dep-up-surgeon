/**
 * Keeps a run's footprint to dependency files. Validators and install scripts can rewrite tracked
 * files — Next 16's `next build` rewrites tsconfig.json — and those edits would otherwise sit in the
 * working tree next to the upgrade. In a git repo, every tracked file under the project directory
 * that was clean before the run and changed during it is checked out again, except the files an
 * upgrade legitimately changes. Git can't tell such a rewrite from an edit the user made while the
 * run was going, so the changed content is copied aside first instead of being discarded.
 */
import path from 'node:path';
import fs from 'fs-extra';
import { execa } from 'execa';
import { ROOT_LOCKFILE_NAMES } from '../core/workspaces.js';
import { getRepoRoot, isGitRepo } from './git.js';

/** Files an upgrade (or undo) is allowed to leave changed, matched by basename. */
const DEPENDENCY_FILES = new Set<string>([
  'package.json',
  'pnpm-workspace.yaml',
  '.dep-up-surgeonrc',
  ...ROOT_LOCKFILE_NAMES,
  // Yarn Plug'n'Play: zero-install repos commit the resolution map with the lockfile.
  '.pnp.cjs',
  '.pnp.loader.mjs',
  '.pnp.data.json',
]);

/** Yarn's install output that zero-install repos commit (`.yarn/cache/*.zip`, ...). */
const YARN_INSTALL_DIRS = ['.yarn/cache/', '.yarn/unplugged/', '.yarn/install-state.gz'];

/** Where the content of restored files is kept, under the project directory (git-ignored). */
export const SIDE_EFFECTS_DIR = path.join('node_modules', '.cache', 'dep-up-surgeon', 'side-effects');

/** Files dep-up-surgeon itself writes into the project (legacy report, summary, rollback backups). */
export function isToolArtifact(file: string): boolean {
  const base = path.basename(file);
  return (
    base.startsWith('.dep-up-surgeon.last-run.') ||
    /^dep-up-surgeon-summary\.(md|html)$/.test(base) ||
    base.endsWith('.dep-up-surgeon.bak')
  );
}

function isDependencyFile(repoPath: string): boolean {
  return (
    DEPENDENCY_FILES.has(path.posix.basename(repoPath)) ||
    YARN_INSTALL_DIRS.some((dir) => `/${repoPath}`.includes(`/${dir}`))
  );
}

interface StatusEntry {
  /** Repo-root-relative path, `/`-separated. */
  path: string;
  tracked: boolean;
}

async function gitStatus(root: string): Promise<StatusEntry[]> {
  const r = await execa('git', ['status', '--porcelain=v1', '-z'], { cwd: root, reject: false });
  if (r.exitCode !== 0) {
    return [];
  }
  const fields = r.stdout.split('\0');
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (field.length < 4) {
      continue;
    }
    const xy = field.slice(0, 2);
    entries.push({ path: field.slice(3), tracked: xy !== '??' });
    // A rename / copy carries its original path as the next NUL-separated field.
    if (xy[0] === 'R' || xy[0] === 'C') {
      i++;
    }
  }
  return entries;
}

/** `path` relative to the repo root, `/`-separated (git's own spelling). */
function repoRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/');
}

export interface WorktreeSnapshot {
  root: string;
  /** The project directory; nothing outside it is restored. */
  cwd: string;
  /** Repo-relative prefix of `cwd` (`''` when it is the repo root). */
  scope: string;
  /** Paths that already had changes (or were untracked) before the run. */
  changedBefore: Set<string>;
}

/** `undefined` outside a git repo: there is no clean state to compare against. */
export async function captureWorktree(cwd: string): Promise<WorktreeSnapshot | undefined> {
  if (!(await isGitRepo(cwd))) {
    return undefined;
  }
  const root = await getRepoRoot(cwd);
  if (!root) {
    return undefined;
  }
  // `git rev-parse --show-toplevel` is canonical (macOS `/private/var`); match it.
  const realRoot = await fs.realpath(root).catch(() => root);
  const realCwd = await fs.realpath(cwd).catch(() => cwd);
  return {
    root: realRoot,
    cwd: realCwd,
    scope: repoRelative(realRoot, realCwd),
    changedBefore: new Set((await gitStatus(realRoot)).map((e) => e.path)),
  };
}

export interface SideEffectRestore {
  /** Tracked files put back to their pre-run content (repo-relative). */
  restored: string[];
  /** Untracked, non-ignored files that appeared during the run; never deleted. */
  untracked: string[];
  /** Where the run's version of each restored file was copied, when anything was restored. */
  backupDir?: string;
}

export interface RestoreOptions {
  /** Absolute paths the run wrote on purpose (e.g. `--summary-file`): never restored. */
  keep?: string[];
}

export async function restoreSideEffects(
  before: WorktreeSnapshot,
  options: RestoreOptions = {},
): Promise<SideEffectRestore> {
  const inScope = (p: string): boolean =>
    before.scope === '' || p === before.scope || p.startsWith(`${before.scope}/`);
  const keep = new Set(
    await Promise.all(
      (options.keep ?? []).map(async (f) =>
        repoRelative(before.root, await fs.realpath(f).catch(() => path.resolve(f))),
      ),
    ),
  );
  const changed = (await gitStatus(before.root)).filter(
    (e) =>
      inScope(e.path) &&
      !before.changedBefore.has(e.path) &&
      !keep.has(e.path) &&
      !isDependencyFile(e.path) &&
      !isToolArtifact(e.path),
  );
  const untracked = changed.filter((e) => !e.tracked).map((e) => e.path);
  const candidates = changed.filter((e) => e.tracked).map((e) => e.path);
  if (candidates.length === 0) {
    return { restored: [], untracked };
  }

  // Copy the run's version aside first: an edit the user saved mid-run looks exactly like a
  // build rewrite, and must stay recoverable. A file that can't be copied is left alone.
  const backupDir = path.join(before.cwd, SIDE_EFFECTS_DIR);
  await fs.remove(backupDir).catch(() => undefined);
  const restored: string[] = [];
  for (const p of candidates) {
    const source = path.join(before.root, p);
    try {
      if (await fs.pathExists(source)) {
        const inProject = before.scope ? p.slice(before.scope.length + 1) : p;
        await fs.copy(source, path.join(backupDir, ...inProject.split('/')));
      }
      restored.push(p);
    } catch {
      // keep it changed rather than lose it
    }
  }
  if (restored.length === 0) {
    return { restored: [], untracked };
  }
  await fs.outputFile(path.join(backupDir, '.gitignore'), '*\n').catch(() => undefined);
  // They were clean before the run, so the index still holds their pre-run content.
  const r = await execa('git', ['checkout', '--', ...restored], { cwd: before.root, reject: false });
  if (r.exitCode !== 0) {
    return { restored: [], untracked };
  }
  return { restored, untracked, backupDir };
}
