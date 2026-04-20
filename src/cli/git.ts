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
  /**
   * Optional changelog excerpt body (from GitHub Releases or the package tarball CHANGELOG.md).
   * When present, formatters append it to the commit body under a clearly demarcated section so
   * reviewers can see *why* the version moved without opening a browser tab.
   */
  changelog?: {
    source: 'github-release' | 'changelog.md';
    url?: string;
    body: string;
    breaking?: {
      hasBreaking: boolean;
      matchedLines: string[];
      reasons: string[];
    };
  };
  /**
   * Security metadata from `--security-only` audit. Surfaced in commit subjects and bodies so
   * the merge queue / code-review tools can pivot on severity + advisory id.
   */
  security?: {
    severity: 'low' | 'moderate' | 'high' | 'critical';
    ids: string[];
    url?: string;
    title?: string;
  };
  /**
   * Peer-range intersection breadcrumb. Present only when the engine's peer resolver nudged
   * this row off the registry `latest` to keep a linked-group install satisfiable. Emitted
   * as a footer + a `[peer-resolved]` subject tag so reviewers can see at a glance that the
   * version in the commit isn't the pure "bump to latest" one.
   */
  resolvedPeer?: {
    originalTarget: string;
    reason: string;
    tuplesExplored: number;
  };
}

/** Strip the leading caret/tilde/etc. for a clean "from → to" message. */
function tidyVersion(v: string): string {
  return v.trim();
}

/**
 * Render a changelog-excerpt block for the commit body. Returns an empty string when the change
 * has no attached excerpt. Each block is prefixed with a fenced separator so `git log -p` stays
 * legible even when a commit carries multiple excerpts (linked groups).
 */
function formatChangelogBlock(change: UpgradeChange): string {
  if (!change.changelog?.body) {
    return '';
  }
  const cl = change.changelog;
  const attribution =
    cl.source === 'github-release'
      ? cl.url
        ? `source: GitHub Release (${cl.url})`
        : 'source: GitHub Release'
      : 'source: CHANGELOG.md';
  return [
    `--- ${change.name} ${tidyVersion(change.from)} → ${tidyVersion(change.to)} ---`,
    attribution,
    '',
    cl.body,
  ].join('\n');
}

/** Concatenate every available changelog block, separated by blank lines. */
function changelogSection(changes: UpgradeChange[]): string {
  const blocks = changes.map(formatChangelogBlock).filter(Boolean);
  return blocks.length > 0 ? `\n\n${blocks.join('\n\n')}` : '';
}

/**
 * Prepend a conventional-commits-ish `security` scope and severity tag when ANY change in the
 * batch carries security metadata. Keeps the subject parseable by dashboards that group by
 * keyword while still fitting in a normal 72-char commit subject line.
 */
function securitySubjectTag(changes: UpgradeChange[]): string {
  const highest = changes.reduce<'low' | 'moderate' | 'high' | 'critical' | undefined>((acc, c) => {
    const s = c.security?.severity;
    if (!s) return acc;
    if (!acc) return s;
    const rank = { low: 1, moderate: 2, high: 3, critical: 4 } as const;
    return rank[s] > rank[acc] ? s : acc;
  }, undefined);
  return highest ? `[security:${highest}] ` : '';
}

/**
 * True when ANY change in the batch has a breaking-change marker detected in its changelog.
 * Consumed by the subject tag (`[breaking] `) and the dedicated "Breaking changes:" footer so
 * reviewers spot them at a glance in `git log` + `gh pr view`.
 */
function hasBreakingChange(changes: UpgradeChange[]): boolean {
  return changes.some((c) => c.changelog?.breaking?.hasBreaking === true);
}

/** Render the `[breaking] ` tag prefix; emitted BEFORE the security tag so order is stable. */
function breakingSubjectTag(changes: UpgradeChange[]): string {
  return hasBreakingChange(changes) ? '[breaking] ' : '';
}

/**
 * Render a per-change breaking-changes footer. One section per upgrade so reviewers can see
 * which package the breaking lines came from. Capped to 5 lines per package — the scanner
 * already dedupes, this is just a belt-and-braces against especially noisy changelogs.
 */
function breakingFooter(changes: UpgradeChange[]): string {
  const rows: string[] = [];
  for (const c of changes) {
    const b = c.changelog?.breaking;
    if (!b?.hasBreaking || b.matchedLines.length === 0) continue;
    rows.push(`- ${c.name}:`);
    for (const line of b.matchedLines.slice(0, 5)) {
      rows.push(`    · ${line}`);
    }
  }
  return rows.length > 0 ? `\n\nBreaking changes detected:\n${rows.join('\n')}` : '';
}

/**
 * `[peer-resolved] ` subject tag when ANY change in the batch was downgraded by the peer-range
 * intersection resolver. Emitted AFTER `[breaking]` and BEFORE `[security:…]` so the tags always
 * read `[breaking] [peer-resolved] [security:critical] …` in a stable order.
 */
function peerResolvedSubjectTag(changes: UpgradeChange[]): string {
  return changes.some((c) => c.resolvedPeer) ? '[peer-resolved] ' : '';
}

/**
 * Body footer that lists every package whose installed version was downgraded from the
 * originally requested target by the peer resolver. The explanation is intentionally terse
 * — enough to give the reviewer the "this was intentional" signal without dumping the
 * tuple-search diagnostics.
 */
