/**
 * Unit tests for the audit parser / runner. All tests inject a fake `exec` so no `npm audit`
 * subprocess is ever spawned — we assert exclusively against canned JSON blobs taken from real
 * `npm`, `pnpm`, and `yarn` output.
 *
 * Coverage:
 *   - npm v7+ shape (nested `vulnerabilities.<name>.via[]`)
 *   - yarn classic NDJSON (one `{type: 'auditAdvisory'}` per line)
 *   - yarn berry `yarn npm audit --json` (npm-like object on a single line)
 *   - severity coercion + dedupe
 *   - `guessMinSafe` across common patched_versions shapes
 *   - runAudit swallows errors / empty output
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const audit = await import(path.join(root, 'dist/core/audit.js'));
const { runAudit, parseNpmLikeAudit, parseYarnAudit, maxSeverity, guessMinSafe } = audit;

// ---------------------------------------------------------------------------
// parseNpmLikeAudit
// ---------------------------------------------------------------------------

const NPM_SAMPLE = JSON.stringify({
  vulnerabilities: {
    axios: {
      name: 'axios',
      severity: 'high',
      via: [
        {
          source: 1234,
          name: 'axios',
          title: 'SSRF in axios',
          url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz',
          severity: 'high',
          range: '<1.7.4',
          ghsa_id: 'GHSA-xxxx-yyyy-zzzz',
        },
      ],
      range: '<1.7.4',
      fixAvailable: { name: 'axios', version: '1.7.4' },
    },
    lodash: {
      name: 'lodash',
      severity: 'critical',
      via: [
        {
          source: 5678,
          name: 'lodash',
          title: 'Prototype pollution',
          url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc',
          severity: 'critical',
          range: '<4.17.21',
          cve: ['CVE-2020-8203'],
        },
      ],
      range: '<4.17.21',
      fixAvailable: true,
    },
  },
});

test('parseNpmLikeAudit: extracts axios advisory with fix version', () => {
  const rows = parseNpmLikeAudit(NPM_SAMPLE);
  assert.strictEqual(rows.length, 2);
  const axios = rows.find((r) => r.name === 'axios');
  assert.ok(axios);
  assert.strictEqual(axios.severity, 'high');
  assert.strictEqual(axios.vulnerableRange, '<1.7.4');
  assert.strictEqual(axios.recommendedVersion, '1.7.4');
  assert.match(axios.url, /advisories/);
  assert.ok(axios.ids.includes('GHSA-xxxx-yyyy-zzzz'));
});

test('parseNpmLikeAudit: falls back to range parsing when fixAvailable is a bare boolean', () => {
  const rows = parseNpmLikeAudit(NPM_SAMPLE);
  const lodash = rows.find((r) => r.name === 'lodash');
  assert.ok(lodash);
  // fixAvailable: true gives no version; we fall back to parsing `<4.17.21`.
  assert.strictEqual(lodash.recommendedVersion, '4.17.21');
  assert.strictEqual(lodash.severity, 'critical');
});

test('parseNpmLikeAudit: skips entries with only transitive (string) via', () => {
  const blob = JSON.stringify({
    vulnerabilities: {
      somepkg: {
        name: 'somepkg',
        severity: 'low',
        via: ['axios'], // transitive ref only
        range: '*',
        fixAvailable: true,
      },
    },
  });
  const rows = parseNpmLikeAudit(blob);
  assert.strictEqual(rows.length, 0);
});

test('parseNpmLikeAudit: returns [] on empty / malformed input', () => {
  assert.deepStrictEqual(parseNpmLikeAudit(''), []);
  assert.deepStrictEqual(parseNpmLikeAudit('   \n'), []);
  assert.deepStrictEqual(parseNpmLikeAudit('not json'), []);
});

// ---------------------------------------------------------------------------
// parseYarnAudit
// ---------------------------------------------------------------------------

const YARN_CLASSIC_SAMPLE = [
  JSON.stringify({
    type: 'auditAdvisory',
    data: {
      resolution: { path: 'foo > bar', id: 42 },
      advisory: {
        id: 42,
        name: 'ms',
        title: 'ReDoS in ms',
        url: 'https://npmjs.com/advisories/42',
        severity: 'moderate',
        patched_versions: '>=2.0.0',
        vulnerable_versions: '<2.0.0',
        range: '<2.0.0',
        source: 42,
      },
    },
  }),
  JSON.stringify({ type: 'auditSummary', data: { vulnerabilities: { moderate: 1 } } }),
].join('\n');

test('parseYarnAudit: parses classic NDJSON auditAdvisory lines', () => {
  const rows = parseYarnAudit(YARN_CLASSIC_SAMPLE);
  assert.strictEqual(rows.length, 1);
  const ms = rows[0];
  assert.strictEqual(ms.name, 'ms');
  assert.strictEqual(ms.severity, 'moderate');
  assert.strictEqual(ms.vulnerableRange, '<2.0.0');
  assert.strictEqual(ms.recommendedVersion, '2.0.0');
});

test('parseYarnAudit: handles yarn berry npm-style single-object output', () => {
  const rows = parseYarnAudit(NPM_SAMPLE);
  assert.ok(rows.find((r) => r.name === 'axios'));
  assert.ok(rows.find((r) => r.name === 'lodash'));
});

test('parseYarnAudit: dedupes advisories across lines for the same package', () => {
  const doubled = [YARN_CLASSIC_SAMPLE, YARN_CLASSIC_SAMPLE].join('\n');
  const rows = parseYarnAudit(doubled);
  assert.strictEqual(rows.length, 1, 'same package across lines should merge to one row');
});

// ---------------------------------------------------------------------------
// runAudit
// ---------------------------------------------------------------------------

test('runAudit (npm): returns parsed advisories when command succeeds', async () => {
  const result = await runAudit({
    manager: 'npm',
    cwd: '/tmp',
    exec: async () => ({ stdout: NPM_SAMPLE, exitCode: 1 }), // non-zero exit is normal with vulns
  });
  assert.strictEqual(result.error, undefined);
  assert.strictEqual(result.advisories.length, 2);
});

test('runAudit (yarn): forwards to NDJSON parser', async () => {
  const result = await runAudit({
    manager: 'yarn',
    cwd: '/tmp',
    exec: async () => ({ stdout: YARN_CLASSIC_SAMPLE, exitCode: 1 }),
  });
  assert.strictEqual(result.error, undefined);
  assert.strictEqual(result.advisories.length, 1);
  assert.strictEqual(result.advisories[0].name, 'ms');
});

test('runAudit: non-zero exit + empty stdout → error message', async () => {
  const result = await runAudit({
    manager: 'npm',
    cwd: '/tmp',
    exec: async () => ({ stdout: '', exitCode: 127 }),
  });
  assert.strictEqual(result.advisories.length, 0);
  assert.match(result.error, /exited 127/);
});

test('runAudit: swallows exec throwable', async () => {
  const result = await runAudit({
    manager: 'npm',
    cwd: '/tmp',
    exec: async () => {
      throw new Error('spawn ENOENT');
    },
  });
  assert.strictEqual(result.advisories.length, 0);
  assert.match(result.error, /ENOENT/);
});

test('runAudit: unknown manager returns error', async () => {
  const result = await runAudit({
    manager: 'bun',
    cwd: '/tmp',
    exec: async () => ({ stdout: '', exitCode: 0 }),
  });
  assert.match(result.error, /not supported/);
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

test('maxSeverity: picks the higher rank', () => {
  assert.strictEqual(maxSeverity('low', 'moderate'), 'moderate');
  assert.strictEqual(maxSeverity('high', 'critical'), 'critical');
  assert.strictEqual(maxSeverity('critical', 'low'), 'critical');
  assert.strictEqual(maxSeverity('low', 'low'), 'low');
});

test('guessMinSafe: various range shapes', () => {
  assert.strictEqual(guessMinSafe('<1.2.3'), '1.2.3');
  assert.strictEqual(guessMinSafe('<=1.2.3'), '1.2.3');
  assert.strictEqual(guessMinSafe('>=2.0.0'), '2.0.0');
  assert.strictEqual(guessMinSafe('>1.0.0'), '1.0.0');
  assert.strictEqual(guessMinSafe('>=1.0.0 <2.0.0'), '2.0.0');
  assert.strictEqual(guessMinSafe(undefined), undefined);
  assert.strictEqual(guessMinSafe(''), undefined);
  assert.strictEqual(guessMinSafe('n/a'), undefined);
});
