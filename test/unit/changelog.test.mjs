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
  neutralizeGithubRefs,
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

test('sanitizeMarkdown: neutralizes GitHub mentions and issue refs', () => {
  assert.strictEqual(sanitizeMarkdown('Fixed by @alice, closes #12'), 'Fixed by `@alice`, closes `#12`');
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
// GitHub quota / download size guards (global fetch stubbed — no network)
// ---------------------------------------------------------------------------

async function withStubbedFetch(handler, fn) {
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return handler(String(url), init);
  };
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = realFetch;
  }
}

const noTarball = { extractChangelog: async () => undefined };

test('fetchChangelog: a GitHub 403 rate limit stops GitHub calls for the rest of the run', async () => {
  const rateLimited = () =>
    new Response(
      JSON.stringify({
        message: 'API rate limit exceeded for 203.0.113.7. (But here\'s the good news: Authenticated requests get a higher rate limit.)',
        documentation_url: 'https://docs.github.com/rest/overview/resources-in-the-rest-api#rate-limiting',
      }),
      {
        status: 403,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'x-ratelimit-limit': '60',
          'x-ratelimit-remaining': '0',
          'x-ratelimit-reset': '1726150000',
        },
      },
    );
  await withStubbedFetch(rateLimited, async (calls) => {
    const cache = createChangelogCache();
    const fetchers = { ...noTarball, getManifest: async () => ({ repository: 'git+https://github.com/o/r.git' }) };
    for (const name of ['pkg-a', 'pkg-b', 'pkg-c']) {
      const excerpt = await fetchChangelog({ packageName: name, toVersion: '1.0.0', cache, fetchers, githubToken: '' });
      assert.strictEqual(excerpt, undefined);
    }
    assert.strictEqual(calls.length, 1, `expected one GitHub call, got:\n${calls.join('\n')}`);
  });
});

test('fetchChangelog: one releases-list request per package, tag matched locally', async () => {
  const releases = [
    { tag_name: 'v1.8.0', name: 'v1.8.0', body: '## What\'s Changed\n- newer', html_url: 'https://github.com/axios/axios/releases/tag/v1.8.0' },
    { tag_name: 'v1.7.2', name: 'v1.7.2', body: '### Bug Fixes\n- fetch: fix a thing', html_url: 'https://github.com/axios/axios/releases/tag/v1.7.2' },
  ];
  const handler = (url) =>
    /\/repos\/axios\/axios\/releases\?per_page=100$/.test(url)
      ? new Response(JSON.stringify(releases), { status: 200, headers: { 'x-ratelimit-remaining': '42' } })
      : new Response('{"message":"Not Found"}', { status: 404 });
  await withStubbedFetch(handler, async (calls) => {
    const excerpt = await fetchChangelog({
      packageName: 'axios',
      toVersion: '1.7.2',
      githubToken: '',
      fetchers: { ...noTarball, getManifest: async () => ({ repository: { type: 'git', url: 'git+https://github.com/axios/axios.git' } }) },
    });
    assert.ok(excerpt);
    assert.strictEqual(excerpt.source, 'github-release');
    assert.match(excerpt.body, /fix a thing/);
    assert.strictEqual(excerpt.url, 'https://github.com/axios/axios/releases/tag/v1.7.2');
    assert.strictEqual(calls.length, 1, calls.join('\n'));
  });
});

test('fetchChangelog: GitHub response bodies are read with a size cap', async () => {
  const total = 64 * 1024 * 1024;
  const chunk = new Uint8Array(1024 * 1024).fill(0x61);
  let pulled = 0;
  const handler = () =>
    new Response(
      new ReadableStream({
        pull(controller) {
          if (pulled >= total) return controller.close();
          pulled += chunk.byteLength;
          controller.enqueue(chunk);
        },
      }),
      { status: 200 },
    );
  await withStubbedFetch(handler, async () => {
    await fetchChangelog({
      packageName: 'huge',
      toVersion: '1.0.0',
      githubToken: '',
      fetchers: { ...noTarball, getManifest: async () => ({ repository: 'github:o/huge' }) },
    });
  });
  assert.ok(pulled <= 16 * 1024 * 1024, `read ${pulled} bytes from a 64 MB body`);
});

