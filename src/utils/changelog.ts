/**
 * Fetch a short human-readable changelog excerpt for a package version bump. Used to enrich
 * commit messages (via `--git-commit`) and summary reports so reviewers can see *why* a version
 * changed without opening a browser tab per package.
 *
 * Sources, in order of preference:
 *
 *   1. **GitHub Releases API** (`GET /repos/{owner}/{repo}/releases/tags/{tag}`). Best data —
 *      maintainers curate release notes here and they are short by construction. Tags tried in
 *      order: `v<version>`, `<version>`, `<pkg-name>@<version>` (monorepo releases), `release-<version>`.
 *      Requires a `GITHUB_TOKEN` env var for anything above 60 req/h (the unauth IP rate limit).
 *   2. **CHANGELOG.md from the published tarball** via `pacote.extract` → parse the section whose
 *      heading matches the new version. Works for every package that ships its CHANGELOG (very
 *      common in the JS ecosystem); no network beyond the registry we already talk to.
 *
 * Everything here is best-effort — a missing / unparseable changelog must NEVER abort the
 * upgrade or the commit. Every call returns `undefined` on any kind of failure and logs nothing
 * louder than `log.dim` at the call site.
 */
import os from 'node:os';
import path from 'node:path';
import fs from 'fs-extra';
import pacote from 'pacote';
import semver from 'semver';

/**
 * Maximum number of lines we keep from any changelog excerpt. Commit bodies get unwieldy past
 * ~40 lines and release notes with code samples routinely blow past 200 lines. 30 lines is a
 * sensible balance: enough to read the breaking-changes section, short enough to fit in a
 * `git log --oneline -p` skim.
 */
const MAX_LINES = 30;

/**
 * Hard cap on the body size we fetch from GitHub. A release with massive embedded images or
 * broken HTML can be multi-MB; we truncate before parsing to protect memory.
 */
const MAX_BODY_BYTES = 256 * 1024;

export interface ChangelogExcerpt {
  /** Source of the excerpt — useful for attribution in commit messages / UIs. */
  source: 'github-release' | 'changelog.md';
  /** Resolved URL (GitHub release page) for users who want to read the full notes. */
  url?: string;
  /** Plain text body, already trimmed to MAX_LINES. */
  body: string;
  /** True when the body was truncated to fit MAX_LINES. */
  truncated: boolean;
}

export interface ChangelogCache {
  /** Keyed by `<pkg>@<toVersion>`. `null` means we tried and found nothing (negative cache). */
  entries: Map<string, ChangelogExcerpt | null>;
}

export function createChangelogCache(): ChangelogCache {
  return { entries: new Map() };
}

export interface FetchChangelogOptions {
  /** Package name, e.g. `"axios"` or `"@scope/pkg"`. */
  packageName: string;
  /** The new version that was installed (exact semver, no caret/tilde). */
  toVersion: string;
  /** Optional previous version; only used to emit "from X" in a header line. */
  fromVersion?: string;
  /** Shared cache across a run so the same `<pkg>@<ver>` is fetched once. */
  cache?: ChangelogCache;
  /**
   * Override for tests. When provided, replaces the built-in GitHub / pacote fetchers entirely.
   */
  fetchers?: ChangelogFetchers;
  /** Optional GitHub token; otherwise read from `GITHUB_TOKEN` / `GH_TOKEN` env. */
  githubToken?: string;
}

/**
 * Dependency-injected fetch primitives. Exposed so unit tests can exercise the parsing logic
 * without hitting the network or the filesystem.
 */
export interface ChangelogFetchers {
  /** Return the `repository` + `homepage` fields from the published manifest. */
  getManifest?: (
    spec: string,
  ) => Promise<{ repository?: unknown; homepage?: unknown } | undefined>;
  /** Extract the package tarball into `dest` and return the path to CHANGELOG.md (if any). */
  extractChangelog?: (spec: string, dest: string) => Promise<string | undefined>;
  /** Call the GitHub REST API (or a mock) and return the release body + html_url. */
  getGithubRelease?: (
    owner: string,
    repo: string,
    tag: string,
    token?: string,
  ) => Promise<{ body: string; html_url: string } | undefined>;
}

