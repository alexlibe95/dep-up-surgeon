/**
 * Post-run hook that pushes the branch created by `--git-branch` and opens a pull request on
 * the remote. Runs ONLY when `--open-pr` is set AND `--git-commit --git-branch` actually
 * produced at least one commit on that branch.
 *
 * Provider selection:
 *   - **GitHub (default + only provider for v1)**: shells out to `gh` (GitHub CLI). Chosen over
 *     direct API calls because `gh auth` already handles user auth, org SSO, 2FA, and enterprise
 *     Azure AD SAML flows that would be a nightmare to re-implement. The tool simply becomes
 *     "pipeline the user's already-authenticated CLI" — zero new credentials for us to handle.
 *   - **GitLab (future)**: `glab` CLI would plug in here with the same interface; left as a
 *     TODO because the feature surface is already large.
 *
 * Safety:
 *   - NEVER fatal. A missing `gh` binary, an unauthenticated user, a network blip, or even a
 *     400 from the API MUST degrade to `{ ok: false, error: "..." }`. The upgrade run has
 *     already cost real time (install + validator + git commits) — we'd never want to drop
 *     that work just because the PR-open step failed.
 *   - Never force-pushes. `git push -u origin <branch>` + if it rejects (non-fast-forward,
 *     push hook refused, etc.) we bail with an error. Users who want to overwrite a stale
 *     branch can rerun with `--git-branch` pointed elsewhere.
 *   - Reuses an existing PR for the same branch instead of creating a duplicate (what `gh pr
 *     create` does natively; we just surface it cleanly as `reused: true`).
 */
import path from 'node:path';
import fs from 'fs-extra';
import { execa } from 'execa';
import type { FinalReport } from '../types.js';

export interface OpenPrConfig {
  /** Workspace root (= git repo root in 99% of cases). All git commands run here. */
  cwd: string;
  /** Branch name that was passed to `--git-branch`. Required — we don't open a PR from `main`. */
  branch: string;
  /**
   * Override for the PR title. When omitted, we render a deterministic title derived from the
   * upgrade counts (e.g. `"chore(deps): bump 5 packages"`). Users who always want the same
   * title (e.g. to match a bot naming convention) can pin it via `--open-pr-title`.
   */
  title?: string;
  /**
   * Body written to the PR description. Usually the Markdown summary produced by
   * `src/cli/summary.ts` (`renderSummaryMarkdown`). Absent body = "no summary available".
   */
  body?: string;
  /** When true, pass `--draft` to `gh pr create`. */
  draft?: boolean;
  /** Optional base branch; falls back to the remote's default branch via `gh repo view`. */
  base?: string;
  /**
   * Optional assignees / reviewers passed straight to `gh`. Accepts comma-separated usernames
   * as written by the user. We deliberately don't validate existence — `gh` already gives a
   * clear error for unknown users.
   */
  reviewers?: string;
  assignees?: string;
  /**
   * Explicit remote name. Defaults to `origin`. Tests can use this to inject a mock remote.
   */
  remote?: string;
  /**
   * Test seam. When provided, replaces the real `execa`; the function signature matches the
   * subset we actually use. Production passes `undefined` and the real execa is imported.
   */
  exec?: ExecFn;
  /** Test seam. When provided, replaces the real `which` lookup. */
  commandExists?: (bin: string) => Promise<boolean>;
}

