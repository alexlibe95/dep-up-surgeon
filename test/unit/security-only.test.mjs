/**
 * Regression harness for the `--security-only` upgrade path.
 *
 * Covers the three phases a real `--security-only` run goes through:
 *
 *   1. `npm audit --json` is parsed into `SecurityAdvisory[]` and the right packages are
 *      picked up (no false negatives on `fixture-security-only`'s tree).
 *   2. `--min-severity <level>` filters the advisory set through `filterAdvisoriesBySeverity`
 *      (the helper `cli.ts` uses) and produces the exact `restrictToNames` membership.
 *   3. A full `runUpgradeFlow` pass with `restrictToNames` seeded from (2) narrows the plan to
 *      just the audited packages and — when the validator fails on the recommended version —
 *      fires the rollback path so `package.json` reverts to the pre-upgrade range.
 *
 * All tests are hermetic: no `npm install`, no registry access, no `npm audit` subprocess.
 *   - `runAudit` is driven via its built-in `exec` injection with the canned blob in
 *     `test/fixtures/14-security-only/audit-mixed-severities.json`.
 *   - `RegistryCache.latest` is pre-seeded so `fetchLatestVersion` never hits the wire.
 *   - The install step is replaced by the `UpgradeEngineOptions.installer` hook — a tiny stub
 *     that mirrors `runInstall`'s contract and always reports success.
 *   - The validator is a node one-liner that passes or fails based on the axios range found
 *     in `package.json`, so we can deterministically force a rollback.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..', '..');
const fixtureDir = path.join(root, 'test', 'fixtures', '14-security-only');

const audit = await import(path.join(root, 'dist', 'core', 'audit.js'));
const upgrader = await import(path.join(root, 'dist', 'core', 'upgrader.js'));
const concurrency = await import(path.join(root, 'dist', 'utils', 'concurrency.js'));

const {
  runAudit,
  filterAdvisoriesBySeverity,
  parseMinSeverity,
  parseNpmLikeAudit,
} = audit;
const { runUpgradeFlow } = upgrader;
const { createRegistryCache } = concurrency;

// Read the canned audit blob once and reuse it everywhere. Storing it on disk (vs inline) keeps
// the fixture browsable + shareable with the `test/fixtures` docs and matches the 01..13 layout.
const AUDIT_JSON = await fs.readFile(
  path.join(fixtureDir, 'audit-mixed-severities.json'),
  'utf8',
);

// ---------------------------------------------------------------------------
// Phase 1: audit parsing — canned JSON → SecurityAdvisory[]
// ---------------------------------------------------------------------------

test('audit: canned npm blob yields exactly the three vulnerable packages', async () => {
  let invokedBin = '';
  let invokedArgs = [];
  const exec = async (bin, args) => {
    invokedBin = bin;
    invokedArgs = args;
    return { stdout: AUDIT_JSON, exitCode: 1 };
  };
  const result = await runAudit({ manager: 'npm', cwd: fixtureDir, exec });
  assert.strictEqual(result.error, undefined, `unexpected error: ${result.error}`);
  assert.strictEqual(invokedBin, 'npm');
  assert.deepStrictEqual(invokedArgs, ['audit', '--json']);
  const names = result.advisories.map((a) => a.name).sort();
  assert.deepStrictEqual(names, ['axios', 'lodash', 'minimist']);
  // fixAvailable.version on every entry → recommendedVersion should be populated for each.
  const axiosAdv = result.advisories.find((a) => a.name === 'axios');
  assert.strictEqual(axiosAdv.severity, 'high');
  assert.strictEqual(axiosAdv.recommendedVersion, '1.6.0');
  assert.ok(axiosAdv.ids.includes('GHSA-wf5p-g6vw-rhxx'));
});

test('audit: parseNpmLikeAudit on the canned blob reproduces the same set as runAudit', () => {
  const advisories = parseNpmLikeAudit(AUDIT_JSON);
  assert.strictEqual(advisories.length, 3);
  const bySev = Object.fromEntries(advisories.map((a) => [a.name, a.severity]));
  assert.deepStrictEqual(bySev, { axios: 'high', lodash: 'moderate', minimist: 'low' });
});

// ---------------------------------------------------------------------------
// Phase 2: --min-severity filter
// ---------------------------------------------------------------------------

test('parseMinSeverity: accepts canonical values case-insensitively', () => {
  assert.strictEqual(parseMinSeverity('low'), 'low');
  assert.strictEqual(parseMinSeverity('MODERATE'), 'moderate');
  assert.strictEqual(parseMinSeverity('  High  '), 'high');
  assert.strictEqual(parseMinSeverity('critical'), 'critical');
});

test('parseMinSeverity: rejects unknown strings so CLI can error loudly', () => {
  assert.strictEqual(parseMinSeverity(''), undefined);
  assert.strictEqual(parseMinSeverity('severe'), undefined);
  assert.strictEqual(parseMinSeverity('none'), undefined);
  assert.strictEqual(parseMinSeverity(undefined), undefined);
});

test('filterAdvisoriesBySeverity: threshold ladder drops lower tiers correctly', () => {
  const advisories = parseNpmLikeAudit(AUDIT_JSON);

  const low = filterAdvisoriesBySeverity(advisories, 'low');
  assert.deepStrictEqual(
    low.map((a) => a.name).sort(),
    ['axios', 'lodash', 'minimist'],
    'low threshold admits everything',
  );

  const moderate = filterAdvisoriesBySeverity(advisories, 'moderate');
  assert.deepStrictEqual(
    moderate.map((a) => a.name).sort(),
    ['axios', 'lodash'],
    'moderate drops the low-severity minimist',
  );

  const high = filterAdvisoriesBySeverity(advisories, 'high');
  assert.deepStrictEqual(
    high.map((a) => a.name),
    ['axios'],
    'high keeps only axios (high)',
  );

  const critical = filterAdvisoriesBySeverity(advisories, 'critical');
  assert.deepStrictEqual(critical, [], 'no critical advisories in the canned blob');
});

// ---------------------------------------------------------------------------
// Phase 3: restrictToNames narrows the plan in dry-run
// ---------------------------------------------------------------------------

async function stageFixture(srcDir) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-secure-'));
  const src = await fs.readFile(path.join(srcDir, 'package.json'), 'utf8');
  await fs.writeFile(path.join(tmp, 'package.json'), src);
  return tmp;
}

test('runUpgradeFlow: restrictToNames=audit-filtered set ignores every non-audited dep', async () => {
  const advisories = filterAdvisoriesBySeverity(parseNpmLikeAudit(AUDIT_JSON), 'low');
  const restrictToNames = new Set(advisories.map((a) => a.name));

  const dir = await stageFixture(fixtureDir);
  const cache = createRegistryCache();
  // Dry-run still calls fetchLatestVersion → seed so we never hit pacote.
  cache.latest.set('axios', Promise.resolve('1.6.0'));
  cache.latest.set('lodash', Promise.resolve('4.17.21'));
  cache.latest.set('minimist', Promise.resolve('1.2.8'));
  cache.latest.set('left-pad', Promise.resolve('1.3.0'));

  const report = await runUpgradeFlow({
    cwd: dir,
    dryRun: true,
    interactive: false,
    force: false,
    jsonOutput: true,
    ignore: new Set(),
    fallbackStrategy: 'highest-stable',
    linkGroups: 'off',
    linkedGroupsConfig: [],
    validate: { skip: true },
    restrictToNames,
    registryCache: cache,
  });

  // left-pad is the only clean dep and MUST end up in `ignored` (restrict set excluded it).
  assert.ok(
    report.ignored.includes('left-pad'),
    `left-pad must be ignored when --security-only drops it: ignored=${JSON.stringify(report.ignored)}`,
  );

  // Conversely, every audited package should still appear in the plan (either in groupPlan
  // or as a future upgrade row in dry-run mode). Group names are a superset of upgradable deps.
  const planned = new Set((report.groupPlan ?? []).flatMap((g) => g.packages ?? []));
  for (const name of ['axios', 'lodash', 'minimist']) {
    assert.ok(
      planned.has(name),
      `audited package "${name}" must stay in the plan; groupPlan=${JSON.stringify(report.groupPlan)}`,
    );
  }
  assert.ok(
    !planned.has('left-pad'),
    `non-audited "left-pad" must NOT appear in the plan`,
  );
});

test('runUpgradeFlow: --min-severity=high synthesises restrictToNames={axios} only', async () => {
  const filtered = filterAdvisoriesBySeverity(parseNpmLikeAudit(AUDIT_JSON), 'high');
  const restrictToNames = new Set(filtered.map((a) => a.name));
  assert.deepStrictEqual([...restrictToNames], ['axios']);

  const dir = await stageFixture(fixtureDir);
  const cache = createRegistryCache();
  cache.latest.set('axios', Promise.resolve('1.6.0'));
  cache.latest.set('lodash', Promise.resolve('4.17.21'));
  cache.latest.set('minimist', Promise.resolve('1.2.8'));
  cache.latest.set('left-pad', Promise.resolve('1.3.0'));

  const report = await runUpgradeFlow({
    cwd: dir,
    dryRun: true,
    interactive: false,
    force: false,
    jsonOutput: true,
    ignore: new Set(),
    fallbackStrategy: 'highest-stable',
    linkGroups: 'off',
    linkedGroupsConfig: [],
    validate: { skip: true },
    restrictToNames,
    registryCache: cache,
  });

  // Everything except axios must be ignored — lodash + minimist + left-pad.
  for (const name of ['lodash', 'minimist', 'left-pad']) {
    assert.ok(
      report.ignored.includes(name),
      `high threshold must drop "${name}"; ignored=${JSON.stringify(report.ignored)}`,
    );
  }
  const planned = new Set((report.groupPlan ?? []).flatMap((g) => g.packages ?? []));
  assert.ok(planned.has('axios'));
  assert.ok(!planned.has('lodash'));
  assert.ok(!planned.has('minimist'));
});

// ---------------------------------------------------------------------------
// Phase 4: rollback when the validator fails on the advisory's recommended version
// ---------------------------------------------------------------------------

/**
 * Installer stub that records every call and mirrors a successful `<mgr> install`. Returning
 * `ok: true` with an empty `output` is the cleanest way to exercise the engine's rollback path
 * WITHOUT triggering the peer / install-failure branches.
 */