function peerResolvedFooter(changes: UpgradeChange[]): string {
  const rows = changes
    .filter((c) => c.resolvedPeer)
    .map((c) => {
      const rp = c.resolvedPeer!;
      return `- ${c.name}: requested ${tidyVersion(rp.originalTarget)}, installed ${tidyVersion(c.to)}`;
    });
  if (rows.length === 0) return '';
  return `\n\nPeer-range resolutions (kept linked group satisfiable):\n${rows.join('\n')}`;
}

/** Render a per-change security footer (inside the commit body). */
function securityFooter(changes: UpgradeChange[]): string {
  const rows = changes
    .filter((c) => c.security)
    .map((c) => {
      const s = c.security!;
      const id = s.ids[0] ? ` ${s.ids[0]}` : '';
      const title = s.title ? ` — ${s.title}` : '';
      const url = s.url ? ` (${s.url})` : '';
      return `- ${c.name}: ${s.severity}${id}${title}${url}`;
    });
  return rows.length > 0 ? `\n\nSecurity fixes:\n${rows.join('\n')}` : '';
}

export function formatPerSuccessMessage(prefix: string, changes: UpgradeChange[]): string {
  const brkTag = breakingSubjectTag(changes);
  const peerTag = peerResolvedSubjectTag(changes);
  const secTag = securitySubjectTag(changes);
  if (changes.length === 1) {
    const c = changes[0];
    const ws = c.workspace && c.workspace !== 'root' ? ` (${c.workspace})` : '';
    const subject = `${prefix}${brkTag}${peerTag}${secTag}bump ${c.name} from ${tidyVersion(c.from)} to ${tidyVersion(c.to)}${ws}`;
    return (
      subject +
      breakingFooter(changes) +
      peerResolvedFooter(changes) +
      securityFooter(changes) +
      changelogSection(changes)
    );
  }
  const head = changes[0];
  const ws = head.workspace && head.workspace !== 'root' ? ` (${head.workspace})` : '';
  const lines = [
    `${prefix}${brkTag}${peerTag}${secTag}bump ${changes.length} linked packages${ws}`,
    '',
    ...changes.map((c) => `- ${c.name}: ${tidyVersion(c.from)} → ${tidyVersion(c.to)}`),
  ];
  return (
    lines.join('\n') +
    breakingFooter(changes) +
    peerResolvedFooter(changes) +
    securityFooter(changes) +
    changelogSection(changes)
  );
}

/**
 * Compact one-line changelog reference for per-target / all-in-one commit modes where embedding
 * full release notes per package would balloon the message. We surface the best-known URL when
 * we have one, otherwise a short `(CHANGELOG.md)` marker.
 */
function compactChangelogMark(change: UpgradeChange): string {
  if (!change.changelog?.body) {
    return '';
  }
  if (change.changelog.source === 'github-release' && change.changelog.url) {
    return `  (release notes: ${change.changelog.url})`;
  }
  if (change.changelog.source === 'github-release') {
    return '  (see GitHub release)';
  }
  return '  (see CHANGELOG.md)';
}

export function formatPerTargetMessage(
  prefix: string,
  workspace: string,
  changes: UpgradeChange[],
): string {
  if (changes.length === 0) {
    return `${prefix}no changes for ${workspace}`;
  }
  const brkTag = breakingSubjectTag(changes);
  const peerTag = peerResolvedSubjectTag(changes);
  const secTag = securitySubjectTag(changes);
  const wsLabel = workspace === 'root' ? '' : ` in ${workspace}`;
  const lines = [
    `${prefix}${brkTag}${peerTag}${secTag}${changes.length} upgrade${changes.length === 1 ? '' : 's'}${wsLabel}`,
    '',
    ...changes.map(
      (c) => `- ${c.name}: ${tidyVersion(c.from)} → ${tidyVersion(c.to)}${compactChangelogMark(c)}`,
    ),
  ];
  return (
    lines.join('\n') + breakingFooter(changes) + peerResolvedFooter(changes) + securityFooter(changes)
  );
}

export function formatAllInOneMessage(prefix: string, changes: UpgradeChange[]): string {
  if (changes.length === 0) {
    return `${prefix}no upgrades`;
  }
  const brkTag = breakingSubjectTag(changes);
  const peerTag = peerResolvedSubjectTag(changes);
  const secTag = securitySubjectTag(changes);
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
      ? `${prefix}${brkTag}${peerTag}${secTag}${changes.length} upgrade${changes.length === 1 ? '' : 's'}`
      : `${prefix}${brkTag}${peerTag}${secTag}${changes.length} upgrades across ${targetCount} targets`;
  const lines: string[] = [head, ''];
  for (const [ws, list] of targets) {
    if (targetCount > 1) {
      lines.push(`[${ws}]`);
    }
    for (const c of list) {
      lines.push(`- ${c.name}: ${tidyVersion(c.from)} → ${tidyVersion(c.to)}${compactChangelogMark(c)}`);
    }
    if (targetCount > 1) {
      lines.push('');
    }
  }
  // Trim trailing blank line.
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  return (
    lines.join('\n') + breakingFooter(changes) + peerResolvedFooter(changes) + securityFooter(changes)
  );
}
