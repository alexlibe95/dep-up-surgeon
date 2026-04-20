/**
 * Unit tests for the changelog extraction + fetching logic. All network-free — we dependency-
 * inject fake implementations of the GitHub / pacote fetchers via `ChangelogFetchers` so each
 * test is deterministic.
 *
 * Coverage:
 *   - `parseRepoUrl` across the ~8 real-world shapes of `package.json.repository`
 *   - `extractVersionSection` across common CHANGELOG.md heading styles
 *   - `sanitizeMarkdown` + `truncateText`
 *   - `fetchChangelog` end-to-end: GitHub Releases first, CHANGELOG.md fallback, negative cache
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mod = await import(path.join(root, 'dist/utils/changelog.js'));
const {
  parseRepoUrl,
  extractVersionSection,
  sanitizeMarkdown,
  truncateText,
  fetchChangelog,
  createChangelogCache,
  formatExcerptForCommit,
} = mod;

// ---------------------------------------------------------------------------
// parseRepoUrl
// ---------------------------------------------------------------------------

test('parseRepoUrl: git+https url', () => {
  assert.deepStrictEqual(parseRepoUrl('git+https://github.com/axios/axios.git'), {
    owner: 'axios',
    repo: 'axios',
  });
});

test('parseRepoUrl: plain https url', () => {
  assert.deepStrictEqual(parseRepoUrl('https://github.com/expressjs/express'), {
    owner: 'expressjs',
    repo: 'express',
  });
});

test('parseRepoUrl: object form with url field', () => {
  assert.deepStrictEqual(parseRepoUrl({ url: 'git+https://github.com/lodash/lodash.git' }), {
    owner: 'lodash',
    repo: 'lodash',
  });
});

test('parseRepoUrl: github: shorthand', () => {
  assert.deepStrictEqual(parseRepoUrl('github:facebook/react'), {
    owner: 'facebook',
    repo: 'react',
  });
});

test('parseRepoUrl: git@ ssh form', () => {
  assert.deepStrictEqual(parseRepoUrl('git@github.com:vuejs/vue.git'), {
    owner: 'vuejs',
    repo: 'vue',
  });
});

test('parseRepoUrl: bare owner/repo shorthand', () => {
  assert.deepStrictEqual(parseRepoUrl('sindresorhus/execa'), {
    owner: 'sindresorhus',
    repo: 'execa',
  });
});

test('parseRepoUrl: rejects non-github hosts', () => {
  assert.strictEqual(parseRepoUrl('https://gitlab.com/owner/repo'), undefined);
  assert.strictEqual(parseRepoUrl('https://bitbucket.org/owner/repo'), undefined);
});

test('parseRepoUrl: rejects malformed input', () => {
  assert.strictEqual(parseRepoUrl(undefined), undefined);
  assert.strictEqual(parseRepoUrl(''), undefined);
  assert.strictEqual(parseRepoUrl('not a url at all'), undefined);
  assert.strictEqual(parseRepoUrl({}), undefined);
});

// ---------------------------------------------------------------------------
// extractVersionSection
// ---------------------------------------------------------------------------

const CHANGELOG_KEEPACHANGELOG = `# Changelog

## [2.0.0] - 2024-09-12

### Added
- new feature A
- new feature B

### Changed
- behavior C is now stricter

## [1.0.1] - 2024-08-01

### Fixed
- bug D

## [1.0.0] - 2024-07-15

initial release
`;

const CHANGELOG_PLAIN = `# Changes

## 3.1.0

- bumps
- more bumps

## 3.0.0

- major refactor

`;

test('extractVersionSection: keepachangelog [1.0.1] style', () => {
  const section = extractVersionSection(CHANGELOG_KEEPACHANGELOG, '1.0.1');
  assert.ok(section);
  assert.match(section, /\[1\.0\.1\]/);
  assert.match(section, /bug D/);
  assert.doesNotMatch(section, /initial release/, 'section should stop at next heading');
  assert.doesNotMatch(section, /new feature A/, 'section should not bleed backwards');
});

test('extractVersionSection: plain `## 3.1.0` style', () => {
  const section = extractVersionSection(CHANGELOG_PLAIN, '3.1.0');
  assert.ok(section);
  assert.match(section, /3\.1\.0/);
  assert.match(section, /bumps/);
  assert.doesNotMatch(section, /major refactor/);
});

test('extractVersionSection: matches `v1.0.0` prefix', () => {
  const cl = `## v1.0.0\n\ninitial\n\n## v0.9.0\n\nbeta\n`;
  const section = extractVersionSection(cl, '1.0.0');
  assert.ok(section);
  assert.match(section, /initial/);
  assert.doesNotMatch(section, /beta/);
});

test('extractVersionSection: does not match a version prefix (1.2.3 must not match 1.2.30)', () => {
  const cl = `## 1.2.30\n\nnew\n\n## 1.2.3\n\nold\n`;
  const section = extractVersionSection(cl, '1.2.3');
  assert.ok(section);
  assert.match(section, /old/);
  assert.doesNotMatch(section, /new/);
});

test('extractVersionSection: returns undefined when version is absent', () => {
  assert.strictEqual(extractVersionSection(CHANGELOG_PLAIN, '99.0.0'), undefined);
  assert.strictEqual(extractVersionSection('', '1.0.0'), undefined);
});

// ---------------------------------------------------------------------------
// sanitizeMarkdown / truncateText
// ---------------------------------------------------------------------------

test('sanitizeMarkdown: strips HTML comments', () => {
  assert.strictEqual(
    sanitizeMarkdown('before <!-- secret --> after').trim(),
    'before  after',
  );
});

test('sanitizeMarkdown: converts links to text (url) form', () => {
  const out = sanitizeMarkdown('See [docs](https://example.com/docs) for more.');
  assert.match(out, /docs \(https:\/\/example\.com\/docs\)/);
});

test('sanitizeMarkdown: collapses triple+ blank lines to doubles', () => {
  const input = 'a\n\n\n\n\nb';
  assert.strictEqual(sanitizeMarkdown(input), 'a\n\nb');
});

test('truncateText: keeps short bodies unchanged', () => {
  const r = truncateText('line1\nline2\nline3');
  assert.strictEqual(r.truncated, false);
  assert.strictEqual(r.text, 'line1\nline2\nline3');
});

test('truncateText: truncates bodies longer than the line cap', () => {
  const body = Array.from({ length: 60 }, (_, i) => `line${i}`).join('\n');
  const r = truncateText(body);
  assert.strictEqual(r.truncated, true);
  assert.match(r.text, /truncated/);
  const kept = r.text.split('\n').filter((l) => /^line\d+$/.test(l));
  assert.strictEqual(kept.length, 30, 'MAX_LINES cap should apply');
});

// ---------------------------------------------------------------------------
// fetchChangelog end-to-end with injected fetchers
// ---------------------------------------------------------------------------

function makeFetchers({ manifestRepo, githubBody, changelogBody, changelogPath } = {}) {
  const getManifest = async (spec) => {
    return manifestRepo ? { repository: manifestRepo } : undefined;
  };
  const getGithubRelease = async (owner, repo, tag, token) => {
    if (!githubBody) return undefined;
    // Only answer for the first candidate the caller tries, to simulate real releases.
    return githubBody[tag]
      ? { body: githubBody[tag], html_url: `https://github.com/${owner}/${repo}/releases/tag/${tag}` }
      : undefined;
  };
  const extractChangelog = async (spec, dest) => {
    if (!changelogBody) return undefined;
    const fs = await import('node:fs/promises');
    const file = path.join(dest, changelogPath ?? 'CHANGELOG.md');
    await fs.writeFile(file, changelogBody);
    return file;
  };
  return { getManifest, getGithubRelease, extractChangelog };
}

test('fetchChangelog: returns GitHub release body when available', async () => {
  const fetchers = makeFetchers({
    manifestRepo: 'git+https://github.com/axios/axios.git',
    githubBody: {
      'v1.7.2': '### Fixes\n- fix a thing\n- fix another thing',
    },
  });
  const excerpt = await fetchChangelog({
    packageName: 'axios',
    toVersion: '1.7.2',
    fetchers,
  });
  assert.ok(excerpt);
  assert.strictEqual(excerpt.source, 'github-release');
  assert.match(excerpt.url, /axios\/axios\/releases\/tag\/v1\.7\.2/);
  assert.match(excerpt.body, /fix a thing/);
});

test('fetchChangelog: falls back to CHANGELOG.md when no GitHub release matches', async () => {
  const fetchers = makeFetchers({
    manifestRepo: 'git+https://github.com/somepkg/somepkg.git',
    githubBody: {}, // no tags
    changelogBody: `## 2.0.0\n\n- new feature\n\n## 1.0.0\n\n- initial\n`,
  });
  const excerpt = await fetchChangelog({
    packageName: 'somepkg',
    toVersion: '2.0.0',
    fetchers,
  });
  assert.ok(excerpt);
  assert.strictEqual(excerpt.source, 'changelog.md');
  assert.match(excerpt.body, /new feature/);
  assert.doesNotMatch(excerpt.body, /initial/);
});

test('fetchChangelog: returns undefined when neither source has the version', async () => {
  const fetchers = makeFetchers({
    manifestRepo: 'git+https://github.com/x/y.git',
    githubBody: {},
    changelogBody: '## 1.0.0\n\n- first\n',
  });
  const excerpt = await fetchChangelog({
    packageName: 'y',
    toVersion: '9.9.9',
    fetchers,
  });
  assert.strictEqual(excerpt, undefined);
});

test('fetchChangelog: cache de-duplicates repeat calls', async () => {
  let githubCalls = 0;
  const fetchers = {
    getManifest: async () => ({ repository: 'github:x/y' }),
    getGithubRelease: async () => {
      githubCalls++;
      return { body: 'notes', html_url: 'https://example.com/r' };
    },
    extractChangelog: async () => undefined,
  };
  const cache = createChangelogCache();
  await fetchChangelog({ packageName: 'y', toVersion: '1.0.0', cache, fetchers });
  await fetchChangelog({ packageName: 'y', toVersion: '1.0.0', cache, fetchers });
  await fetchChangelog({ packageName: 'y', toVersion: '1.0.0', cache, fetchers });
  assert.strictEqual(githubCalls, 1, 'cache must dedupe repeated requests');
});

test('fetchChangelog: negative cache prevents re-fetch for missing versions', async () => {
  let githubCalls = 0;
  const fetchers = {
    getManifest: async () => ({ repository: 'github:x/y' }),
    getGithubRelease: async () => {
      githubCalls++;
      return undefined;
    },
    extractChangelog: async () => undefined,
  };
  const cache = createChangelogCache();
  await fetchChangelog({ packageName: 'y', toVersion: '1.0.0', cache, fetchers });
  await fetchChangelog({ packageName: 'y', toVersion: '1.0.0', cache, fetchers });
  // GitHub was called at most the candidate-count times on the first go; the second go must be 0.
  const firstRunCount = githubCalls;
  await fetchChangelog({ packageName: 'y', toVersion: '1.0.0', cache, fetchers });
  assert.strictEqual(githubCalls, firstRunCount, 'negative result should be cached');
});

test('fetchChangelog: never throws on internal errors', async () => {
  const fetchers = {
    getManifest: async () => {
      throw new Error('boom');
    },
    getGithubRelease: async () => {
      throw new Error('also boom');
    },
    extractChangelog: async () => {
      throw new Error('still boom');
    },
  };
  const excerpt = await fetchChangelog({
    packageName: 'y',
    toVersion: '1.0.0',
    fetchers,
  });
  assert.strictEqual(excerpt, undefined);
});

test('fetchChangelog: tries scoped monorepo tag form first for @scope/pkg', async () => {
  const tagsTried = [];
  const fetchers = {
    getManifest: async () => ({ repository: 'github:x/monorepo' }),
    getGithubRelease: async (owner, repo, tag) => {
      tagsTried.push(tag);
      // Succeed only on the last candidate so we see the full ordering.
      return tag === 'v1.0.0' ? { body: 'x', html_url: 'u' } : undefined;
    },
    extractChangelog: async () => undefined,
  };
  await fetchChangelog({
    packageName: '@scope/pkg',
    toVersion: '1.0.0',
    fetchers,
  });
  assert.ok(tagsTried[0].includes('@scope/pkg@1.0.0'), `first tag was: ${tagsTried[0]}`);
  // And `v1.0.0` should be tried among the candidates.
  assert.ok(tagsTried.includes('v1.0.0'));
});

// ---------------------------------------------------------------------------
// formatExcerptForCommit
// ---------------------------------------------------------------------------

test('formatExcerptForCommit: github-release shape', () => {
  const out = formatExcerptForCommit('axios', '^1.6.0', '1.7.2', {
    source: 'github-release',
    url: 'https://github.com/axios/axios/releases/tag/v1.7.2',
    body: '### Fixes\n- something',
    truncated: false,
  });
  assert.match(out, /axios \^1\.6\.0 → 1\.7\.2/);
  assert.match(out, /source: GitHub Release/);
  assert.match(out, /github\.com\/axios/);
  assert.match(out, /something/);
});

test('formatExcerptForCommit: changelog.md shape', () => {
  const out = formatExcerptForCommit('some-pkg', undefined, '2.0.0', {
    source: 'changelog.md',
    body: '## 2.0.0\n\n- new',
    truncated: false,
  });
  assert.match(out, /some-pkg @ 2\.0\.0/);
  assert.match(out, /CHANGELOG\.md/);
});