function makeInstaller() {
  const calls = [];
  const installer = async (cwd, manager) => {
    calls.push({ cwd, manager });
    return { ok: true, output: '', exitCode: 0, command: `${manager} install`, filtered: false };
  };
  return { installer, calls };
}

test('runUpgradeFlow: validator fail on recommended version triggers package.json rollback', async () => {
  const dir = await stageFixture(fixtureDir);
  const pkgPath = path.join(dir, 'package.json');
  const before = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  const originalAxios = before.dependencies.axios;
  assert.strictEqual(originalAxios, '^0.21.0', 'fixture invariant');

  const { installer, calls } = makeInstaller();

  // Validator: node one-liner that fails (exit 1) when axios has been bumped to anything in the
  // 1.x line — exactly the advisory-recommended version. When the range is restored to ^0.21.0
  // the validator passes. This is the signal the engine uses to decide whether to roll back.
  const validateCmd = `node -e "const p=require('${pkgPath.replace(/\\/g, '\\\\')}');if(/^[\\^~]?1\\./.test(p.dependencies.axios)){process.exit(1)}"`;

  const cache = createRegistryCache();
  cache.latest.set('axios', Promise.resolve('1.6.0'));

  const report = await runUpgradeFlow({
    cwd: dir,
    dryRun: false,
    interactive: false,
    force: false,
    jsonOutput: true,
    ignore: new Set(),
    fallbackStrategy: 'highest-stable',
    linkGroups: 'off',
    linkedGroupsConfig: [],
    validate: { command: validateCmd, source: 'cli' },
    restrictToNames: new Set(['axios']),
    registryCache: cache,
    installer,
    resolvePeers: false,
  });

  // 1. package.json must be restored to the original pin — the whole point of rollback.
  const after = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  assert.strictEqual(
    after.dependencies.axios,
    originalAxios,
    'axios range must roll back to ^0.21.0 after validator failure',
  );

  // 2. The report must flag axios as failed with kind "validation-script" — the discriminator
  //    downstream tools (JSON consumers, HTML summary) key off.
  const axiosFail = (report.failed ?? []).find((f) => f.name === 'axios');
  assert.ok(axiosFail, `expected axios in failed list; got ${JSON.stringify(report.failed)}`);
  assert.strictEqual(
    axiosFail.reason,
    'validation-script',
    `expected reason=validation-script; got ${axiosFail.reason}`,
  );

  // 3. The engine must have installed at least twice: once to apply the bump + once to roll back.
  //    (The exact count is implementation-detail sensitive — we just assert the minimum.)
  assert.ok(
    calls.length >= 2,
    `expected >= 2 installer calls (apply + rollback); got ${calls.length}`,
  );

  // 4. axios must NOT appear in `report.upgraded` as a success.
  const upgradedAxios = (report.upgraded ?? []).find((u) => u.name === 'axios' && u.success);
  assert.strictEqual(upgradedAxios, undefined, 'axios must not be a successful upgrade');
});

