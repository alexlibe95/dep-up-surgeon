/**
 * `.dep-up-surgeonrc` loading + `appendIgnoreToRc` robustness. A malformed rc must never be
 * silently treated as empty (that would un-ignore packages and drop the custom validator), and
 * the writer must never clobber sections it could not read.
 */
import assert from 'node:assert';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { loadConfig, appendIgnoreToRc } = await import(path.join(root, 'dist/config/loadConfig.js'));

const RC = '.dep-up-surgeonrc';

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-load-config-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test('loadConfig: missing rc yields an empty config', async () => {
  await withTempDir(async (dir) => {
    assert.deepEqual(await loadConfig(dir), {});
  });
});

test('loadConfig: unparseable rc surfaces a warning with the path and parser message', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, RC),
      '{\n  "ignore": [react],\n  "validate": "pnpm -r build"\n}\n',
    );
    const config = await loadConfig(dir);
    assert.equal(config.warnings?.length, 1);
    assert.ok(config.warnings[0].includes(path.join(dir, RC)), config.warnings[0]);
    assert.match(config.warnings[0], /failed to parse [\s\S]*JSON/);
    assert.equal(config.validate, undefined);
  });
});

test('loadConfig: accepts the README jsonc form (comments, trailing commas, BOM)', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, RC),
      '\uFEFF{\n' +
        '  // never touch react\n' +
        '  "ignore": ["react", "a//b", "c/*d*/",],\n' +
        '  /* block\n     comment */\n' +
        '  "validate": "pnpm -r build", // trailing\n' +
        '  "overrides": [\n' +
        '    { "selector": "lodash@4.17.21", "reason": "has \\"quotes\\", and ,] chars" },\n' +
        '  ],\n' +
        '}\n',
    );
    const config = await loadConfig(dir);
    assert.equal(config.warnings, undefined, String(config.warnings));
    assert.deepEqual(config.ignore, ['react', 'a//b', 'c/*d*/']);
    assert.equal(config.validate, 'pnpm -r build');
    assert.deepEqual(config.overrides, [
      { chain: ['lodash'], range: '4.17.21', reason: 'has "quotes", and ,] chars', source: 'lodash@4.17.21' },
    ]);
  });
});

test('loadConfig: rc root that is not an object is reported', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, RC), '["react"]\n');
    const config = await loadConfig(dir);
    assert.ok(config.warnings?.some((w) => /object/.test(w)), String(config.warnings));
  });
});

test('loadConfig: string `ignore` is coerced to a one-element list with a warning', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, RC), JSON.stringify({ ignore: 'react', validate: 'tsc --noEmit' }));
    const config = await loadConfig(dir);
    assert.deepEqual(config.ignore, ['react']);
    assert.equal(config.validate, 'tsc --noEmit');
    assert.ok(config.warnings?.some((w) => w.includes('ignore')), String(config.warnings));
  });
});

test('loadConfig: non-string `ignore` entries are dropped with a warning', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, RC), JSON.stringify({ ignore: ['react', 42, null, 'vue'] }));
    const config = await loadConfig(dir);
    assert.deepEqual(config.ignore, ['react', 'vue']);
    assert.ok(config.warnings?.some((w) => w.includes('ignore')), String(config.warnings));
  });
});

test('loadConfig: an invalid `ignore` does not stop the other sections from being normalized', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, RC),
      JSON.stringify({
        ignore: { react: true },
        validate: '  tsc -p tsconfig.json --noEmit  ',
        linkedGroups: [{ id: 'eslint', packages: ['eslint', '@eslint/js'] }],
        overrides: [{ chain: ['qs'], range: '6.14.1' }, { chain: ['missing-range'] }],
      }),
    );
    const config = await loadConfig(dir);
    assert.deepEqual(config.ignore, []);
    assert.equal(config.validate, 'tsc -p tsconfig.json --noEmit');
    assert.deepEqual(config.linkedGroups, [{ id: 'eslint', packages: ['eslint', '@eslint/js'] }]);
    assert.deepEqual(config.overrides, [{ chain: ['qs'], range: '6.14.1' }]);
    assert.ok(config.warnings?.some((w) => w.includes('ignore')), String(config.warnings));
    assert.ok(config.warnings?.some((w) => w.includes('missing')), String(config.warnings));
  });
});

test('appendIgnoreToRc: refuses to rewrite an rc that does not parse', async () => {
  await withTempDir(async (dir) => {
    const raw =
      '{\n  "ignore": [react],\n  "linkedGroups": [{ "id": "eslint", "packages": ["eslint", "@eslint/js"] }]\n}\n';
    await fs.writeFile(path.join(dir, RC), raw);
    await assert.rejects(appendIgnoreToRc(dir, 'axios'), /not valid JSON/);
    assert.equal(await fs.readFile(path.join(dir, RC), 'utf8'), raw, 'rc left untouched');
  });
});

test('appendIgnoreToRc: coerces a string `ignore` and keeps every other section', async () => {
  await withTempDir(async (dir) => {
    const rc = {
      ignore: 'react',
      linkedGroups: [{ id: 'eslint', packages: ['eslint', '@eslint/js'] }],
      validate: { command: 'pnpm test' },
      overrides: [{ selector: 'express>qs@6.14.1', reason: 'CVE-2022-24999' }],
    };
    await fs.writeFile(path.join(dir, RC), JSON.stringify(rc, null, 2));
    await appendIgnoreToRc(dir, 'axios');
    const after = JSON.parse(await fs.readFile(path.join(dir, RC), 'utf8'));
    assert.deepEqual(after.ignore, ['react', 'axios']);
    assert.deepEqual(after.linkedGroups, rc.linkedGroups);
    assert.deepEqual(after.validate, rc.validate);
    assert.deepEqual(after.overrides, rc.overrides);
  });
});

test('appendIgnoreToRc: creates the rc when it does not exist', async () => {
  await withTempDir(async (dir) => {
    await appendIgnoreToRc(dir, 'vue', 'axios');
    const raw = await fs.readFile(path.join(dir, RC), 'utf8');
    assert.equal(raw, '{\n  "ignore": [\n    "vue",\n    "axios"\n  ]\n}\n');
  });
});

test('appendIgnoreToRc: appends without re-sorting and keeps indentation, CRLF and BOM', async () => {
  await withTempDir(async (dir) => {
    const rc = { validate: 'tsc --noEmit', ignore: ['zod', 'react'] };
    await fs.writeFile(
      path.join(dir, RC),
      '\uFEFF' + JSON.stringify(rc, null, '\t').replace(/\n/g, '\r\n') + '\r\n',
    );
    await appendIgnoreToRc(dir, 'axios', 'react');
    const raw = await fs.readFile(path.join(dir, RC), 'utf8');
    const expected = { validate: 'tsc --noEmit', ignore: ['zod', 'react', 'axios'] };
    assert.equal(raw, '\uFEFF' + JSON.stringify(expected, null, '\t').replace(/\n/g, '\r\n') + '\r\n');
  });
});

test('appendIgnoreToRc: accepts trailing commas but refuses to drop comments', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, RC), '{\n  "ignore": ["react",],\n}\n');
    await appendIgnoreToRc(dir, 'axios');
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir, RC), 'utf8')), {
      ignore: ['react', 'axios'],
    });

    const commented = '{\n  // legacy, see #12\n  "ignore": ["react"]\n}\n';
    await fs.writeFile(path.join(dir, RC), commented);
    await assert.rejects(appendIgnoreToRc(dir, 'axios'), /comments/);
    assert.equal(await fs.readFile(path.join(dir, RC), 'utf8'), commented, 'rc left untouched');
  });
});
