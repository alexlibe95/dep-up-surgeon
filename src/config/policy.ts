/**
 * Policy-as-code for `dep-up-surgeon`. Reads `.dep-up-surgeon.policy.yaml` / `.json` from the
 * workspace root and returns an immutable `Policy` object the engine consults before every
 * upgrade attempt. Intentionally a superset of the existing `.dep-up-surgeonrc` shape —
 * `linkedGroups` / `ignore` / `validate` are still honored there; this file is for rules that
 * are reasonable to REVIEW as its own commit (i.e. "governance", not "ergonomics").
 *
 * Supported rules:
 *
 *   freeze:                 # implicit `ignore`. Human-readable "why" appears in the report.
 *     - name: "react"
 *       reason: "awaiting compat audit for Next.js 14"
 *
 *   maxVersion:             # cap the attempted version to an inclusive range. The engine
 *     - name: "eslint"      # will NEVER try a version outside this range, even for `@latest`.
 *       version: "8.x"
 *
 *   allowMajorAfter:        # date gate on major bumps. Until the gate passes the engine
 *     - name: "react"       # caps to the current major. After the gate, unrestricted.
 *       date: "2026-06-01"
 *
 *   requireReviewers:       # metadata only — surfaced in the JSON report + PR body when
 *     major: 2              # the CLI is wired to a PR sender. No effect on the engine.
 *     minor: 1
 *     patch: 0
 *
 *   autoMerge:              # metadata only — same story as requireReviewers. A future PR
 *     patch: true           # sender / GitHub Action can flip `auto-merge` on the PR when
 *     minor: false          # this is true + all checks pass.
 *     include:
 *       - "eslint-plugin-*"
 *
 * Name patterns everywhere support:
 *   - exact strings: `"react"`, `"@scope/pkg"`
 *   - `*` wildcard: `"eslint-plugin-*"`, `"@types/*"`
 *
 * Everything is optional. An empty / missing file is not an error — we just return a no-op
 * policy so every caller can use the `Policy` shape unconditionally.
 */
import path from 'node:path';
import fs from 'fs-extra';
import semver from 'semver';
import YAML from 'yaml';

export type Severity = 'major' | 'minor' | 'patch';

export interface PolicyFreezeEntry {
  pattern: string;
  reason?: string;
}

export interface PolicyMaxVersionEntry {
  pattern: string;
  range: string;
}

export interface PolicyAllowMajorAfterEntry {
  pattern: string;
  date: Date;
}

export interface Policy {
  freeze: PolicyFreezeEntry[];
  maxVersion: PolicyMaxVersionEntry[];
  allowMajorAfter: PolicyAllowMajorAfterEntry[];
  requireReviewers?: Partial<Record<Severity, number>>;
  autoMerge?: {
    major?: boolean;
    minor?: boolean;
    patch?: boolean;
    /** Name patterns that are eligible regardless of the severity flags above. */
    include?: string[];
  };
  /** Absolute path the policy was loaded from. Populated for traceability in the report. */
  sourceFile?: string;
  /** Parse warnings collected during load — unknown keys, bad shape values. Non-fatal. */
  warnings: string[];
}

export const EMPTY_POLICY: Policy = {
  freeze: [],
  maxVersion: [],
  allowMajorAfter: [],
  warnings: [],
};

export interface LoadPolicyResult {
  policy: Policy;
  /** True when a policy file was found AND it had at least one recognized rule. */
  present: boolean;
}

/**
 * Look for `.dep-up-surgeon.policy.yaml`, `.yml`, then `.json` in `cwd`. Returns the first
 * match (no merging across files). Missing file → `EMPTY_POLICY`.
 */
export async function loadPolicy(cwd: string): Promise<LoadPolicyResult> {
  const candidates = [
    '.dep-up-surgeon.policy.yaml',
    '.dep-up-surgeon.policy.yml',
    '.dep-up-surgeon.policy.json',
  ];
  for (const name of candidates) {
    const abs = path.join(cwd, name);
    if (!(await fs.pathExists(abs))) {
      continue;
    }
    const raw = await fs.readFile(abs, 'utf8').catch(() => undefined);
    if (raw === undefined) {
      continue;
    }
    try {
      const parsed = name.endsWith('.json') ? (JSON.parse(raw) as unknown) : YAML.parse(raw);
      const policy = normalizePolicy(parsed, abs);
      return {
        policy,
        present:
          policy.freeze.length > 0 ||
          policy.maxVersion.length > 0 ||
          policy.allowMajorAfter.length > 0 ||
          Boolean(policy.requireReviewers) ||
          Boolean(policy.autoMerge),
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        policy: {
          ...EMPTY_POLICY,
          sourceFile: abs,
          warnings: [`failed to parse ${name}: ${msg}`],
        },
        present: false,
      };
    }
  }
  return { policy: EMPTY_POLICY, present: false };
}