test('fetchChangelog: legacy getGithubRelease seam stops probing once it reports a rate limit', async () => {
  const tagsTried = [];
  const cache = createChangelogCache();
  const fetchers = {
    ...noTarball,
    getManifest: async () => ({ repository: 'github:o/r' }),
    getGithubRelease: async (owner, repo, tag) => {
      tagsTried.push(tag);
      return { body: '', html_url: '', rateLimited: true };
    },
  };
  await fetchChangelog({ packageName: 'a', toVersion: '1.0.0', cache, fetchers });
  await fetchChangelog({ packageName: 'b', toVersion: '1.0.0', cache, fetchers });
  assert.deepStrictEqual(tagsTried, ['a@1.0.0']);
});

// ---------------------------------------------------------------------------
// Tag candidates in monorepos
// ---------------------------------------------------------------------------

function listedFetchers(releases, extra = {}) {
  const probed = [];
  return {
    probed,
    fetchers: {
      ...noTarball,
      getManifest: async () => ({ repository: 'github:vitejs/vite' }),
      listGithubReleases: async () => ({ releases }),
      getGithubRelease: async (owner, repo, tag) => {
        probed.push(tag);
        return extra[tag];
      },
    },
  };
}

test("fetchChangelog: a monorepo package gets its own release, not the main package's `v<version>`", async () => {
  const releases = [
    { tag_name: 'v5.0.0', body: '- vite core notes', html_url: 'u/v5.0.0' },
    { tag_name: 'create-vite@5.0.0', body: '- create-vite notes', html_url: 'u/create-vite@5.0.0' },
    { tag_name: 'plugin-react@4.0.0', body: '- plugin-react notes', html_url: 'u/plugin-react@4.0.0' },
    { tag_name: 'v4.0.0', body: '- vite 4 notes', html_url: 'u/v4.0.0' },
  ];
  const { fetchers } = listedFetchers(releases);
  const unscoped = await fetchChangelog({ packageName: 'create-vite', toVersion: '5.0.0', fetchers });
  assert.match(unscoped.body, /create-vite notes/);
  const scoped = await fetchChangelog({ packageName: '@vitejs/plugin-react', toVersion: '4.0.0', fetchers });
  assert.match(scoped.body, /plugin-react notes/);
  // The main package still finds its generic `v` tag.
  const core = await fetchChangelog({ packageName: 'vite', toVersion: '5.0.0', fetchers });
  assert.match(core.body, /vite core notes/);
});

test('fetchChangelog: per-tag probing tries package-specific tags before `v<version>`', async () => {
  const tagsTried = [];
  const fetchers = {
    ...noTarball,
    getManifest: async () => ({ repository: 'github:x/monorepo' }),
    getGithubRelease: async (owner, repo, tag) => {
      tagsTried.push(tag);
      return tag === 'v1.0.0' ? { body: 'x', html_url: 'u' } : undefined;
    },
  };
  await fetchChangelog({ packageName: 'pkg', toVersion: '1.0.0', fetchers });
  assert.deepStrictEqual(tagsTried, ['pkg@1.0.0', 'pkg-1.0.0', 'v1.0.0']);
  tagsTried.length = 0;
  await fetchChangelog({ packageName: '@scope/pkg', toVersion: '1.0.0', fetchers });
  assert.deepStrictEqual(tagsTried, ['@scope/pkg@1.0.0', 'pkg@1.0.0', 'pkg-1.0.0', 'v1.0.0']);
});

test('fetchChangelog: a full page without the release probes the tag scheme the repo uses', async () => {
  const filler = (fmt) => Array.from({ length: 100 }, (_, i) => ({ tag_name: fmt(i), body: 'old', html_url: 'u' }));
  const single = listedFetchers(filler((i) => `v9.${i}.0`), { 'v1.0.0': { body: 'v-tag notes', html_url: 'u' } });
  const a = await fetchChangelog({ packageName: 'pkg', toVersion: '1.0.0', fetchers: single.fetchers });
  assert.deepStrictEqual(single.probed, ['v1.0.0']);
  assert.match(a.body, /v-tag notes/);

  const mono = listedFetchers(filler((i) => `pkg@9.${i}.0`), { 'pkg@1.0.0': { body: 'own notes', html_url: 'u' } });
  const b = await fetchChangelog({ packageName: 'pkg', toVersion: '1.0.0', fetchers: mono.fetchers });
  assert.deepStrictEqual(mono.probed, ['pkg@1.0.0']);
  assert.match(b.body, /own notes/);
});

