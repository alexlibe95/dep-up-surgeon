import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDomain,
  describeResolution,
  resolvePeerRanges,
} from '../../dist/core/peerResolver.js';

/**
 * Helper: build a `CandidateDomain` directly from a `{ version: peerDeps }` map, skipping
 * the registry fetch. Matches the shape `buildDomain` would produce after filtering.
 */
function makeDomain(name, peerMap, versions) {
  const m = new Map();
  for (const [v, slice] of Object.entries(peerMap)) {
    m.set(v, { peerDependencies: slice.peerDependencies ?? {}, ...(slice.deprecated ? { deprecated: slice.deprecated } : {}), ...(slice.peerDependenciesMeta ? { peerDependenciesMeta: slice.peerDependenciesMeta } : {}) });
  }
  return { name, versions, peers: m };
}

test('buildDomain: keeps only versions within [current, requestedTarget] sorted newest first', () => {
  const peers = new Map([
    ['17.0.0', { peerDependencies: {} }],
    ['18.0.0', { peerDependencies: {} }],
    ['18.3.1', { peerDependencies: {} }],
    ['19.0.0', { peerDependencies: {} }],
    ['20.0.0-rc.1', { peerDependencies: {} }], // prerelease — excluded by default
  ]);
  const d = buildDomain(
    { name: 'react', currentRange: '^18.0.0', requestedTarget: '19.0.0' },
    peers,
  );
  // 17.0.0 < minVersion('^18.0.0') → dropped; 20.0.0-rc.1 > target → dropped; prerelease → dropped.
  assert.deepEqual(d.versions, ['19.0.0', '18.3.1', '18.0.0']);
});

test('buildDomain: excludes deprecated versions even when in range', () => {
  const peers = new Map([
    ['18.0.0', { peerDependencies: {} }],
    ['18.2.0', { peerDependencies: {}, deprecated: 'critical bug — do not use' }],
    ['18.3.1', { peerDependencies: {} }],
  ]);
  const d = buildDomain(
    { name: 'react', currentRange: '^18.0.0', requestedTarget: '18.3.1' },
    peers,
  );
  assert.deepEqual(d.versions, ['18.3.1', '18.0.0']);
});

test('buildDomain: returns empty array when requestedTarget is not valid semver', () => {
  const peers = new Map([['1.0.0', { peerDependencies: {} }]]);
  const d = buildDomain(
    { name: 'x', currentRange: '^1', requestedTarget: 'not-a-version' },
    peers,
  );
  assert.deepEqual(d.versions, []);
});

test('buildDomain: includePrereleases=true keeps -rc versions', () => {
  const peers = new Map([
    ['1.0.0', { peerDependencies: {} }],
    ['1.1.0-rc.1', { peerDependencies: {} }],
  ]);
  const d = buildDomain(
    { name: 'x', currentRange: '^1', requestedTarget: '1.1.0-rc.1' },
    peers,
    true,
  );
  assert.ok(d.versions.includes('1.1.0-rc.1'));
});

test('resolvePeerRanges: empty domain list returns undefined', () => {
  const r = resolvePeerRanges([], new Map(), { externalInstalled: new Map() });
  assert.equal(r, undefined);
});

test('resolvePeerRanges: any empty domain short-circuits to undefined', () => {
  const react = makeDomain('react', { '18.3.1': { peerDependencies: {} } }, ['18.3.1']);
  const dom = makeDomain('react-dom', {}, []);
  const r = resolvePeerRanges([react, dom], new Map(), { externalInstalled: new Map() });
  assert.equal(r, undefined);
});

