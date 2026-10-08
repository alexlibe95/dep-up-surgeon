/**
 * Unit tests for src/cli/doctor.ts and src/cli/doctorRenderer.ts.
 *
 * We exercise doctor against real temp directories with hand-crafted `package.json` /
 * lockfile / policy fixtures. External commands (validator, audit, peer-scan) are skipped
 * via the opt-out flags so tests run deterministically in CI without network, node_modules,
 * or a shelled package manager.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { runDoctor, peerScanCommandFor } = await import(path.join(root, 'dist/cli/doctor.js'));
const { doctorExitCode, renderDoctorHuman } = await import(
  path.join(root, 'dist/cli/doctorRenderer.js')
);

async function mkProject(entries) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-doctor-'));
  for (const [rel, contents] of Object.entries(entries)) {
    const abs = path.join(dir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, contents);
  }
  return dir;
}

// Single set of skip flags so every test disables the slow / external checks consistently.
// Tests that want to exercise those checks can override individual fields.
const ALL_SKIPS = {
  skipValidator: true,
  skipAudit: true,
  skipPeerScan: true,
  skipStaleScan: true,
};

function pick(report, id) {
  const hit = report.checks.find((c) => c.id === id);
  assert.ok(hit, `doctor report missing check ${id}`);
  return hit;
}

test('doctor: missing package.json → manager check red, exit code 2, nothing else runs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-doctor-empty-'));
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS });
  // Node version check runs even without a readable package.json and reports yellow.
  const node = pick(report, 'node-version');
  assert.strictEqual(node.status, 'yellow');
  const manager = pick(report, 'manager');
  assert.strictEqual(manager.status, 'red');
  assert.match(manager.message, /No readable `package\.json`.*file not found/);
  assert.strictEqual(report.overall, 'red');
  assert.strictEqual(doctorExitCode(report, false), 2);
  // Checks that shell out (or would read a parent project) never run against a non-project.
  assert.deepStrictEqual(report.checks.map((c) => c.id), ['node-version', 'manager']);
});

test('doctor: unparseable package.json → manager check red', async () => {
  const dir = await mkProject({ 'package.json': '{ "name": "demo", ' });
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS });
  assert.strictEqual(pick(report, 'manager').status, 'red');
  assert.strictEqual(doctorExitCode(report, false), 2);
});

test('doctor: engines.node mismatch → red with hint', async () => {
  const dir = await mkProject({
    'package.json': JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      engines: { node: '>=99.0.0' },
    }),
  });
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS });
  const node = pick(report, 'node-version');
  assert.strictEqual(node.status, 'red');
  assert.match(node.message, /does NOT satisfy/);
  assert.ok(node.hint && /nvm use/.test(node.hint));
  assert.strictEqual(report.overall, 'red');
});

test('doctor: engines.node satisfied → green', async () => {
  const dir = await mkProject({
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', engines: { node: '*' } }),
  });
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS });
  const node = pick(report, 'node-version');
  assert.strictEqual(node.status, 'green');
});

test('doctor: lockfile parsed — reports package count', async () => {
  const dir = await mkProject({
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'package-lock.json': JSON.stringify({
      lockfileVersion: 2,
      packages: {
        '': { name: 'demo' },
        'node_modules/axios': { version: '1.6.4' },
        'node_modules/debug': { version: '4.3.4' },
      },
    }),
  });
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS });
  const lock = pick(report, 'lockfile');
  assert.strictEqual(lock.status, 'green');
  assert.match(lock.message, /2 packages tracked/);
});

test('doctor: no lockfile → yellow + hint', async () => {
  const dir = await mkProject({
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
  });
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS });
  const lock = pick(report, 'lockfile');
  assert.strictEqual(lock.status, 'yellow');
  assert.match(lock.hint, /install/);
});

test('doctor: ambiguous lockfiles → manager yellow with issues list', async () => {
  const dir = await mkProject({
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'package-lock.json': '{"lockfileVersion":2,"packages":{}}',
    'yarn.lock': '# yarn lockfile\n',
  });
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS });
  const mgr = pick(report, 'manager');
  assert.strictEqual(mgr.status, 'yellow');
  assert.match(mgr.message, /2 lockfiles present/);
});

test('doctor: bun.lock / npm-shrinkwrap.json count toward ambiguous lockfiles', async () => {
  const bunAndNpm = await mkProject({
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'package-lock.json': '{"lockfileVersion":3,"packages":{}}',
    'bun.lock': '{ "lockfileVersion": 1, "workspaces": { "": { "name": "demo" } }, "packages": {} }\n',
  });
  const r1 = await runDoctor({ cwd: bunAndNpm, toolVersion: 'x', ...ALL_SKIPS });
  assert.match(pick(r1, 'manager').message, /2 lockfiles present/);

  const shrinkwrap = await mkProject({
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'package-lock.json': '{"lockfileVersion":3,"packages":{}}',
    'npm-shrinkwrap.json': '{"lockfileVersion":3,"packages":{}}',
  });
  const r2 = await runDoctor({ cwd: shrinkwrap, toolVersion: 'x', ...ALL_SKIPS });
  assert.match(pick(r2, 'manager').message, /2 lockfiles present/);
});

test('doctor: --package-manager override reaches project detection', async () => {
  const dir = await mkProject({
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'package-lock.json': JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { name: 'demo' }, 'node_modules/axios': { version: '1.6.4' } },
    }),
  });
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', manager: 'pnpm', ...ALL_SKIPS });
  const mgr = pick(report, 'manager');
  assert.strictEqual(mgr.data.manager, 'pnpm');
  assert.strictEqual(mgr.data.source, 'cli');
  const lock = pick(report, 'lockfile');
  assert.strictEqual(lock.status, 'yellow');
  assert.match(lock.message, /package-lock\.json.*pnpm/);
});

test('peerScanCommandFor: never runs an install that can touch the lockfile, node_modules or scripts', () => {
  assert.deepStrictEqual(peerScanCommandFor('npm'), { bin: 'npm', args: ['ls', '--all', '--parseable'] });
  // `pnpm install --frozen-lockfile --lockfile-only` still rewrites pnpm-lock.yaml.
  assert.match(peerScanCommandFor('pnpm').skipped, /read-only.*pnpm-lock\.yaml/);
  assert.deepStrictEqual(peerScanCommandFor('yarn', 1), { bin: 'yarn', args: ['check'] });
  assert.match(peerScanCommandFor('yarn', 4).skipped, /read-only/);
  assert.match(peerScanCommandFor('bun').skipped, /read-only/);
});

test('doctor: bun peer scan is reported as skipped instead of running `bun install`', async () => {
  const dir = await mkProject({
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'bun.lock': '{ "lockfileVersion": 1, "workspaces": { "": { "name": "demo" } }, "packages": {} }\n',
  });
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS, skipPeerScan: false });
  const peers = pick(report, 'peer-deps');
  assert.strictEqual(peers.status, 'green');
  assert.match(peers.message, /skipped/i);
  assert.match(peers.message, /read-only/);
});

/**
 * Run `fn` with `PATH` pointing at a temp dir holding the given fake executables (`#!/bin/sh`
 * bodies). `inherit` keeps the real PATH after it (for `cat` & co.); without it nothing else
 * resolves, so a missing binary really is missing.
 */
