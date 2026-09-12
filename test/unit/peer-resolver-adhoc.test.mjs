import test from 'node:test';
import assert from 'node:assert/strict';

import { tryResolveAdHocPeerConflict } from '../../dist/core/peerResolverAdHoc.js';
import { extractClassifiedConflicts } from '../../dist/core/conflictAnalyzer.js';

/**
 * The ad-hoc resolver fetches packuments + `latest` through `src/utils/npm.ts`. For tests
 * we pass a fake `RegistryCache` that's pre-seeded with the fixtures we need, so the
 * resolver never hits the real registry. The cache shape is `{ latest, peers }` where:
 *   - `latest` maps `name → Promise<string>` (resolved dist-tag).
 *   - `peers` maps `name → Promise<Map<version, { peerDependencies, peerDependenciesMeta }>>`.
 */
function makeCache(latestMap, peersMap) {
  return {
    latest: new Map(Object.entries(latestMap).map(([k, v]) => [k, Promise.resolve(v)])),
    peers: new Map(
      Object.entries(peersMap).map(([pkgName, versions]) => {
        const m = new Map();
        for (const [ver, slice] of Object.entries(versions)) {
          m.set(ver, {
            peerDependencies: slice.peerDependencies ?? {},
            ...(slice.peerDependenciesMeta ? { peerDependenciesMeta: slice.peerDependenciesMeta } : {}),
            ...(slice.deprecated ? { deprecated: slice.deprecated } : {}),
          });
        }
        return [pkgName, Promise.resolve(m)];
      }),
    ),
    versions: new Map(),
  };
}

test('tryResolveAdHocPeerConflict: synthesizes an ad-hoc group from parsed peer conflicts', async () => {
  // Scenario: bumping `eslint-plugin-react-hooks` to 5.0.0 fails because it peers on
  // `eslint: ^8` but the project is still on `eslint@^7`. The resolver should discover
  // that a compatible `eslint-plugin-react-hooks` version exists at 4.6.0 (peers on
  // `eslint: ^7 || ^8`) and propose keeping `eslint` at its current range.
  const registryCache = makeCache(
    {
      'eslint-plugin-react-hooks': '5.0.0',
      eslint: '7.32.0',
    },
    {
      'eslint-plugin-react-hooks': {
        '5.0.0': { peerDependencies: { eslint: '^8.0.0' } },
        '4.6.0': { peerDependencies: { eslint: '^7.0.0 || ^8.0.0' } },
      },
      eslint: {
        '7.32.0': { peerDependencies: {} },
        '8.57.0': { peerDependencies: {} },
      },
    },
  );

  const res = await tryResolveAdHocPeerConflict({
    primary: {
      name: 'eslint-plugin-react-hooks',
      section: 'devDependencies',
      currentRange: '^4.0.0',
    },
    primaryTarget: '5.0.0',
    classified: [
      {
        depender: 'eslint',
        dependency: 'eslint-plugin-react-hooks',
        requiredRange: '^8.0.0',
        rawMessage: 'peer eslint@^8.0.0 from eslint-plugin-react-hooks@5.0.0',
        category: 'peerDependencyMismatch',
      },
    ],
    pkg: {
      name: 'demo',
      version: '0.0.0',
      devDependencies: {
        'eslint-plugin-react-hooks': '^4.0.0',
        eslint: '^7.32.0',
      },
    },
    registryCache,
  });

  assert.ok(res, 'ad-hoc resolver should find a tuple');
  const primary = res.bumps.find((b) => b.isPrimary);
  assert.ok(primary);
  assert.equal(primary.name, 'eslint-plugin-react-hooks');
  // Target was 5.0.0 (requires eslint ^8), but eslint is pinned to ^7 → resolver picks 4.6.0.
  assert.equal(primary.to, '4.6.0');
  // eslint should NOT appear as a bump — its current range still satisfies the ad-hoc solution.
  const eslintBump = res.bumps.find((b) => b.name === 'eslint');
  assert.equal(eslintBump, undefined);
  assert.match(res.reason, /ad-hoc peer-range intersection/);
  assert.ok(['backtracking', 'sat'].includes(res.method));
});

