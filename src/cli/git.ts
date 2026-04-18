/**
 * Thin wrappers around `git` for the optional commit-per-success workflow.
 *
 * Design notes:
 *   - Every helper uses `reject: false` so we never throw on a non-zero git exit code; callers
 *     decide whether the failure should abort the whole run or just degrade to "skip git for
 *     this step". A failed commit (e.g. signing rejected by GPG, pre-commit hook refused) must
 *     never lose the actual upgrade work — the package.json mutation already happened.
 *   - We deliberately `git add` only the files we know we touched (the per-target package.json
 *     + the root lockfile), never `git add -A` / `git add .`. That avoids accidentally sweeping
 *     up unrelated WIP, generated files, or files modified by user prepare/postinstall hooks.
 *   - `relativizeForRepo` translates the absolute paths the engine works with into repo-root-
 *     relative paths so commit messages and `git add` arguments don't leak local filesystem
 *     prefixes.
 */
import path from 'node:path';
import fs from 'fs-extra';
import { execa } from 'execa';
import type { PackageManager } from '../core/workspaces.js';

export type GitCommitMode = 'per-success' | 'per-target' | 'all';

export interface GitOptions {
  /** Working directory used for git invocations (typically the workspace root). */
  cwd: string;
  /** When true, pass `--gpg-sign` to every commit. */
  sign?: boolean;
  /** Override commit author / committer (purely for tests; never wired to the CLI). */
  authorEmail?: string;
  authorName?: string;
}

export interface GitCommitResult {
  ok: boolean;
  /** Short commit SHA (`git rev-parse --short HEAD`) when ok; undefined when commit failed. */
  sha?: string;
  message: string;
  /** Files that were `git add`-ed for this commit (repo-root-relative). */
  files: string[];
  /** Stderr output from `git commit` when it failed (for surfacing to the user). */
  error?: string;
}

/** True when `cwd` is inside a git working tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  const r = await execa('git', ['rev-parse', '--is-inside-work-tree'], { cwd, reject: false });
  return r.exitCode === 0 && r.stdout.trim() === 'true';
}

/** Absolute path to the repo's top-level directory (`git rev-parse --show-toplevel`). */
export async function getRepoRoot(cwd: string): Promise<string | undefined> {
  const r = await execa('git', ['rev-parse', '--show-toplevel'], { cwd, reject: false });
  return r.exitCode === 0 ? r.stdout.trim() : undefined;
}

/**
 * List of repo-root-relative paths that have uncommitted changes (modified, added, deleted,
 * untracked but not in `.gitignore`). Used by the pre-flight check to refuse running on a
 * dirty tree unless the user passed `--git-allow-dirty`.
 */
export async function getUncommittedFiles(cwd: string): Promise<string[]> {
  const r = await execa('git', ['status', '--porcelain'], { cwd, reject: false });
  if (r.exitCode !== 0) {
    return [];
  }
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((line) => {
      // Porcelain format is `XY <path>` where XY is two status chars. Renames look like
      // `R  old -> new`; we want the new name.
      const m = line.match(/^.{1,3}\s+(?:.+? -> )?(.+)$/);
      return m ? m[1] : line;
    });
}

