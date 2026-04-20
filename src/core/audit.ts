/**
 * Run `<manager> audit --json`, parse the JSON, and return a normalized list of vulnerabilities
 * keyed by package name. Used by `--security-only` to filter the upgrade plan down to packages
 * with known advisories — the `dep-up-surgeon` equivalent of Dependabot's "security alerts".
 *
 * Three manager shapes are supported:
 *   - **npm**  (v7+): `{ vulnerabilities: { "<pkg>": { severity, via: [...], fixAvailable } } }`
 *                      where `via[]` either contains nested vuln refs (transitive) or advisory
 *                      objects (`{ title, url, source, cve, range }`).
 *   - **yarn** (classic + berry via `yarn npm audit --json`): newline-delimited JSON with one
 *                      `{ type: 'auditAdvisory', data: { advisory: {...} } }` per advisory.
 *   - **pnpm** (v7+): same top-level shape as npm (pnpm intentionally mimics npm audit).
 *
 * Design notes:
 *   - Everything is best-effort: a missing audit binary, a registry 5xx, or an unparsable blob
 *     returns `{ advisories: [], error }` so the caller can decide whether to abort or continue.
 *   - We dedupe per package + CVE id so one advisory listed under multiple via[] chains collapses
 *     to a single `SecurityAdvisory` row.
 *   - `recommendedVersion` is the audit's own `fixAvailable.version` when present; otherwise the
 *     lowest semver greater than the `vulnerableRange`'s upper bound (best-effort parse).
 */
import { execa } from 'execa';
import semver from 'semver';
import type { PackageManager } from './workspaces.js';

export type Severity = 'low' | 'moderate' | 'high' | 'critical';

export interface SecurityAdvisory {
  /** The *direct* package that the user should bump (not necessarily the vulnerable transitive). */
  name: string;
  severity: Severity;
  /** Every advisory id we found — usually a CVE or a GHSA. */
  ids: string[];
  /** First non-empty URL (GitHub Advisory / npm advisory). */
  url?: string;
  /** Human-readable advisory title, when the manager exposed one. */
  title?: string;
  /** Vulnerable range, e.g. `<1.2.3` or `>=2.0.0 <2.1.7`. */
  vulnerableRange?: string;
  /** Lowest safe version per the audit data (may be absent when only a range is known). */
  recommendedVersion?: string;
}

export interface AuditResult {
  advisories: SecurityAdvisory[];
  /** Populated when the audit command itself failed (non-zero exit + no parseable data). */
  error?: string;
}

export interface RunAuditOptions {
  manager: PackageManager;
  cwd: string;
  /**
   * Inject the actual command execution. Used in tests to pass canned JSON blobs without
   * shelling out. Receives the chosen `bin` and argv and must return `{ stdout, exitCode }`.
   */
  exec?: (bin: string, args: string[], cwd: string) => Promise<{ stdout: string; exitCode: number }>;
}

/**
 * Public entry point. Picks the right command for the given manager, runs it, parses the output,
 * and returns the normalized advisory list. Never throws.
 */
