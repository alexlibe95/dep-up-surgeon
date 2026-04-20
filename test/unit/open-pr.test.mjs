import test from 'node:test';
import assert from 'node:assert/strict';

import { openPullRequest, defaultPrTitle, defaultPrBody } from '../../dist/cli/openPr.js';

/** Build a minimal FinalReport stub the PR helpers accept. */
function makeReport(overrides = {}) {
  return {
    upgraded: [],
    failed: [],
    skipped: [],
    conflicts: [],
    parsedConflicts: [],
    groupPlan: [],
    ignored: [],
    ...overrides,
  };
}

/**
 * ExecFn mock factory. Records every call in `calls` and returns the scripted response for a
 * matching `bin+args.join(' ')` prefix, or `{ exitCode: 0, stdout: '', stderr: '' }` by default.
 */
function makeExec(script = {}) {
  const calls = [];
  const fn = async (bin, args, options) => {
    const key = [bin, ...args].join(' ');
    calls.push({ bin, args, options, key });
    for (const [prefix, value] of Object.entries(script)) {
      if (key.startsWith(prefix)) {
        return typeof value === 'function' ? value({ bin, args, options }) : value;
      }
    }
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  return { exec: fn, calls };
}

test('openPullRequest: missing branch returns error without running any commands', async () => {
  const { exec, calls } = makeExec();
  const result = await openPullRequest(
    { cwd: '/tmp', branch: '', exec, commandExists: async () => true },
    makeReport(),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /requires --git-branch/);
  assert.equal(calls.length, 0);
});

test('openPullRequest: missing gh binary returns a friendly error', async () => {
  const { exec, calls } = makeExec();
  const result = await openPullRequest(
    { cwd: '/tmp', branch: 'deps/foo', exec, commandExists: async () => false },
    makeReport(),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /gh \(GitHub CLI\) not found/);
  // Never invoked any exec when command is missing.
  assert.equal(calls.length, 0);
});

test('openPullRequest: unauthenticated gh returns an error before pushing', async () => {
  const { exec, calls } = makeExec({
    'gh auth status': { exitCode: 1, stdout: '', stderr: 'not logged in' },
  });
  const result = await openPullRequest(
    { cwd: '/tmp', branch: 'deps/foo', exec, commandExists: async () => true },
    makeReport(),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /not authenticated/);
  // Only the auth check ran; no push, no pr create.
  assert.ok(calls.every((c) => !c.key.startsWith('git push')));
});

test('openPullRequest: happy path — push, create, parse URL + number', async () => {
  const { exec, calls } = makeExec({
    'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
    'gh repo view': {
      exitCode: 0,
      stdout: '{"nameWithOwner":"owner/repo","defaultBranch":"main"}',
      stderr: '',
    },
    'git push': { exitCode: 0, stdout: '', stderr: '' },
    'gh pr view': { exitCode: 1, stdout: '', stderr: 'no PR found' },
    'gh pr create': {
      exitCode: 0,
      stdout: 'https://github.com/owner/repo/pull/42',
      stderr: '',
    },
  });
  const result = await openPullRequest(
    {
      cwd: '/tmp',
      branch: 'deps/foo',
      title: 'my title',
      body: 'my body',
      draft: true,
      exec,
      commandExists: async () => true,
    },
    makeReport(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.provider, 'github');
  assert.equal(result.repo, 'owner/repo');
  assert.equal(result.base, 'main');
  assert.equal(result.url, 'https://github.com/owner/repo/pull/42');
  assert.equal(result.number, 42);
  assert.equal(result.draft, true);
  assert.equal(result.reused, false);

  // gh pr create invoked with --draft + --body-file - (body piped via stdin).
  const createCall = calls.find((c) => c.key.startsWith('gh pr create'));
  assert.ok(createCall, 'pr create was invoked');
  assert.ok(createCall.args.includes('--draft'));
  assert.ok(createCall.args.includes('--body-file'));
  assert.equal(createCall.options.input, 'my body');
  // Base resolved automatically from gh repo view when not explicit.
  assert.ok(createCall.args.includes('--base'));
  assert.equal(createCall.args[createCall.args.indexOf('--base') + 1], 'main');
});

test('openPullRequest: existing PR for the branch is reused instead of recreated', async () => {
  const { exec, calls } = makeExec({
    'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
    'gh repo view': {
      exitCode: 0,
      stdout: '{"nameWithOwner":"owner/repo","defaultBranch":"main"}',
      stderr: '',
    },
    'git push': { exitCode: 0, stdout: '', stderr: '' },
    'gh pr view': {
      exitCode: 0,
      stdout: '{"url":"https://github.com/owner/repo/pull/7","number":7,"isDraft":false}',
      stderr: '',
    },
  });
  const result = await openPullRequest(
    { cwd: '/tmp', branch: 'deps/foo', exec, commandExists: async () => true },
    makeReport(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.reused, true);
  assert.equal(result.number, 7);
  assert.equal(result.url, 'https://github.com/owner/repo/pull/7');
  // Never shelled out to pr create when reusing.
  assert.ok(!calls.some((c) => c.key.startsWith('gh pr create')));
});

test('openPullRequest: git push failure returns an error without creating a PR', async () => {
  const { exec, calls } = makeExec({
    'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
    'gh repo view': { exitCode: 0, stdout: '{}', stderr: '' },
    'git push': {
      exitCode: 1,
      stdout: '',
      stderr: 'rejected (fetch first)',
    },
  });
  const result = await openPullRequest(
    { cwd: '/tmp', branch: 'deps/foo', exec, commandExists: async () => true },
    makeReport(),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /git push failed/);
  assert.match(result.error, /rejected/);
  assert.ok(!calls.some((c) => c.key.startsWith('gh pr create')));
});

test('openPullRequest: gh pr create failure surfaces stderr in error', async () => {
  const { exec } = makeExec({
    'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
    'gh repo view': { exitCode: 0, stdout: '{"nameWithOwner":"a/b","defaultBranch":"main"}', stderr: '' },
    'git push': { exitCode: 0, stdout: '', stderr: '' },
    'gh pr view': { exitCode: 1, stdout: '', stderr: '' },
    'gh pr create': {
      exitCode: 1,
      stdout: '',
      stderr: 'GraphQL error: Validation failed',
    },
  });
  const result = await openPullRequest(
    { cwd: '/tmp', branch: 'deps/foo', exec, commandExists: async () => true },
    makeReport(),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /gh pr create failed/);
  assert.match(result.error, /GraphQL error/);
  // Metadata still present even on failure.
  assert.equal(result.repo, 'a/b');
  assert.equal(result.base, 'main');
});

test('openPullRequest: explicit --base wins over gh repo view default', async () => {
  const { exec, calls } = makeExec({
    'gh auth status': { exitCode: 0, stdout: '', stderr: '' },
    'gh repo view': { exitCode: 0, stdout: '{"nameWithOwner":"a/b","defaultBranch":"main"}', stderr: '' },
    'git push': { exitCode: 0, stdout: '', stderr: '' },
    'gh pr view': { exitCode: 1, stdout: '', stderr: '' },
    'gh pr create': { exitCode: 0, stdout: 'https://x/pull/1', stderr: '' },
  });
  const result = await openPullRequest(
    { cwd: '/tmp', branch: 'deps/foo', base: 'develop', exec, commandExists: async () => true },
    makeReport(),
  );
  assert.equal(result.ok, true);
  assert.equal(result.base, 'develop');
  const createCall = calls.find((c) => c.key.startsWith('gh pr create'));
  assert.equal(createCall.args[createCall.args.indexOf('--base') + 1], 'develop');
});

test('defaultPrTitle: tagged subject for breaking + security upgrades', () => {
  const report = makeReport({
    upgraded: [
      {
        name: 'axios',
        from: '1.0.0',
        to: '2.0.0',
        success: true,
        skipped: false,
        reason: 'success',
        security: { severity: 'high', ids: ['GHSA-1'] },
        changelog: { source: 'github-release', body: 'x', breaking: { hasBreaking: true, matchedLines: ['BREAKING'], reasons: ['BREAKING CHANGE'] } },
      },
    ],
  });
  const title = defaultPrTitle(report);
  assert.match(title, /\[breaking\+security\]/);
  assert.match(title, /bump axios/);
});

test('defaultPrTitle: no tag when there are no breaking / security markers', () => {
  const report = makeReport({
    upgraded: [
      { name: 'lodash', from: '4.17.20', to: '4.17.21', success: true, skipped: false, reason: 'success' },
      { name: 'chalk', from: '5.0.0', to: '5.3.0', success: true, skipped: false, reason: 'success' },
    ],
  });
  const title = defaultPrTitle(report);
  assert.equal(title.includes('['), false, 'no tag brackets');
  assert.match(title, /bump 2 packages/);
});

test('defaultPrBody: renders a minimal markdown table of upgraded packages', () => {
  const report = makeReport({
    upgraded: [{ name: 'axios', from: '1.6.0', to: '1.7.2', success: true, skipped: false, reason: 'success' }],
  });
  const body = defaultPrBody(report);
  assert.match(body, /Automated dependency upgrade/);
  assert.match(body, /\| `axios` \| `1.6.0` \| `1.7.2` \|/);
  assert.match(body, /dep-up-surgeon/);
});
