/**
 * Fetch a short human-readable changelog excerpt for a package version bump. Used to enrich
 * commit messages (via `--git-commit`) and summary reports so reviewers can see *why* a version
 * changed without opening a browser tab per package.
 *
 * Sources, in order of preference:
 *
 *   1. **GitHub Releases API** (`GET /repos/{owner}/{repo}/releases?per_page=100`, one request
 *      per package). Best data — maintainers curate release notes here and they are short by
 *      construction. The tag is matched locally: `<pkg-name>@<version>` (monorepo releases),
 *      `v<version>`, `<version>`, `release-<version>`, ….
 *      Requires a `GITHUB_TOKEN` env var for anything above 60 req/h (the unauth IP rate limit);
 *      once GitHub refuses (403/429) we stop calling it for the rest of the run.
 *   2. **CHANGELOG.md from the published tarball** via `pacote.extract` → parse the section whose
 *      heading matches the new version. Works for every package that ships its CHANGELOG (very
 *      common in the JS ecosystem); no network beyond the registry we already talk to. Skipped
 *      when the manifest's `dist.unpackedSize` is over 20 MB.
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
import { registryOptions } from './npmConfig.js';

/**
 * Maximum number of lines we keep from any changelog excerpt. Commit bodies get unwieldy past
 * ~40 lines and release notes with code samples routinely blow past 200 lines. 30 lines is a
 * sensible balance: enough to read the breaking-changes section, short enough to fit in a
 * `git log --oneline -p` skim.
 */
const MAX_LINES = 30;

/**
 * Hard cap on a single release body we keep. A release with massive embedded images or
 * broken HTML can be multi-MB; we truncate before parsing to protect memory.
 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Hard cap on any GitHub API response we read. A page of 100 releases is legitimately a few MB;
 * past this we abort the download instead of buffering it.
 */
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

const RELEASES_PER_PAGE = 100;

/** Tarballs bigger than this (next, typescript, …) aren't worth downloading for a changelog. */
const MAX_TARBALL_UNPACKED_BYTES = 20 * 1024 * 1024;

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
  /**
   * Set once GitHub answers 403/429 or reports `x-ratelimit-remaining: 0`: later lookups sharing
   * this cache skip GitHub instead of queueing more refused calls.
   */
  githubRateLimited?: boolean;
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
  /** Return the `repository` + `homepage` (+ `dist`) fields from the published manifest. */
  getManifest?: (
    spec: string,
  ) => Promise<{ repository?: unknown; homepage?: unknown; dist?: { unpackedSize?: unknown } } | undefined>;
  /** Extract the package tarball into `dest` and return the path to CHANGELOG.md (if any). */
  extractChangelog?: (spec: string, dest: string) => Promise<string | undefined>;
  /**
   * Fetch the most recent page of releases (or a mock). Used by default; callers that inject
   * only `getGithubRelease` keep per-tag lookups instead.
   */
  listGithubReleases?: (
    owner: string,
    repo: string,
    token?: string,
  ) => Promise<GithubReleasesPage | undefined>;
  /** Call the GitHub REST API (or a mock) and return the release body + html_url. */
  getGithubRelease?: (
    owner: string,
    repo: string,
    tag: string,
    token?: string,
  ) => Promise<{ body: string; html_url: string; rateLimited?: boolean } | undefined>;
}

export interface GithubReleasesPage {
  releases: Array<{ tag_name: string; body?: string | null; html_url?: string }>;
  /** GitHub refused the call, or it was the last one allowed in the current quota window. */
  rateLimited?: boolean;
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

  const injected = options.fetchers;
  const fetchers: ResolvedFetchers = {
    getManifest: injected?.getManifest ?? defaultGetManifest,
    extractChangelog: injected?.extractChangelog ?? defaultExtractChangelog,
    getGithubRelease: injected?.getGithubRelease ?? defaultGetGithubRelease,
    listGithubReleases:
      injected?.listGithubReleases ?? (injected?.getGithubRelease ? undefined : defaultListGithubReleases),
  };
  const token = options.githubToken ?? process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  // Without a shared cache the rate-limit flag only lives for this call.
  const runState = cache ?? createChangelogCache();

