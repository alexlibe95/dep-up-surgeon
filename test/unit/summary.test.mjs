/**
 * Unit tests for the markdown / html summary renderers and destination resolver.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { renderSummaryMarkdown, renderSummaryHtml, resolveSummaryDestination, writeSummary } =
  await import(path.join(root, 'dist/cli/summary.js'));

function fixtureReport() {
  return {
    upgraded: [
      { name: 'axios', success: true, from: '1.6.0', to: '1.15.0', workspace: 'root' },
      {
        name: 'react',
        success: true,
        from: '17.0.2',
        to: '19.2.5',
        linkedGroupId: 'graph-0',
        workspace: '@org/web',
      },
    ],
    skipped: [],
    failed: [
      {
        name: 'next',
        reason: 'validation-script',
        previousVersion: '14.0.0',
        attemptedVersion: '15.0.0',
        validation: { command: 'npm test', exitCode: 1, lastLines: 'boom' },
        workspace: '@org/web',
      },
      {
        name: 'esbuild',
        reason: 'install',
        previousVersion: '0.20.0',
        attemptedVersion: '0.25.0',
        install: { command: 'npm install', exitCode: 1, lastLines: 'ERESOLVE', ok: false },
        message: 'npm install failed (exit 1)',
      },
    ],
    conflicts: [],
    unresolved: [],
    groups: [{ id: 'graph-0', packages: ['react', 'react-dom'] }],
    project: {
      manager: 'npm',
      managerVersion: '10.2.3',
      managerSource: 'package.json:packageManager',
      lockfile: 'package-lock.json',
      hasWorkspaces: true,
      workspaceGlobs: ['packages/*'],
      workspaceMembers: [
        { name: '@org/web', dir: '/repo/packages/web' },
        { name: '@org/api', dir: '/repo/packages/api' },
      ],
    },
    targets: [
      { label: 'root', cwd: '/repo', packageJson: '/repo/package.json' },
      { label: '@org/web', cwd: '/repo/packages/web', packageJson: '/repo/packages/web/package.json' },
    ],
    ignored: ['some-pinned-pkg'],
  };
}

test('renderSummaryMarkdown: includes counts, project, both tables, ignored', () => {
  const md = renderSummaryMarkdown(fixtureReport(), '9.9.9');
  assert.match(md, /## dep-up-surgeon — upgrade report/);
  assert.match(md, /2 upgraded, 2 failed, 0 skipped/);
  assert.match(md, /dep-up-surgeon `9\.9\.9`/);
  assert.match(md, /\*\*Project\*\*: npm@10\.2\.3 \(via `package\.json:packageManager`/);
  assert.match(md, /\*\*Targets\*\*: `root`, `@org\/web`/);
  // Upgraded table
  assert.match(md, /### Upgraded[\s\S]*\| `axios` \| root \| `1\.6\.0` \| `1\.15\.0`/);
  assert.match(md, /\| `react` \| @org\/web \| `17\.0\.2` \| `19\.2\.5` \| group `graph-0` \|/);
  // Failed table
  assert.match(md, /### Failed or rolled back/);
  assert.match(md, /\| `next`.*\| @org\/web \| `validation-script` \|.*validator `npm test` exited `1`/);
  assert.match(md, /\| `esbuild`.*\| `install` \|.*installer exited `1`/);
  // Ignored
  assert.match(md, /### Ignored[\s\S]*`some-pinned-pkg`/);
});

test('renderSummaryMarkdown: handles empty report (no project / no upgrades)', () => {
  const md = renderSummaryMarkdown(
    {
      upgraded: [],
      skipped: [],
      failed: [],
      conflicts: [],
      unresolved: [],
      groups: [],
    },
    '0.0.0',
  );
  assert.match(md, /0 upgraded, 0 failed, 0 skipped/);
  assert.doesNotMatch(md, /### Upgraded/);
  assert.doesNotMatch(md, /### Failed/);
  assert.doesNotMatch(md, /### Ignored/);
});

test('renderSummaryMarkdown: surfaces preflightAborted', () => {
  const md = renderSummaryMarkdown(
    {
      upgraded: [],
      skipped: [],
      failed: [],
      conflicts: [],
      unresolved: [],
      groups: [],
      preflightAborted: true,
      preflight: { ok: false, skipped: false, command: 'npm test', exitCode: 2, source: 'auto' },
    },
    '0.0.0',
  );
  assert.match(md, /Pre-flight validator failed/);
  assert.match(md, /`npm test` exited `2`/);
});

test('renderSummaryHtml: produces a <section> with both tables and html-escapes content', () => {
  const r = fixtureReport();
  // Inject something that needs escaping into a column the renderer always emits raw-escaped.
  r.failed[1].attemptedVersion = '<script>alert("x")</script>';
  const html = renderSummaryHtml(r, '9.9.9');
  assert.ok(html.startsWith('<style>'), 'html should begin with inline <style> block');
  assert.match(html, /<section class="dep-up-surgeon-report">/);
  assert.ok(html.endsWith('</section>'));
  // Severity chips render with the shared css class so GH and offline renders match.
  assert.match(html, /\.chip-critical\s*\{/);
  assert.match(html, /<h3>Upgraded<\/h3>/);
  assert.match(html, /<h3>Failed or rolled back<\/h3>/);
  // No raw script tag should leak through.
  assert.doesNotMatch(html, /<script>alert/);
  assert.match(html, /&lt;script&gt;/);
});

test('resolveSummaryDestination: explicit file beats env beats default', () => {
  const cwd = '/tmp/repo';
  const env = { GITHUB_STEP_SUMMARY: '/tmp/gh-summary.md' };
  const a = resolveSummaryDestination({ format: 'md', cwd, toolVersion: 'x', file: 'out.md', env });
  assert.deepStrictEqual(a, { path: path.resolve(cwd, 'out.md'), append: false });

  const b = resolveSummaryDestination({ format: 'md', cwd, toolVersion: 'x', env });
  assert.deepStrictEqual(b, { path: '/tmp/gh-summary.md', append: true });

  const c = resolveSummaryDestination({ format: 'html', cwd, toolVersion: 'x', env: {} });
  assert.deepStrictEqual(c, {
    path: path.join(cwd, 'dep-up-surgeon-summary.html'),
    append: false,
  });
});

test('writeSummary: appends to GITHUB_STEP_SUMMARY when set', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-summary-'));
  const stepSummary = path.join(dir, 'gh-step-summary.md');
  await fs.writeFile(stepSummary, '<!-- existing -->\n');

  const written = await writeSummary(fixtureReport(), {
    format: 'md',
    cwd: dir,
    toolVersion: '1.0.0',
    env: { GITHUB_STEP_SUMMARY: stepSummary },
  });
  assert.strictEqual(written, stepSummary);

  const contents = await fs.readFile(stepSummary, 'utf8');
  assert.match(contents, /<!-- existing -->/);
  assert.match(contents, /## dep-up-surgeon — upgrade report/);
});

test('renderSummaryMarkdown: surfaces peer-range resolutions section + badge', () => {
  const report = {
    upgraded: [
      {
        name: 'react',
        success: true,
        from: '18.2.0',
        to: '18.3.1',
        linkedGroupId: 'react-pair',
        workspace: 'root',
        resolvedPeer: { originalTarget: '19.0.0', reason: 'peer-range intersection', tuplesExplored: 6 },
      },
      {
        name: 'react-dom',
        success: true,
        from: '18.2.0',
        to: '18.3.1',
        linkedGroupId: 'react-pair',
        workspace: 'root',
      },
    ],
    skipped: [],
    failed: [],
  };
  const md = renderSummaryMarkdown(report, { toolVersion: '1.0.0' });
  assert.match(md, /### Peer-range resolutions/);
  assert.match(md, /\| `react` \| `react-pair` \| `19\.0\.0` \| `18\.3\.1` \| 6 \|/);
  assert.match(md, /peer-resolved from `19\.0\.0`/);
});

test('renderSummaryHtml: surfaces peer-range resolutions section', () => {
  const report = {
    upgraded: [
      {
        name: 'react',
        success: true,
        from: '18.2.0',
        to: '18.3.1',
        linkedGroupId: 'g',
        resolvedPeer: { originalTarget: '19.0.0', reason: 'r', tuplesExplored: 2 },
      },
    ],
    skipped: [],
    failed: [],
  };
  const html = renderSummaryHtml(report, { toolVersion: '1.0.0' });
  assert.match(html, /<h3>Peer-range resolutions<\/h3>/);
  assert.match(html, /<td><code>19\.0\.0<\/code><\/td>/);
});

test('writeSummary: writes to default file when no env/explicit', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-summary-'));
  const written = await writeSummary(fixtureReport(), {
    format: 'html',
    cwd: dir,
    toolVersion: '1.0.0',
    env: {},
  });
  assert.strictEqual(written, path.join(dir, 'dep-up-surgeon-summary.html'));
  const contents = await fs.readFile(written, 'utf8');
  assert.match(contents, /<section class="dep-up-surgeon-report">/);
});

test('renderSummaryHtml: severity chip + clickable advisory ID in security table', () => {
  const report = {
    upgraded: [
      {
        name: 'axios',
        success: true,
        from: '1.6.0',
        to: '1.7.4',
        workspace: 'root',
        security: {
          severity: 'high',
          ids: ['GHSA-wf5p-g6vw-rhxx'],
          url: 'https://github.com/advisories/GHSA-wf5p-g6vw-rhxx',
          title: 'SSRF in axios',
        },
      },
    ],
    skipped: [],
    failed: [],
  };
  const html = renderSummaryHtml(report, '1.0.0');
  assert.match(html, /<span class="chip chip-high">high<\/span>/);
  assert.match(
    html,
    /<a href="https:\/\/github\.com\/advisories\/GHSA-wf5p-g6vw-rhxx"[^>]*><code>GHSA-wf5p-g6vw-rhxx<\/code><\/a>/,
  );
});

test('renderSummaryHtml: peer-resolved + breaking chips in Upgraded notes', () => {
  const report = {
    upgraded: [
      {
        name: 'react',
        success: true,
        from: '18.2.0',
        to: '18.3.1',
        linkedGroupId: 'react-pair',
        workspace: 'root',
        resolvedPeer: { originalTarget: '19.0.0', reason: 'peer-range', tuplesExplored: 4 },
        changelog: {
          body: '### Breaking changes\n- removed legacy API',
          source: 'github-release',
          breaking: { hasBreaking: true, matchedLines: ['removed legacy API'] },
        },
      },
    ],
    skipped: [],
    failed: [],
  };
  const html = renderSummaryHtml(report, '1.0.0');
  assert.match(html, /<span class="chip chip-peer">peer-resolved<\/span>/);
  assert.match(html, /<span class="chip chip-breaking">breaking<\/span>/);
});

test('renderSummaryMarkdown: emits Lockfile fix section with merged rows', () => {
  const report = {
    upgraded: [],
    skipped: [],
    failed: [],
    lockfileFix: {
      status: 'ok',
      manager: 'npm',
      lockfile: 'package-lock.json',
      command: 'npm dedupe --no-audit --loglevel error',
      exitCode: 0,
      dedupeChanges: [
        { name: 'debug', change: 'merged', before: ['4.3.2', '4.3.4'], after: ['4.3.4'] },
        { name: 'ms', change: 'updated', before: ['2.1.2'], after: ['2.1.3'] },
      ],
      stale: [
        {
          name: 'lodash',
          installed: ['4.17.20'],
          latest: '4.17.21',
          majorBehind: 0,
          minorBehind: 0,
        },
      ],
    },
  };
  const md = renderSummaryMarkdown(report, '1.0.0');
  assert.match(md, /### Lockfile fix/);
  assert.match(md, /Ran `npm dedupe.*` — 1 merged, 1 updated, 1 stale transitive flagged/);
  assert.match(md, /\| `debug` \| merged \| `4\.3\.2`, `4\.3\.4` \| `4\.3\.4` \|/);
  assert.match(md, /\| `ms` \| updated \| `2\.1\.2` \| `2\.1\.3` \|/);
  assert.match(md, /<details><summary>Stale transitives \(1/);
});

test('renderSummaryHtml: lockfile-fix renders chips + stale details block', () => {
  const report = {
    upgraded: [],
    skipped: [],
    failed: [],
    lockfileFix: {
      status: 'ok',
      manager: 'pnpm',
      lockfile: 'pnpm-lock.yaml',
      command: 'pnpm dedupe',
      exitCode: 0,
      dedupeChanges: [
        { name: 'debug', change: 'merged', before: ['4.3.2', '4.3.4'], after: ['4.3.4'] },
      ],
      stale: [
        {
          name: 'left-pad',
          installed: ['1.1.0'],
          latest: '1.3.0',
          majorBehind: 0,
          minorBehind: 2,
        },
      ],
    },
  };
  const html = renderSummaryHtml(report, '1.0.0');
  assert.match(html, /<h3>Lockfile fix<\/h3>/);
  assert.match(html, /<span class="chip chip-peer">merged<\/span>/);
  assert.match(html, /<details><summary>Stale transitives \(1/);
  assert.match(html, /<code>left-pad<\/code>/);
});

test('renderSummaryMarkdown: lockfile-fix skipped reports reason', () => {
  const md = renderSummaryMarkdown(
    {
      upgraded: [],
      skipped: [],
      failed: [],
      lockfileFix: {
        status: 'skipped',
        manager: 'yarn',
        lockfile: 'yarn.lock',
        skipReason: 'unsupported',
        dedupeChanges: [],
        stale: [],
      },
    },
    '1.0.0',
  );
  assert.match(md, /Skipped — package manager has no dedupe subcommand/);
});
