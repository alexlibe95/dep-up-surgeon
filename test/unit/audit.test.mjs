/**
 * Unit tests for the audit parsers / runner. All tests inject a fake `exec` (plus `fetchVersions`
 * and `lockfileVersions` whenever the registry or a lockfile would be consulted), so no audit
 * subprocess or network request is ever made.
 *
 * Samples are real output from npm 11.19.0, pnpm 10.34.5, yarn 1.22.22, yarn 3.8.7, yarn 4.18.0
 * and bun 1.4.2 on a project pinning express@4.17.1, compression@1.7.4 and lodash@4.17.20 (plus
 * ip@2.0.1), trimmed to a few advisories with the long `overview` / `references` texts dropped.
 *
 * Coverage:
 *   - npm v7+ shape (nested `vulnerabilities.<name>.via[]`), `{ error }` payloads, clean report
 *   - pnpm legacy `advisories` map
 *   - bun `{ "<pkg>": [advisory, ...] }`
 *   - yarn 1 NDJSON, yarn 3 legacy object, yarn 4 `yarn npm audit` tree lines, berry detection
 *   - unrecognized / non-JSON output → `error`, never an empty success
 *   - severity coercion + dedupe, GHSA ids first
 *   - `recommendedVersion` with and without a published-versions list
 */
import assert from 'node:assert';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const audit = await import(path.join(root, 'dist/core/audit.js'));
const { runAudit, parseNpmLikeAudit, parseYarnAudit, maxSeverity, guessMinSafe } = audit;

// Registry stand-in: abridged published version lists around each fix.
const PUBLISHED = {
  lodash: ['4.17.15', '4.17.19', '4.17.20', '4.17.21', '4.17.23', '4.18.0', '4.18.1'],
  'on-headers': ['1.0.0', '1.0.1', '1.0.2', '1.1.0'],
  qs: ['6.7.0', '6.7.3', '6.14.1', '6.14.2', '6.15.3', '6.16.0'],
};

function fakeRegistry(calls = []) {
  return async (name) => {
    calls.push(name);
    return PUBLISHED[name] ?? [];
  };
}

// ---------------------------------------------------------------------------
// npm
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

test('parseNpmLikeAudit: returns [] on empty / malformed input', () => {
  assert.deepStrictEqual(parseNpmLikeAudit(''), []);
  assert.deepStrictEqual(parseNpmLikeAudit('   \n'), []);
  assert.deepStrictEqual(parseNpmLikeAudit('not json'), []);
});

// Trimmed from npm 11.19.0; the verbatim blob is test/fixtures/14-security-only/audit-npm11-express.json.
const NPM11_SAMPLE = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    compression: {
      name: 'compression',
      severity: 'low',
      isDirect: true,
      via: ['on-headers'],
      effects: [],
      range: '1.0.3 - 1.8.0',
      nodes: ['node_modules/compression'],
      fixAvailable: { name: 'compression', version: '1.8.2', isSemVerMajor: false },
    },
    'on-headers': {
      name: 'on-headers',
      severity: 'low',
      isDirect: false,
      via: [
        {
          source: 1106812,
          name: 'on-headers',
          dependency: 'on-headers',
          title: 'on-headers is vulnerable to http response header manipulation',
          url: 'https://github.com/advisories/GHSA-76c9-3jph-rj3q',
          severity: 'low',
          cwe: ['CWE-241'],
          cvss: { score: 3.4, vectorString: 'CVSS:3.1/AV:L/AC:L/PR:H/UI:N/S:U/C:L/I:L/A:N' },
          range: '<1.1.0',
        },
      ],
      effects: ['compression'],
      range: '<1.1.0',
      nodes: ['node_modules/on-headers'],
      fixAvailable: { name: 'compression', version: '1.8.2', isSemVerMajor: false },
    },
    qs: {
      name: 'qs',
      severity: 'high',
      isDirect: false,
      via: [
        {
          source: 1104120,
          name: 'qs',
          dependency: 'qs',
          title: 'qs vulnerable to Prototype Pollution',
          url: 'https://github.com/advisories/GHSA-hrpp-h998-j3pp',
          severity: 'high',
          cwe: ['CWE-1321'],
          cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' },
          range: '>=6.7.0 <6.7.3',
        },
        {
          source: 1158507,
          name: 'qs',
          dependency: 'qs',
          title: 'qs: Denial of Service via Attacker Controlled isBuffer',
          url: 'https://github.com/advisories/GHSA-4mjr-xmp4-gh2g',
          severity: 'moderate',
          cwe: ['CWE-248', 'CWE-703'],
          cvss: { score: 5.3, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L' },
          range: '>=2.2.5 <6.16.0',
        },
      ],
      effects: ['body-parser', 'express'],
      range: '<=6.15.3',
      nodes: ['node_modules/qs'],
      fixAvailable: { name: 'express', version: '4.22.2', isSemVerMajor: false },
    },
  },
  metadata: {
    vulnerabilities: { info: 0, low: 5, moderate: 0, high: 5, critical: 1, total: 11 },
    dependencies: { prod: 59, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 58 },
  },
});

