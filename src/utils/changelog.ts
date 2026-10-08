/**
 * Fetch a short human-readable changelog excerpt for a package version bump. Used to enrich
 * commit messages (via `--git-commit`) and summary reports so reviewers can see *why* a version
 * changed without opening a browser tab per package.
 *
 * Sources, in order of preference:
 *
 *   1. **GitHub Releases API** (`GET /repos/{owner}/{repo}/releases?per_page=100`, one request
 *      per package). Best data — maintainers curate release notes here and they are short by
 *      construction. The tag is matched locally, package-specific forms first so a monorepo
 *      never hands out a sibling's notes: `<pkg-name>@<version>`, `<short-name>@<version>`,
 *      `<short-name>-<version>`, then `v<version>`, `<version>`, `release-<version>`, ….
 *      Requires a `GITHUB_TOKEN` env var for anything above 60 req/h (the unauth IP rate limit);
 *      once GitHub refuses (403/429) we stop calling it for the rest of the run.
 *   2. **CHANGELOG.md from the published tarball** via `pacote.extract` → parse the section whose
 *      heading matches the new version. Works for every package that ships its CHANGELOG (very
 *      common in the JS ecosystem); no network beyond the registry we already talk to. Skipped
 *      when the manifest's `dist.unpackedSize` is over 20 MB.
 *
 * When the bump crosses a major (or a `0.x` minor), the notes of the first release of each
 * crossed line (`2.0.0`, `3.0.0`, …) are looked up in the same source and scanned for breaking
 * changes too — the target's own notes are often a patch release that never mentions them.
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
import type { SemVer } from 'semver';
import { registryOptions } from './npmConfig.js';

/**
 * Maximum number of lines we keep from any changelog excerpt. Commit bodies get unwieldy past
 * ~40 lines and release notes with code samples routinely blow past 200 lines. 30 lines is a
 * sensible balance for reading, short enough to fit in a `git log --oneline -p` skim. Display
 * only: the breaking-change scan always reads the full notes.
 */
const MAX_LINES = 30;

/**
 * Boundary releases (first release of a crossed major / `0.x` minor) scanned per bump, nearest
 * to the target first. Each one not on the listed releases page costs one GitHub request.
 */
const MAX_BOUNDARY_RELEASES = 3;

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
  /**
   * Plain text body for display, already sanitized (`sanitizeMarkdown`: GitHub mentions and
   * issue refs neutralized) and trimmed to MAX_LINES.
   */
  body: string;
  /** True when the body was truncated to fit MAX_LINES. */
  truncated: boolean;
  /**
   * Breaking-change scan of the FULL notes (not the truncated `body`), plus the notes of the
   * first release of every major / `0.x` minor the bump crosses when those were found (their
   * lines are prefixed with that version, e.g. `2.0.0: Dropped support for Node 16`). Use this
   * rather than re-scanning `body`.
   */
  breaking: BreakingChangeScan;
}

export interface ChangelogCache {
  /**
   * Keyed by `<pkg>@<toVersion>` (plus the crossed boundary releases, which change the breaking
   * scan). `null` means we tried and found nothing (negative cache).
   */
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
  /**
   * Optional previous version (or the range it was declared with, e.g. `^1.4.0`). When the bump
   * crosses a major (or a `0.x` minor), the boundary releases' notes are scanned for breaking
   * changes as well.
   */
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
  const boundaries = crossedBoundaries(options.fromVersion, toVersion);
  const key = `${packageName}@${toVersion}${boundaries.length > 0 ? ` (+${boundaries.join(', ')})` : ''}`;
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

  let notes: ReleaseNotes | undefined;
  try {
    // 1. Try GitHub Releases when we can resolve the repo from the manifest.
    const manifest = await fetchers.getManifest(`${packageName}@${toVersion}`).catch(() => undefined);
    const repo = parseRepoUrl(manifest?.repository) ?? parseRepoUrl(manifest?.homepage);
    if (repo && !runState.githubRateLimited) {
      notes = await tryGithubRelease(
        repo.owner,
        repo.repo,
        packageName,
        toVersion,
        boundaries,
        token,
        fetchers,
        runState,
      );
    }

    // 2. Fallback: CHANGELOG.md from the published tarball (unless it's huge).
    const unpackedSize = manifest?.dist?.unpackedSize;
    const tarballTooLarge = typeof unpackedSize === 'number' && unpackedSize > MAX_TARBALL_UNPACKED_BYTES;
    if (!notes && !tarballTooLarge) {
      notes = await tryPackageChangelog(packageName, toVersion, boundaries, fetchers.extractChangelog);
    }
  } catch {
    // Never let changelog enrichment abort the upgrade flow.
    notes = undefined;
  }