/**
 * Public entry point. Returns the best excerpt we could assemble for the `packageName@toVersion`
 * transition, or `undefined` when nothing was found (missing CHANGELOG, no repo URL, rate-limited,
 * etc.). Never throws.
 */
export async function fetchChangelog(
  options: FetchChangelogOptions,
): Promise<ChangelogExcerpt | undefined> {
  const { packageName, toVersion, cache } = options;
  const key = `${packageName}@${toVersion}`;
  if (cache?.entries.has(key)) {
    return cache.entries.get(key) ?? undefined;
  }

  const fetchers: Required<ChangelogFetchers> = {
    getManifest: options.fetchers?.getManifest ?? defaultGetManifest,
    extractChangelog: options.fetchers?.extractChangelog ?? defaultExtractChangelog,
    getGithubRelease: options.fetchers?.getGithubRelease ?? defaultGetGithubRelease,
  };
  const token = options.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;

  let excerpt: ChangelogExcerpt | undefined;
  try {
    // 1. Try GitHub Releases when we can resolve the repo from the manifest.
    const manifest = await fetchers.getManifest(`${packageName}@${toVersion}`).catch(() => undefined);
    const repo = parseRepoUrl(manifest?.repository) ?? parseRepoUrl(manifest?.homepage);
    if (repo) {
      excerpt = await tryGithubRelease(
        repo.owner,
        repo.repo,
        packageName,
        toVersion,
        token,
        fetchers.getGithubRelease,
      );
    }

    // 2. Fallback: CHANGELOG.md from the published tarball.
    if (!excerpt) {
      excerpt = await tryPackageChangelog(
        packageName,
        toVersion,
        options.fromVersion,
        fetchers.extractChangelog,
      );
    }
  } catch {
    // Never let changelog enrichment abort the upgrade flow.
    excerpt = undefined;
  }

  cache?.entries.set(key, excerpt ?? null);
  return excerpt;
}

// ---------------------------------------------------------------------------
// GitHub Releases
// ---------------------------------------------------------------------------

async function tryGithubRelease(
  owner: string,
  repo: string,
  packageName: string,
  version: string,
  token: string | undefined,
  getRelease: NonNullable<Required<ChangelogFetchers>['getGithubRelease']>,
): Promise<ChangelogExcerpt | undefined> {
  // Tag patterns maintainers use, ordered most-likely-first. The monorepo form (`<pkg>@<v>`)
  // is what Changesets / Lerna publish, so we check it first for scoped packages. The `v`
  // prefix is the classic GitHub convention.
  const candidates: string[] = [];
  if (packageName.includes('/') || packageName.startsWith('@')) {
    candidates.push(`${packageName}@${version}`);
  }
  candidates.push(`v${version}`, version, `release-${version}`, `releases/v${version}`);
  // Un-scoped short form for monorepos that drop the scope in tags (e.g. `core@1.0.0`).
  const shortName = packageName.includes('/') ? packageName.split('/').pop()! : packageName;
  if (shortName !== packageName) {
    candidates.push(`${shortName}@${version}`, `${shortName}-${version}`);
  }

  for (const tag of candidates) {
    const r = await getRelease(owner, repo, tag, token).catch(() => undefined);
    if (!r || !r.body) {
      continue;
    }
    const body = truncateText(sanitizeMarkdown(r.body));
    return {
      source: 'github-release',
      url: r.html_url,
      body: body.text,
      truncated: body.truncated,
    };
  }
  return undefined;
}