test('parseNpmLikeAudit: keeps a direct dep whose via[] only names vulnerable dependencies', () => {
  const compression = parseNpmLikeAudit(NPM11_SAMPLE).find((r) => r.name === 'compression');
  assert.ok(compression, 'compression@1.7.4 (via: ["on-headers"]) must not be dropped');
  assert.strictEqual(compression.severity, 'low');
  assert.strictEqual(compression.vulnerableRange, '1.0.3 - 1.8.0');
  assert.strictEqual(compression.recommendedVersion, '1.8.2');
  // Ids come from the dependency's advisory so reports still say what the bump closes.
  assert.deepStrictEqual(compression.ids, ['GHSA-76c9-3jph-rj3q', 'advisory-1106812']);
});

test('parseNpmLikeAudit: ignores fixAvailable when it names a parent package', () => {
  const rows = parseNpmLikeAudit(NPM11_SAMPLE);
  // qs → { name: 'express', version: '4.22.2' }, on-headers → { name: 'compression', ... }.
  assert.strictEqual(rows.find((r) => r.name === 'qs').recommendedVersion, '6.16.0');
  assert.strictEqual(rows.find((r) => r.name === 'on-headers').recommendedVersion, '1.1.0');
});

test('parseNpmLikeAudit: GHSA ids come from the advisory URL, numeric ids are kept', () => {
  const qs = parseNpmLikeAudit(NPM11_SAMPLE).find((r) => r.name === 'qs');
  assert.deepStrictEqual(qs.ids, [
    'GHSA-hrpp-h998-j3pp',
    'GHSA-4mjr-xmp4-gh2g',
    'advisory-1104120',
    'advisory-1158507',
  ]);
});

test('runAudit (npm): looks up versions only for rows without an npm-named fix', async () => {
  const fetched = [];
  const result = await runAudit({
    manager: 'npm',
    cwd: '/tmp',
    exec: async () => ({ stdout: NPM11_SAMPLE, exitCode: 1 }),
    fetchVersions: fakeRegistry(fetched),
    lockfileVersions: new Map([
      ['qs', new Set(['6.7.0'])],
      ['on-headers', new Set(['1.0.2'])],
    ]),
  });
  assert.strictEqual(result.error, undefined, `unexpected error: ${result.error}`);
  assert.deepStrictEqual(fetched.sort(), ['on-headers', 'qs']);
  const recommended = Object.fromEntries(result.advisories.map((a) => [a.name, a.recommendedVersion]));
  assert.deepStrictEqual(recommended, { compression: '1.8.2', 'on-headers': '1.1.0', qs: '6.16.0' });
});

test('runAudit (npm): an { error } payload is reported, not treated as a clean audit', async () => {
  // Verbatim npm 11.19.0 stdout for a project without a lockfile.
  const enolock = JSON.stringify(
    {
      error: {
        code: 'ENOLOCK',
        summary: 'This command requires an existing lockfile.',
        detail:
          'Try creating one first with: npm i --package-lock-only\nOriginal error: loadVirtual requires existing shrinkwrap file',
      },
    },
    null,
    2,
  );
  const result = await runAudit({
    manager: 'npm',
    cwd: '/tmp',
    exec: async () => ({ stdout: enolock, exitCode: 1 }),
  });
  assert.deepStrictEqual(result.advisories, []);
  assert.match(result.error ?? '', /ENOLOCK: This command requires an existing lockfile/);
});

test('runAudit (npm): a clean report is a success with no advisories', async () => {
  const clean = JSON.stringify(
    {
      auditReportVersion: 2,
      vulnerabilities: {},
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 },
        dependencies: { prod: 2, dev: 0, optional: 0, peer: 0, peerOptional: 0, total: 1 },
      },
    },
    null,
    2,
  );
  const result = await runAudit({
    manager: 'npm',
    cwd: '/tmp',
    exec: async () => ({ stdout: clean, exitCode: 0 }),
  });
  assert.strictEqual(result.error, undefined);
  assert.deepStrictEqual(result.advisories, []);
});

