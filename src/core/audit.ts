/**
 * Run `<manager> audit --json`, parse the output, and return a normalized list of vulnerabilities
 * keyed by package name. Used by `--security-only` to filter the upgrade plan down to packages
 * with known advisories — the `dep-up-surgeon` equivalent of Dependabot's "security alerts".
 *
 * Every manager prints its own shape:
 *   - **npm**  (v7+): `{ vulnerabilities: { "<pkg>": { severity, via: [...], range, fixAvailable } } }`
 *                      where `via[]` holds advisory objects (`{ source, title, url, range }`) and/or
 *                      names of dependencies that make this package vulnerable.
 *   - **pnpm**:        the legacy npm v6 report `{ actions, advisories: { "<id>": { module_name,
 *                      vulnerable_versions, patched_versions, findings, ... } }, metadata }`.
 *   - **bun**:         `{ "<pkg>": [{ id, url, title, severity, vulnerable_versions }] }`.
 *   - **yarn 1**:      `yarn audit --json` NDJSON: one `{ type: 'auditAdvisory', data: { advisory } }`
 *                      per dependency path (advisory in the pnpm shape) plus an `auditSummary`.
 *   - **yarn 2+**:     `yarn npm audit --json` NDJSON: one `{ value: "<pkg>", children: { ID, URL,
 *                      Severity, "Vulnerable Versions", "Tree Versions" } }` per advisory (yarn 4);
 *                      yarn 2/3 print the legacy report object on a single line instead.
 *
 * Design notes:
 *   - Never throws. A missing binary, an `{ error }` payload, or output we don't recognize returns
 *     `{ advisories: [], error }` — an unreadable audit must never look like a clean one.
 *   - Rows are merged per package: highest severity, union of ids (GHSA ids first).
 *   - `recommendedVersion` is npm's `fixAvailable.version` when it names this same package.
 *     Otherwise it's the lowest published version outside every advisory's vulnerable range and
 *     above the installed version; without a version list, only a version provably outside all
 *     ranges (or nothing).
 */
import { execa } from 'execa';
import semver from 'semver';
import { runWithConcurrency } from '../utils/concurrency.js';
import { loadLockfileVersionTree, type LockfileVersionTree } from '../utils/installedVersion.js';
import { fetchAllPublishedVersions } from '../utils/npm.js';
import type { PackageManager } from './workspaces.js';

export type Severity = 'low' | 'moderate' | 'high' | 'critical';

export interface SecurityAdvisory {
  /** Package the advisory applies to: a direct dep to bump, or a transitive to pin via overrides. */
  name: string;
  severity: Severity;
  /** Every advisory id we found (GHSA first, then CVE, then numeric `advisory-<n>` ids). */
  ids: string[];
  /** First non-empty URL (GitHub Advisory / npm advisory). */
  url?: string;
  /** Human-readable advisory title, when the manager exposed one. */
  title?: string;
  /** Vulnerable range, e.g. `<1.2.3` or `>=2.0.0 <2.1.7`. */
  vulnerableRange?: string;
  /** Lowest non-vulnerable version we could determine (absent when none could be proven). */
  recommendedVersion?: string;
}

export interface AuditResult {
  advisories: SecurityAdvisory[];
  /** Populated when the audit could not run or printed something that isn't an audit report. */
  error?: string;
}

export interface RunAuditOptions {
  manager: PackageManager;
  cwd: string;
  /**
   * Inject the actual command execution. Used in tests to pass canned JSON blobs without
   * shelling out. Receives the chosen `bin` and argv and must return `{ stdout, exitCode }`.
   */
  exec?: (
    bin: string,
    args: string[],
    cwd: string,
  ) => Promise<{ stdout: string; exitCode: number; timedOut?: boolean }>;
  /**
   * Major version of the project's yarn (1 = classic, 2+ = berry). Berry has no `yarn audit`, so
   * this picks the command. Probed with `yarn --version` when omitted.
   */
  yarnMajorVersion?: number;
  /**
   * Published versions of a package, used for `recommendedVersion` when the audit doesn't name a
   * fix. Defaults to a registry packument lookup; failures fall back to range analysis.
   */
  fetchVersions?: (name: string) => Promise<string[]>;
  /** Installed versions per package name. Read from the project lockfile when omitted. */
  lockfileVersions?: LockfileVersionTree;
}

