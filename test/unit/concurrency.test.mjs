/**
 * Unit tests for the concurrency primitives in `src/utils/concurrency.ts` and the orchestrator
 * plumbing that uses them in `runUpgradeFlow`.
 *
 * The design contract under test:
 *
 *   - `AsyncMutex` serializes its callers FIFO and survives thrown errors.
 *   - `runWithConcurrency` runs at most N workers and returns results in INPUT order
 *     (not completion order), which is what the orchestrator relies on for deterministic
 *     report merging.
 *   - `RegistryCache` deduplicates concurrent fetches by package name (one in-flight promise
 *     per name).
 *   - `runUpgradeFlow` propagates the effective `concurrency` onto the report and downgrades
 *     to 1 in non-JSON mode (so per-target log lines don't interleave).
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { AsyncMutex, runWithConcurrency, createRegistryCache, mapWithConcurrency } = await import(
  path.join(root, 'dist/utils/concurrency.js')
);
const { runUpgradeFlow } = await import(path.join(root, 'dist/core/upgrader.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('AsyncMutex: serializes FIFO with no overlap between critical sections', async () => {
  const m = new AsyncMutex();
  let inFlight = 0;
  let maxInFlight = 0;
  const finished = [];

  const task = (id, ms) =>
    m.runExclusive(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await sleep(ms);
      inFlight--;
      finished.push(id);
    });

  // Kick off 4 tasks roughly simultaneously. Even though task 1 sleeps the longest, FIFO
  // ordering means it finishes first; nothing should ever be in-flight together.
  await Promise.all([task(1, 30), task(2, 5), task(3, 20), task(4, 5)]);
  assert.strictEqual(maxInFlight, 1, 'mutex must never let two callers run concurrently');
  assert.deepStrictEqual(finished, [1, 2, 3, 4], 'mutex must release in FIFO order');
});

test('AsyncMutex: a thrown call releases the lock for the next waiter', async () => {
  const m = new AsyncMutex();
  let ranAfter = false;
  const failed = m.runExclusive(async () => {
    throw new Error('boom');
  });
  const after = m.runExclusive(async () => {
    ranAfter = true;
    return 42;
  });
  await assert.rejects(failed, /boom/);
  const v = await after;
  assert.strictEqual(v, 42);
  assert.strictEqual(ranAfter, true, 'subsequent call must run after a thrown predecessor');
});

test('runWithConcurrency: respects the limit and preserves input order', async () => {
  const items = [10, 80, 20, 60, 40];
  let inFlight = 0;
  let maxInFlight = 0;
  const results = await runWithConcurrency(items, 2, async (ms, idx) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await sleep(ms);
    inFlight--;
    return `i=${idx}/v=${ms}`;
  });
  assert.ok(maxInFlight <= 2, `expected at most 2 in flight, saw ${maxInFlight}`);
  assert.deepStrictEqual(
    results,
    ['i=0/v=10', 'i=1/v=80', 'i=2/v=20', 'i=3/v=60', 'i=4/v=40'],
    'results must come back in INPUT order, not completion order',
  );
});

test('runWithConcurrency: limit of 1 falls back to a sequential loop', async () => {
  const order = [];
  await runWithConcurrency([5, 30, 10], 1, async (ms, idx) => {
    await sleep(ms);
    order.push(idx);
  });
  assert.deepStrictEqual(order, [0, 1, 2], 'serial mode must run + finish strictly in order');
});

test('mapWithConcurrency: alias for runWithConcurrency (backwards compatibility)', async () => {
  const out = await mapWithConcurrency([1, 2, 3], 3, async (n) => n * 10);
  assert.deepStrictEqual(out, [10, 20, 30]);
});

test('RegistryCache: structurally has the two memoization maps', () => {
  const c = createRegistryCache();
  assert.ok(c.latest instanceof Map, 'latest must be a Map');
  assert.ok(c.versions instanceof Map, 'versions must be a Map');
  // Mimic what the npm helper does: store an in-flight promise so concurrent callers share it.
  const p = Promise.resolve('1.0.0');
  c.latest.set('axios', p);
  assert.strictEqual(c.latest.get('axios'), p, 'cache must return the SAME promise instance');
});

// ---------------------------------------------------------------------------
// runUpgradeFlow propagation
// ---------------------------------------------------------------------------

async function makeTmp(prefix) {
  return await fs.mkdtemp(path.join(os.tmpdir(), `dus-conc-${prefix}-`));
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}

async function setupMono() {
  const dir = await makeTmp('mono');
  await writeJson(path.join(dir, 'package.json'), {
    name: 'mono-root',
    private: true,
    workspaces: ['packages/*'],
    devDependencies: {},
  });
  await writeJson(path.join(dir, 'packages', 'a', 'package.json'), {
    name: '@org/a',
    version: '0.0.1',
    dependencies: { axios: '^1.0.0' },
  });
  await writeJson(path.join(dir, 'packages', 'b', 'package.json'), {
    name: '@org/b',
    version: '0.0.1',
    dependencies: { axios: '^1.0.0' },
  });
  return dir;
}

test('runUpgradeFlow: concurrency defaults to 1 and is recorded on the report', async () => {
  const dir = await setupMono();
  const r = await runUpgradeFlow({
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
    workspaceMode: 'all',
  });
  assert.strictEqual(r.concurrency, 1, 'default must be 1 when --concurrency is omitted');
});

test('runUpgradeFlow: concurrency > 1 propagates to the report in JSON mode', async () => {
  const dir = await setupMono();
  const r = await runUpgradeFlow({
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
    workspaceMode: 'all',
    concurrency: 4,
  });
  // We have 3 targets (root + 2 children), so effective should cap at 3.
  assert.strictEqual(r.concurrency, 3, 'effective concurrency must be capped at the target count');
});

test('runUpgradeFlow: non-JSON mode silently downgrades concurrency to 1', async () => {
  const dir = await setupMono();
  const r = await runUpgradeFlow({
    cwd: dir,
    dryRun: true,
    interactive: false,
    force: false,
    jsonOutput: false, // human mode → must downgrade
    ignore: new Set(),
    fallbackStrategy: 'highest-stable',
    linkGroups: 'off',
    linkedGroupsConfig: [],
    validate: { skip: true },
    workspaceMode: 'all',
    concurrency: 4,
  });
  assert.strictEqual(r.concurrency, 1, 'non-JSON mode must downgrade to 1 to keep logs legible');
});

test('runUpgradeFlow: parallel run still merges target rows in deterministic order', async () => {
  const dir = await setupMono();
  const r = await runUpgradeFlow({
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
    workspaceMode: 'all',
    concurrency: 8,
  });
  // Targets, in input order, are: root, then alphabetical workspace members.
  const labels = r.targets.map((t) => t.label);
  assert.deepStrictEqual(labels, ['root', '@org/a', '@org/b']);
});