export async function runAudit(opts: RunAuditOptions): Promise<AuditResult> {
  const exec = opts.exec ?? defaultExec;
  const command = auditCommandFor(opts.manager);
  if (!command) {
    return { advisories: [], error: `audit is not supported for ${opts.manager}` };
  }

  let stdout = '';
  try {
    const r = await exec(command.bin, command.args, opts.cwd);
    stdout = r.stdout;
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

  try {
    if (opts.manager === 'yarn') {
      return { advisories: parseYarnAudit(stdout) };
    }
    // npm / pnpm share the JSON shape.
    return { advisories: parseNpmLikeAudit(stdout) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { advisories: [], error: `failed to parse audit output: ${msg}` };
  }
}

async function defaultExec(
  bin: string,
  args: string[],
  cwd: string,
): Promise<{ stdout: string; exitCode: number }> {
  const r = await execa(bin, args, { cwd, reject: false, timeout: 60_000 });
  return { stdout: r.stdout ?? '', exitCode: r.exitCode ?? -1 };
}

function auditCommandFor(manager: PackageManager): { bin: string; args: string[] } | undefined {
  switch (manager) {
    case 'npm':
      // `--omit=dev` is NOT passed: a runtime dep bundling a dev-only vulnerable package would
      // still be visible in the lockfile tree and users generally want to know. Maintainers of
      // security policies can always re-filter later.
      return { bin: 'npm', args: ['audit', '--json'] };
    case 'pnpm':
      return { bin: 'pnpm', args: ['audit', '--json'] };
    case 'yarn':
      // Yarn classic emits newline-delimited JSON. Yarn berry maps `yarn npm audit` to a similar
      // shape; we prefer the classic form because it works on both when invoked as `yarn audit`.
      return { bin: 'yarn', args: ['audit', '--json'] };
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// npm / pnpm parser
// ---------------------------------------------------------------------------

interface NpmAuditJson {
  vulnerabilities?: Record<string, NpmVulnEntry>;
}

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
  cwe?: string[];
  cvss?: unknown;
  [k: string]: unknown;
}

export function parseNpmLikeAudit(stdout: string): SecurityAdvisory[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }
  let parsed: NpmAuditJson;
  try {
    parsed = JSON.parse(trimmed) as NpmAuditJson;
  } catch {
    // Some older npm versions emit one JSON object per line — try NDJSON as a fallback.
    return parseNpmNdjson(trimmed);
  }
  const vulns = parsed.vulnerabilities ?? {};
  const byName = new Map<string, SecurityAdvisory>();

  for (const [pkgName, entry] of Object.entries(vulns)) {
    // Build a list of advisory descriptors from `via[]`. Strings in `via[]` are just names of
    // transitive packages that carry the same advisory — we ignore those at this stage.
    const advisories: NpmAdvisory[] = [];
    for (const v of entry.via ?? []) {
      if (typeof v === 'object' && v !== null) {
        advisories.push(v);
      }
    }
    if (advisories.length === 0) {
      continue;
    }
    const severity = coerceSeverity(entry.severity) ?? coerceSeverity(advisories[0].severity);
    if (!severity) {
      continue;
    }
    const ids = dedupe(
      advisories
        .map((a) => extractAdvisoryId(a))
        .filter((x): x is string => Boolean(x)),
    );
    const url = advisories.find((a) => typeof a.url === 'string')?.url as string | undefined;
    const title = advisories.find((a) => typeof a.title === 'string')?.title as string | undefined;
    const vulnerableRange =
      advisories.find((a) => typeof a.range === 'string')?.range as string | undefined ??
      entry.range;
    const recommendedVersion = extractFixVersion(entry.fixAvailable) ?? guessMinSafe(vulnerableRange);

    const existing = byName.get(pkgName);
    if (existing) {
      // Merge: take the higher severity, union the ids.
      existing.severity = maxSeverity(existing.severity, severity);
      existing.ids = dedupe([...existing.ids, ...ids]);
      if (!existing.url && url) existing.url = url;
      if (!existing.title && title) existing.title = title;
      if (!existing.recommendedVersion && recommendedVersion) {
        existing.recommendedVersion = recommendedVersion;
      }
    } else {
      const row: SecurityAdvisory = {
        name: pkgName,
        severity,
        ids,
      };
      if (url) row.url = url;
      if (title) row.title = title;
      if (vulnerableRange) row.vulnerableRange = vulnerableRange;
      if (recommendedVersion) row.recommendedVersion = recommendedVersion;
      byName.set(pkgName, row);
    }
  }

  return [...byName.values()];
}

function parseNpmNdjson(stdout: string): SecurityAdvisory[] {
  const byName = new Map<string, SecurityAdvisory>();
  for (const line of stdout.split('\n')) {
    const l = line.trim();
    if (!l || l[0] !== '{') {
      continue;
    }
    try {
      const obj = JSON.parse(l) as { type?: string; data?: unknown };
      if (obj.type === 'auditAdvisory' && obj.data) {
        const a = (obj.data as { advisory?: NpmAdvisory }).advisory;
        if (a) mergeAdvisoryFromYarnLike(byName, a);
      }
    } catch {
      // skip malformed line
    }
  }
  return [...byName.values()];
}

// ---------------------------------------------------------------------------
// yarn parser (classic NDJSON)
// ---------------------------------------------------------------------------

interface YarnAdvisoryLine {
  type?: string;
  data?: { advisory?: NpmAdvisory; resolution?: { path?: string; id?: number } };
}

export function parseYarnAudit(stdout: string): SecurityAdvisory[] {
  const byName = new Map<string, SecurityAdvisory>();
  for (const line of stdout.split('\n')) {
    const l = line.trim();
    if (!l || l[0] !== '{') {
      continue;
    }
    let parsed: YarnAdvisoryLine;
    try {
      parsed = JSON.parse(l) as YarnAdvisoryLine;
    } catch {
      continue;
    }
    // Yarn berry (via `yarn npm audit --json`) emits the npm-style top-level object on the
    // first line. Detect that and reuse the npm parser.
    if (
      parsed.type === undefined &&
      typeof parsed === 'object' &&
      parsed !== null &&
      'vulnerabilities' in parsed
    ) {
      for (const r of parseNpmLikeAudit(l)) {
        const existing = byName.get(r.name);
        if (existing) {
          existing.severity = maxSeverity(existing.severity, r.severity);
          existing.ids = dedupe([...existing.ids, ...r.ids]);
        } else {
          byName.set(r.name, r);
        }
      }
      continue;
    }
    if (parsed.type !== 'auditAdvisory') {
      continue;
    }
    const adv = parsed.data?.advisory;
    if (!adv) continue;
    mergeAdvisoryFromYarnLike(byName, adv);
  }
  return [...byName.values()];
}

function mergeAdvisoryFromYarnLike(
  byName: Map<string, SecurityAdvisory>,
  a: NpmAdvisory,
): void {
  const name = typeof a.name === 'string' ? a.name : undefined;
  const severity = coerceSeverity(a.severity);
  if (!name || !severity) return;
  const id = extractAdvisoryId(a);
  const url = typeof a.url === 'string' ? a.url : undefined;
  const title = typeof a.title === 'string' ? a.title : undefined;
  const range = typeof a.range === 'string' ? a.range : undefined;
  const patched =
    typeof (a as { patched_versions?: unknown }).patched_versions === 'string'
      ? ((a as { patched_versions?: string }).patched_versions as string)
      : undefined;
  const recommendedVersion = guessMinSafe(patched) ?? guessMinSafe(range);

  const existing = byName.get(name);
  if (existing) {
    existing.severity = maxSeverity(existing.severity, severity);
    if (id) existing.ids = dedupe([...existing.ids, id]);
    if (!existing.url && url) existing.url = url;
    if (!existing.title && title) existing.title = title;
    if (!existing.vulnerableRange && range) existing.vulnerableRange = range;
    if (!existing.recommendedVersion && recommendedVersion) {
      existing.recommendedVersion = recommendedVersion;
    }
  } else {
    const row: SecurityAdvisory = {
      name,
      severity,
      ids: id ? [id] : [],
    };
    if (url) row.url = url;
    if (title) row.title = title;
    if (range) row.vulnerableRange = range;
    if (recommendedVersion) row.recommendedVersion = recommendedVersion;
    byName.set(name, row);
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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

function extractAdvisoryId(a: NpmAdvisory): string | undefined {
  // npm audit surfaces advisories with GHSA ids; some old ones have CVE ids; yarn adds numeric
  // `source`. Prefer alpha-prefix ids for stable cross-referencing.
  const candidates: unknown[] = [
    (a as { github_advisory_id?: unknown }).github_advisory_id,
    (a as { ghsa_id?: unknown }).ghsa_id,
    (a as { cve?: unknown }).cve,
    (a as { cves?: unknown }).cves,
    a.source,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim();
    if (Array.isArray(c) && typeof c[0] === 'string') return c[0].trim();
    if (typeof c === 'number') return `advisory-${c}`;
  }
  return undefined;
}

function extractFixVersion(
  fixAvailable: NpmVulnEntry['fixAvailable'] | undefined,
): string | undefined {
  if (!fixAvailable || typeof fixAvailable === 'boolean') return undefined;
  const v = fixAvailable.version;
  return typeof v === 'string' && semver.valid(semver.coerce(v) ?? '') ? v : undefined;
}

/**
 * Best-effort min-safe version parser. Given a vulnerable range like `<1.2.3` we return
 * `1.2.3` as the likely fix; for `>=2.0.0 <2.1.7` we return `2.1.7`. When the range is opaque
 * (e.g. `*` or `n/a`) we give up and return `undefined`.
 */
export function guessMinSafe(range: string | undefined): string | undefined {
  if (!range || typeof range !== 'string') return undefined;
  if (!semver.validRange(range)) {
    // yarn sometimes returns `patched_versions` like `>=1.2.3` which IS valid; but `"none"` etc.
    const m = range.match(/(\d+\.\d+\.\d+)/);
    return m ? m[1] : undefined;
  }
  // Pick the first intersection of numeric versions in the range bounds. `<X.Y.Z` means X.Y.Z is
  // the fix; `>=X.Y.Z` means X.Y.Z is fine already. We walk the tokens and take the upper-bound
  // version for `<`-ish operators (match BOTH `<` and `<=`).
  const upper = range.match(/<=?\s*([\d.]+)/);
  if (upper) return upper[1];
  const lowerEq = range.match(/>=\s*([\d.]+)/);
  if (lowerEq) return lowerEq[1];
  const lower = range.match(/>\s*([\d.]+)/);
  if (lower) return lower[1];
  return undefined;
}
