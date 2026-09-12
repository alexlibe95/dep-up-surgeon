/**
 * `.npmrc` → pacote options. pacote doesn't read npm config itself, so without this every
 * registry lookup ignored mirrors, scoped registries and auth tokens.
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { parseNpmrc, initRegistryOptions } = await import(path.join(root, 'dist/utils/npmConfig.js'));

test('parseNpmrc: comments, quotes and ${ENV} expansion', () => {
  const cfg = parseNpmrc(
    [
      '; comment',
      '# another comment',
      'registry = "https://mirror.example.com/"',
      '@acme:registry=https://npm.acme.dev/',
      '//npm.acme.dev/:_authToken=${ACME_TOKEN}',
      'optional=${MISSING?}',
      'literal=${MISSING}',
    ].join('\n'),
    { ACME_TOKEN: 's3cret' },
  );
  assert.strictEqual(cfg.registry, 'https://mirror.example.com/');
  assert.strictEqual(cfg['@acme:registry'], 'https://npm.acme.dev/');
  assert.strictEqual(cfg['//npm.acme.dev/:_authToken'], 's3cret');
  assert.strictEqual(cfg.optional, '');
  assert.strictEqual(cfg.literal, '${MISSING}');
});

test('initRegistryOptions: project .npmrc beats user config; npm_config_* env beats both', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dus-npmrc-'));
  const userrc = path.join(dir, 'user.npmrc');
  const project = path.join(dir, 'project');
  await fs.mkdir(project);
  await fs.writeFile(
    userrc,
    'registry=https://user.example/\n@acme:registry=https://user-acme.example/\nstrict-ssl=false\n',
  );
  await fs.writeFile(
    path.join(project, '.npmrc'),
    'registry=https://project.example/\n//npm.acme.dev/:_authToken=tok\n',
  );

  const opts = initRegistryOptions(project, {
    npm_config_userconfig: userrc,
    npm_config_globalconfig: path.join(dir, 'missing-global-npmrc'),
    'npm_config_@acme:registry': 'https://env-acme.example/',
  });

  assert.strictEqual(opts.registry, 'https://project.example/');
  assert.strictEqual(opts['@acme:registry'], 'https://env-acme.example/');
  assert.strictEqual(opts['//npm.acme.dev/:_authToken'], 'tok');
  assert.strictEqual(opts.strictSSL, false);
  // Settings that don't affect fetching are not forwarded to pacote.
  assert.strictEqual(opts.userconfig, undefined);
});