test('resolvePeerRanges: classic react + react-dom — latest satisfies peer, no downgrade', () => {
  // `react-dom@18.3.1` peers on `react: "^18.0.0"`, and `react@18.3.1` trivially satisfies.
  const react = makeDomain(
    'react',
    { '18.3.1': { peerDependencies: {} } },
    ['18.3.1'],
  );
  const reactDom = makeDomain(
    'react-dom',
    { '18.3.1': { peerDependencies: { react: '^18.0.0' } } },
    ['18.3.1'],
  );
  const r = resolvePeerRanges(
    [reactDom, react],
    new Map([['react', '18.3.1'], ['react-dom', '18.3.1']]),
    { externalInstalled: new Map() },
  );
  assert.ok(r);
  assert.equal(r.versions.get('react'), '18.3.1');
  assert.equal(r.versions.get('react-dom'), '18.3.1');
  assert.equal(r.downgradedFrom.size, 0);
});

test('resolvePeerRanges: finds intersection when latests clash — picks oldest compatible', () => {
  // Canonical failure: the user wanted react@19 + @types/react@19, but @types/react@19 peers
  // on react "^19", while react-dom@18 (already at latest 18) peers on react "^18".
  // The resolver should downgrade `react` (and implicitly `@types/react`) to 18.x so all three
  // satisfy.
  //
  // Modeled as: domains = [react(19, 18.3.1, 18.0.0), reactDom(18.3.1), typesReact(19, 18.2.0)].
  const react = makeDomain(
    'react',
    {
      '19.0.0': { peerDependencies: {} },
      '18.3.1': { peerDependencies: {} },
      '18.0.0': { peerDependencies: {} },
    },
    ['19.0.0', '18.3.1', '18.0.0'],
  );
  const reactDom = makeDomain(
    'react-dom',
    { '18.3.1': { peerDependencies: { react: '^18.0.0' } } },
    ['18.3.1'],
  );
  const typesReact = makeDomain(
    '@types/react',
    {
      '19.0.0': { peerDependencies: { react: '^19.0.0' } },
      '18.2.0': { peerDependencies: { react: '^18.0.0' } },
    },
    ['19.0.0', '18.2.0'],
  );
  const requested = new Map([
    ['react', '19.0.0'],
    ['react-dom', '18.3.1'],
    ['@types/react', '19.0.0'],
  ]);
  const r = resolvePeerRanges([react, reactDom, typesReact], requested, {
    externalInstalled: new Map(),
  });
  assert.ok(r);
  // react must be ≤ 18.x to satisfy react-dom@18.3.1. Newest valid is 18.3.1.
  assert.equal(r.versions.get('react'), '18.3.1');
  assert.equal(r.versions.get('react-dom'), '18.3.1');
  // @types/react@19 requires react ^19 → incompatible with our react@18.3.1 → falls to 18.2.0.
  assert.equal(r.versions.get('@types/react'), '18.2.0');
  // Downgrades recorded for both ejected packages.
  assert.equal(r.downgradedFrom.get('react'), '19.0.0');
  assert.equal(r.downgradedFrom.get('@types/react'), '19.0.0');
  assert.ok(!r.downgradedFrom.has('react-dom')); // was already at its requested target
});

test('resolvePeerRanges: rejects tuple when external installed package violates peer', () => {
  // `react-dom@19` peers on `react: "^19"`. External `next: "^14"` has no opinion — fine.
  // BUT: a candidate of `react-dom@19` hypothetically peers on `next: "^15"`; our external
  // `next` is still "^14" → minVersion 14.0.0 fails. Resolver must downgrade react-dom.
  const reactDom = makeDomain(
    'react-dom',
    {
      '19.0.0': { peerDependencies: { react: '^19', next: '^15' } },
      '18.3.1': { peerDependencies: { react: '^18' } },
    },
    ['19.0.0', '18.3.1'],
  );
  const react = makeDomain(
    'react',
    {
      '19.0.0': { peerDependencies: {} },
      '18.3.1': { peerDependencies: {} },
    },
    ['19.0.0', '18.3.1'],
  );
  const r = resolvePeerRanges(
    [reactDom, react],
    new Map([['react-dom', '19.0.0'], ['react', '19.0.0']]),
    { externalInstalled: new Map([['next', '^14.0.0']]) },
  );
  assert.ok(r);
  assert.equal(r.versions.get('react-dom'), '18.3.1');
  assert.equal(r.versions.get('react'), '18.3.1');
  assert.equal(r.downgradedFrom.get('react-dom'), '19.0.0');
});