// ---------------------------------------------------------------------------
// Breaking-change scan on the returned excerpt
// ---------------------------------------------------------------------------

test('fetchChangelog: breaking scan reads the full notes, not the truncated body', async () => {
  const notes = [
    ...Array.from({ length: 50 }, (_, i) => `- fix ${i}`),
    '',
    'BREAKING CHANGE: `parse()` now throws on invalid input',
  ].join('\n');
  const { fetchers } = listedFetchers([{ tag_name: 'v2.0.0', body: notes, html_url: 'u' }]);
  const excerpt = await fetchChangelog({ packageName: 'pkg', toVersion: '2.0.0', fetchers });
  assert.strictEqual(excerpt.truncated, true);
  assert.doesNotMatch(excerpt.body, /BREAKING/);
  assert.strictEqual(excerpt.breaking.hasBreaking, true);
  assert.match(excerpt.breaking.matchedLines[0], /parse\(\) now throws/);
});

test('fetchChangelog: a bump across majors scans the boundary releases from the same listing', async () => {
  const releases = [
    { tag_name: 'v3.1.0', body: '### Features\n- add `retry` option', html_url: 'u/v3.1.0' },
    { tag_name: 'v3.0.0', body: '### Breaking\n- Drop support for Node 16', html_url: 'u/v3.0.0' },
    { tag_name: 'v2.5.0', body: '- add things', html_url: 'u/v2.5.0' },
    { tag_name: 'v2.0.0', body: '- Removed the deprecated `legacy` option', html_url: 'u/v2.0.0' },
    { tag_name: 'v1.4.0', body: '- BREAKING CHANGE: not part of this bump', html_url: 'u/v1.4.0' },
  ];
  const { fetchers, probed } = listedFetchers(releases);
  const excerpt = await fetchChangelog({ packageName: 'pkg', toVersion: '3.1.0', fromVersion: '^1.4.0', fetchers });
  assert.match(excerpt.body, /retry/, 'the displayed notes stay the target release');
  assert.strictEqual(excerpt.breaking.hasBreaking, true);
  assert.deepStrictEqual(excerpt.breaking.matchedLines, [
    '3.0.0: Drop support for Node 16',
    '2.0.0: Removed the deprecated legacy option',
  ]);
  assert.deepStrictEqual(probed, [], 'boundaries on the listed page cost no extra request');

  // Same major: nothing extra is scanned.
  const minor = await fetchChangelog({ packageName: 'pkg', toVersion: '3.1.0', fromVersion: '3.0.0', fetchers });
  assert.strictEqual(minor.breaking.hasBreaking, false);
});

test('fetchChangelog: boundary releases off a full page are probed, at most 3', async () => {
  const releases = [
    { tag_name: 'v9.0.1', body: '- fix', html_url: 'u' },
    ...Array.from({ length: 99 }, (_, i) => ({ tag_name: `other@1.0.${i}`, body: 'x', html_url: 'u' })),
  ];
  const { fetchers, probed } = listedFetchers(releases, {
    'v8.0.0': { body: 'BREAKING CHANGE: config is now ESM-only', html_url: 'u' },
  });
  const excerpt = await fetchChangelog({ packageName: 'pkg', toVersion: '9.0.1', fromVersion: '1.0.0', fetchers });
  assert.deepStrictEqual(probed, ['v9.0.0', 'v8.0.0', 'v7.0.0']);
  assert.deepStrictEqual(excerpt.breaking.matchedLines, ['8.0.0: BREAKING CHANGE: config is now ESM-only']);
});

test('fetchChangelog: CHANGELOG.md fallback scans crossed 0.x minors from the same file', async () => {
  const changelog = [
    '# Changelog',
    '## 0.5.1',
    '- fix typo',
    '## 0.5.0',
    '- **BREAKING CHANGE**: `init()` is async',
    '## 0.4.0',
    '- Renamed `createClient` to `connect`',
    '## 0.3.2',
    '- Removed the `debug` option',
  ].join('\n');
  const fetchers = makeFetchers({ changelogBody: changelog });
  const excerpt = await fetchChangelog({ packageName: 'zero', toVersion: '0.5.1', fromVersion: '~0.3.2', fetchers });
  assert.strictEqual(excerpt.source, 'changelog.md');
  assert.match(excerpt.body, /fix typo/);
  assert.doesNotMatch(excerpt.body, /init/);
  assert.deepStrictEqual(excerpt.breaking.matchedLines, [
    '0.5.0: BREAKING CHANGE: init() is async',
    '0.4.0: Renamed createClient to connect',
  ]);
});