/**
 * Normalize the raw parsed policy object into the strongly-typed `Policy` shape. Tolerates
 * missing sections, unknown keys (recorded as warnings), and loose types (e.g. date strings).
 */
export function normalizePolicy(raw: unknown, sourceFile?: string): Policy {
  const warnings: string[] = [];
  const out: Policy = {
    freeze: [],
    maxVersion: [],
    allowMajorAfter: [],
    warnings,
  };
  if (sourceFile) {
    out.sourceFile = sourceFile;
  }
  if (!raw || typeof raw !== 'object') {
    warnings.push('policy root is not an object; ignoring');
    return out;
  }
  const obj = raw as Record<string, unknown>;

  // freeze
  if (Array.isArray(obj.freeze)) {
    for (const entry of obj.freeze) {
      const norm = normalizeFreezeEntry(entry, warnings);
      if (norm) out.freeze.push(norm);
    }
  } else if (obj.freeze !== undefined) {
    warnings.push('`freeze` must be an array');
  }

  // maxVersion
  if (Array.isArray(obj.maxVersion)) {
    for (const entry of obj.maxVersion) {
      const norm = normalizeMaxVersionEntry(entry, warnings);
      if (norm) out.maxVersion.push(norm);
    }
  } else if (obj.maxVersion !== undefined) {
    warnings.push('`maxVersion` must be an array');
  }

  // allowMajorAfter
  if (Array.isArray(obj.allowMajorAfter)) {
    for (const entry of obj.allowMajorAfter) {
      const norm = normalizeAllowMajorAfterEntry(entry, warnings);
      if (norm) out.allowMajorAfter.push(norm);
    }
  } else if (obj.allowMajorAfter !== undefined) {
    warnings.push('`allowMajorAfter` must be an array');
  }

  // requireReviewers
  if (obj.requireReviewers && typeof obj.requireReviewers === 'object') {
    const rr = obj.requireReviewers as Record<string, unknown>;
    const result: Partial<Record<Severity, number>> = {};
    for (const key of ['major', 'minor', 'patch'] as const) {
      if (typeof rr[key] === 'number' && Number.isFinite(rr[key])) {
        result[key] = Math.max(0, Math.floor(rr[key] as number));
      } else if (rr[key] !== undefined) {
        warnings.push(`requireReviewers.${key} must be a non-negative integer`);
      }
    }
    if (Object.keys(result).length > 0) {
      out.requireReviewers = result;
    }
  }

  // autoMerge
  if (obj.autoMerge && typeof obj.autoMerge === 'object') {
    const am = obj.autoMerge as Record<string, unknown>;
    const result: Policy['autoMerge'] = {};
    for (const key of ['major', 'minor', 'patch'] as const) {
      if (typeof am[key] === 'boolean') {
        result[key] = am[key];
      } else if (am[key] !== undefined) {
        warnings.push(`autoMerge.${key} must be a boolean`);
      }
    }
    if (Array.isArray(am.include)) {
      const include: string[] = [];
      for (const v of am.include) {
        if (typeof v === 'string') include.push(v);
        else warnings.push('autoMerge.include entries must be strings');
      }
      if (include.length > 0) result.include = include;
    }
    if (Object.keys(result).length > 0) {
      out.autoMerge = result;
    }
  }

  // Unknown top-level keys: surface as warnings so users get fast feedback on typos.
  const known = new Set([
    'freeze',
    'maxVersion',
    'allowMajorAfter',
    'requireReviewers',
    'autoMerge',
  ]);
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) {
      warnings.push(`unknown policy key "${k}" (ignored)`);
    }
  }

  return out;
}

function normalizeFreezeEntry(
  entry: unknown,
  warnings: string[],
): PolicyFreezeEntry | undefined {
  if (typeof entry === 'string') {
    return { pattern: entry };
  }
  if (!entry || typeof entry !== 'object') {
    warnings.push('freeze entries must be strings or objects');
    return undefined;
  }
  const obj = entry as Record<string, unknown>;
  const pattern = typeof obj.name === 'string' ? obj.name : typeof obj.pattern === 'string' ? obj.pattern : undefined;
  if (!pattern) {
    warnings.push('freeze entry missing `name`');
    return undefined;
  }
  const out: PolicyFreezeEntry = { pattern };
  if (typeof obj.reason === 'string') {
    out.reason = obj.reason;
  }
  return out;
}