test('tryResolveAdHocPeerConflict: returns undefined when no blocker is a direct dep', async () => {
  // The conflict names a blocker (`react`) that isn't declared in the workspace — can't
  // form an ad-hoc group without adding a new dep, which is out of scope.
  const registryCache = makeCache({}, {});
  const res = await tryResolveAdHocPeerConflict({
    primary: {
      name: 'some-plugin',
      section: 'devDependencies',
      currentRange: '^1.0.0',
    },
    primaryTarget: '2.0.0',
    classified: [
      {
        depender: 'react',
        dependency: 'some-plugin',
        requiredRange: '^18.0.0',
        rawMessage: 'peer react@^18.0.0',
        category: 'peerDependencyMismatch',
      },
    ],
    pkg: {
      name: 'demo',
      version: '0.0.0',
      devDependencies: { 'some-plugin': '^1.0.0' }, // no react here
    },
    registryCache,
  });
  assert.equal(res, undefined);
});

test('tryResolveAdHocPeerConflict: skips non-peer classified entries', async () => {
  const registryCache = makeCache({}, {});
  const res = await tryResolveAdHocPeerConflict({
    primary: {
      name: 'some-plugin',
      section: 'devDependencies',
      currentRange: '^1.0.0',
    },
    primaryTarget: '2.0.0',
    classified: [
      {
        // engine conflict, not peer — resolver must ignore it
        depender: 'node',
        dependency: 'some-plugin',
        requiredRange: '>=20',
        rawMessage: 'EBADENGINE',
        category: 'incompatibleEngine',
      },
    ],
    pkg: {
      name: 'demo',
      version: '0.0.0',
      devDependencies: { 'some-plugin': '^1.0.0', node: '20' },
    },
    registryCache,
  });
  assert.equal(res, undefined);
});

test('tryResolveAdHocPeerConflict: caps ad-hoc group size to maxAdHocMembers', async () => {
  // 10 classified blockers, maxAdHocMembers=3 → primary + 2 blockers at most. The
  // resolver's input never includes more than 3 packages total. We assert this indirectly
  // by the fact that registry fetches are only requested for the capped set — unknown
  // names hit the cache and would throw on `.get`, but we've only seeded 3 entries.
  const peers = {
    primary: { '1.0.0': { peerDependencies: {} } },
    'blocker-a': { '1.0.0': { peerDependencies: {} } },
    'blocker-b': { '1.0.0': { peerDependencies: {} } },
  };
  const latest = { primary: '1.0.0', 'blocker-a': '1.0.0', 'blocker-b': '1.0.0' };
  const registryCache = makeCache(latest, peers);

  const classified = [];
  for (let i = 0; i < 10; i++) {
    classified.push({
      depender: `blocker-${String.fromCharCode(97 + i)}`, // blocker-a..j
      dependency: 'primary',
      requiredRange: '^1.0.0',
      rawMessage: `peer`,
      category: 'peerDependencyMismatch',
    });
  }
  const devDeps = { primary: '^1.0.0' };
  for (let i = 0; i < 10; i++) {
    devDeps[`blocker-${String.fromCharCode(97 + i)}`] = '^1.0.0';
  }

  const res = await tryResolveAdHocPeerConflict({
    primary: { name: 'primary', section: 'devDependencies', currentRange: '^1.0.0' },
    primaryTarget: '1.0.0',
    classified,
    pkg: { name: 'demo', version: '0.0.0', devDependencies: devDeps },
    registryCache,
    maxAdHocMembers: 3,
  });
  // This is a noop solve (everything already satisfies) → resolver returns undefined
  // because `onlyPrimaryUnchanged` catches "primary stayed at target, no blockers moved".
  // The meaningful assertion is that this call COMPLETED without a registry miss, which
  // proves the cap engaged (blocker-c..j were never fetched).
  assert.equal(res, undefined);
});