async function withFakeBins(scripts, fn, { inherit = true } = {}) {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-doctor-bin-'));
  for (const [name, body] of Object.entries(scripts)) {
    await fs.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  }
  const realPath = process.env.PATH;
  process.env.PATH = inherit ? `${bin}${path.delimiter}${realPath}` : bin;
  try {
    return await fn(bin);
  } finally {
    process.env.PATH = realPath;
  }
}

const unixOnly = { skip: process.platform === 'win32' ? 'uses #!/bin/sh fakes' : false };

test('doctor: pnpm peer scan is skipped and never runs pnpm (it would rewrite pnpm-lock.yaml)', unixOnly, async () => {
  const lockfile = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n";
  const dir = await mkProject({
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'pnpm-lock.yaml': lockfile,
  });
  const marker = path.join(dir, 'pnpm-was-run');
  await withFakeBins({ pnpm: `touch "${marker}"; echo "lockfileVersion: 'rewritten'" > pnpm-lock.yaml` }, async () => {
    const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS, skipPeerScan: false });
    const peers = pick(report, 'peer-deps');
    assert.strictEqual(peers.status, 'green');
    assert.match(peers.message, /skipped.*pnpm.*read-only/i);
  });
  await assert.rejects(fs.access(marker), 'doctor must not spawn pnpm');
  assert.strictEqual(await fs.readFile(path.join(dir, 'pnpm-lock.yaml'), 'utf8'), lockfile);
});

async function yarnProject() {
  return mkProject({
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { 'left-pad': '^1.3.0' } }),
    'yarn.lock': '"left-pad@^1.3.0":\n  version "1.3.0"\n',
    // Installed, so `dependencies-installed` stays green and only the peer scan decides.
    'node_modules/left-pad/package.json': JSON.stringify({ name: 'left-pad', version: '1.3.0' }),
  });
}

/**
 * Fake yarn: `--version` answers `version` (exits 1 when null), `yarn check` prints `out` to
 * stderr and exits `code`.
 */
async function fakeYarn(out, code, version = '1.22.22') {
  const outFile = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'dus-yarn-out-')), 'check.txt');
  await fs.writeFile(outFile, out);
  return [
    'case "$1" in',
    version ? `  --version) echo ${version} ;;` : '  --version) exit 1 ;;',
    `  check) cat "${outFile}" >&2; exit ${code} ;;`,
    'esac',
  ].join('\n');
}