test('runUpgradeFlow: validator passing on recommended version keeps the upgrade applied', async () => {
  const dir = await stageFixture(fixtureDir);
  const pkgPath = path.join(dir, 'package.json');

  const { installer } = makeInstaller();

  // Validator always passes. Use `node -e "process.exit(0)"` rather than `true` so the test
  // works on Windows too (no shell `true` builtin there).
  const validateCmd = `node -e "process.exit(0)"`;

  const cache = createRegistryCache();
  cache.latest.set('axios', Promise.resolve('1.6.0'));

  const report = await runUpgradeFlow({
    cwd: dir,
    dryRun: false,
    interactive: false,
    force: false,
    jsonOutput: true,
    ignore: new Set(),
    fallbackStrategy: 'highest-stable',
    linkGroups: 'off',
    linkedGroupsConfig: [],
    validate: { command: validateCmd, source: 'cli' },
    restrictToNames: new Set(['axios']),
    registryCache: cache,
    installer,
    resolvePeers: false,
  });

  const after = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
  assert.match(
    after.dependencies.axios,
    /1\.6\.0/,
    `axios must be bumped to 1.6.0 when validator passes; got ${after.dependencies.axios}`,
  );
  const axiosRow = (report.upgraded ?? []).find((u) => u.name === 'axios');
  assert.ok(axiosRow && axiosRow.success, `expected axios success row; got ${JSON.stringify(axiosRow)}`);
});
