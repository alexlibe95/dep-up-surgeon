import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { computeBlastRadius, DEFAULT_MAX_FILES } from '../../dist/utils/blastRadius.js';

async function mkTmp() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'dus-blast-'));
}

async function write(dir, relPath, body) {
  const abs = path.join(dir, relPath);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body, 'utf8');
  return abs;
}

test('computeBlastRadius: detects ES import, CommonJS require, and dynamic import', async () => {
  const dir = await mkTmp();
  await write(dir, 'src/a.ts', `import axios from 'axios';\nexport const x = 1;\n`);
  await write(dir, 'src/b.js', `const lodash = require('lodash');\n`);
  await write(dir, 'src/c.mjs', `const m = await import('react');\n`);
  await write(dir, 'src/d.tsx', `import type { Foo } from 'axios/types';\n`);
  await write(dir, 'src/unrelated.ts', `// no imports here\nexport const y = 2;\n`);

  const res = await computeBlastRadius({
    cwd: dir,
    packageNames: ['axios', 'lodash', 'react', 'nope'],
  });

  assert.equal(res.byPackage.get('axios').total, 2); // a.ts + d.tsx (subpath)
  assert.equal(res.byPackage.get('lodash').total, 1);
  assert.equal(res.byPackage.get('react').total, 1);
  assert.equal(res.byPackage.get('nope').total, 0);
  assert.equal(res.byPackage.get('nope').hits.length, 0);

  const axiosFiles = res.byPackage.get('axios').hits.map((h) => h.relativePath).sort();
  assert.deepEqual(axiosFiles, ['src/a.ts', 'src/d.tsx'].sort());
});

test('computeBlastRadius: scoped packages and word-boundary safety', async () => {
  const dir = await mkTmp();
  // `@types/node` should NOT match files that only import `@types/node-ipc`.
  await write(dir, 'a.ts', `import type {} from '@types/node';\n`);
  await write(dir, 'b.ts', `import type {} from '@types/node-ipc';\n`);
  await write(dir, 'c.ts', `import 'react';\nimport 'react-dom';\n`);

  const res = await computeBlastRadius({
    cwd: dir,
    packageNames: ['@types/node', 'react'],
  });

  assert.equal(res.byPackage.get('@types/node').total, 1);
  assert.equal(res.byPackage.get('@types/node').hits[0].relativePath, 'a.ts');

  // `react` should match c.ts (one match), NOT the `react-dom` line.
  assert.equal(res.byPackage.get('react').total, 1);
  assert.equal(res.byPackage.get('react').hits[0].matches, 1);
});

test('computeBlastRadius: skips node_modules, dist, and unsupported extensions', async () => {
  const dir = await mkTmp();
  await write(dir, 'node_modules/pkg/index.js', `require('axios');`);
  await write(dir, 'dist/bundle.js', `require('axios');`);
  await write(dir, '.git/hooks/pre-commit.js', `require('axios');`);
  await write(dir, 'src/real.ts', `import 'axios';`);
  await write(dir, 'docs/README.md', `\`\`\`js\nrequire('axios');\n\`\`\``);

  const res = await computeBlastRadius({ cwd: dir, packageNames: ['axios'] });
  assert.equal(res.byPackage.get('axios').total, 1);
  assert.equal(res.byPackage.get('axios').hits[0].relativePath, 'src/real.ts');
});

test('computeBlastRadius: truncates to maxFiles but total keeps counting', async () => {
  const dir = await mkTmp();
  for (let i = 0; i < 10; i++) {
    await write(dir, `src/f${i}.ts`, `import 'axios';`);
  }
  const res = await computeBlastRadius({
    cwd: dir,
    packageNames: ['axios'],
    maxFiles: 3,
  });
  const rec = res.byPackage.get('axios');
  assert.equal(rec.total, 10);
  assert.equal(rec.hits.length, 3);
  assert.equal(rec.truncated, true);
});

test('computeBlastRadius: handles re-exports and multiline imports', async () => {
  const dir = await mkTmp();
  await write(
    dir,
    'src/a.ts',
    `export { default as ax } from 'axios';\nexport * from 'axios/utils';\n`,
  );
  // Multiline import — the regex matches the `from 'axios'` fragment even across indent.
  await write(
    dir,
    'src/b.ts',
    `import {\n  foo,\n  bar,\n} from 'axios';\n`,
  );
  const res = await computeBlastRadius({ cwd: dir, packageNames: ['axios'] });
  assert.equal(res.byPackage.get('axios').total, 2);
  // a.ts had two matches (re-export + wildcard subpath), b.ts one.
  const hits = res.byPackage.get('axios').hits;
  const a = hits.find((h) => h.relativePath === 'src/a.ts');
  const b = hits.find((h) => h.relativePath === 'src/b.ts');
  assert.equal(a.matches, 2);
  assert.equal(b.matches, 1);
  // Sorted by match count desc.
  assert.equal(hits[0].relativePath, 'src/a.ts');
});

test('computeBlastRadius: empty packageNames returns empty result without walking', async () => {
  const dir = await mkTmp();
  await write(dir, 'src/a.ts', `import 'axios';`);
  const res = await computeBlastRadius({ cwd: dir, packageNames: [] });
  assert.equal(res.byPackage.size, 0);
  assert.equal(res.filesScanned, 0);
});

test('DEFAULT_MAX_FILES is a positive integer', () => {
  assert.equal(typeof DEFAULT_MAX_FILES, 'number');
  assert.ok(DEFAULT_MAX_FILES > 0);
  assert.equal(Math.floor(DEFAULT_MAX_FILES), DEFAULT_MAX_FILES);
});