function normalizeMaxVersionEntry(
  entry: unknown,
  warnings: string[],
): PolicyMaxVersionEntry | undefined {
  if (!entry || typeof entry !== 'object') {
    warnings.push('maxVersion entries must be objects');
    return undefined;
  }
  const obj = entry as Record<string, unknown>;
  const pattern = typeof obj.name === 'string' ? obj.name : typeof obj.pattern === 'string' ? obj.pattern : undefined;
  const range = typeof obj.version === 'string' ? obj.version : typeof obj.range === 'string' ? obj.range : undefined;
  if (!pattern || !range) {
    warnings.push('maxVersion entry requires both `name` and `version`');
    return undefined;
  }
  if (!semver.validRange(range)) {
    warnings.push(`maxVersion "${pattern}": "${range}" is not a valid semver range`);
    return undefined;
  }
  return { pattern, range };
}

function normalizeAllowMajorAfterEntry(
  entry: unknown,
  warnings: string[],
): PolicyAllowMajorAfterEntry | undefined {
  if (!entry || typeof entry !== 'object') {
    warnings.push('allowMajorAfter entries must be objects');
    return undefined;
  }
  const obj = entry as Record<string, unknown>;
  const pattern = typeof obj.name === 'string' ? obj.name : typeof obj.pattern === 'string' ? obj.pattern : undefined;
  const dateRaw = obj.date;
  if (!pattern || (typeof dateRaw !== 'string' && !(dateRaw instanceof Date))) {
    warnings.push('allowMajorAfter entry requires `name` and ISO `date`');
    return undefined;
  }
  const date = dateRaw instanceof Date ? dateRaw : new Date(dateRaw);
  if (Number.isNaN(date.getTime())) {
    warnings.push(`allowMajorAfter "${pattern}": "${dateRaw}" is not a valid date`);
    return undefined;
  }
  return { pattern, date };
}

// ---------------------------------------------------------------------------
// Pattern matching
// ---------------------------------------------------------------------------

/**
 * Match a package name against a pattern. Supports `*` as "any sequence of non-separator
 * characters" and literal exact names; a bare `*` matches every name, scoped ones included.
 * Not a full glob — that's intentional; deps names don't need `[abc]` / `{a,b}` / `**` to
 * stay expressive.
 */
