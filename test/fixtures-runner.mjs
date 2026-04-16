/**
 * Integration tests: run `dep-up-surgeon --dry-run --json` in each fixture directory.
 * Requires network (pacote → npm registry) and `npm run build` first.
 */
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'dist/cli.js');

function runFixture(relDir, extraArgs = []) {
  const cwd = path.join(root, 'test/fixtures', relDir);
  if (!existsSync(path.join(cwd, 'package.json'))) {
    throw new Error(`Missing fixture: ${cwd}`);
  }
  const r = spawnSync(process.execPath, [cli, '--dry-run', '--json', ...extraArgs], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: { ...process.env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', cwd };
}

function parseReport(stdout) {
  const t = stdout.trim();
  const start = t.indexOf('{');
  if (start === -1) {
    throw new Error(`No JSON object in stdout:\n${t.slice(0, 500)}`);
  }
  return JSON.parse(t.slice(start));
}

test('CLI binary exists', () => {
  assert.ok(existsSync(cli), `Run npm run build first (missing ${cli})`);
});

test('fixture 01-minimal-single: dry-run exits 0 and reports groups', () => {
  const { status, stdout, stderr } = runFixture('01-minimal-single');
  assert.strictEqual(stderr, '', `stderr: ${stderr}`);
  assert.strictEqual(status, 0, stdout);
  const j = parseReport(stdout);
  assert.ok(Array.isArray(j.groups), 'groups array');
  assert.ok(j.groups.length >= 1);
  const names = new Set(j.groups.flatMap((g) => g.packages ?? []));
  assert.ok(names.has('lodash'));
});

test('fixture 02-react-dom-types: has react-related packages in plan', () => {
  const { status, stdout, stderr } = runFixture('02-react-dom-types');
  assert.strictEqual(stderr, '');
  assert.strictEqual(status, 0, stdout);
  const j = parseReport(stdout);
  const names = new Set(j.groups.flatMap((g) => g.packages ?? []));
  assert.ok(names.has('react'));
  assert.ok(names.has('react-dom'));
});

test('fixture 03-custom-linked-groups: custom-bundle forces semver+chalk', () => {
  const { status, stdout } = runFixture('03-custom-linked-groups');
  assert.strictEqual(status, 0, stdout);
  const j = parseReport(stdout);
  const custom = j.groups.find((g) => g.id === 'custom-bundle');
  assert.ok(custom, `groups: ${JSON.stringify(j.groups.map((g) => g.id))}`);
  assert.deepStrictEqual(new Set(custom.packages), new Set(['semver', 'chalk']));
});

test('fixture 04-workspace-non-registry: registry dep still listed', () => {
  const { status, stdout } = runFixture('04-workspace-non-registry');
  assert.strictEqual(status, 0, stdout);
  const j = parseReport(stdout);
  const names = new Set(j.groups.flatMap((g) => g.packages ?? []));
  assert.ok(names.has('left-pad'));
});

test('fixture 05-root-name-app: completes (root name does not crash)', () => {
  const { status, stdout, stderr } = runFixture('05-root-name-app');
  assert.strictEqual(status, 0, `stderr: ${stderr}\n${stdout}`);
  const j = parseReport(stdout);
  assert.ok(Array.isArray(j.groups));
});

test('fixture 06-ignore-rc: lodash ignored', () => {
  const { status, stdout } = runFixture('06-ignore-rc');
  assert.strictEqual(status, 0, stdout);
  const j = parseReport(stdout);
  assert.ok(j.ignored.includes('lodash'));
});

test('fixture 07-two-unrelated: at least two groups (peer-only graph)', () => {
  const { status, stdout } = runFixture('07-two-unrelated');
  assert.strictEqual(status, 0, stdout);
  const j = parseReport(stdout);
  assert.ok(
    j.groups.length >= 2,
    `expected multiple singleton/multi groups, got ${j.groups.length}: ${JSON.stringify(j.groups)}`,
  );
});

test('fixture 01 with --link-groups none: one group per package', () => {
  const { status, stdout } = runFixture('01-minimal-single', ['--link-groups', 'none']);
  assert.strictEqual(status, 0, stdout);
  const j = parseReport(stdout);
  assert.strictEqual(j.groups.length, 1);
  assert.strictEqual(j.groups[0].packages.length, 1);
});

test('fixture 08-next-hello-world: Next.js + React stack (from next.js hello-world example)', () => {
  const { status, stdout, stderr } = runFixture('08-next-hello-world');
  assert.strictEqual(stderr, '');
  assert.strictEqual(status, 0, stdout);
  const j = parseReport(stdout);
  const names = new Set(j.groups.flatMap((g) => g.packages ?? []));
  assert.ok(names.has('next'));
  assert.ok(names.has('react'));
  assert.ok(names.has('react-dom'));
});

test('fixture 09-vite-vue-ts: Vite + Vue (from vite template-vue-ts)', () => {
  const { status, stdout, stderr } = runFixture('09-vite-vue-ts');
  assert.strictEqual(stderr, '');
  assert.strictEqual(status, 0, stdout);
  const j = parseReport(stdout);
  const names = new Set(j.groups.flatMap((g) => g.packages ?? []));
  assert.ok(names.has('vue'));
  assert.ok(names.has('vite'));
});

test('fixture 10-astro-minimal: Astro minimal example', () => {
  const { status, stdout, stderr } = runFixture('10-astro-minimal');
  assert.strictEqual(stderr, '');
  assert.strictEqual(status, 0, stdout);
  const j = parseReport(stdout);
  const names = new Set(j.groups.flatMap((g) => g.packages ?? []));
  assert.ok(names.has('astro'));
});

test('fixture 11-nest-sample-cats: NestJS sample (trimmed)', () => {
  const { status, stdout, stderr } = runFixture('11-nest-sample-cats');
  assert.strictEqual(stderr, '');
  assert.strictEqual(status, 0, stdout);
  const j = parseReport(stdout);
  const names = new Set(j.groups.flatMap((g) => g.packages ?? []));
  assert.ok(names.has('@nestjs/core'));
  assert.ok(names.has('rxjs'));
});

test('fixture 12-express-style: Express-style runtime dep subset', () => {
  const { status, stdout, stderr } = runFixture('12-express-style');
  assert.strictEqual(stderr, '');
  assert.strictEqual(status, 0, stdout);
  const j = parseReport(stdout);
  const names = new Set(j.groups.flatMap((g) => g.packages ?? []));
  assert.ok(names.has('debug'));
  assert.ok(names.has('body-parser'));
  assert.ok(j.groups.length >= 1);
});

test('fixture 13-random: larger React + Vite + Tailwind style app', () => {
  const { status, stdout, stderr } = runFixture('13-random');
  assert.strictEqual(stderr, '');
  assert.strictEqual(status, 0, stdout);
  const j = parseReport(stdout);
  const names = new Set(j.groups.flatMap((g) => g.packages ?? []));
  assert.ok(names.has('react'));
  assert.ok(names.has('vite'));
  assert.ok(names.has('typescript'));
  assert.ok(names.has('tailwindcss'));
  assert.ok(j.groups.length >= 1);
});