  let excerpt: ChangelogExcerpt | undefined;
  try {
    // 1. Try GitHub Releases when we can resolve the repo from the manifest.
    const manifest = await fetchers.getManifest(`${packageName}@${toVersion}`).catch(() => undefined);
    const repo = parseRepoUrl(manifest?.repository) ?? parseRepoUrl(manifest?.homepage);
    if (repo && !runState.githubRateLimited) {
      excerpt = await tryGithubRelease(
        repo.owner,
        repo.repo,
        packageName,
        toVersion,
        token,
        fetchers,
        runState,
      );
    }

    // 2. Fallback: CHANGELOG.md from the published tarball (unless it's huge).
    const unpackedSize = manifest?.dist?.unpackedSize;
    const tarballTooLarge = typeof unpackedSize === 'number' && unpackedSize > MAX_TARBALL_UNPACKED_BYTES;
    if (!excerpt && !tarballTooLarge) {
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

type ResolvedFetchers = Required<Omit<ChangelogFetchers, 'listGithubReleases'>> &
  Pick<ChangelogFetchers, 'listGithubReleases'>;

async function tryGithubRelease(
  owner: string,
  repo: string,
  packageName: string,
  version: string,
  token: string | undefined,
  fetchers: ResolvedFetchers,
  runState: ChangelogCache,
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

  let probeTags = candidates;
  if (fetchers.listGithubReleases) {
    const page = await fetchers.listGithubReleases(owner, repo, token).catch(() => undefined);
    if (page?.rateLimited) {
      runState.githubRateLimited = true;
    }
    if (!page) {
      return undefined;
    }
    const byTag = new Map(page.releases.map((r) => [r.tag_name, r]));
    for (const tag of candidates) {
      const hit = byTag.get(tag);
      if (hit?.body) {
        return releaseExcerpt(hit.body, hit.html_url);
      }
    }
    // Only a full page can have pushed the release off; one lookup of the likeliest tag is
    // still far cheaper than probing every candidate.
    if (page.releases.length < RELEASES_PER_PAGE) {
      return undefined;
    }
    probeTags = candidates.slice(0, 1);
  }

  for (const tag of probeTags) {
    if (runState.githubRateLimited) {
      return undefined;
    }
    const r = await fetchers.getGithubRelease(owner, repo, tag, token).catch(() => undefined);
    if (r?.rateLimited) {
      runState.githubRateLimited = true;
    }
    if (!r || !r.body) {
      continue;
    }
    return releaseExcerpt(r.body, r.html_url);
  }
  return undefined;
}

function releaseExcerpt(rawBody: string, url: string | undefined): ChangelogExcerpt {
  const body = truncateText(sanitizeMarkdown(rawBody));
  return {
    source: 'github-release',
    url,
    body: body.text,
    truncated: body.truncated,
  };
}

async function defaultListGithubReleases(
  owner: string,
  repo: string,
  token: string | undefined,
): Promise<GithubReleasesPage | undefined> {
  const { json, rateLimited } = await githubGetJson(
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=${RELEASES_PER_PAGE}`,
    token,
  );
  if (!Array.isArray(json)) {
    return rateLimited ? { releases: [], rateLimited } : undefined;
  }
  const releases: GithubReleasesPage['releases'] = [];
  for (const r of json as Array<{ tag_name?: unknown; body?: unknown; html_url?: unknown } | null>) {
    if (typeof r?.tag_name !== 'string') {
      continue;
    }
    releases.push({
      tag_name: r.tag_name,
      body: typeof r.body === 'string' ? r.body.slice(0, MAX_BODY_BYTES) : null,
      html_url: typeof r.html_url === 'string' ? r.html_url : undefined,
    });
  }
  return { releases, rateLimited };
}

async function defaultGetGithubRelease(
  owner: string,
  repo: string,
  tag: string,
  token: string | undefined,
): Promise<{ body: string; html_url: string; rateLimited?: boolean } | undefined> {
  const { json, rateLimited } = await githubGetJson(
    `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`,
    token,
  );
  const release = json as { body?: unknown; html_url?: unknown } | undefined;
  if (!release || typeof release.body !== 'string') {
    return rateLimited ? { body: '', html_url: '', rateLimited } : undefined;
  }
  const html_url = typeof release.html_url === 'string' ? release.html_url : '';
  return { body: release.body.slice(0, MAX_BODY_BYTES), html_url, rateLimited };
}

/**
 * GET a GitHub REST URL. `json` is set only for a 2xx body that fits `MAX_RESPONSE_BYTES` and
 * parses; `rateLimited` flags 403/429 and the last call allowed in the quota window.
 */
async function githubGetJson(
  url: string,
  token: string | undefined,
): Promise<{ json?: unknown; rateLimited: boolean }> {
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
  let rateLimited = false;
  try {
    const res = await fetch(url, { headers, signal: controller.signal });
    rateLimited =
      res.status === 403 || res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0';
    if (!res.ok) {
      await res.body?.cancel();
      return { rateLimited };
    }
    const text = await readTextCapped(res, MAX_RESPONSE_BYTES);
    return { json: text === undefined ? undefined : JSON.parse(text), rateLimited };
  } catch {
    return { rateLimited };
  } finally {
    clearTimeout(timer);
  }
}

/** Read a response body as UTF-8, cancelling the download once it exceeds `maxBytes`. */
async function readTextCapped(res: Response, maxBytes: number): Promise<string | undefined> {
  if (!res.body) {
    return '';
  }
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
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
): Promise<{ repository?: unknown; homepage?: unknown; dist?: { unpackedSize?: unknown } } | undefined> {
  try {
    const m = (await pacote.manifest(spec, { ...registryOptions(), fullMetadata: true })) as {
      repository?: unknown;
      homepage?: unknown;
      dist?: { unpackedSize?: unknown };
    };
    return m;
  } catch {
    return undefined;
  }
}

async function defaultExtractChangelog(spec: string, dest: string): Promise<string | undefined> {
  try {
    await pacote.extract(spec, dest, registryOptions());
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

// ---------------------------------------------------------------------------
// Breaking-change detection
// ---------------------------------------------------------------------------

/**
 * Result of scanning a changelog body for breaking-change markers. Non-destructive — the
 * original excerpt is left untouched; this is pure signal for reviewers.
 */
export interface BreakingChangeScan {
  /** True when at least one breaking-change marker matched. */
  hasBreaking: boolean;
  /**
   * The actual lines that tripped the scan, capped at 10. Useful for surfacing in the PR body
   * so reviewers see *which* breaking changes matched, not just a boolean badge.
   */
  matchedLines: string[];
  /**
   * Short labels describing *why* each line matched ("BREAKING CHANGE", "drops Node 16",
   * "💥 emoji", etc.). Parallel array to `matchedLines`.
   */
  reasons: string[];
}

/**
 * Regex patterns matching how the ecosystem *actually* writes breaking changes in release
 * notes. Ordered roughly by prevalence — the first matching pattern wins per line so the
 * `reasons` label stays stable. Each entry: `{ re, label, unless? }`; a line that also matches
 * `unless` is not flagged by that pattern.
 *
 *  - `BREAKING CHANGE` / `BREAKING CHANGES:` — Conventional Commits footer, very common in
 *    auto-generated changelogs (semantic-release / changesets / lerna). Negated mentions
 *    ("no breaking changes", "Breaking changes: none") don't count.
 *  - `💥` / `⚠️  BREAKING` — emoji conventions (changesets, tsup, vitest).
 *  - `drops? (support for )?Node <N>` — explicit Node version drops, the single most common
 *    silent breaker.
 *  - `minimum (supported )?Node` / `requires Node >= X` — same family. Both Node patterns skip
 *    lines about the repo's own tooling (CI, tests) unless they mention support / engines.
 *  - `removed?` / `dropped?` bullets — only with public-API context (option, export, support,
 *    deprecated, …) and not for internal / unused / dev-dependency cleanups. Scoped to line
 *    starts so we don't false-match prose like "we've removed the bug".
 *
 * Intentional non-matches: "deprecated" alone (too noisy — deprecations are not breaks),
 * "renamed" without an identifier or API noun (often cosmetic), "changed default" (informational).
 */
const NEGATED_BREAKING =
  /\b(?:no|not|without|non|zero)(?:[\s-]+(?:a|an|any|known|major|new))?[\s-]+breaking\b|\bbreaking[\s_-]?changes?\b[\s:*_-]*(?:none|n\/a)\b/i;
const TOOLING_ONLY =
  /^(?!.*\b(?:support|engines)\b).*\b(?:ci|tests?|testing|workflows?|github\s+actions|contributors?|development)\b/i;
const NON_PUBLIC =
  /\b(?:internal(?:ly)?|unused|private|dead\s+code|dev(?:elopment)?[\s-]?dependenc(?:y|ies))\b/i;
const PUBLIC_API =
  '\\b(?:apis?|options?|flags?|exports?|methods?|hooks?|props?|fields?|commands?|plugins?|functions?|class(?:es)?|parameters?|arguments?)\\b';

const BREAKING_PATTERNS: ReadonlyArray<{ re: RegExp; label: string; unless?: RegExp }> = [
  { re: /\bBREAKING[\s_-]?CHANGES?\b/i, label: 'BREAKING CHANGE', unless: NEGATED_BREAKING },
  { re: /(?:^|\s)💥(?:\s|$)/u, label: 'breaking-change emoji' },
  { re: /⚠️\s*BREAKING/i, label: 'warning-tagged breaking' },
  {
    re: /\bdrops?(?:\s+support\s+for)?\s+Node(?:\.js)?\s*(?:v?\d+)/i,
    label: 'drops Node version',
    unless: TOOLING_ONLY,
  },
  {
    re: /\b(?:minimum|require\w*)\s+(?:supported\s+)?Node(?:\.js)?\s*(?:version\s+)?(?:is\s+|>=\s*|>\s*|=\s*)?v?\d+/i,
    label: 'raises minimum Node',
    unless: TOOLING_ONLY,
  },
  {
    re: new RegExp(
      `^[\\s>*\\-+]*(?:removed?|dropped?)\\b.*(?:${PUBLIC_API}|\\b(?:support|deprecated|legacy)\\b)`,
      'i',
    ),
    label: 'removed API',
    unless: NON_PUBLIC,
  },
  { re: /\b(?:is\s+)?no\s+longer\s+(?:supported|exported|available)\b/i, label: 'no longer supported' },
  {
    // A backticked identifier or an API noun separates "renamed `foo` to `bar`" from prose.
    re: new RegExp(`^(?=.*(?:\`|${PUBLIC_API})).*\\brenamed?\\b.+\\bto\\b`, 'i'),
    label: 'renamed export',
    unless: NON_PUBLIC,
  },
];

/**
 * Scan a plain-text changelog body (post-sanitize, post-truncate) for breaking-change
 * markers. Returns `{ hasBreaking: false, matchedLines: [], reasons: [] }` for cleanly
 * additive releases.
 *
 * Design notes:
 *   - Line-based, not regex-over-whole-body: preserves line context so reviewers can read the
 *     matched line verbatim in the summary.
 *   - Caps matches at 10 — past that the signal is saturated and we're just adding noise.
 *   - Dedupes identical lines (some changelogs repeat "BREAKING CHANGE:" once per bullet).
 *   - Works on raw or sanitized markdown — strips list markers + emphasis on the fly so the
 *     user-facing `matchedLines` reads cleanly.
 */
export function scanForBreakingChanges(body: string | undefined): BreakingChangeScan {
  const empty: BreakingChangeScan = { hasBreaking: false, matchedLines: [], reasons: [] };
  if (!body || body.trim().length === 0) return empty;

  const lines = body.split(/\r?\n/);
  const matchedLines: string[] = [];
  const reasons: string[] = [];
  const seen = new Set<string>();

  for (const raw of lines) {
    if (matchedLines.length >= 10) break;
    const line = raw.trim();
    if (line.length === 0) continue;
    for (const { re, label, unless } of BREAKING_PATTERNS) {
      if (!re.test(line) || unless?.test(line)) continue;
      // Clean markup so the surfaced line reads like prose, not raw markdown.
      const display = line
        .replace(/^#+\s*/, '') // heading markers
        .replace(/^[*>\-+]\s*/, '') // list bullets / quotes
        .replace(/\*\*([^*]+)\*\*/g, '$1') // bold
        .replace(/\*([^*]+)\*/g, '$1') // italic
        .replace(/`([^`]+)`/g, '$1') // inline code
        .trim();
      if (seen.has(display)) break;
      seen.add(display);
      matchedLines.push(display.length > 200 ? display.slice(0, 197) + '…' : display);
      reasons.push(label);
      break;
    }
  }

  return {
    hasBreaking: matchedLines.length > 0,
    matchedLines,
    reasons,
  };
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