export type ExecFn = (
  bin: string,
  args: string[],
  options?: { cwd?: string; reject?: false; input?: string },
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>;

export interface OpenPrResult {
  ok: boolean;
  provider: 'github' | 'gitlab';
  repo?: string;
  number?: number;
  url?: string;
  branch?: string;
  base?: string;
  draft?: boolean;
  reused?: boolean;
  error?: string;
}

/**
 * Default title when `--open-pr-title` isn't set. Readable, sortable in a queue, links to the
 * tool so reviewers understand where the PR came from. We keep it short — users can always
 * edit the PR after the fact.
 */
export function defaultPrTitle(report: FinalReport): string {
  const upgraded = report.upgraded.filter((r) => r.success && !r.skipped);
  const total = upgraded.length;
  if (total === 0) {
    return 'deps: automated run (no upgrades)';
  }
  const hasBreaking = upgraded.some((r) => r.changelog?.breaking?.hasBreaking === true);
  const hasSecurity = upgraded.some((r) => r.security);
  const tagBits: string[] = [];
  if (hasBreaking) tagBits.push('breaking');
  if (hasSecurity) tagBits.push('security');
  const tag = tagBits.length > 0 ? `[${tagBits.join('+')}] ` : '';
  if (total === 1) {
    const r = upgraded[0]!;
    return `deps: ${tag}bump ${r.name} from ${r.from ?? '?'} to ${r.to ?? '?'}`;
  }
  return `deps: ${tag}bump ${total} package${total === 1 ? '' : 's'}`;
}

/**
 * Default body when `--open-pr` is set but no summary is available (e.g. `--no-summary`
 * wasn't passed but rendering failed). Minimal — just enough to link back to the structured
 * report so the reviewer can inspect `.dep-up-surgeon.last-run.json`.
 */
export function defaultPrBody(report: FinalReport): string {
  const upgraded = report.upgraded.filter((r) => r.success && !r.skipped);
  const lines: string[] = [];
  lines.push('## Automated dependency upgrade');
  lines.push('');
  lines.push(
    `_Generated by [dep-up-surgeon](https://www.npmjs.com/package/dep-up-surgeon). ${upgraded.length} upgraded, ${report.failed.length} failed, ${report.upgraded.filter((r) => r.skipped).length} skipped._`,
  );
  lines.push('');
  if (upgraded.length > 0) {
    lines.push('### Upgraded');
    lines.push('');
    lines.push('| Package | From | To |');
    lines.push('| --- | --- | --- |');
    for (const r of upgraded) {
      lines.push(`| \`${r.name}\` | \`${r.from ?? '?'}\` | \`${r.to ?? '?'}\` |`);
    }
  }
  return lines.join('\n');
}

/**
 * Best-effort `which`. Intentionally lightweight — we only need it to decide between
 * "CLI present → try it" and "CLI missing → bail out with a friendly hint".
 */
export async function defaultCommandExists(bin: string): Promise<boolean> {
  try {
    const r = await execa(process.platform === 'win32' ? 'where' : 'which', [bin], {
      reject: false,
    });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

async function defaultExec(
  bin: string,
  args: string[],
  options?: { cwd?: string; reject?: false; input?: string },
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  const r = await execa(bin, args, { ...(options ?? {}), reject: false });
  return { exitCode: r.exitCode ?? null, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/**
 * Public entry point. Pushes the branch and opens a PR. Always returns a result object; never
 * throws. Wire at the very end of the CLI run, after git commits are flushed + the summary
 * has been written (so we can use it as the PR body).
 */
export async function openPullRequest(
  config: OpenPrConfig,
  report: FinalReport,
): Promise<OpenPrResult> {
  const exec: ExecFn = config.exec ?? defaultExec;
  const hasCommand = config.commandExists ?? defaultCommandExists;
  const remote = (config.remote ?? 'origin').trim() || 'origin';
  const branch = config.branch.trim();

  if (!branch) {
    return { ok: false, provider: 'github', error: '--open-pr requires --git-branch to be set.' };
  }

  // Gate on gh presence FIRST so we give a precise error before touching the network.
  if (!(await hasCommand('gh'))) {
    return {
      ok: false,
      provider: 'github',
      branch,
      error:
        'gh (GitHub CLI) not found on PATH. Install from https://cli.github.com/ and run `gh auth login`, or drop --open-pr.',
    };
  }

  // Confirm auth before we push; `gh auth status` exits non-zero when not logged in.
  const authCheck = await exec('gh', ['auth', 'status', '-h', 'github.com'], {
    cwd: config.cwd,
    reject: false,
  });
  if (authCheck.exitCode !== 0) {
    return {
      ok: false,
      provider: 'github',
      branch,
      error: `gh is installed but not authenticated. Run \`gh auth login\` and retry. (${oneLine(authCheck.stderr || authCheck.stdout)})`,
    };
  }

  // Resolve the repo slug + default base branch once. Both are surfaced in the result so the
  // JSON consumer has the full context without re-running gh.
  let repoSlug: string | undefined;
  let baseBranch = config.base;
  const repoView = await exec(
    'gh',
    [
      'repo',
      'view',
      '--json',
      'nameWithOwner,defaultBranchRef',
      '--jq',
      '{nameWithOwner: .nameWithOwner, defaultBranch: .defaultBranchRef.name}',
    ],
    { cwd: config.cwd, reject: false },
  );
  if (repoView.exitCode === 0 && repoView.stdout.trim()) {
    try {
      const parsed = JSON.parse(repoView.stdout.trim()) as {
        nameWithOwner?: unknown;
        defaultBranch?: unknown;
      };
      if (typeof parsed.nameWithOwner === 'string') {
        repoSlug = parsed.nameWithOwner;
      }
      if (!baseBranch && typeof parsed.defaultBranch === 'string') {
        baseBranch = parsed.defaultBranch;
      }
    } catch {
      // leave repoSlug / baseBranch undefined — gh pr create still works without them
    }
  }

  // Push the branch. Use `--set-upstream` so subsequent `git push` from the repo just works.
  // We do NOT force-push; a rejected push means the branch already exists remotely and has
  // commits we don't have — users should reset explicitly.
  const push = await exec('git', ['push', '--set-upstream', remote, branch], {
    cwd: config.cwd,
    reject: false,
  });
  if (push.exitCode !== 0) {
    return {
      ok: false,
      provider: 'github',
      branch,
      repo: repoSlug,
      base: baseBranch,
      error: `git push failed: ${oneLine(push.stderr || push.stdout)}`,
    };
  }

  // Check for an existing PR for this branch — `gh pr create` also does, but we want to
  // distinguish reuse in the structured report.
  const existing = await exec(
    'gh',
    ['pr', 'view', branch, '--json', 'url,number,isDraft', '--jq', '.'],
    { cwd: config.cwd, reject: false },
  );
  if (existing.exitCode === 0 && existing.stdout.trim()) {
    try {
      const parsed = JSON.parse(existing.stdout.trim()) as {
        url?: unknown;
        number?: unknown;
        isDraft?: unknown;
      };
      return {
        ok: true,
        provider: 'github',
        branch,
        repo: repoSlug,
        base: baseBranch,
        url: typeof parsed.url === 'string' ? parsed.url : undefined,
        number: typeof parsed.number === 'number' ? parsed.number : undefined,
        draft: typeof parsed.isDraft === 'boolean' ? parsed.isDraft : config.draft,
        reused: true,
      };
    } catch {
      // fall through to create
    }
  }

  // Create the PR. `--body-file -` lets us stream the summary via stdin, avoiding argv/quoting
  // hell (summaries can be several KB of markdown with backticks, emoji, and newlines).
  const title = config.title ?? defaultPrTitle(report);
  const body = config.body ?? defaultPrBody(report);
  const args = ['pr', 'create', '--title', title, '--head', branch, '--body-file', '-'];
  if (baseBranch) {
    args.push('--base', baseBranch);
  }
  if (config.draft) {
    args.push('--draft');
  }
  if (config.reviewers && config.reviewers.trim().length > 0) {
    args.push('--reviewer', config.reviewers.trim());
  }
  if (config.assignees && config.assignees.trim().length > 0) {
    args.push('--assignee', config.assignees.trim());
  }

  const created = await exec('gh', args, { cwd: config.cwd, reject: false, input: body });
  if (created.exitCode !== 0) {
    return {
      ok: false,
      provider: 'github',
      branch,
      repo: repoSlug,
      base: baseBranch,
      draft: config.draft,
      error: `gh pr create failed: ${oneLine(created.stderr || created.stdout)}`,
    };
  }

  // `gh pr create` prints the PR URL on the last non-empty stdout line.
  const url = lastNonEmptyLine(created.stdout);
  const number = extractPrNumber(url);
  return {
    ok: true,
    provider: 'github',
    branch,
    repo: repoSlug,
    base: baseBranch,
    url,
    number,
    draft: config.draft,
    reused: false,
  };
}

/**
 * Collapse CLI output to a single line suitable for an error message. `gh` and `git` are both
 * happy to produce multi-paragraph errors with embedded blank lines; the structured report is
 * way more readable with them flattened.
 */
function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, 400);
}

function lastNonEmptyLine(s: string): string | undefined {
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1];
}

function extractPrNumber(url: string | undefined): number | undefined {
  if (!url) return undefined;
  const m = url.match(/\/pull\/(\d+)(?:$|[#?])/);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read the summary markdown file from disk so we can reuse it as the PR body. Returns
 * `undefined` on any read error — callers should fall back to `defaultPrBody(report)`.
 */
export async function readSummaryAsBody(cwd: string, summaryFile: string | undefined): Promise<string | undefined> {
  if (!summaryFile) return undefined;
  const abs = path.isAbsolute(summaryFile) ? summaryFile : path.join(cwd, summaryFile);
  try {
    const body = await fs.readFile(abs, 'utf8');
    return body.trim().length > 0 ? body : undefined;
  } catch {
    return undefined;
  }
}