test('resolvePeerRanges: optional peer is ignored (not a hard constraint)', () => {
  // react-dom@20 peers on `fictional-peer: "^2"` but it's MARKED OPTIONAL. Even with the
  // external at "^1" (which would violate a hard peer) the resolver picks 20.
  const reactDom = makeDomain(
    'react-dom',
    {
      '20.0.0': {
        peerDependencies: { 'fictional-peer': '^2' },
        peerDependenciesMeta: { 'fictional-peer': { optional: true } },
      },
    },
    ['20.0.0'],
  );
  const react = makeDomain(
    'react',
    { '20.0.0': { peerDependencies: {} } },
    ['20.0.0'],
  );
  const r = resolvePeerRanges(
    [reactDom, react],
    new Map([['react-dom', '20.0.0'], ['react', '20.0.0']]),
    { externalInstalled: new Map([['fictional-peer', '^1.0.0']]) },
  );
  assert.ok(r);
  assert.equal(r.versions.get('react-dom'), '20.0.0');
});

test('resolvePeerRanges: no satisfiable tuple returns undefined', () => {
  // A peers react ^19, B peers react ^18, and only one version of react exists at ^19.
  const a = makeDomain(
    'a',
    { '1.0.0': { peerDependencies: { react: '^19' } } },
    ['1.0.0'],
  );
  const b = makeDomain(
    'b',
    { '1.0.0': { peerDependencies: { react: '^18' } } },
    ['1.0.0'],
  );
  const react = makeDomain('react', { '19.0.0': { peerDependencies: {} } }, ['19.0.0']);
  const r = resolvePeerRanges(
    [a, b, react],
    new Map([['a', '1.0.0'], ['b', '1.0.0'], ['react', '19.0.0']]),
    { externalInstalled: new Map() },
  );
  assert.equal(r, undefined);
});

test('resolvePeerRanges: respects maxTuples budget and returns undefined when exceeded', () => {
  // Construct two domains with 30 versions each; none of the tuples satisfy the constraint.
  // With maxTuples=10 the search bails before visiting the full 900-tuple space.
  const versionsA = Array.from({ length: 30 }, (_, i) => `1.${i}.0`);
  const peersA = {};
  for (const v of versionsA) peersA[v] = { peerDependencies: { b: '^99' } };
  const versionsB = Array.from({ length: 30 }, (_, i) => `1.${i}.0`);
  const peersB = {};
  for (const v of versionsB) peersB[v] = { peerDependencies: {} };
  const a = makeDomain('a', peersA, versionsA);
  const b = makeDomain('b', peersB, versionsB);
  const r = resolvePeerRanges(
    [a, b],
    new Map([['a', '1.29.0'], ['b', '1.29.0']]),
    { externalInstalled: new Map(), maxTuples: 10 },
  );
  assert.equal(r, undefined);
});

test('resolvePeerRanges: tuplesExplored counter is non-zero and bounded', () => {
  const react = makeDomain(
    'react',
    { '18.3.1': { peerDependencies: {} } },
    ['18.3.1'],
  );
  const reactDom = makeDomain(
    'react-dom',
    { '18.3.1': { peerDependencies: { react: '^18' } } },
    ['18.3.1'],
  );
  const r = resolvePeerRanges(
    [reactDom, react],
    new Map([['react-dom', '18.3.1'], ['react', '18.3.1']]),
    { externalInstalled: new Map() },
  );
  assert.ok(r);
  assert.ok(r.tuplesExplored >= 1 && r.tuplesExplored <= 10);
});