type ExecFn = NonNullable<RunAuditOptions['exec']>;

const VERSION_LOOKUP_CONCURRENCY = 8;
const VERSION_LOOKUP_TIMEOUT_MS = 15_000;

/**
 * Public entry point. Picks the right command for the given manager, runs it, parses the output,
 * and returns the normalized advisory list. Never throws.
 */
export async function runAudit(opts: RunAuditOptions): Promise<AuditResult> {
  const exec = opts.exec ?? defaultExec;
  const yarnMajor = opts.manager === 'yarn' ? await detectYarnMajor(opts, exec) : undefined;
  const command = auditCommandFor(opts.manager, yarnMajor);
  if (!command) {
    return { advisories: [], error: `audit is not supported for ${opts.manager}` };
  }

  let stdout = '';
  try {
    const r = await exec(command.bin, command.args, opts.cwd);
    stdout = r.stdout;
    if (r.timedOut) {
      return {
        advisories: [],
        error: `${command.bin} ${command.args.join(' ')} timed out after ${AUDIT_TIMEOUT_MS / 1000}s`,
      };
    }
    // Non-zero exits are normal when vulns are found — we still parse.
    // Only treat a zero-length stdout + non-zero exit as a real error.
    if (!stdout && r.exitCode !== 0) {
      return {
        advisories: [],
        error: `${command.bin} ${command.args.join(' ')} exited ${r.exitCode} with no output`,
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { advisories: [], error: msg };
  }

  let parsed: ParsedAudit;
  try {
    parsed = parseAuditOutput(opts.manager, stdout, yarnMajor);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { advisories: [], error: `failed to parse audit output: ${msg}` };
  }
  if (parsed.error) {
    return { advisories: [], error: parsed.error };
  }
  await lookUpVersions(parsed.entries, opts);
  return { advisories: toAdvisories(parsed.entries) };
}

/**
 * Big trees (e.g. Gatsby, ~2k packages) take well over a minute for `npm audit` to answer; a
 * 60s cap killed it and surfaced as a confusing "exited -1 with no output".
 */
const AUDIT_TIMEOUT_MS = 180_000;

async function defaultExec(
  bin: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; exitCode: number; timedOut: boolean }> {
  const r = await execa(bin, args, { cwd, reject: false, timeout: AUDIT_TIMEOUT_MS });
  return { stdout: r.stdout ?? '', exitCode: r.exitCode ?? -1, timedOut: Boolean(r.timedOut) };
}

async function detectYarnMajor(opts: RunAuditOptions, exec: ExecFn): Promise<number | undefined> {
  if (typeof opts.yarnMajorVersion === 'number') {
    return opts.yarnMajorVersion;
  }
  try {
    const r = await exec('yarn', ['--version'], opts.cwd);
    const m = r.exitCode === 0 ? r.stdout.trim().match(/^(\d+)\./) : null;
    return m ? Number.parseInt(m[1], 10) : undefined;
  } catch {
    return undefined;
  }
}

function auditCommandFor(
  manager: PackageManager,
  yarnMajor?: number,
): { bin: string; args: string[] } | undefined {
  switch (manager) {
    case 'npm':
      // `--omit=dev` is NOT passed: a runtime dep bundling a dev-only vulnerable package would
      // still be visible in the lockfile tree and users generally want to know. Maintainers of
      // security policies can always re-filter later.
      return { bin: 'npm', args: ['audit', '--json'] };
    case 'pnpm':
      return { bin: 'pnpm', args: ['audit', '--json'] };
    case 'yarn':
      // Berry resolves `yarn audit` to a missing script. `--all --recursive` covers every
      // workspace and transitive deps, matching what npm / pnpm audit from the lockfile.
      return (yarnMajor ?? 1) >= 2
        ? { bin: 'yarn', args: ['npm', 'audit', '--json', '--all', '--recursive'] }
        : { bin: 'yarn', args: ['audit', '--json'] };
    case 'bun':
      // bun 1.2+: `{ "<pkg>": [advisory, ...] }`.
      return { bin: 'bun', args: ['audit', '--json'] };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** Everything learned about one package across all of its advisories. */
interface PackageEntry {
  row: SecurityAdvisory;
  /** The package's own vulnerable ranges (never a dependency's). */
  ranges: Set<string>;
  /** Patched ranges, when the manager reports them (legacy report shape). */
  patched: Set<string>;
  /** Installed versions, from the audit output or the lockfile. */
  installed: Set<string>;
  /** npm named a fix for this exact package; trust it over our own range analysis. */
  auditFix: boolean;
  /** Published versions, when the registry lookup succeeded. */
  published?: string[];
}

interface ParsedAudit {
  entries: Map<string, PackageEntry>;
  error?: string;
}

function parseAuditOutput(
  manager: PackageManager,
  stdout: string,
  yarnMajor: number | undefined,
): ParsedAudit {
  const text = stdout.trim();
  if (manager === 'yarn') {
    // `yarn npm audit --json` prints nothing at all for a clean project.
    if (!text && (yarnMajor ?? 1) >= 2) {
      return { entries: new Map() };
    }
    return parseYarnLines(text);
  }
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch {
    return unrecognized(manager, text);
  }
  if (!isRecord(obj)) {
    return unrecognized(manager, text);
  }
  const failure = reportError(obj);
  if (failure) {
    return { entries: new Map(), error: `${manager} audit failed: ${failure}` };
  }
  const entries = manager === 'bun' ? parseBunReport(obj) : parseNpmReport(obj);
  return entries ? { entries } : unrecognized(manager, text);
}

function unrecognized(manager: PackageManager, text: string): ParsedAudit {
  const firstLine = text
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  return {
    entries: new Map(),
    error: firstLine
      ? `unrecognized ${manager} audit output: ${firstLine.slice(0, 200)}`
      : `${manager} audit produced no output`,
  };
}

/** npm and pnpm print `{ "error": { code, summary | message } }` when the audit can't run. */
function reportError(obj: Record<string, unknown>): string | undefined {
  const e = obj.error;
  if (!isRecord(e)) return undefined;
  const parts = [e.code, e.summary ?? e.message].filter(
    (p): p is string => typeof p === 'string' && p.length > 0,
  );
  return parts.length > 0 ? parts.join(': ') : 'unknown error';
}

/**
 * Parse npm, pnpm, or bun `audit --json` output (shape-detected) without registry lookups.
 * Returns `[]` for anything that isn't an audit report; `runAudit` reports those as errors.
 */
export function parseNpmLikeAudit(stdout: string): SecurityAdvisory[] {
  let obj: unknown;
  try {
    obj = JSON.parse(stdout.trim());
  } catch {
    return [];
  }
  if (!isRecord(obj) || reportError(obj)) {
    return [];
  }
  const entries = parseNpmReport(obj) ?? parseBunReport(obj);
  return entries ? toAdvisories(entries) : [];
}

/** Parse yarn 1 / yarn 2+ audit NDJSON without registry lookups. `[]` when unrecognized. */
export function parseYarnAudit(stdout: string): SecurityAdvisory[] {
  const parsed = parseYarnLines(stdout.trim());
  return parsed.error ? [] : toAdvisories(parsed.entries);
}

// ---------------------------------------------------------------------------
// npm / pnpm parser
// ---------------------------------------------------------------------------

interface NpmVulnEntry {
  name?: string;
  severity?: string;
  via?: Array<string | NpmAdvisory>;
  range?: string;
  fixAvailable?: boolean | { name?: string; version?: string };
}

interface NpmAdvisory {
  source?: number | string;
  name?: string;
  title?: string;
  url?: string;
  severity?: string;
  range?: string;
  [k: string]: unknown;
}

/** npm 7+ `vulnerabilities` report; pnpm (and npm 6) print the legacy `advisories` map. */
function parseNpmReport(obj: Record<string, unknown>): Map<string, PackageEntry> | undefined {
  const entries = new Map<string, PackageEntry>();
  if (!isRecord(obj.vulnerabilities)) {
    if (!isRecord(obj.advisories)) return undefined;
    addLegacyReport(entries, obj.advisories);
    return entries;
  }
  const vulns = obj.vulnerabilities as Record<string, NpmVulnEntry>;

  for (const [name, raw] of Object.entries(obj.vulnerabilities)) {
    if (!isRecord(raw)) continue;
    const entry = raw as NpmVulnEntry;
    const own = (entry.via ?? []).filter((v): v is NpmAdvisory => isRecord(v));
    const e = entryFor(
      entries,
      name,
      coerceSeverity(entry.severity) ?? coerceSeverity(own[0]?.severity),
    );
    if (!e) continue;

    // A direct dep can be vulnerable only through its dependencies (`via: ["on-headers"]`). It's
    // still the package to bump, so keep it and borrow those advisories' ids for the report.
    const advisories = own.length > 0 ? own : inheritedAdvisories(vulns, entry);
    for (const a of advisories) {
      mergeDetails(e, {
        ids: advisoryIds(a),
        url: a.url,
        title: a.title,
        // Borrowed advisories describe the dependency's versions, not this package's.
        range: own.length > 0 ? a.range : undefined,
      });
    }
    if (typeof entry.range === 'string' && entry.range) {
      e.ranges.add(entry.range);
    }
    const vulnerableRange = entry.range || own.find((a) => typeof a.range === 'string')?.range;
    if (vulnerableRange && !e.row.vulnerableRange) {
      e.row.vulnerableRange = vulnerableRange;
    }

    // On transitive rows `fixAvailable` names the parent to bump (qs → express@4.22.2); that
    // version means nothing for this package.
    const fix = entry.fixAvailable;
    if (isRecord(fix) && fix.name === name && typeof fix.version === 'string' && semver.valid(fix.version)) {
      e.row.recommendedVersion = fix.version;
      e.auditFix = true;
    }
  }
  return entries;
}

/** Advisory objects reachable through the dependency names in `entry.via` (cycle-safe). */
function inheritedAdvisories(vulns: Record<string, NpmVulnEntry>, entry: NpmVulnEntry): NpmAdvisory[] {
  const out: NpmAdvisory[] = [];
  const seen = new Set<string>();
  const queue = (entry.via ?? []).filter((v): v is string => typeof v === 'string');
  for (let dep = queue.shift(); dep !== undefined; dep = queue.shift()) {
    if (seen.has(dep)) continue;
    seen.add(dep);
    const via = vulns[dep]?.via;
    for (const v of Array.isArray(via) ? via : []) {
      if (typeof v === 'string') queue.push(v);
      else if (isRecord(v)) out.push(v);
    }
  }
  return out;
}

interface LegacyAdvisory {
  module_name?: string;
  severity?: string;
  title?: string;
  url?: string;
  vulnerable_versions?: string;
  patched_versions?: string;
  findings?: Array<{ version?: string }>;
  [k: string]: unknown;
}

/** One legacy (npm v6) advisory: pnpm, yarn 1 `auditAdvisory` lines, yarn 2/3. */
function addLegacyAdvisory(entries: Map<string, PackageEntry>, a: LegacyAdvisory): void {
  const e = entryFor(entries, a.module_name, a.severity);
  if (!e) return;
  mergeDetails(e, {
    ids: advisoryIds(a),
    url: a.url,
    title: a.title,
    range: a.vulnerable_versions,
    patched: a.patched_versions,
    installed: Array.isArray(a.findings) ? a.findings.map((f) => (isRecord(f) ? f.version : undefined)) : [],
  });
}

function addLegacyReport(entries: Map<string, PackageEntry>, advisories: Record<string, unknown>): void {
  for (const a of Object.values(advisories)) {
    if (isRecord(a)) addLegacyAdvisory(entries, a as LegacyAdvisory);
  }
}

// ---------------------------------------------------------------------------
// bun parser
// ---------------------------------------------------------------------------

/** bun: `{ "<pkg>": [{ id, url, title, severity, vulnerable_versions }] }`, `{}` when clean. */
function parseBunReport(obj: Record<string, unknown>): Map<string, PackageEntry> | undefined {
  if (!Object.values(obj).every((v) => Array.isArray(v))) {
    return undefined;
  }
  const entries = new Map<string, PackageEntry>();
  for (const [name, list] of Object.entries(obj) as Array<[string, unknown[]]>) {
    for (const a of list) {
      if (!isRecord(a)) continue;
      const e = entryFor(entries, name, a.severity);
      if (e) {
        mergeDetails(e, { ids: advisoryIds(a), url: a.url, title: a.title, range: a.vulnerable_versions });
      }
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// yarn parser (classic + berry NDJSON)
// ---------------------------------------------------------------------------

function parseYarnLines(text: string): ParsedAudit {
  const entries = new Map<string, PackageEntry>();
  let recognized = false;
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l || l[0] !== '{') {
      continue;
    }
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      continue;
    }
    if (!isRecord(obj)) continue;
    if (obj.type === 'error') {
      return { entries, error: `yarn audit failed: ${String(obj.data)}` };
    }
    if (obj.type === 'auditSummary') {
      recognized = true;
    } else if (obj.type === 'auditAdvisory') {
      recognized = true;
      const advisory = isRecord(obj.data) ? obj.data.advisory : undefined;
      if (isRecord(advisory)) addLegacyAdvisory(entries, advisory as LegacyAdvisory);
    } else if (isRecord(obj.advisories)) {
      // yarn 2/3: the registry's legacy report, verbatim on one line.
      recognized = true;
      addLegacyReport(entries, obj.advisories);
    } else if (typeof obj.value === 'string' && isRecord(obj.children)) {
      recognized = true;
      addBerryNode(entries, obj.value, obj.children);
    }
    // Anything else (`{"type":"info"}`, warnings) is progress noise.
  }
  return recognized ? { entries } : unrecognized('yarn', text);
}

/** yarn 4 tree node: `{ value: "<pkg>", children: { ID, Issue, URL, Severity, ... } }`. */
function addBerryNode(entries: Map<string, PackageEntry>, name: string, node: Record<string, unknown>): void {
  // `yarn npm audit` also lists deprecated packages (`ID: "<pkg> (deprecation)"`).
  if (typeof node.ID === 'string' && node.ID.endsWith('(deprecation)')) return;
  const e = entryFor(entries, name, node.Severity);
  if (!e) return;
  const treeVersions = node['Tree Versions'];
  mergeDetails(e, {
    ids: advisoryIds({ id: node.ID, url: node.URL }),
    url: node.URL,
    title: node.Issue,
    range: node['Vulnerable Versions'],
    installed: Array.isArray(treeVersions) ? treeVersions : [],
  });
}

// ---------------------------------------------------------------------------
// Row assembly
// ---------------------------------------------------------------------------

function entryFor(
  entries: Map<string, PackageEntry>,
  name: unknown,
  severity: unknown,
): PackageEntry | undefined {
  const sev = coerceSeverity(severity);
  if (typeof name !== 'string' || !name || !sev) return undefined;
  const existing = entries.get(name);
  if (existing) {
    existing.row.severity = maxSeverity(existing.row.severity, sev);
    return existing;
  }
  const created: PackageEntry = {
    row: { name, severity: sev, ids: [] },
    ranges: new Set(),
    patched: new Set(),
    installed: new Set(),
    auditFix: false,
  };
  entries.set(name, created);
  return created;
}

function mergeDetails(
  e: PackageEntry,
  d: { ids: string[]; url?: unknown; title?: unknown; range?: unknown; patched?: unknown; installed?: unknown[] },
): void {
  e.row.ids = dedupe([...e.row.ids, ...d.ids]);
  if (!e.row.url && typeof d.url === 'string' && d.url) e.row.url = d.url;
  if (!e.row.title && typeof d.title === 'string' && d.title) e.row.title = d.title;
  if (typeof d.range === 'string' && d.range) e.ranges.add(d.range);
  if (typeof d.patched === 'string' && d.patched) e.patched.add(d.patched);
  for (const v of d.installed ?? []) {
    if (typeof v === 'string') e.installed.add(v);
  }
}

function toAdvisories(entries: Map<string, PackageEntry>): SecurityAdvisory[] {
  return [...entries.values()].map((e) => {
    const row = e.row;
    row.ids.sort((a, b) => idRank(a) - idRank(b));
    if (!row.vulnerableRange && e.ranges.size > 0) {
      row.vulnerableRange = [...e.ranges].join(' || ');
    }
    if (!e.auditFix) {
      const ranges = [...e.ranges];
      const installed = installedFloor(e.installed, ranges);
      const fix = e.published
        ? lowestSafeVersion(e.published, ranges, installed)
        : provableSafeVersion(ranges, [...e.patched], installed);
      if (fix) row.recommendedVersion = fix;
    }
    return row;
  });
}

/** Adds lockfile-installed and registry-published versions for rows without an audit-named fix. */
async function lookUpVersions(entries: Map<string, PackageEntry>, opts: RunAuditOptions): Promise<void> {
  const pending = [...entries.values()].filter((e) => !e.auditFix && e.ranges.size > 0);
  if (pending.length === 0) return;
  const tree = opts.lockfileVersions ?? (await loadLockfileVersionTree(opts.cwd, opts.manager));
  const fetchVersions = opts.fetchVersions ?? ((name: string) => fetchAllPublishedVersions(name));
  await runWithConcurrency(pending, VERSION_LOOKUP_CONCURRENCY, async (e) => {
    for (const v of tree.get(e.row.name) ?? []) e.installed.add(v);
    const published = await publishedVersions(fetchVersions, e.row.name);
    if (published.length > 0) e.published = published;
  });
}

async function publishedVersions(
  fetchVersions: (name: string) => Promise<string[]>,
  name: string,
): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<string[]>((resolve) => {
      timer = setTimeout(() => resolve([]), VERSION_LOOKUP_TIMEOUT_MS);
    });
    const versions = await Promise.race([fetchVersions(name), timeout]);
    return Array.isArray(versions) ? versions : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function coerceSeverity(s: unknown): Severity | undefined {
  if (typeof s !== 'string') return undefined;
  const k = s.toLowerCase();
  return k === 'low' || k === 'moderate' || k === 'high' || k === 'critical' ? k : undefined;
}

const SEVERITY_RANK: Record<Severity, number> = { low: 1, moderate: 2, high: 3, critical: 4 };

export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Parse a user-supplied `--min-severity` value into a canonical `Severity`. Returns
 * `undefined` when the string is empty or doesn't match one of the four canonical tiers,
 * letting callers report a precise error rather than silently accepting `"Critical"` or
 * `"HIGH"` without case normalization.
 */
export function parseMinSeverity(raw: string | undefined): Severity | undefined {
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'low' || trimmed === 'moderate' || trimmed === 'high' || trimmed === 'critical') {
    return trimmed;
  }
  return undefined;
}

/**
 * Filter `advisories` down to entries whose `severity` is at least `minSeverity` on the
 * standard npm-audit rank ladder (`low < moderate < high < critical`). Used by
 * `--security-only --min-severity <level>` to trim the `restrictToNames` set **after**
 * parsing — the parsers themselves preserve everything they find so the filter can be
 * applied once per run and we don't lose data in tests / structured reports.
 *
 * Factored out of `cli.ts` so regression tests can feed in canned advisory lists and
 * assert the exact set the upgrader would receive.
 */
export function filterAdvisoriesBySeverity(
  advisories: SecurityAdvisory[],
  minSeverity: Severity,
): SecurityAdvisory[] {
  const threshold = SEVERITY_RANK[minSeverity];
  return advisories.filter((a) => SEVERITY_RANK[a.severity] >= threshold);
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr)];
}

const GHSA_IN_URL = /GHSA(?:-[0-9a-z]{4}){3}/i;

/** Every id one advisory carries. npm 11 only exposes the GHSA id through the advisory URL. */
function advisoryIds(a: Record<string, unknown>): string[] {
  const out: string[] = [];
  const add = (v: unknown): void => {
    if (typeof v === 'string' && v.trim()) out.push(v.trim());
    else if (typeof v === 'number') out.push(`advisory-${v}`);
    else if (Array.isArray(v)) v.forEach((x) => add(x));
  };
  add(a.github_advisory_id);
  add(a.ghsa_id);
  add(typeof a.url === 'string' ? a.url.match(GHSA_IN_URL)?.[0] : undefined);
  add(a.cve);
  add(a.cves);
  add(a.source);
  add(a.id);
  return dedupe(out);
}

/** Reports and commit messages show `ids[0]`, so cross-referenceable ids go first. */
function idRank(id: string): number {
  return /^GHSA-/i.test(id) ? 0 : /^CVE-/i.test(id) ? 1 : 2;
}

// ---------------------------------------------------------------------------
// Safe-version selection
// ---------------------------------------------------------------------------

/** Highest installed version that is still vulnerable: what a fix has to move past. */
function installedFloor(installed: Set<string>, ranges: string[]): string | undefined {
  return [...installed]
    .filter((v) => semver.valid(v) && ranges.some((r) => semver.satisfies(v, r)))
    .sort(semver.rcompare)[0];
}

/**
 * Lowest stable candidate outside every vulnerable range and above the installed version. When
 * the installed version is unknown it must clear the top of the vulnerable set instead, so the
 * pick is never a downgrade.
 */
function lowestSafeVersion(
  candidates: string[],
  ranges: string[],
  installed: string | undefined,
): string | undefined {
  if (ranges.length === 0 || !ranges.every((r) => semver.validRange(r))) {
    return undefined;
  }
  let aboveFloor: (v: string) => boolean;
  if (installed) {
    aboveFloor = (v) => semver.gt(v, installed);
  } else {
    const top = upperBound(ranges);
    if (!top) return undefined;
    aboveFloor = (v) => (top.inclusive ? semver.gt(v, top.version) : semver.gte(v, top.version));
  }
  return candidates
    .filter((v) => semver.valid(v) && !semver.prerelease(v))
    .sort(semver.compare)
    .find((v) => aboveFloor(v) && !ranges.some((r) => semver.satisfies(v, r)));
}

/** Candidates nameable without the registry: each `<X` bound and each patched clause's minimum. */
function provableSafeVersion(
  ranges: string[],
  patched: string[],
  installed: string | undefined,
): string | undefined {
  const candidates: string[] = [];
  for (const range of ranges.filter((r) => semver.validRange(r))) {
    for (const clause of new semver.Range(range).set) {
      for (const c of clause) {
        if (c.operator === '<' && c.semver instanceof semver.SemVer) candidates.push(c.semver.version);
      }
    }
  }
  for (const range of patched.filter((r) => semver.validRange(r))) {
    for (const clause of new semver.Range(range).set) {
      // The "no fix" marker `<0.0.0` has no minimum.
      const min = semver.minVersion(clause.map((c) => c.value).join(' '));
      if (min) candidates.push(min.version);
    }
  }
  return lowestSafeVersion(candidates, ranges, installed);
}

interface Bound {
  version: string;
  inclusive: boolean;
}

/** Top of the vulnerable set, or `undefined` when some clause has no upper limit (`>=1.0.0`). */
function upperBound(ranges: string[]): Bound | undefined {
  let top: Bound | undefined;
  for (const range of ranges) {
    for (const clause of new semver.Range(range).set) {
      let clauseTop: Bound | undefined;
      for (const c of clause) {
        // `*` parses to an ANY comparator whose `semver` is not a real version.
        if (!(c.semver instanceof semver.SemVer)) continue;
        if (c.operator === '<' || c.operator === '<=' || c.operator === '' || c.operator === '=') {
          const bound = { version: c.semver.version, inclusive: c.operator !== '<' };
          if (!clauseTop || compareBounds(bound, clauseTop) < 0) clauseTop = bound;
        }
      }
      if (!clauseTop) return undefined;
      if (!top || compareBounds(clauseTop, top) > 0) top = clauseTop;
    }
  }
  return top;
}

function compareBounds(a: Bound, b: Bound): number {
  return semver.compare(a.version, b.version) || Number(a.inclusive) - Number(b.inclusive);
}

/**
 * Lowest version provably outside the vulnerable `range`: `<1.2.3` → `1.2.3`,
 * `>=2.0.0 <2.1.7` → `2.1.7`. Inclusive or open-ended bounds (`<=1.2.3`, `>=1.0.0`) name no
 * provably safe version without the registry, so they return `undefined`.
 */
export function guessMinSafe(range: string | undefined): string | undefined {
  if (!range || typeof range !== 'string') return undefined;
  return provableSafeVersion([range], [], undefined);
}
