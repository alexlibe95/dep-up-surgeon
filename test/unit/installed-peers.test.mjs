/**
 * Unit tests for `installedPeers.ts`: peer ranges between installed direct dependencies, read from
 * hand-written `node_modules/<name>/package.json` manifests in temp dirs.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { findDirectPeerViolations, peerRangesOn, peerViolationToConflict } = await import(
  path.join(root, 'dist/core/installedPeers.js')
);

async function installed(manifests) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-peers-'));
  for (const manifest of manifests) {
    await fs.mkdir(path.join(dir, 'node_modules', manifest.name), { recursive: true });
    await fs.writeFile(path.join(dir, 'node_modules', manifest.name, 'package.json'), JSON.stringify(manifest));
  }
  return dir;
}

const fiber = {
  name: '@react-three/fiber',
  version: '9.7.0',
  peerDependencies: { react: '>=19 <19.3', three: '>=0.156', expo: '>=43.0' },
  peerDependenciesMeta: { three: { optional: true } },
};

test("findDirectPeerViolations: an installed direct dep outside another direct dep's peer range", async () => {
  const dir = await installed([
    fiber,
    { name: 'react', version: '19.3.0' },
    { name: 'three', version: '0.100.0' },
    // A transitive with a violated peer: not a direct dep, so out of scope.
    { name: 'scheduler', version: '1.0.0', peerDependencies: { react: '<19' } },
  ]);
  const violations = await findDirectPeerViolations(['react', '@react-three/fiber', 'three'], [dir]);
  // `three` is an optional peer and `expo` isn't installed: neither counts.
  assert.deepStrictEqual(violations, [
    { dependent: '@react-three/fiber', dependentVersion: '9.7.0', peer: 'react', range: '>=19 <19.3', installed: '19.3.0' },
  ]);
});

test('findDirectPeerViolations: nothing to report when every peer range is met', async () => {
  const dir = await installed([fiber, { name: 'react', version: '19.2.8' }]);
  assert.deepStrictEqual(await findDirectPeerViolations(['react', '@react-three/fiber'], [dir]), []);
});

test('peerRangesOn: collects the ranges packages outside the batch place on its members', async () => {
  const dir = await installed([
    fiber,
    { name: 'next', version: '16.3.5', peerDependencies: { react: '^18.2.0 || ^19.0.0' } },
    { name: 'react-dom', version: '19.2.8', peerDependencies: { react: '^19.2.8' } },
  ]);
  const ranges = await peerRangesOn(new Set(['react', 'react-dom']), ['@react-three/fiber', 'next', 'react', 'react-dom'], [dir]);
  // react-dom is a member, so its own peer on react doesn't bound the batch.
  assert.deepStrictEqual(Object.fromEntries(ranges), { react: ['>=19 <19.3', '^18.2.0 || ^19.0.0'] });
});

test('peerViolationToConflict: produces a peer mismatch the ad-hoc resolver can read blockers from', () => {
  const conflict = peerViolationToConflict({
    dependent: '@react-three/fiber',
    dependentVersion: '9.7.0',
    peer: 'react',
    range: '>=19 <19.3',
    installed: '19.3.0',
  });
  assert.strictEqual(conflict.category, 'peerDependencyMismatch');
  assert.strictEqual(conflict.depender, '@react-three/fiber@9.7.0');
  assert.strictEqual(conflict.dependency, 'react');
});