  const excerpt = notes ? toExcerpt(notes) : undefined;
  cache?.entries.set(key, excerpt ?? null);
  return excerpt;
}

/** Raw notes of the target release, plus whichever crossed boundary releases were found. */
interface ReleaseNotes {
  source: ChangelogExcerpt['source'];
  url?: string;
  raw: string;
  boundaries: Array<{ version: string; raw: string }>;
}

function toExcerpt(notes: ReleaseNotes): ChangelogExcerpt {
  const body = truncateText(sanitizeMarkdown(notes.raw));
  // Scan the full notes (a long release can bury BREAKING far below the display cut), and
  // before mentions are neutralized: the backticks that adds would read as code to the patterns.
  const breaking = mergeBreakingScans([
    scanForBreakingChanges(cleanMarkdown(notes.raw)),
    ...notes.boundaries.map((b) => {
      const scan = scanForBreakingChanges(cleanMarkdown(b.raw));
      return { ...scan, matchedLines: scan.matchedLines.map((line) => `${b.version}: ${line}`) };
    }),
  ]);
  return {
    source: notes.source,
    ...(notes.source === 'github-release' ? { url: notes.url } : {}),
    body: body.text,
    truncated: body.truncated,
    breaking,
  };
}

/** Concatenate scans (target release first) under the scanner's dedupe + 10-line cap. */
function mergeBreakingScans(scans: BreakingChangeScan[]): BreakingChangeScan {
  const matchedLines: string[] = [];
  const reasons: string[] = [];
  for (const scan of scans) {
    scan.matchedLines.forEach((line, i) => {
      if (matchedLines.length >= MAX_BREAKING_LINES || matchedLines.includes(line)) return;
      matchedLines.push(line);
      reasons.push(scan.reasons[i]!);
    });
  }
  return { hasBreaking: matchedLines.length > 0, matchedLines, reasons };
}

/**
 * First release of every major (or `0.x` minor) a `from → to` bump crosses, excluding `to`
 * itself and nearest first: `^1.4.0 → 3.2.1` gives `3.0.0`, `2.0.0`; `0.3.2 → 0.5.1` gives
 * `0.5.0`, `0.4.0`. Empty when `from` is unknown or not a version / range.
 */
function crossedBoundaries(fromVersion: string | undefined, toVersion: string): string[] {
  const from = fromVersion ? lowestVersion(fromVersion) : undefined;
  const to = semver.parse(toVersion);
  if (!from || !to || semver.lte(to, from)) {
    return [];
  }
  const out: string[] = [];
  const add = (v: string): void => {
    if (semver.gt(v, from) && semver.lt(v, to)) out.push(v);
  };
  if (to.major > from.major) {
    for (let m = to.major; m > from.major && out.length < MAX_BOUNDARY_RELEASES; m--) add(`${m}.0.0`);
  } else if (to.major === 0) {
    for (let n = to.minor; n > from.minor && out.length < MAX_BOUNDARY_RELEASES; n--) add(`0.${n}.0`);
  }
  return out;
}