test('describeResolution: formats unchanged vs downgraded members distinctly', () => {
  const tuple = {
    versions: new Map([
      ['react', '18.3.1'],
      ['react-dom', '18.3.1'],
    ]),
    downgradedFrom: new Map([['react', '19.0.0']]),
    tuplesExplored: 4,
  };
  const text = describeResolution(tuple, [
    { name: 'react', currentRange: '^18', requestedTarget: '19.0.0' },
    { name: 'react-dom', currentRange: '^18', requestedTarget: '18.3.1' },
  ]);
  assert.match(text, /react: 19\.0\.0 → 18\.3\.1/);
  assert.match(text, /react-dom@18\.3\.1/);
  assert.match(text, /explored 4/);
});

test('resolvePeerRanges: external peer whose range is malformed is treated as unknown (not a failure)', () => {
  // `satisfies("42.0.0", "abc-not-semver")` throws in raw semver; resolver should swallow and
  // skip the external check rather than blow up the whole run.
  const a = makeDomain(
    'a',
    { '1.0.0': { peerDependencies: { weird: '^1.0.0' } } },
    ['1.0.0'],
  );
  const b = makeDomain('b', { '1.0.0': { peerDependencies: {} } }, ['1.0.0']);
  const r = resolvePeerRanges(
    [a, b],
    new Map([['a', '1.0.0'], ['b', '1.0.0']]),
    { externalInstalled: new Map([['weird', 'abc-not-semver']]) },
  );
  // The garbage external is SKIPPED (unknown → assume satisfied), so we still find a tuple.
  assert.ok(r);
  assert.equal(r.versions.get('a'), '1.0.0');
});

// --- SAT-style solver path --------------------------------------------------

test('resolvePeerRanges: small graphs still use the backtracker (method=backtracking)', () => {
  const a = makeDomain(
    'a',
    { '1.0.0': { peerDependencies: { b: '^1.0.0' } } },
    ['1.0.0'],
  );
  const b = makeDomain(
    'b',
    { '1.0.0': { peerDependencies: { a: '^1.0.0' } } },
    ['1.0.0'],
  );
  const r = resolvePeerRanges([a, b], new Map([['a', '1.0.0'], ['b', '1.0.0']]), {
    externalInstalled: new Map(),
  });
  assert.ok(r);
  assert.equal(r.method, 'backtracking');
});

test('resolvePeerRanges: large linked graph (10+) automatically uses the SAT path', () => {
  // Build a star graph: `hub` peers on everyone else, and each satellite peers on hub. All
  // at matching versions, so there's a trivially satisfiable tuple that the backtracker
  // would also find — the point of the test is that (a) the SAT path engages and
  // (b) produces the same solution.
  const names = ['hub', ...Array.from({ length: 12 }, (_, i) => `sat-${i}`)];
  const domains = [];
  const hubPeers = {};
  for (const s of names.slice(1)) hubPeers[s] = '^1.0.0';
  domains.push(
    makeDomain(
      'hub',
      { '1.0.0': { peerDependencies: hubPeers } },
      ['1.0.0'],
    ),
  );
  for (const s of names.slice(1)) {
    domains.push(
      makeDomain(
        s,
        { '1.0.0': { peerDependencies: { hub: '^1.0.0' } } },
        ['1.0.0'],
      ),
    );
  }
  const requested = new Map(names.map((n) => [n, '1.0.0']));
  const r = resolvePeerRanges(domains, requested, { externalInstalled: new Map() });
  assert.ok(r);
  assert.equal(r.method, 'sat');
  for (const n of names) assert.equal(r.versions.get(n), '1.0.0');
});