// ---------------------------------------------------------------------------
// pnpm (legacy npm v6 report)
// ---------------------------------------------------------------------------

const LEGACY_ON_HEADERS = {
  findings: [{ version: '1.0.2', paths: ['.>compression>on-headers'] }],
  found_by: null,
  deleted: null,
  created: '2025-07-17T21:17:19.000Z',
  id: 1106812,
  npm_advisory_id: null,
  reported_by: null,
  title: 'on-headers is vulnerable to http response header manipulation',
  metadata: null,
  cves: ['CVE-2025-7339'],
  access: 'public',
  severity: 'low',
  module_name: 'on-headers',
  vulnerable_versions: '<1.1.0',
  github_advisory_id: 'GHSA-76c9-3jph-rj3q',
  recommendation: 'Upgrade to version 1.1.0 or later',
  patched_versions: '>=1.1.0',
  updated: '2025-07-30T21:06:13.000Z',
  cvss: { score: 3.4, vectorString: 'CVSS:3.1/AV:L/AC:L/PR:H/UI:N/S:U/C:L/I:L/A:N' },
  cwe: ['CWE-241'],
  url: 'https://github.com/advisories/GHSA-76c9-3jph-rj3q',
};

const LEGACY_LODASH_COMMAND_INJECTION = {
  findings: [{ version: '4.17.20', paths: ['.>lodash'] }],
  found_by: null,
  deleted: null,
  created: '2021-05-06T16:05:51.000Z',
  id: 1106913,
  npm_advisory_id: null,
  reported_by: null,
  title: 'Command Injection in lodash',
  metadata: null,
  cves: ['CVE-2021-23337'],
  access: 'public',
  severity: 'high',
  module_name: 'lodash',
  vulnerable_versions: '<4.17.21',
  github_advisory_id: 'GHSA-35jh-r3h4-6jhm',
  recommendation: 'Upgrade to version 4.17.21 or later',
  patched_versions: '>=4.17.21',
  updated: '2025-08-12T21:44:25.000Z',
  cvss: { score: 7.2, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H' },
  cwe: ['CWE-77', 'CWE-94'],
  url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm',
};

const LEGACY_LODASH_TEMPLATE = {
  findings: [{ version: '4.17.20', paths: ['.>lodash'] }],
  found_by: null,
  deleted: null,
  created: '2026-04-01T23:51:12.000Z',
  id: 1115806,
  npm_advisory_id: null,
  reported_by: null,
  title: 'lodash vulnerable to Code Injection via `_.template` imports key names',
  metadata: null,
  cves: ['CVE-2026-4800'],
  access: 'public',
  severity: 'high',
  module_name: 'lodash',
  vulnerable_versions: '>=4.0.0 <=4.17.23',
  github_advisory_id: 'GHSA-r5fr-rjxr-66jc',
  recommendation: 'Upgrade to version 4.18.0 or later',
  patched_versions: '>=4.18.0',
  updated: '2026-04-01T23:51:13.000Z',
  cvss: { score: 8.1, vectorString: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H' },
  cwe: ['CWE-94'],
  url: 'https://github.com/advisories/GHSA-r5fr-rjxr-66jc',
};

// Trimmed from pnpm 10.34.5 `pnpm audit --json`.
const PNPM_SAMPLE = JSON.stringify(
  {
    actions: [],
    advisories: {
      1106812: LEGACY_ON_HEADERS,
      1106913: LEGACY_LODASH_COMMAND_INJECTION,
      1115806: LEGACY_LODASH_TEMPLATE,
    },
    muted: [],
    metadata: {
      vulnerabilities: { info: 0, low: 7, moderate: 6, high: 7, critical: 0 },
      dependencies: 59,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 59,
    },
  },
  null,
  2,
);

test('runAudit (pnpm): parses the legacy advisories map', async () => {
  let invoked = [];
  const result = await runAudit({
    manager: 'pnpm',
    cwd: '/tmp',
    exec: async (bin, args) => {
      invoked = [bin, ...args];
      return { stdout: PNPM_SAMPLE, exitCode: 1 };
    },
    fetchVersions: fakeRegistry(),
    lockfileVersions: new Map(),
  });
  assert.deepStrictEqual(invoked, ['pnpm', 'audit', '--json']);
  assert.strictEqual(result.error, undefined, `unexpected error: ${result.error}`);
  assert.deepStrictEqual(result.advisories.map((a) => a.name).sort(), ['lodash', 'on-headers']);

  const lodash = result.advisories.find((a) => a.name === 'lodash');
  assert.strictEqual(lodash.severity, 'high');
  assert.strictEqual(lodash.title, 'Command Injection in lodash');
  assert.strictEqual(lodash.url, 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm');
  assert.deepStrictEqual(lodash.ids, [
    'GHSA-35jh-r3h4-6jhm',
    'GHSA-r5fr-rjxr-66jc',
    'CVE-2021-23337',
    'CVE-2026-4800',
    'advisory-1106913',
    'advisory-1115806',
  ]);
  assert.strictEqual(lodash.vulnerableRange, '<4.17.21 || >=4.0.0 <=4.17.23');
  // 4.17.21 fixes the first advisory but is still inside `>=4.0.0 <=4.17.23`.
  assert.strictEqual(lodash.recommendedVersion, '4.18.0');

  const onHeaders = result.advisories.find((a) => a.name === 'on-headers');
  assert.strictEqual(onHeaders.severity, 'low');
  assert.strictEqual(onHeaders.recommendedVersion, '1.1.0');
});

test('parseNpmLikeAudit (pnpm): every advisory of a package counts, not just the first', () => {
  const lodash = parseNpmLikeAudit(PNPM_SAMPLE).find((r) => r.name === 'lodash');
  assert.ok(lodash);
  // No registry: patched `>=4.17.21` is still vulnerable per the second advisory, `>=4.18.0` isn't.
  assert.strictEqual(lodash.recommendedVersion, '4.18.0');
});

test('runAudit (pnpm): ERR_PNPM_AUDIT_NO_LOCKFILE payload is an error', async () => {
  // Verbatim pnpm 10.34.5 stdout.
  const noLockfile = JSON.stringify(
    {
      error: {
        code: 'ERR_PNPM_AUDIT_NO_LOCKFILE',
        message: 'No pnpm-lock.yaml found: Cannot audit a project without a lockfile',
      },
    },
    null,
    2,
  );
  const result = await runAudit({
    manager: 'pnpm',
    cwd: '/tmp',
    exec: async () => ({ stdout: noLockfile, exitCode: 1 }),
  });
  assert.deepStrictEqual(result.advisories, []);
  assert.match(result.error ?? '', /ERR_PNPM_AUDIT_NO_LOCKFILE: No pnpm-lock.yaml found/);
});

test('runAudit (pnpm): a clean report is a success', async () => {
  const clean = JSON.stringify(
    {
      actions: [],
      advisories: {},
      muted: [],
      metadata: {
        vulnerabilities: { info: 0, low: 0, moderate: 0, high: 0, critical: 0 },
        dependencies: 2,
        devDependencies: 0,
        optionalDependencies: 0,
        totalDependencies: 2,
      },
    },
    null,
    2,
  );
  const result = await runAudit({
    manager: 'pnpm',
    cwd: '/tmp',
    exec: async () => ({ stdout: clean, exitCode: 0 }),
  });
  assert.strictEqual(result.error, undefined);
  assert.deepStrictEqual(result.advisories, []);
});

// ---------------------------------------------------------------------------
// bun
// ---------------------------------------------------------------------------

// Trimmed from bun 1.4.2 `bun audit --json`.
const BUN_SAMPLE = JSON.stringify({
  lodash: [
    {
      id: 1106913,
      url: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm',
      title: 'Command Injection in lodash',
      severity: 'high',
      vulnerable_versions: '<4.17.21',
      cwe: ['CWE-77', 'CWE-94'],
      cvss: { score: 7.2, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:H/UI:N/S:U/C:H/I:H/A:H' },
    },
    {
      id: 1108258,
      url: 'https://github.com/advisories/GHSA-29mw-wpgm-hmr9',
      title: 'Regular Expression Denial of Service (ReDoS) in lodash',
      severity: 'moderate',
      vulnerable_versions: '>=4.0.0 <4.17.21',
      cwe: ['CWE-400', 'CWE-1333'],
      cvss: { score: 5.3, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:L' },
    },
    {
      id: 1120370,
      url: 'https://github.com/advisories/GHSA-xxjr-mmjv-4gpg',
      title: 'Lodash has Prototype Pollution Vulnerability in `_.unset` and `_.omit` functions',
      severity: 'moderate',
      vulnerable_versions: '>=4.0.0 <=4.17.22',
      cwe: ['CWE-1321'],
      cvss: { score: 6.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:L' },
    },
    {
      id: 1115806,
      url: 'https://github.com/advisories/GHSA-r5fr-rjxr-66jc',
      title: 'lodash vulnerable to Code Injection via `_.template` imports key names',
      severity: 'high',
      vulnerable_versions: '>=4.0.0 <=4.17.23',
      cwe: ['CWE-94'],
      cvss: { score: 8.1, vectorString: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H' },
    },
    {
      id: 1115810,
      url: 'https://github.com/advisories/GHSA-f23m-r3pf-42rh',
      title: 'lodash vulnerable to Prototype Pollution via array path bypass in `_.unset` and `_.omit`',
      severity: 'moderate',
      vulnerable_versions: '<=4.17.23',
      cwe: ['CWE-1321'],
      cvss: { score: 6.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:L' },
    },
  ],
  'on-headers': [
    {
      id: 1106812,
      url: 'https://github.com/advisories/GHSA-76c9-3jph-rj3q',
      title: 'on-headers is vulnerable to http response header manipulation',
      severity: 'low',
      vulnerable_versions: '<1.1.0',
      cwe: ['CWE-241'],
      cvss: { score: 3.4, vectorString: 'CVSS:3.1/AV:L/AC:L/PR:H/UI:N/S:U/C:L/I:L/A:N' },
    },
  ],
});

test('runAudit (bun): parses per-package advisory arrays', async () => {
  let invoked = [];
  const result = await runAudit({
    manager: 'bun',
    cwd: '/tmp',
    exec: async (bin, args) => {
      invoked = [bin, ...args];
      return { stdout: BUN_SAMPLE, exitCode: 1 };
    },
    fetchVersions: fakeRegistry(),
    lockfileVersions: new Map([
      ['lodash', new Set(['4.17.20'])],
      ['on-headers', new Set(['1.0.2'])],
    ]),
  });
  assert.deepStrictEqual(invoked, ['bun', 'audit', '--json']);
  assert.strictEqual(result.error, undefined, `unexpected error: ${result.error}`);

  const lodash = result.advisories.find((a) => a.name === 'lodash');
  assert.ok(lodash);
  assert.strictEqual(lodash.severity, 'high');
  assert.strictEqual(lodash.ids[0], 'GHSA-35jh-r3h4-6jhm');
  assert.ok(lodash.ids.includes('GHSA-f23m-r3pf-42rh'));
  assert.ok(lodash.ids.includes('advisory-1115810'));
  // Lowest published version outside all five ranges and above the lockfile's 4.17.20.
  assert.strictEqual(lodash.recommendedVersion, '4.18.0');

  const onHeaders = result.advisories.find((a) => a.name === 'on-headers');
  assert.strictEqual(onHeaders.severity, 'low');
  assert.strictEqual(onHeaders.vulnerableRange, '<1.1.0');
  assert.strictEqual(onHeaders.recommendedVersion, '1.1.0');
});

test('parseNpmLikeAudit (bun): no recommendation unless a version is provably safe', () => {
  const rows = parseNpmLikeAudit(BUN_SAMPLE);
  // The only `<X` bound (4.17.21) is inside `<=4.17.23`; naming 4.18.0 needs the registry.
  assert.strictEqual(rows.find((r) => r.name === 'lodash').recommendedVersion, undefined);
  assert.strictEqual(rows.find((r) => r.name === 'on-headers').recommendedVersion, '1.1.0');
});

test('runAudit (bun): {} is a clean report', async () => {
  const result = await runAudit({
    manager: 'bun',
    cwd: '/tmp',
    exec: async () => ({ stdout: '{}\n', exitCode: 0 }),
  });
  assert.strictEqual(result.error, undefined);
  assert.deepStrictEqual(result.advisories, []);
});

test('runAudit (bun): output in another manager\'s shape is an error, not a clean audit', async () => {
  const result = await runAudit({
    manager: 'bun',
    cwd: '/tmp',
    exec: async () => ({ stdout: NPM_SAMPLE, exitCode: 1 }),
  });
  assert.deepStrictEqual(result.advisories, []);
  assert.match(result.error ?? '', /unrecognized bun audit output/);
});

// ---------------------------------------------------------------------------
// yarn
// ---------------------------------------------------------------------------

/** yarn 1 prints the registry's legacy advisory once per dependency path. */
function yarnAdvisoryLine(advisory, resolutionPath) {
  return JSON.stringify({
    type: 'auditAdvisory',
    data: {
      resolution: { id: advisory.id, path: resolutionPath, dev: false, optional: false, bundled: false },
      advisory,
    },
  });
}

const YARN_QS_ADVISORY = {
  findings: [{ version: '6.7.0', paths: ['express>qs', 'express>body-parser>qs'] }],
  found_by: null,
  deleted: null,
  created: '2022-11-27T00:30:50.000Z',
  id: 1104120,
  npm_advisory_id: null,
  reported_by: null,
  title: 'qs vulnerable to Prototype Pollution',
  metadata: null,
  cves: ['CVE-2022-24999'],
  access: 'public',
  severity: 'high',
  module_name: 'qs',
  vulnerable_versions: '>=6.7.0 <6.7.3',
  github_advisory_id: 'GHSA-hrpp-h998-j3pp',
  recommendation: 'Upgrade to version 6.7.3 or later',
  patched_versions: '>=6.7.3',
  updated: '2025-04-29T15:41:45.000Z',
  cvss: { score: 7.5, vectorString: 'CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H' },
  cwe: ['CWE-1321'],
  url: 'https://github.com/advisories/GHSA-hrpp-h998-j3pp',
};

// ip has no patched release: yarn reports `patched_versions: "<0.0.0"`.
const YARN_IP_ADVISORY = {
  findings: [{ version: '2.0.1', paths: ['ip'] }],
  found_by: null,
  deleted: null,
  created: '2024-06-02T22:29:29.000Z',
  id: 1101851,
  npm_advisory_id: null,
  reported_by: null,
  title: 'ip SSRF improper categorization in isPublic',
  metadata: null,
  cves: ['CVE-2024-29415'],
  access: 'public',
  severity: 'high',
  module_name: 'ip',
  vulnerable_versions: '<=2.0.1',
  github_advisory_id: 'GHSA-2p57-rm9w-gvfp',
  recommendation: 'None',
  patched_versions: '<0.0.0',
  updated: '2025-01-17T21:31:39.000Z',
  cvss: { score: 8.1, vectorString: 'CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H' },
  cwe: ['CWE-918'],
  url: 'https://github.com/advisories/GHSA-2p57-rm9w-gvfp',
};

const yarnLodash = (advisory) => ({ ...advisory, findings: [{ version: '4.17.20', paths: ['lodash'] }] });

// Trimmed from yarn 1.22.22 `yarn audit --json`.
const YARN_CLASSIC_SAMPLE = [
  yarnAdvisoryLine(YARN_QS_ADVISORY, 'express>qs'),
  yarnAdvisoryLine(YARN_QS_ADVISORY, 'express>body-parser>qs'),
  yarnAdvisoryLine(yarnLodash(LEGACY_LODASH_COMMAND_INJECTION), 'lodash'),
  yarnAdvisoryLine(yarnLodash(LEGACY_LODASH_TEMPLATE), 'lodash'),
  JSON.stringify({
    type: 'auditSummary',
    data: {
      vulnerabilities: { info: 0, low: 9, moderate: 8, high: 8, critical: 0 },
      dependencies: 58,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 58,
    },
  }),
].join('\n');

test('runAudit (yarn 1): runs `yarn audit --json` and parses auditAdvisory lines', async () => {
  const calls = [];
  const result = await runAudit({
    manager: 'yarn',
    cwd: '/tmp',
    yarnMajorVersion: 1,
    exec: async (bin, args) => {
      calls.push([bin, ...args]);
      return { stdout: YARN_CLASSIC_SAMPLE, exitCode: 12 };
    },
    fetchVersions: fakeRegistry(),
    lockfileVersions: new Map(),
  });
  assert.deepStrictEqual(calls, [['yarn', 'audit', '--json']]);
  assert.strictEqual(result.error, undefined, `unexpected error: ${result.error}`);
  assert.deepStrictEqual(result.advisories.map((a) => a.name), ['qs', 'lodash']);

  const [qs, lodash] = result.advisories;
  assert.strictEqual(qs.severity, 'high');
  // The same advisory repeated for each dependency path collapses into one row.
  assert.deepStrictEqual(qs.ids, ['GHSA-hrpp-h998-j3pp', 'CVE-2022-24999', 'advisory-1104120']);
  assert.strictEqual(qs.vulnerableRange, '>=6.7.0 <6.7.3');
  assert.strictEqual(qs.recommendedVersion, '6.7.3');
  assert.strictEqual(lodash.recommendedVersion, '4.18.0');
});

test('runAudit (yarn): probes `yarn --version` to pick the classic command', async () => {
  const calls = [];
  const result = await runAudit({
    manager: 'yarn',
    cwd: '/tmp',
    exec: async (bin, args) => {
      calls.push(args);
      return args[0] === '--version'
        ? { stdout: '1.22.22\n', exitCode: 0 }
        : { stdout: YARN_CLASSIC_SAMPLE, exitCode: 12 };
    },
    fetchVersions: fakeRegistry(),
    lockfileVersions: new Map(),
  });
  assert.deepStrictEqual(calls, [['--version'], ['audit', '--json']]);
  assert.strictEqual(result.advisories.length, 2);
});

test('parseYarnAudit (yarn 1): the "<0.0.0" patched marker means there is no fix', () => {
  const rows = parseYarnAudit(yarnAdvisoryLine(YARN_IP_ADVISORY, 'ip'));
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].name, 'ip');
  assert.strictEqual(rows[0].vulnerableRange, '<=2.0.1');
  assert.strictEqual(rows[0].recommendedVersion, undefined);
});

test('parseYarnAudit (yarn 1): a patched union picks the fix above the installed version', () => {
  // Real line shape with hypothetical ranges for a fix back-ported to 1.x and 2.x.
  const line = (installed) =>
    yarnAdvisoryLine(
      {
        ...YARN_IP_ADVISORY,
        module_name: 'example-pkg',
        findings: [{ version: installed, paths: ['example-pkg'] }],
        vulnerable_versions: '<1.2.3 || >=2.0.0 <2.1.0',
        patched_versions: '>=1.2.3 <2.0.0 || >=2.1.0',
      },
      'example-pkg',
    );
  assert.strictEqual(parseYarnAudit(line('1.0.0'))[0].recommendedVersion, '1.2.3');
  assert.strictEqual(parseYarnAudit(line('2.0.5'))[0].recommendedVersion, '2.1.0');
});

// Trimmed from yarn 4.18.0 `yarn npm audit --json --all --recursive`: one tree node per line.
// The left-pad line is from a second project; berry lists deprecations next to advisories.
const YARN_BERRY_SAMPLE = [
  JSON.stringify({
    value: 'lodash',
    children: {
      ID: 1106913,
      Issue: 'Command Injection in lodash',
      URL: 'https://github.com/advisories/GHSA-35jh-r3h4-6jhm',
      Severity: 'high',
      'Vulnerable Versions': '<4.17.21',
      'Tree Versions': ['4.17.20'],
      Dependents: ['yarn4-audit-sample@workspace:.'],
    },
  }),
  JSON.stringify({
    value: 'lodash',
    children: {
      ID: 1115806,
      Issue: 'lodash vulnerable to Code Injection via `_.template` imports key names',
      URL: 'https://github.com/advisories/GHSA-r5fr-rjxr-66jc',
      Severity: 'high',
      'Vulnerable Versions': '>=4.0.0 <=4.17.23',
      'Tree Versions': ['4.17.20'],
      Dependents: ['yarn4-audit-sample@workspace:.'],
    },
  }),
  JSON.stringify({
    value: 'on-headers',
    children: {
      ID: 1106812,
      Issue: 'on-headers is vulnerable to http response header manipulation',
      URL: 'https://github.com/advisories/GHSA-76c9-3jph-rj3q',
      Severity: 'low',
      'Vulnerable Versions': '<1.1.0',
      'Tree Versions': ['1.0.2'],
      Dependents: ['compression@npm:1.7.4'],
    },
  }),
  JSON.stringify({
    value: 'left-pad',
    children: {
      ID: 'left-pad (deprecation)',
      Issue: 'use String.prototype.padStart()',
      Severity: 'moderate',
      'Vulnerable Versions': '1.3.0',
      'Tree Versions': ['1.3.0'],
      Dependents: ['c@workspace:.'],
    },
  }),
].join('\n');

test('runAudit (yarn 4): runs `yarn npm audit` and parses tree lines', async () => {
  const calls = [];
  const result = await runAudit({
    manager: 'yarn',
    cwd: '/tmp',
    yarnMajorVersion: 4,
    exec: async (bin, args) => {
      calls.push([bin, ...args]);
      return { stdout: YARN_BERRY_SAMPLE, exitCode: 1 };
    },
    fetchVersions: fakeRegistry(),
    lockfileVersions: new Map(),
  });
  assert.deepStrictEqual(calls, [['yarn', 'npm', 'audit', '--json', '--all', '--recursive']]);
  assert.strictEqual(result.error, undefined, `unexpected error: ${result.error}`);
  // Deprecation notices are not vulnerabilities.
  assert.deepStrictEqual(result.advisories.map((a) => a.name), ['lodash', 'on-headers']);

  const [lodash, onHeaders] = result.advisories;
  assert.strictEqual(lodash.severity, 'high');
  assert.deepStrictEqual(lodash.ids, [
    'GHSA-35jh-r3h4-6jhm',
    'GHSA-r5fr-rjxr-66jc',
    'advisory-1106913',
    'advisory-1115806',
  ]);
  assert.strictEqual(lodash.vulnerableRange, '<4.17.21 || >=4.0.0 <=4.17.23');
  assert.strictEqual(lodash.recommendedVersion, '4.18.0');
  assert.strictEqual(onHeaders.recommendedVersion, '1.1.0');
});

test('runAudit (yarn): probes `yarn --version` to pick the berry command', async () => {
  const calls = [];
  const result = await runAudit({
    manager: 'yarn',
    cwd: '/tmp',
    exec: async (bin, args) => {
      calls.push(args);
      // Berry prints nothing at all for a clean project.
      return args[0] === '--version' ? { stdout: '4.18.0\n', exitCode: 0 } : { stdout: '', exitCode: 0 };
    },
  });
  assert.deepStrictEqual(calls, [['--version'], ['npm', 'audit', '--json', '--all', '--recursive']]);
  assert.strictEqual(result.error, undefined);
  assert.deepStrictEqual(result.advisories, []);
});

test('runAudit (yarn): berry rejecting `yarn audit` is an error, not an empty success', async () => {
  // Verbatim yarn 4.18.0 stdout for `yarn audit --json`.
  const usageError =
    'Usage Error: Couldn\'t find a script named "audit".\n\n$ yarn run [--inspect] [--inspect-brk] [-T,--top-level] [-B,--binaries-only] [--require #0] <scriptName> ...\n';
  const result = await runAudit({
    manager: 'yarn',
    cwd: '/tmp',
    yarnMajorVersion: 1,
    exec: async () => ({ stdout: usageError, exitCode: 1 }),
  });
  assert.deepStrictEqual(result.advisories, []);
  assert.match(result.error ?? '', /unrecognized yarn audit output: Usage Error/);
});

test('runAudit (yarn 3): parses the legacy report printed on a single line', async () => {
  // Trimmed from yarn 3.8.7 `yarn npm audit --json --all --recursive`.
  const stdout = `${JSON.stringify({
    actions: [],
    advisories: {
      1106812: { ...LEGACY_ON_HEADERS, findings: [{ version: '1.0.2', paths: ['compression>on-headers'] }] },
    },
    muted: [],
    metadata: {
      vulnerabilities: { info: 0, low: 1, moderate: 3, high: 2, critical: 0 },
      dependencies: 13,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 13,
    },
  })}\n`;
  const result = await runAudit({
    manager: 'yarn',
    cwd: '/tmp',
    yarnMajorVersion: 3,
    exec: async () => ({ stdout, exitCode: 1 }),
    fetchVersions: fakeRegistry(),
    lockfileVersions: new Map(),
  });
  assert.strictEqual(result.error, undefined, `unexpected error: ${result.error}`);
  assert.deepStrictEqual(
    result.advisories.map((a) => [a.name, a.severity, a.recommendedVersion]),
    [['on-headers', 'low', '1.1.0']],
  );
});

// ---------------------------------------------------------------------------
// runAudit
// ---------------------------------------------------------------------------

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
    manager: /** @type {any} */ ('unknown'),
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

test('guessMinSafe: returns only versions provably outside the vulnerable range', () => {
  assert.strictEqual(guessMinSafe('<1.2.3'), '1.2.3');
  assert.strictEqual(guessMinSafe('>=1.0.0 <2.0.0'), '2.0.0');
  assert.strictEqual(guessMinSafe('>=6.7.0 <6.7.3 || <6.14.1'), '6.14.1');
  // Inclusive or open-ended upper bounds: the bound itself is vulnerable.
  assert.strictEqual(guessMinSafe('<=0.2.3'), undefined);
  assert.strictEqual(guessMinSafe('<=1.2.3'), undefined);
  assert.strictEqual(guessMinSafe('>=4.0.0 <=4.17.23'), undefined);
  assert.strictEqual(guessMinSafe('>=0.0.0'), undefined);
  assert.strictEqual(guessMinSafe('>=2.0.0'), undefined);
  assert.strictEqual(guessMinSafe('>1.0.0'), undefined);
  assert.strictEqual(guessMinSafe(undefined), undefined);
  assert.strictEqual(guessMinSafe(''), undefined);
  assert.strictEqual(guessMinSafe('n/a'), undefined);
});