/** Lowest version a `from` spec allows (`^1.4.0` → 1.4.0); `undefined` for tags, `*`, URLs. */
function lowestVersion(spec: string): SemVer | undefined {
  try {
    const v = semver.minVersion(spec.trim());
    return v && semver.gt(v, '0.0.0') ? v : undefined;
  } catch {
    return undefined;
  }
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
  boundaries: readonly string[],
  token: string | undefined,
  fetchers: ResolvedFetchers,
  runState: ChangelogCache,
): Promise<ReleaseNotes | undefined> {
  const candidates = tagCandidates(packageName, version);

  let listed: Map<string, GithubReleasesPage['releases'][number]> | undefined;
  // Without a listing, or with a full page, a release we didn't see may still exist.
  let mayBeUnlisted = true;
  let target: { tag: string; body: string; url?: string } | undefined;
  let probeTags = candidates;
  if (fetchers.listGithubReleases) {
    const page = await fetchers.listGithubReleases(owner, repo, token).catch(() => undefined);
    if (page?.rateLimited) {
      runState.githubRateLimited = true;
    }
    if (!page) {
      return undefined;
    }
    listed = new Map(page.releases.map((r) => [r.tag_name, r]));
    mayBeUnlisted = page.releases.length >= RELEASES_PER_PAGE;
    for (const tag of candidates) {
      const hit = listed.get(tag);
      if (hit?.body) {
        target = { tag, body: hit.body, url: hit.html_url };
        break;
      }
    }
    if (!target) {
      // Only a full page can have pushed the release off; one lookup of the likeliest tag is
      // still far cheaper than probing every candidate.
      if (!mayBeUnlisted) {
        return undefined;
      }
      probeTags = [likeliestTag(candidates, version, [...listed.keys()])];
    }
  }

  for (const tag of target ? [] : probeTags) {
    if (runState.githubRateLimited) {
      return undefined;
    }
    const r = await fetchers.getGithubRelease(owner, repo, tag, token).catch(() => undefined);
    if (r?.rateLimited) {
      runState.githubRateLimited = true;
    }
    if (r?.body) {
      target = { tag, body: r.body, url: r.html_url };
      break;
    }
  }
  if (!target) {
    return undefined;
  }

  // Boundary releases use the target's tag scheme (`pkg@2.0.0` next to `pkg@2.1.3`): free when
  // listed, otherwise one bounded lookup each — and only when they could be unlisted.
  const scheme = candidates.indexOf(target.tag);
  const found: ReleaseNotes['boundaries'] = [];
  for (const boundary of boundaries) {
    const tag = tagCandidates(packageName, boundary)[scheme]!;
    const hit = listed?.get(tag);
    if (hit?.body) {
      found.push({ version: boundary, raw: hit.body });
      continue;
    }
    if (!mayBeUnlisted || runState.githubRateLimited) {
      continue;
    }
    const r = await fetchers.getGithubRelease(owner, repo, tag, token).catch(() => undefined);
    if (r?.rateLimited) {
      runState.githubRateLimited = true;
    }
    if (r?.body) {
      found.push({ version: boundary, raw: r.body });
    }
  }
  return { source: 'github-release', url: target.url, raw: target.body, boundaries: found };
}

/**
 * Tag patterns maintainers use, most specific first. The package-specific forms come before the
 * generic `v<version>` / `<version>`: in a monorepo those usually belong to the main package, so
 * matching them first hands out a sibling's notes (`create-vite@5.0.0` getting vite's `v5.0.0`).
 * `<pkg>@<v>` is what Changesets / Lerna publish; `<short>@<v>` / `<short>-<v>` drop the scope.
 * The order (and so each scheme's index) is the same for every version of a package.
 */
function tagCandidates(packageName: string, version: string): string[] {
  const shortName = packageName.split('/').pop()!;
  return [
    ...new Set([
      `${packageName}@${version}`,
      `${shortName}@${version}`,
      `${shortName}-${version}`,
      `v${version}`,
      version,
      `release-${version}`,
      `releases/v${version}`,
    ]),
  ];
}

/**
 * The one tag worth a direct lookup once the release has fallen off the listed page: the first
 * candidate whose naming scheme (`<prefix><version>`) a listed release already uses.
 */
function likeliestTag(candidates: readonly string[], version: string, listedTags: readonly string[]): string {
  for (const candidate of candidates) {
    const prefix = candidate.slice(0, candidate.length - version.length);
    if (listedTags.some((t) => t.startsWith(prefix) && semver.valid(t.slice(prefix.length)))) {
      return candidate;
    }
  }
  return candidates[0]!;
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
  boundaries: readonly string[],
  extract: NonNullable<Required<ChangelogFetchers>['extractChangelog']>,
): Promise<ReleaseNotes | undefined> {
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
    // The tarball's CHANGELOG covers every earlier release: boundary sections come for free.
    const found = boundaries.flatMap((version) => {
      const s = extractVersionSection(raw, version);
      return s ? [{ version, raw: s }] : [];
    });
    return { source: 'changelog.md', raw: section, boundaries: found };
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
 *
 * The result is pasted into the user's commits and PR bodies, so upstream `@handle`s and issue
 * refs are neutralized too (see `neutralizeGithubRefs`).
 */
export function sanitizeMarkdown(md: string): string {
  return neutralizeGithubRefs(cleanMarkdown(md));
}

/** The markup clean-up half of `sanitizeMarkdown`; what the breaking-change scan reads. */
function cleanMarkdown(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, '') // HTML comments
    .replace(/^```[\s\S]*?```$/gm, '') // multi-line code fences
    .replace(/!?\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)') // [text](url) → text (url); images lose the `!`
    .replace(/[ \t]+$/gm, '') // trailing whitespace
    .replace(/\n{3,}/g, '\n\n') // collapse 3+ blank lines
    .trim();
}