test('tryResolveAdHocPeerConflict: does not silently bump a blocker past its pinned range', async () => {
  // Blocker `eslint@^7` shouldn't be allowed to move to 8.x even if that would unblock the
  // primary — we only allow the resolver to DOWNGRADE the primary in the non-linked path.
  const registryCache = makeCache(
    {
      plugin: '5.0.0',
      eslint: '8.57.0', // newer than the pin
    },
    {
      plugin: {
        '5.0.0': { peerDependencies: { eslint: '^8.0.0' } },
        '4.6.0': { peerDependencies: { eslint: '^7.0.0 || ^8.0.0' } },
      },
      eslint: {
        '7.32.0': { peerDependencies: {} },
        '8.57.0': { peerDependencies: {} },
      },
    },
  );

  const res = await tryResolveAdHocPeerConflict({
    primary: { name: 'plugin', section: 'devDependencies', currentRange: '^4.0.0' },
    primaryTarget: '5.0.0',
    classified: [
      {
        depender: 'eslint',
        dependency: 'plugin',
        requiredRange: '^8.0.0',
        rawMessage: 'peer eslint@^8',
        category: 'peerDependencyMismatch',
      },
    ],
    pkg: {
      name: 'demo',
      version: '0.0.0',
      devDependencies: { plugin: '^4.0.0', eslint: '^7.32.0' },
    },
    registryCache,
  });
  assert.ok(res);
  // eslint must stay on ^7.x semantics — the bump list should not include it.
  assert.equal(res.bumps.find((b) => b.name === 'eslint'), undefined);
  // Primary is downgraded to 4.6.0 (the version that peers on ^7 || ^8).
  assert.equal(res.bumps.find((b) => b.isPrimary).to, '4.6.0');
});

// Real npm 10 ERESOLVE output: the depender is printed as `<name>@<version>`.
const TYPESCRIPT_6_ERESOLVE = [
  'npm error code ERESOLVE',
  'npm error ERESOLVE unable to resolve dependency tree',
  'npm error',
  'npm error While resolving: my-app@0.0.0',
  'npm error Found: typescript@6.0.3',
  'npm error node_modules/typescript',
  'npm error   dev typescript@"6.0.3" from the root project',
  'npm error',
  'npm error Could not resolve dependency:',
  'npm error peer typescript@">=5.9 <6.0" from @angular/build@21.2.8',
  'npm error node_modules/@angular/build',
  'npm error   dev @angular/build@"^21.2.8" from the root project',
  'npm error',
  'npm error Fix the upstream dependency conflict, or retry',
  'npm error this command with --force or --legacy-peer-deps',
  'npm error to accept an incorrect (and potentially broken) dependency resolution.',
].join('\n');

test('tryResolveAdHocPeerConflict: finds a blocker from a versioned npm depender (@scope/name@ver)', async () => {
  const classified = extractClassifiedConflicts(TYPESCRIPT_6_ERESOLVE, { rootPackageName: 'my-app' });
  assert.ok(classified.some((c) => c.depender === '@angular/build@21.2.8'));
  const registryCache = makeCache(
    { typescript: '6.0.3', '@angular/build': '21.2.8' },
    {
      typescript: { '5.9.2': {}, '5.9.3': {}, '6.0.3': {} },
      '@angular/build': { '21.2.8': { peerDependencies: { typescript: '>=5.9 <6.0' } } },
    },
  );
  const res = await tryResolveAdHocPeerConflict({
    primary: { name: 'typescript', section: 'devDependencies', currentRange: '~5.9.2' },
    primaryTarget: '6.0.3',
    classified,
    pkg: {
      name: 'my-app',
      version: '0.0.0',
      devDependencies: { '@angular/build': '^21.2.8', typescript: '~5.9.2' },
    },
    registryCache,
  });
  assert.ok(res, 'ad-hoc resolver should treat @angular/build as the blocker');
  assert.equal(res.bumps.find((b) => b.isPrimary).to, '5.9.3');
  assert.equal(res.bumps.find((b) => b.name === '@angular/build'), undefined);
});

// eslint-plugin-react-hooks@5 needs eslint ^8; the workspace pins eslint ^7.0.0 (7.32.0 published).
const HOOKS_ERESOLVE = [
  'npm error code ERESOLVE',
  'npm error ERESOLVE unable to resolve dependency tree',
  'npm error',
  'npm error While resolving: demo@0.0.0',
  'npm error Found: eslint@7.32.0',
  'npm error node_modules/eslint',
  'npm error   dev eslint@"^7.0.0" from the root project',
  'npm error',
  'npm error Could not resolve dependency:',
  'npm error peer eslint@"^8.0.0" from eslint-plugin-react-hooks@5.0.0',
  'npm error node_modules/eslint-plugin-react-hooks',
  'npm error   dev eslint-plugin-react-hooks@"5.0.0" from the root project',
].join('\n');