test('doctor: yarn 1 `yarn check` errors (not installed / wrong version / lockfile pattern) → red', unixOnly, async () => {
  const dir = await yarnProject();
  const out = [
    'error "left-pad" not installed',
    'error "react-dom#react@^18.0.0" doesn\'t satisfy found match of "react@17.0.2"',
    'error "scheduler" is wrong version: expected "0.23.0", got "0.20.2"',
    'error Lockfile does not contain pattern: "lodash@^4.17.21"',
    'error Found 4 errors.',
  ].join('\n');
  await withFakeBins({ yarn: await fakeYarn(out, 1) }, async () => {
    const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS, skipPeerScan: false });
    const peers = pick(report, 'peer-deps');
    assert.strictEqual(peers.status, 'red', peers.message);
    assert.strictEqual(peers.data.total, 4);
    assert.match(peers.message, /4 peer \/ missing dep warnings already present \(4 fatal\)/);
  });
});

test('doctor: yarn `incorrect peer dependency` warning with exit 0 → yellow', unixOnly, async () => {
  const dir = await yarnProject();
  const out = 'warning " > react-dom@18.2.0" has incorrect peer dependency "react@^18.2.0".';
  await withFakeBins({ yarn: await fakeYarn(out, 0) }, async () => {
    const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS, skipPeerScan: false });
    assert.strictEqual(pick(report, 'peer-deps').status, 'yellow');
  });
});

test('doctor: a peer scan that fails without recognised warnings is yellow, not green', unixOnly, async () => {
  const dir = await yarnProject();
  // Berry answering `yarn check` (its version probe failed, so doctor treated it as classic).
  const usageError = 'Usage Error: Couldn\'t find a script named "check".';
  await withFakeBins({ yarn: await fakeYarn(usageError, 1, null) }, async () => {
    const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS, skipPeerScan: false });
    const peers = pick(report, 'peer-deps');
    assert.strictEqual(peers.status, 'yellow');
    assert.match(peers.message, /Peer scan could not run: `yarn check` exited 1 \(Usage Error/);
    assert.strictEqual(doctorExitCode(report, true), 1);
  });

  // No yarn binary at all (ENOENT).
  await withFakeBins({}, async () => {
    const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS, skipPeerScan: false });
    const peers = pick(report, 'peer-deps');
    assert.strictEqual(peers.status, 'yellow');
    assert.match(peers.message, /Peer scan could not run: `yarn check` failed \(.*ENOENT/);
  }, { inherit: false });
});

test('doctor: binary bun.lockb is green ("not inspected"), so --strict passes', async () => {
  const dir = await mkProject({
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    'bun.lockb': Buffer.from([0x23, 0x21, 0x2f, 0x75, 0x00, 0xff, 0xfe, 0x00]),
  });
  // The stale scan runs too: it must not try (and fail) to parse the binary file.
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS, skipStaleScan: false });
  const lock = pick(report, 'lockfile');
  assert.strictEqual(lock.status, 'green');
  assert.match(lock.message, /bun\.lockb.*binary lockfile, not inspected/);
  const stale = pick(report, 'stale-transitives');
  assert.strictEqual(stale.status, 'green');
  assert.match(stale.message, /binary lockfile/);
  assert.strictEqual(report.overall, 'green');
  assert.strictEqual(doctorExitCode(report, true), 0);
});

test('doctor: workspace-coherence green when every declared member resolves', async () => {
  const dir = await mkProject({
    'package.json': JSON.stringify({
      name: 'monorepo',
      version: '1.0.0',
      private: true,
      workspaces: ['packages/*'],
    }),
    'packages/real/package.json': JSON.stringify({ name: '@demo/real', version: '1.0.0' }),
  });
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS });
  const ws = pick(report, 'workspace-coherence');
  assert.strictEqual(ws.status, 'green');
  assert.match(ws.message, /1 workspace member\(s\) resolved/);
});

test('doctor: workspace-coherence yellow for a declared dir without package.json', async () => {
  const dir = await mkProject({
    'package.json': JSON.stringify({
      name: 'monorepo',
      version: '1.0.0',
      private: true,
      workspaces: ['packages/*'],
    }),
    'packages/real/package.json': JSON.stringify({ name: '@demo/real', version: '1.0.0' }),
    // Matched by the glob, silently skipped by member detection.
    'packages/ghost/README.md': '# ghost\n',
  });
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS });
  const ws = pick(report, 'workspace-coherence');
  assert.strictEqual(ws.status, 'yellow');
  assert.match(ws.message, /packages\/ghost \(missing-package-json\)/);
  assert.deepStrictEqual(ws.data.problems, [{ dir: path.join('packages', 'ghost'), problem: 'missing-package-json' }]);
});