test('fetchChangelog: the cache keeps bumps with different crossed majors apart', async () => {
  let listed = 0;
  const releases = [
    { tag_name: 'v3.0.1', body: '- fix', html_url: 'u' },
    { tag_name: 'v3.0.0', body: 'BREAKING CHANGE: x', html_url: 'u' },
  ];
  const fetchers = {
    ...noTarball,
    getManifest: async () => ({ repository: 'github:o/r' }),
    listGithubReleases: async () => {
      listed++;
      return { releases };
    },
    getGithubRelease: async () => undefined,
  };
  const cache = createChangelogCache();
  const plain = await fetchChangelog({ packageName: 'p', toVersion: '3.0.1', fromVersion: '3.0.0', cache, fetchers });
  const crossing = await fetchChangelog({ packageName: 'p', toVersion: '3.0.1', fromVersion: '2.1.0', cache, fetchers });
  await fetchChangelog({ packageName: 'p', toVersion: '3.0.1', fromVersion: '^2.0.0', cache, fetchers });
  assert.strictEqual(plain.breaking.hasBreaking, false);
  assert.strictEqual(crossing.breaking.hasBreaking, true);
  assert.strictEqual(listed, 2, 'one fetch per distinct boundary set');
});

// ---------------------------------------------------------------------------
// GitHub mentions / issue refs
// ---------------------------------------------------------------------------

test('neutralizeGithubRefs: wraps mentions and issue refs, leaves code, emails and URLs alone', () => {
  const input = [
    '- fix crash (#123) by @alice in vitejs/vite#456, fixes #789',
    '- closes GH-12; thanks @bob-smith and @org/team',
    '- bump @babel/core@7.22.0 and `@types/node` (see `#1`)',
    '- mail dev@example.com, see https://example.com/page#123 or https://github.com/o/r/pull/9#issuecomment-1',
    '- &#123; entity, pkg@1.2.3 spec',
  ].join('\n');
  assert.strictEqual(
    neutralizeGithubRefs(input),
    [
      '- fix crash (`#123`) by `@alice` in `vitejs/vite#456`, fixes `#789`',
      '- closes `GH-12`; thanks `@bob-smith` and `@org/team`',
      '- bump `@babel/core@7.22.0` and `@types/node` (see `#1`)',
      '- mail dev@example.com, see https://example.com/page#123 or https://github.com/o/r/pull/9#issuecomment-1',
      '- &#123; entity, pkg@1.2.3 spec',
    ].join('\n'),
  );
});

test('fetchChangelog: excerpt body and breaking lines never carry live mentions / closing refs', async () => {
  const notes = "## What's Changed\n- BREAKING CHANGE: drop `legacy` mode by @alice in #42 (fixes #7)\n- docs by @bob";
  const { fetchers } = listedFetchers([{ tag_name: 'v2.0.0', body: notes, html_url: 'u' }]);
  const excerpt = await fetchChangelog({ packageName: 'pkg', toVersion: '2.0.0', fetchers });
  assert.match(excerpt.body, /by `@alice` in `#42` \(fixes `#7`\)/);
  assert.match(excerpt.body, /docs by `@bob`/);
  // The scan unwraps inline code for readability, then re-neutralizes.
  assert.deepStrictEqual(excerpt.breaking.matchedLines, [
    'BREAKING CHANGE: drop legacy mode by `@alice` in `#42` (fixes `#7`)',
  ]);
  assert.match(formatExcerptForCommit('pkg', '1.0.0', '2.0.0', excerpt), /`@alice`/);
});

test('fetchChangelog: skips tarball extraction when dist.unpackedSize exceeds the cap', async () => {
  let extracted = 0;
  const fetchers = {
    getManifest: async () => ({ dist: { unpackedSize: 136_512_345, fileCount: 7412 } }),
    getGithubRelease: async () => undefined,
    extractChangelog: async () => {
      extracted++;
      return undefined;
    },
  };
  const excerpt = await fetchChangelog({ packageName: 'next', toVersion: '15.1.0', fetchers });
  assert.strictEqual(excerpt, undefined);
  assert.strictEqual(extracted, 0, 'a >20 MB tarball must not be downloaded for a changelog');
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