function hooksInput(pkg, extra = {}) {
  return {
    primary: { name: 'eslint-plugin-react-hooks', section: 'devDependencies', currentRange: '^4.0.0' },
    primaryTarget: '5.0.0',
    classified: extractClassifiedConflicts(HOOKS_ERESOLVE, { rootPackageName: 'demo' }),
    pkg,
    registryCache: makeCache(
      { 'eslint-plugin-react-hooks': '5.0.0', eslint: '7.32.0' },
      {
        'eslint-plugin-react-hooks': {
          '5.0.0': { peerDependencies: { eslint: '^8.0.0' } },
          '4.6.0': { peerDependencies: { eslint: '^7.0.0 || ^8.0.0' } },
        },
        eslint: { '7.0.0': {}, '7.32.0': {} },
      },
    ),
    ...extra,
  };
}

test('tryResolveAdHocPeerConflict: never moves a frozen (ignored / policy / security-only) blocker', async () => {
  const pkg = {
    name: 'demo',
    version: '0.0.0',
    devDependencies: { 'eslint-plugin-react-hooks': '^4.0.0', eslint: '^7.0.0' },
  };
  const res = await tryResolveAdHocPeerConflict(
    hooksInput(pkg, { isFrozen: (name) => name === 'eslint' }),
  );
  assert.equal(res?.bumps.some((b) => b.name === 'eslint') ?? false, false);
});

test('tryResolveAdHocPeerConflict: peerDependencies-only blockers are left alone unless includePeers', async () => {
  const pkg = {
    name: 'demo',
    version: '0.0.0',
    devDependencies: { 'eslint-plugin-react-hooks': '^4.0.0' },
    peerDependencies: { eslint: '^7.0.0' },
  };
  const res = await tryResolveAdHocPeerConflict(hooksInput(pkg));
  assert.equal(res?.bumps.some((b) => b.name === 'eslint') ?? false, false);
  const allowed = await tryResolveAdHocPeerConflict(hooksInput(pkg, { includePeers: true }));
  assert.ok(allowed, 'with includePeers the peer-section blocker joins the ad-hoc group');
  assert.equal(allowed.bumps.find((b) => b.isPrimary).to, '4.6.0');
});

test('tryResolveAdHocPeerConflict: lockfileVersions replaces declared range floors for external peers', async () => {
  // Bumping @angular/build 20 → 21 fails on compiler-cli (pinned ^20.3.4). The 20.x line needs
  // typescript >=5.8; package.json still says ^5.4.0 but 5.9.3 is what's installed.
  const output = [
    'npm error code ERESOLVE',
    'npm error ERESOLVE unable to resolve dependency tree',
    'npm error',
    'npm error While resolving: my-app@0.0.0',
    'npm error Found: @angular/compiler-cli@20.3.4',
    'npm error node_modules/@angular/compiler-cli',
    'npm error   dev @angular/compiler-cli@"^20.3.4" from the root project',
    'npm error',
    'npm error Could not resolve dependency:',
    'npm error peer @angular/compiler-cli@"^21.0.0" from @angular/build@21.2.8',
    'npm error node_modules/@angular/build',
    'npm error   dev @angular/build@"21.2.8" from the root project',
  ].join('\n');
  const input = () => ({
    primary: { name: '@angular/build', section: 'devDependencies', currentRange: '^20.3.0' },
    primaryTarget: '21.2.8',
    classified: extractClassifiedConflicts(output, { rootPackageName: 'my-app' }),
    pkg: {
      name: 'my-app',
      version: '0.0.0',
      devDependencies: {
        '@angular/build': '^20.3.0',
        '@angular/compiler-cli': '^20.3.4',
        typescript: '^5.4.0',
      },
    },
    registryCache: makeCache(
      { '@angular/build': '21.2.8', '@angular/compiler-cli': '21.2.8' },
      {
        '@angular/build': {
          '20.3.4': { peerDependencies: { '@angular/compiler-cli': '^20.0.0', typescript: '>=5.8 <6.0' } },
          '21.2.8': { peerDependencies: { '@angular/compiler-cli': '^21.0.0', typescript: '>=5.9 <6.0' } },
        },
        '@angular/compiler-cli': {
          '20.3.4': { peerDependencies: { typescript: '>=5.8 <6.0' } },
          '21.2.8': { peerDependencies: { typescript: '>=5.9 <6.0' } },
        },
      },
    ),
  });
  const res = await tryResolveAdHocPeerConflict({
    ...input(),
    lockfileVersions: new Map([['typescript', new Set(['5.9.3'])]]),
  });
  assert.ok(res, 'installed typescript 5.9.3 satisfies the 20.x peer range');
  assert.equal(res.bumps.find((b) => b.isPrimary).to, '20.3.4');
});