export async function getCurrentBranch(cwd: string): Promise<string | undefined> {
  const r = await execa('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, reject: false });
  return r.exitCode === 0 ? r.stdout.trim() : undefined;
}

/**
 * Create-and-checkout `branch`. If the branch already exists, just checkout (no -b). Returns
 * the previous branch name for reporting, or `undefined` on first-commit-less repos.
 */
export async function checkoutBranch(cwd: string, branch: string): Promise<string | undefined> {
  const previous = await getCurrentBranch(cwd);
  // Try to create+switch first; if that fails because the branch exists, fall back to plain
  // checkout. This avoids racing on `git rev-parse --verify` to detect existence.
  const create = await execa('git', ['checkout', '-b', branch], { cwd, reject: false });
  if (create.exitCode === 0) {
    return previous;
  }
  const switchOnly = await execa('git', ['checkout', branch], { cwd, reject: false });
  if (switchOnly.exitCode !== 0) {
    throw new Error(
      `git checkout ${branch} failed: ${(create.stderr || switchOnly.stderr).trim()}`,
    );
  }
  return previous;
}

/**
 * Stage the given absolute file paths (any path that doesn't exist anymore is silently dropped
 * — git would error on missing pathspec otherwise, and lockfiles can be absent on first install).
 * Returns the repo-root-relative paths that were actually staged.
 */
export async function gitAdd(opts: GitOptions, files: string[]): Promise<string[]> {
  const repoRoot = (await getRepoRoot(opts.cwd)) ?? opts.cwd;
  // `git rev-parse --show-toplevel` returns the CANONICAL path (with macOS's `/private`
  // prefix resolved); the absolute paths the engine gives us may still go through
  // `/var/folders/...`. Realpath both sides so `path.relative` produces a path actually
  // inside the repo — otherwise git refuses with "outside repository".
  const repoRootReal = await fs.realpath(repoRoot).catch(() => repoRoot);
  const relative: string[] = [];
  for (const abs of files) {
    if (!(await fs.pathExists(abs))) {
      continue;
    }
    const absReal = await fs.realpath(abs).catch(() => abs);
    const rel = path.relative(repoRootReal, absReal);
    relative.push(rel);
  }
  if (relative.length === 0) {
    return [];
  }
  const r = await execa('git', ['add', '--', ...relative], {
    cwd: repoRootReal,
    reject: false,
  });
  if (r.exitCode !== 0) {
    throw new Error(`git add failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return relative;
}

/**
 * Create a commit with `message`. Returns `{ ok: false, error }` when there's nothing to
 * commit (clean index) OR when git itself refuses (pre-commit hook, signing, etc.) — callers
 * use the same path either way: log + record + continue.
 */
export async function gitCommit(
  opts: GitOptions,
  message: string,
  files: string[],
): Promise<GitCommitResult> {
  const repoRoot = (await getRepoRoot(opts.cwd)) ?? opts.cwd;

  // Short-circuit if the index has nothing for the commit (e.g. files were absent or the diff
  // was empty). Querying `--cached` instead of the working tree means we only see what's
  // actually staged for THIS commit.
  const status = await execa('git', ['diff', '--cached', '--name-only'], {
    cwd: repoRoot,
    reject: false,
  });
  if (status.exitCode === 0 && status.stdout.trim() === '') {
    return {
      ok: false,
      message,
      files,
      error: 'nothing to commit (no staged changes)',
    };
  }

  const args = ['commit', '-m', message];
  if (opts.sign) {
    args.push('--gpg-sign');
  }
  const env = { ...process.env };
  if (opts.authorEmail) {
    env.GIT_AUTHOR_EMAIL = opts.authorEmail;
    env.GIT_COMMITTER_EMAIL = opts.authorEmail;
  }
  if (opts.authorName) {
    env.GIT_AUTHOR_NAME = opts.authorName;
    env.GIT_COMMITTER_NAME = opts.authorName;
  }

  const r = await execa('git', args, { cwd: repoRoot, env, reject: false });
  if (r.exitCode !== 0) {
    return {
      ok: false,
      message,
      files,
      error: (r.stderr || r.stdout).trim(),
    };
  }

  const sha = await execa('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, reject: false });
  return {
    ok: true,
    sha: sha.exitCode === 0 ? sha.stdout.trim() : undefined,
    message,
    files,
  };
}

/**
 * Default lockfile basename for the detected package manager. We commit it alongside the
 * mutated `package.json` so the commit is self-contained (anyone checking out that SHA can
 * `<mgr> install` and get the exact tree we tested).
 */
export function lockfileBasenameFor(manager: PackageManager): string {
  switch (manager) {
    case 'pnpm':
      return 'pnpm-lock.yaml';
    case 'yarn':
      return 'yarn.lock';
    case 'npm':
    default:
      return 'package-lock.json';
  }
}

// ---------------------------------------------------------------------------
// Commit message formatters
// ---------------------------------------------------------------------------

export interface UpgradeChange {
  name: string;
  /** Old version range (e.g. `^1.6.0`). */
  from: string;
  /** New version range (e.g. `^1.7.2`). */
  to: string;
  /** Workspace label (`'root'` or member package name). */
  workspace?: string;
  /** Linked-group id when this change was part of a batch. */
  groupId?: string;
}

/** Strip the leading caret/tilde/etc. for a clean "from → to" message. */
function tidyVersion(v: string): string {
  return v.trim();
}

export function formatPerSuccessMessage(prefix: string, changes: UpgradeChange[]): string {
  if (changes.length === 1) {
    const c = changes[0];
    const ws = c.workspace && c.workspace !== 'root' ? ` (${c.workspace})` : '';
    return `${prefix}bump ${c.name} from ${tidyVersion(c.from)} to ${tidyVersion(c.to)}${ws}`;
  }
  // Linked group → multi-line message with each member listed.
  const head = changes[0];
  const ws = head.workspace && head.workspace !== 'root' ? ` (${head.workspace})` : '';
  const lines = [
    `${prefix}bump ${changes.length} linked packages${ws}`,
    '',
    ...changes.map((c) => `- ${c.name}: ${tidyVersion(c.from)} → ${tidyVersion(c.to)}`),
  ];
  return lines.join('\n');
}

export function formatPerTargetMessage(
  prefix: string,
  workspace: string,
  changes: UpgradeChange[],
): string {
  if (changes.length === 0) {
    return `${prefix}no changes for ${workspace}`;
  }
  const wsLabel = workspace === 'root' ? '' : ` in ${workspace}`;
  const lines = [
    `${prefix}${changes.length} upgrade${changes.length === 1 ? '' : 's'}${wsLabel}`,
    '',
    ...changes.map((c) => `- ${c.name}: ${tidyVersion(c.from)} → ${tidyVersion(c.to)}`),
  ];
  return lines.join('\n');
}

export function formatAllInOneMessage(prefix: string, changes: UpgradeChange[]): string {
  if (changes.length === 0) {
    return `${prefix}no upgrades`;
  }
  const targets = new Map<string, UpgradeChange[]>();
  for (const c of changes) {
    const key = c.workspace ?? 'root';
    const list = targets.get(key) ?? [];
    list.push(c);
    targets.set(key, list);
  }
  const targetCount = targets.size;
  const head =
    targetCount === 1
      ? `${prefix}${changes.length} upgrade${changes.length === 1 ? '' : 's'}`
      : `${prefix}${changes.length} upgrades across ${targetCount} targets`;
  const lines: string[] = [head, ''];
  for (const [ws, list] of targets) {
    if (targetCount > 1) {
      lines.push(`[${ws}]`);
    }
    for (const c of list) {
      lines.push(`- ${c.name}: ${tidyVersion(c.from)} → ${tidyVersion(c.to)}`);
    }
    if (targetCount > 1) {
      lines.push('');
    }
  }
  // Trim trailing blank line.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.join('\n');
}