export function matchPattern(pattern: string, name: string): boolean {
  if (pattern === name) return true;
  if (!pattern.includes('*')) return false;
  // `freeze: ["*"]` means everything; the segment-bound regex below would miss `@scope/name`.
  if (pattern === '*') return true;
  // Escape regex specials except `*`, then replace `*` with `[^/]*` so `@types/*` does NOT
  // match `@types/foo/bar` (which isn't a real package name anyway).
  const re = new RegExp(
    '^' +
      pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') +
      '$',
  );
  return re.test(name);
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

export interface PolicyDecision {
  /** When true, the package should NOT be upgraded at all. `reason` will be populated. */
  frozen: boolean;
  /**
   * When set, the engine must not attempt versions outside this semver range. With several
   * matching rules it is their intersection, spelled so it stays correct with `||` ranges.
   */
  maxRange?: string;
  /** Every matching `maxVersion` range in rule order; a version must satisfy all of them. */
  maxRanges?: string[];
  /** When set, major bumps are blocked until the listed date. */
  blockedMajorUntil?: Date;
  /** The reason surfaced to the user / report when the package was skipped or capped. */
  reason?: string;
}

/**
 * Compute the combined decision for a single package name. If the package matches multiple
 * rules we combine them conservatively: freeze always wins; otherwise every matching
 * `maxVersion` range must hold and the earliest `blockedMajorUntil` applies.
 */
export function evaluatePolicy(
  policy: Policy,
  packageName: string,
  now: Date = new Date(),
): PolicyDecision {
  const decision: PolicyDecision = { frozen: false };

  const frozen = policy.freeze.find((e) => matchPattern(e.pattern, packageName));
  if (frozen) {
    decision.frozen = true;
    decision.reason = frozen.reason
      ? `frozen by policy (${frozen.pattern}): ${frozen.reason}`
      : `frozen by policy (${frozen.pattern})`;
    return decision;
  }

  // Max-version: every matching rule must hold. Keep the list — space-joining the raw strings
  // breaks on `||` (`8.x || 9.x >=9` still admits 8.57.0).
  const maxRanges = policy.maxVersion
    .filter((rule) => matchPattern(rule.pattern, packageName))
    .map((rule) => rule.range);
  if (maxRanges.length > 0) {
    decision.maxRanges = maxRanges;
    decision.maxRange = maxRanges.length === 1 ? maxRanges[0]! : intersectRanges(maxRanges);
  }

  // Blocked major: earliest gate wins (conservative).
  for (const rule of policy.allowMajorAfter) {
    if (!matchPattern(rule.pattern, packageName)) continue;
    if (rule.date.getTime() <= now.getTime()) continue;
    if (!decision.blockedMajorUntil || rule.date < decision.blockedMajorUntil) {
      decision.blockedMajorUntil = rule.date;
    }
  }

  if (!decision.reason) {
    const bits: string[] = [];
    if (decision.maxRanges) {
      const caps =
        decision.maxRanges.length === 1
          ? decision.maxRanges
          : decision.maxRanges.map((r) => `(${r})`);
      bits.push(`capped to ${caps.join(' and ')}`);
    }
    if (decision.blockedMajorUntil) {
      bits.push(`majors blocked until ${decision.blockedMajorUntil.toISOString().slice(0, 10)}`);
    }
    if (bits.length > 0) decision.reason = `policy: ${bits.join(', ')}`;
  }

  return decision;
}

/**
 * Intersect semver ranges into one equivalent range string. A space (AND) binds tighter than
 * `||`, so the alternatives are distributed: `(a || b)` AND `c` → `a c || b c`.
 */
function intersectRanges(ranges: string[]): string {
  let alternatives: string[][] = [[]];
  for (const range of ranges) {
    const conjunctions = new semver.Range(range).set.map((comparators) =>
      comparators.map((c) => c.value).filter(Boolean),
    );
    alternatives = alternatives.flatMap((acc) => conjunctions.map((conj) => [...acc, ...conj]));
  }
  return alternatives.map((conj) => conj.join(' ') || '*').join(' || ');
}

/**
 * Given a current version range and a candidate target version, return either the version
 * itself (ok) or a REPLACEMENT target that respects the policy. When no acceptable version can
 * be found (e.g. the policy forbids every direction), returns `undefined` to signal "skip".
 *
 * Rules applied:
 *   - `frozen` → undefined (engine treats as ignore).
 *   - `maxRanges` (or a lone `maxRange`) → if `target` satisfies every range, keep it; else
 *     pick the highest version that does from the provided `availableVersions` (descending
 *     preference). Returns undefined when nothing satisfies them all.
 *   - `blockedMajorUntil` → if `target` would be a major bump over `fromVersion`, demote to
 *     the highest available version within the SAME major as `fromVersion`.
 */
export function applyPolicyToTarget(
  decision: PolicyDecision,
  currentVersion: string | undefined,
  target: string,
  availableVersions: string[],
): string | undefined {
  if (decision.frozen) return undefined;

  let candidate = target;
  const cleanTarget = semver.coerce(target)?.version;
  const cleanCurrent = currentVersion ? semver.coerce(currentVersion)?.version : undefined;

  // Apply blockedMajorUntil first: it forces "same major as current".
  if (decision.blockedMajorUntil && cleanTarget && cleanCurrent) {
    if (semver.major(cleanTarget) > semver.major(cleanCurrent)) {
      const sameMajor = availableVersions
        .filter((v) => semver.valid(v) && semver.major(v) === semver.major(cleanCurrent))
        .sort(semver.rcompare);
      if (sameMajor.length === 0) return undefined;
      candidate = sameMajor[0]!;
    }
  }

  // Then apply the max-version caps. If already within all of them, no change.
  const caps = decision.maxRanges ?? (decision.maxRange ? [decision.maxRange] : []);
  if (caps.length > 0) {
    const allowed = (v: string): boolean => caps.every((range) => semver.satisfies(v, range));
    if (allowed(candidate)) {
      return candidate;
    }
    const inRange = availableVersions
      .filter((v) => semver.valid(v) && allowed(v))
      .sort(semver.rcompare);
    if (inRange.length === 0) return undefined;
    candidate = inRange[0]!;
  }

  return candidate;
}
