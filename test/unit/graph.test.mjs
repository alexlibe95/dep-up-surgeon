import test from 'node:test';
import assert from 'node:assert/strict';

import { buildDependencyGraph, findConnectedComponents } from '../../dist/core/graph.js';

/** Fake registry: `getManifest` answers from a fixed `{ name: manifest }` map (no network). */
function ctxFrom(manifests) {
  return {
    isRegistryPackage: () => true,
    getManifest: async (name) => manifests[name] ?? { version: '1.0.0' },
  };
}

test('buildDependencyGraph: optional peers do not create grouping edges', async () => {
  // Trimmed from the published vitest@3.2.4 / vite@7.0.6 manifests: nearly every peer is
  // `optional: true`, which used to fuse the whole test/build toolchain into one batch.
  const manifests = {
    vitest: {
      version: '3.2.4',
      peerDependencies: {
        '@edge-runtime/vm': '*',
        '@types/debug': '^4.1.12',
        '@types/node': '^18.0.0 || ^20.0.0 || >=22.0.0',
        '@vitest/browser': '3.2.4',
        '@vitest/ui': '3.2.4',
        'happy-dom': '*',
        jsdom: '*',
      },
      peerDependenciesMeta: {
        '@edge-runtime/vm': { optional: true },
        '@types/debug': { optional: true },
        '@types/node': { optional: true },
        '@vitest/browser': { optional: true },
        '@vitest/ui': { optional: true },
        'happy-dom': { optional: true },
        jsdom: { optional: true },
      },
    },
    vite: {
      version: '7.0.6',
      peerDependencies: {
        '@types/node': '^20.19.0 || >=22.12.0',
        jiti: '>=1.21.0',
        less: '^4.0.0',
        sass: '^1.70.0',
        terser: '^5.16.0',
      },
      peerDependenciesMeta: {
        '@types/node': { optional: true },
        jiti: { optional: true },
        less: { optional: true },
        sass: { optional: true },
        terser: { optional: true },
      },
    },
    // Required (non-optional) peer — this edge must survive.
    '@vitest/ui': { version: '3.2.4', peerDependencies: { vitest: '3.2.4' } },
  };
  const pkg = {
    name: 'app',
    version: '0.0.0',
    devDependencies: {
      '@types/node': '^22.0.0',
      '@vitest/ui': '^3.2.4',
      jsdom: '^26.0.0',
      sass: '^1.89.0',
      vite: '^7.0.0',
      vitest: '^3.2.4',
    },
  };
  const graph = await buildDependencyGraph(pkg, ctxFrom(manifests));
  assert.deepEqual(findConnectedComponents(graph), [
    ['@types/node'],
    ['@vitest/ui', 'vitest'],
    ['jsdom'],
    ['sass'],
    ['vite'],
  ]);
});

test('buildDependencyGraph: scoped packages pair with @types/<scope>__<name>', async () => {
  const pkg = {
    name: 'app',
    version: '0.0.0',
    devDependencies: {
      '@babel/core': '^7.26.0',
      '@types/babel__core': '^7.20.5',
      '@types/react': '^19.0.0',
      react: '^19.0.0',
    },
  };
  const graph = await buildDependencyGraph(pkg, ctxFrom({}));
  const pairs = graph.edges
    .filter((e) => e.kind === 'types-pair')
    .map((e) => [e.from, e.to].sort())
    .sort((a, b) => a[0].localeCompare(b[0]));
  assert.deepEqual(pairs, [
    ['@babel/core', '@types/babel__core'],
    ['@types/react', 'react'],
  ]);
});

test('buildDependencyGraph: @types/node is never paired with a package named `node`', async () => {
  const pkg = {
    name: 'app',
    version: '0.0.0',
    devDependencies: { '@types/node': '^22.0.0', node: '^22.0.0' },
  };
  const graph = await buildDependencyGraph(pkg, ctxFrom({}));
  assert.equal(graph.edges.length, 0);
  assert.deepEqual(findConnectedComponents(graph), [['@types/node'], ['node']]);
});
