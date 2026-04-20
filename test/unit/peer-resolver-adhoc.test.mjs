import test from 'node:test';
import assert from 'node:assert/strict';

import { tryResolveAdHocPeerConflict } from '../../dist/core/peerResolverAdHoc.js';

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