async function defaultGetGithubRelease(
  owner: string,
  repo: string,
  tag: string,
  token: string | undefined,
): Promise<{ body: string; html_url: string } | undefined> {
  const url = `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dep-up-surgeon',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    if (!res.ok) {
      return undefined;
    }
    const json = (await res.json()) as { body?: string; html_url?: string };
    if (!json || typeof json.body !== 'string') {
      return undefined;
    }
    const body = json.body.slice(0, MAX_BODY_BYTES);
    return { body, html_url: json.html_url ?? '' };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract `{ owner, repo }` from a `package.json` `repository` / `homepage` field. Handles:
 *
 *   - `git+https://github.com/owner/repo.git`
 *   - `https://github.com/owner/repo`
 *   - `git://github.com/owner/repo.git`
 *   - `github:owner/repo`
 *   - `owner/repo` shorthand
 *   - `{ url: '...' }` object form
 *
 * Returns `undefined` for any repo not on github.com (GitLab / Bitbucket support is a follow-up).
 */
export function parseRepoUrl(
  field: unknown,
): { owner: string; repo: string } | undefined {
  let raw: string | undefined;
  if (typeof field === 'string') {
    raw = field;
  } else if (field && typeof field === 'object') {
    const obj = field as { url?: unknown };
    if (typeof obj.url === 'string') {
      raw = obj.url;
    }
  }
  if (!raw) {
    return undefined;
  }
  raw = raw.trim();
  if (!raw) {
    return undefined;
  }

  // `github:owner/repo` shorthand.
  const ghShort = raw.match(/^github:([^/]+)\/([^/#]+)/i);
  if (ghShort) {
    return { owner: ghShort[1]!, repo: stripGitSuffix(ghShort[2]!) };
  }

  // `git+`, `git://`, `ssh://git@`, plain `https://github.com/...` forms.
  const normalized = raw
    .replace(/^git\+/, '')
    .replace(/^git@github\.com:/, 'https://github.com/')
    .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
    .replace(/^git:\/\//, 'https://');
  const m = normalized.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+)/i);
  if (m) {
    return { owner: m[1]!, repo: stripGitSuffix(m[2]!) };
  }

  // `owner/repo` bare shorthand. Only accept when it looks like exactly one slash and no whitespace.
  const bare = raw.match(/^([\w.-]+)\/([\w.-]+)$/);
  if (bare) {
    return { owner: bare[1]!, repo: stripGitSuffix(bare[2]!) };
  }

  return undefined;
}

function stripGitSuffix(s: string): string {
  return s.replace(/\.git$/i, '');
}

// ---------------------------------------------------------------------------
// Tarball CHANGELOG.md parser
// ---------------------------------------------------------------------------

async function tryPackageChangelog(
  packageName: string,
  toVersion: string,
  _fromVersion: string | undefined,
  extract: NonNullable<Required<ChangelogFetchers>['extractChangelog']>,
): Promise<ChangelogExcerpt | undefined> {
  const dest = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-cl-'));
  try {
    const changelogPath = await extract(`${packageName}@${toVersion}`, dest).catch(() => undefined);
    if (!changelogPath) {
      return undefined;
    }
    const raw = await fs.readFile(changelogPath, 'utf8').catch(() => undefined);
    if (!raw) {
      return undefined;
    }
    const section = extractVersionSection(raw, toVersion);
    if (!section) {
      return undefined;
    }
    const body = truncateText(sanitizeMarkdown(section));
    return {
      source: 'changelog.md',
      body: body.text,
      truncated: body.truncated,
    };
  } finally {
    await fs.remove(dest).catch(() => undefined);
  }
}

async function defaultGetManifest(
  spec: string,
): Promise<{ repository?: unknown; homepage?: unknown } | undefined> {
  try {
    const m = (await pacote.manifest(spec, { fullMetadata: true })) as {
      repository?: unknown;
      homepage?: unknown;
    };
    return m;
  } catch {
    return undefined;
  }
}

async function defaultExtractChangelog(spec: string, dest: string): Promise<string | undefined> {
  try {
    await pacote.extract(spec, dest);
  } catch {
    return undefined;
  }
  // Common casings + locations. We only look at the package root and don't recurse — a nested
  // CHANGELOG is rare and almost never the one users mean.
  const candidates = [
    'CHANGELOG.md',
    'CHANGELOG',
    'CHANGELOG.mdx',
    'HISTORY.md',
    'RELEASE_NOTES.md',
    'changelog.md',
  ];
  for (const name of candidates) {
    const p = path.join(dest, name);
    if (await fs.pathExists(p)) {
      return p;
    }
  }
  return undefined;
}

/**
 * Extract the section of a CHANGELOG.md that documents `version`. Understands:
 *
 *   - `## 1.2.3`, `## [1.2.3]`, `## v1.2.3`
 *   - `### 1.2.3 - 2024-09-12`
 *   - `## [1.2.3] - 2024-09-12`
 *
 * Returns everything from the matching heading up to the next `##`/`###` of equal-or-higher
 * level, trimmed. The heading itself is included so the excerpt self-documents.
 */
export function extractVersionSection(markdown: string, version: string): string | undefined {
  const lines = markdown.split(/\r?\n/);
  // Accept both exact and semver-clean forms (e.g. `1.2.3` matches `1.2.3`, `v1.2.3`, `[1.2.3]`).
  const clean = semver.clean(version) ?? version;
  const versionRe = new RegExp(
    // `^#{1,6}` heading, optional spaces, optional `[`, optional `v`, then the version. Uses
    // word-boundary-ish separator (space, `]`, `)`, dash, end of line) to avoid matching
    // `1.2.30` when looking for `1.2.3`.
    `^#{1,6}\\s+\\[?v?${escapeRegex(clean)}(?:[\\]\\s\\-\\)\\.]|$)`,
    'i',
  );
  let startIdx = -1;
  let startDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (versionRe.test(l)) {
      startIdx = i;
      startDepth = (l.match(/^#+/) ?? ['##'])[0].length;
      break;
    }
  }
  if (startIdx === -1) {
    return undefined;
  }

  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const l = lines[i]!;
    const m = l.match(/^(#+)\s+/);
    if (m && m[1]!.length <= startDepth) {
      endIdx = i;
      break;
    }
  }
  const section = lines.slice(startIdx, endIdx).join('\n').trim();
  return section.length > 0 ? section : undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Shared text helpers
// ---------------------------------------------------------------------------

/**
 * Strip markdown link markup + HTML comments + code fences that produce noisy output in
 * plain-text commit bodies. We intentionally keep list markers (`-`, `*`) and bold markers —
 * they still render usefully in `git log` pagers and `gh pr view`.
 */
export function sanitizeMarkdown(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, '') // HTML comments
    .replace(/^```[\s\S]*?```$/gm, '') // multi-line code fences
    .replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)') // [text](url) → text (url); images lose the `!`
    .replace(/[ \t]+$/gm, '') // trailing whitespace
    .replace(/\n{3,}/g, '\n\n') // collapse 3+ blank lines
    .trim();
}

export function truncateText(text: string): { text: string; truncated: boolean } {
  const lines = text.split(/\r?\n/);
  if (lines.length <= MAX_LINES) {
    return { text, truncated: false };
  }
  const head = lines.slice(0, MAX_LINES).join('\n');
  return { text: `${head}\n\n(… truncated; see full notes for details)`, truncated: true };
}

/**
 * Format an excerpt as a commit-body-friendly block. Used by the git commit formatters.
 */
export function formatExcerptForCommit(
  packageName: string,
  fromVersion: string | undefined,
  toVersion: string,
  excerpt: ChangelogExcerpt,
): string {
  const header = fromVersion
    ? `${packageName} ${fromVersion} → ${toVersion}`
    : `${packageName} @ ${toVersion}`;
  const attribution =
    excerpt.source === 'github-release'
      ? excerpt.url
        ? `source: GitHub Release (${excerpt.url})`
        : 'source: GitHub Release'
      : 'source: CHANGELOG.md';
  return [`--- ${header} ---`, attribution, '', excerpt.body].join('\n');
}