test('doctor: workspace-coherence red for a member package.json without a name', async () => {
  const dir = await mkProject({
    'package.json': JSON.stringify({
      name: 'monorepo',
      version: '1.0.0',
      private: true,
      workspaces: ['packages/*'],
    }),
    'packages/real/package.json': JSON.stringify({ name: '@demo/real', version: '1.0.0' }),
    'packages/nameless/package.json': JSON.stringify({ version: '1.0.0' }),
  });
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS });
  const ws = pick(report, 'workspace-coherence');
  assert.strictEqual(ws.status, 'red');
  assert.match(ws.message, /packages\/nameless \(missing-name\)/);
});

test('doctor: policy warnings bubble up as yellow', async () => {
  const dir = await mkProject({
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0' }),
    // Deliberately malformed: `freeze` should be an array; a scalar number triggers a
    // parse warning without throwing.
    '.dep-up-surgeon.policy.json': JSON.stringify({ freeze: 42 }),
  });
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS });
  const policy = pick(report, 'policy');
  // Either 'green' (if parser ignores) or 'yellow' (if it warns). Either is acceptable; what
  // we want to ensure is the check is defensive and doesn't throw.
  assert.ok(['green', 'yellow'].includes(policy.status));
});

test('doctor: skipValidator honored — no exec, green', async () => {
  const dir = await mkProject({
    'package.json': JSON.stringify({
      name: 'demo',
      version: '1.0.0',
      scripts: { test: 'exit 1' },
    }),
  });
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS });
  const v = pick(report, 'preflight-validator');
  assert.strictEqual(v.status, 'green');
  assert.match(v.message, /Skipped via/);
});

test('doctor: declared dependencies without node_modules → red with an install hint', async () => {
  const dir = await mkProject({
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', dependencies: { next: '16.0.0' } }),
  });
  const missing = pick(await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS }), 'dependencies-installed');
  assert.strictEqual(missing.status, 'red');
  assert.match(missing.hint ?? '', /npm install/);

  await fs.mkdir(path.join(dir, 'node_modules'));
  const installed = pick(await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS }), 'dependencies-installed');
  assert.strictEqual(installed.status, 'green');
});

test('doctor: overall aggregation matches worst status', async () => {
  // yellow-only run (lockfile missing) → overall yellow.
  const dir = await mkProject({
    'package.json': JSON.stringify({ name: 'demo', version: '1.0.0', engines: { node: '*' } }),
  });
  const report = await runDoctor({ cwd: dir, toolVersion: 'x', ...ALL_SKIPS });
  assert.strictEqual(report.overall, 'yellow');
  assert.ok(report.counts.yellow >= 1);
  assert.strictEqual(report.counts.red, 0);
});

test('doctorExitCode: maps statuses correctly', () => {
  assert.strictEqual(doctorExitCode({ overall: 'green', counts: { green: 1, yellow: 0, red: 0 }, checks: [], cwd: '.', toolVersion: 'x' }, false), 0);
  assert.strictEqual(doctorExitCode({ overall: 'yellow', counts: { green: 0, yellow: 1, red: 0 }, checks: [], cwd: '.', toolVersion: 'x' }, false), 0);
  assert.strictEqual(doctorExitCode({ overall: 'yellow', counts: { green: 0, yellow: 1, red: 0 }, checks: [], cwd: '.', toolVersion: 'x' }, true), 1);
  assert.strictEqual(doctorExitCode({ overall: 'red', counts: { green: 0, yellow: 0, red: 1 }, checks: [], cwd: '.', toolVersion: 'x' }, false), 2);
  assert.strictEqual(doctorExitCode({ overall: 'red', counts: { green: 0, yellow: 0, red: 1 }, checks: [], cwd: '.', toolVersion: 'x' }, true), 2);
});

test('renderDoctorHuman: produces badges, hints on non-green, counts footer', () => {
  const report = {
    cwd: '/repo',
    toolVersion: '1.0.0',
    overall: 'yellow',
    counts: { green: 1, yellow: 1, red: 0 },
    checks: [
      { id: 'a', label: 'A check', status: 'green', message: 'ok' },
      { id: 'b', label: 'B check', status: 'yellow', message: 'meh', hint: 'fix me' },
    ],
  };
  const human = renderDoctorHuman(report);
  assert.match(human, /dep-up-surgeon doctor/);
  assert.match(human, /in \/repo/);
  assert.match(human, /A check/);
  assert.match(human, /hint: fix me/);
  assert.match(human, /overall: YELLOW/);
  assert.match(human, /1 green/);
  assert.match(human, /1 yellow/);
  assert.match(human, /0 red/);
});
