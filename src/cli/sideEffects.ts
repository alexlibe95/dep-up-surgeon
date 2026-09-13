/**
 * Keeps a run's footprint to dependency files. Validators and install scripts can rewrite tracked
 * files — Next 16's `next build` rewrites tsconfig.json — and those edits would otherwise sit in the
 * working tree next to the upgrade. In a git repo, every tracked file that was clean before the run
 * and changed during it is checked out again, except the files an upgrade legitimately changes.
 */
import path from 'node:path';
import { execa } from 'execa';
import { ROOT_LOCKFILE_NAMES } from '../core/workspaces.js';
import { getRepoRoot, isGitRepo } from './git.js';

/** Files an upgrade (or undo) is allowed to leave changed, matched by basename. */
const DEPENDENCY_FILES = new Set<string>([
  'package.json',
  'pnpm-workspace.yaml',
  '.dep-up-surgeonrc',
  ...ROOT_LOCKFILE_NAMES,
]);

/** Files dep-up-surgeon itself writes into the project (legacy report, summary, rollback backups). */
export function isToolArtifact(file: string): boolean {
  const base = path.basename(file);
  return (
    base.startsWith('.dep-up-surgeon.last-run.') ||
    /^dep-up-surgeon-summary\.(md|html)$/.test(base) ||
    base.endsWith('.dep-up-surgeon.bak')
  );
}

interface StatusEntry {
  /** Repo-root-relative path. */
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

export interface WorktreeSnapshot {
  root: string;
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
  return { root, changedBefore: new Set((await gitStatus(root)).map((e) => e.path)) };
}

export interface SideEffectRestore {
  /** Tracked files put back to their pre-run content. */
  restored: string[];
  /** Untracked, non-ignored files that appeared during the run; never deleted. */
  untracked: string[];
}

export async function restoreSideEffects(before: WorktreeSnapshot): Promise<SideEffectRestore> {
  const changed = (await gitStatus(before.root)).filter(
    (e) =>
      !before.changedBefore.has(e.path) &&
      !DEPENDENCY_FILES.has(path.basename(e.path)) &&
      !isToolArtifact(e.path),
  );
  const untracked = changed.filter((e) => !e.tracked).map((e) => e.path);
  const restored = changed.filter((e) => e.tracked).map((e) => e.path);
  if (restored.length > 0) {
    // They were clean before the run, so the index still holds their pre-run content.
    const r = await execa('git', ['checkout', '--', ...restored], { cwd: before.root, reject: false });
    if (r.exitCode !== 0) {
      return { restored: [], untracked };
    }
  }
  return { restored, untracked };
}