/**
 * GitHub links what it finds in commit messages and PR bodies: an upstream `@handle` (or
 * `@org/team`) gets a notification, and `#123` / `GH-123` / `owner/repo#123` point at the
 * USER's issues — `fixes #123` even closes one on merge. Wrapped in backticks they read the
 * same but GitHub leaves them alone (and a closing keyword no longer precedes a `#`). Scoped
 * package names (`@babel/core@7.22.0`) get the same treatment, which reads fine as code.
 *
 * Alternatives, in order: `@handle` / `@org/team` / `@scope/pkg@1.2.3` (not emails or
 * `pkg@1.2.3`); `#123` / `owner/repo#123` (not `&#123;` entities or `x.com/page#123` URL
 * fragments); `GH-123`.
 */
const GITHUB_REF =
  /(?<![\w.+\-/`@])@[A-Za-z0-9][\w-]*(?:\/[\w.-]*\w)?(?:@[\w.^~-]*\w)?|(?<![\w&/`#.:-])(?:[\w.-]+\/[\w.-]+)?#\d+\b|(?<![\w/`-])GH-\d+\b/gi;

/** Wrap GitHub mentions / issue refs in backticks, outside existing code spans. */
export function neutralizeGithubRefs(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(GITHUB_REF, '`$&`')))
    .join('');
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

/** Matched lines kept per scan — past that the signal is saturated. */
const MAX_BREAKING_LINES = 10;

/**
 * A line that is nothing but a "Breaking changes" heading (`### ⚠ BREAKING CHANGES`,
 * `**Breaking changes:**`). It only counts when the section under it says something.
 */
const BREAKING_HEADING =
  /^(?:#{1,6}\s*)?[*_\s]*(?:(?:⚠️?|💥|🚨|:warning:|:boom:)\s*)*breaking(?:[\s_-]?changes?)?[*_\s]*:?[*_\s]*$/iu;

/** Start of the next section: a markdown heading or a bold-only line (`**Features**`). */
const SECTION_START = /^(?:#{1,6}\s|(\*\*|__)[^*_]+\1:?$)/;

/** Section content that means "nothing here". */
const EMPTY_SECTION_TEXT = /^(?:none|n\/a|nothing|-+)\.?$/i;

/** True when the section under the heading at `idx` is empty or only says None / N/A. */
function isEmptySection(lines: readonly string[], idx: number): boolean {
  for (let i = idx + 1; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (SECTION_START.test(line)) break;
    const text = line.replace(/^[*>\-+]\s*/, '').replace(/[*_`]/g, '').trim();
    if (text && !EMPTY_SECTION_TEXT.test(text) && !NEGATED_BREAKING.test(text)) return false;
  }
  return true;
}

/**
 * Scan a plain-text changelog body for breaking-change markers. Feed it the FULL notes, not a
 * truncated excerpt — `fetchChangelog` does, and exposes the result as `excerpt.breaking`.
 * Returns `{ hasBreaking: false, matchedLines: [], reasons: [] }` for cleanly additive releases.
 *
 * Design notes:
 *   - Line-based, not regex-over-whole-body: preserves line context so reviewers can read the
 *     matched line verbatim in the summary.
 *   - Caps matches at 10 — past that the signal is saturated and we're just adding noise.
 *   - Dedupes identical lines (some changelogs repeat "BREAKING CHANGE:" once per bullet).
 *   - A bare "Breaking Changes" heading only counts when its section has content: release
 *     templates often keep the heading with nothing (or "None" / "N/A") under it.
 *   - Works on raw or sanitized markdown — strips list markers + emphasis on the fly so the
 *     user-facing `matchedLines` reads cleanly (GitHub mentions / issue refs stay neutralized).
 */
export function scanForBreakingChanges(body: string | undefined): BreakingChangeScan {
  const empty: BreakingChangeScan = { hasBreaking: false, matchedLines: [], reasons: [] };
  if (!body || body.trim().length === 0) return empty;

  const lines = body.split(/\r?\n/);
  const matchedLines: string[] = [];
  const reasons: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length && matchedLines.length < MAX_BREAKING_LINES; i++) {
    const line = lines[i]!.trim();
    if (line.length === 0) continue;
    if (BREAKING_HEADING.test(line) && isEmptySection(lines, i)) continue;
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
      // Unwrapping inline code can expose a `@handle` / `#123` again; re-neutralize after clipping.
      matchedLines.push(neutralizeGithubRefs(display.length > 200 ? display.slice(0, 197) + '…' : display));
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