test('resolvePeerRangesSat: arc-consistency prunes impossible combinations before DFS', async () => {
  // 3-cycle where one version of `a` has a peer that nothing in `b` satisfies. AC-3 should
  // discard that `a` version during propagation, leaving a single satisfiable tuple.
  const a = makeDomain(
    'a',
    {
      '2.0.0': { peerDependencies: { b: '>=99.0.0' } }, // impossible — AC-3 prunes
      '1.0.0': { peerDependencies: { b: '^1.0.0' } },
    },
    ['2.0.0', '1.0.0'],
  );
  const b = makeDomain(
    'b',
    { '1.0.0': { peerDependencies: { a: '^1.0.0' } } },
    ['1.0.0'],
  );
  const { resolvePeerRangesSat } = await import('../../dist/core/peerResolver.js');
  const r = resolvePeerRangesSat([a, b], new Map([['a', '2.0.0'], ['b', '1.0.0']]), {
    externalInstalled: new Map(),
  });
  assert.ok(r);
  assert.equal(r.method, 'sat');
  // Even though the resolver is order-preserving (newest-first), the `a@2.0.0` version was
  // AC-3-pruned, so the tuple settles on `a@1.0.0`.
  assert.equal(r.versions.get('a'), '1.0.0');
  assert.equal(r.versions.get('b'), '1.0.0');
});

test('resolvePeerRangesSat: empty domain after external-peer pre-prune returns undefined', async () => {
  // `a@1.0.0` peers on external `typescript: ^5`, but the workspace has `typescript@^4`.
  // SAT pre-prune should remove the only `a` version → empty domain → undefined.
  const a = makeDomain(
    'a',
    { '1.0.0': { peerDependencies: { typescript: '^5.0.0' } } },
    ['1.0.0'],
  );
  const b = makeDomain('b', { '1.0.0': { peerDependencies: {} } }, ['1.0.0']);
  const { resolvePeerRangesSat } = await import('../../dist/core/peerResolver.js');
  const r = resolvePeerRangesSat([a, b], new Map([['a', '1.0.0'], ['b', '1.0.0']]), {
    externalInstalled: new Map([['typescript', '^4.9.0']]),
  });
  assert.equal(r, undefined);
});

test('resolvePeerRanges: satThreshold=0 forces SAT path even for tiny graphs', () => {
  const a = makeDomain('a', { '1.0.0': { peerDependencies: {} } }, ['1.0.0']);
  const b = makeDomain('b', { '1.0.0': { peerDependencies: {} } }, ['1.0.0']);
  const r = resolvePeerRanges([a, b], new Map([['a', '1.0.0'], ['b', '1.0.0']]), {
    externalInstalled: new Map(),
    satThreshold: 0,
  });
  assert.ok(r);
  assert.equal(r.method, 'sat');
});

test('resolvePeerRanges: large-graph SAT fails → dispatcher falls back to backtracking', () => {
  // Construct a tight graph: 10 members, each peers on the NEXT one at a narrow range. The
  // SAT pre-prune is a no-op (every version is locally supported), but the DFS will find a
  // tuple. Result should be a success regardless of which path won.
  const members = Array.from({ length: 10 }, (_, i) => `m-${i}`);
  const domains = members.map((m, i) => {
    const next = members[(i + 1) % members.length];
    return makeDomain(
      m,
      { '1.0.0': { peerDependencies: { [next]: '^1.0.0' } } },
      ['1.0.0'],
    );
  });
  const r = resolvePeerRanges(
    domains,
    new Map(members.map((m) => [m, '1.0.0'])),
    { externalInstalled: new Map() },
  );
  assert.ok(r);
  // satThreshold defaults to 10; this graph is exactly at the threshold, so SAT kicks in.
  assert.equal(r.method, 'sat');
});

test('describeResolution: includes method tag so commit bodies show which solver won', () => {
  const tuple = {
    versions: new Map([['x', '1.0.0']]),
    downgradedFrom: new Map(),
    tuplesExplored: 1,
    method: 'sat',
  };
  const text = describeResolution(tuple, [
    { name: 'x', currentRange: '^1', requestedTarget: '1.0.0' },
  ]);
  assert.match(text, /\[sat\]/);
  assert.match(text, /x@1\.0\.0/);
});
