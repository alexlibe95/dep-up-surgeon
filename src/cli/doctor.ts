/**
 * `--doctor` read-only diagnostic.
 *
 * Runs a suite of read-only checks against the current project and returns a traffic-light
 * report — one entry per check with `status: 'green' | 'yellow' | 'red'`, a short human
 * message, and an optional `hint` with a remediation pointer. No mutations, no installs, no
 * network-exclusive blocking calls (audit is opt-out for air-gapped setups).
 *
 * Designed to be safe to run as a CI pre-check: the exit code maps `red → 2`, `yellow → 1`,
 * `green → 0` (or `--strict` promotes yellow to exit 1 for stricter gates).
 *
 * Checks currently implemented (stable ordering, so downstream diffs stay readable):
 *
 *   1. **node-version**           — current Node satisfies `engines.node`, if set.
 *   2. **manager**                — a package manager was resolved (lockfile + binary match).
 *   3. **lockfile**               — lockfile is present, parseable, and matches the manager.
 *   4. **workspace-coherence**    — detected workspace members resolve on disk + have `package.json`.
 *   5. **policy**                 — `.dep-up-surgeon.policy.{yaml,json}` (when present) parses
 *                                   without warnings.
 *   6. **preflight-validator**    — user's `--validate` / auto-detected `<mgr> test` passes RIGHT NOW,
 *                                   before any upgrades. Skipped when `--no-validate` (doctor
 *                                   respects the same flag plumbing as the upgrade flow).
 *   7. **peer-deps**              — scan installed tree for existing peer-dep warnings via a
 *                                   `<mgr> ls --all` (npm) or equivalent — catches "already
 *                                   broken before you asked me to upgrade anything" cases.
 *   8. **audit**                  — `<mgr> audit` dry-run + severity breakdown. Treated as
 *                                   YELLOW for low/moderate, RED for high/critical.
 *   9. **stale-transitives**      — reuses `scanStaleTransitives` from `lockfileFix.ts` to flag
 *                                   transitives > 1 minor or a full major behind registry latest.
 *                                   Informational (YELLOW); never blocks.
 *
 * Explicitly NOT a check (yet):
 *   - changelog fetch reachability — too flaky across corporate proxies and too many false
 *     positives to be useful as a CI gate.
 *   - `npm whoami` / auth — out of scope; doctor reports project health, not credentials.
 */
import path from 'node:path';
import fs from 'fs-extra';
import semver from 'semver';
import { execa } from 'execa';
import type { PackageJson } from '../types.js';
import type { PackageManager, ProjectInfo } from '../core/workspaces.js';
import { detectProjectInfo } from '../core/workspaces.js';
import { validateProject } from '../core/validator.js';
import { runAudit, type SecurityAdvisory } from '../core/audit.js';
import { tailLines } from '../utils/output.js';
import { createRegistryCache, runWithConcurrency, type RegistryCache } from '../utils/concurrency.js';
import { parseLockfileInstalledVersions } from './lockfileFix.js';
import { loadPolicy } from '../config/policy.js';
import { fetchLatestVersion } from '../utils/npm.js';

export type DoctorStatus = 'green' | 'yellow' | 'red';

export interface DoctorCheck {
  /** Stable id — used as the JSON key so consumers can branch on it reliably. */
  id: string;
  /** Short label shown in the human-readable output. */
  label: string;
  status: DoctorStatus;
  /** One-line human summary of the outcome. */
  message: string;
  /** Optional remediation hint shown under the message for non-green entries. */
  hint?: string;
  /**
   * Free-form structured payload included in `--json` output. Kept check-specific so the human
   * renderer can stay dumb and downstream consumers can parse what they care about.
   */
  data?: Record<string, unknown>;
}

export interface DoctorReport {
  cwd: string;
  toolVersion: string;
  /** Per-check results in stable order. */
  checks: DoctorCheck[];
  /** Aggregate — worst status across all checks. */
  overall: DoctorStatus;
  /** Count of checks per status. */
  counts: Record<DoctorStatus, number>;
}

export interface RunDoctorOptions {
  cwd: string;
  toolVersion: string;
  /** When true, skip the pre-flight validator even if a command is configured. */
  skipValidator?: boolean;
  /** User-provided validator command (overrides the default `<mgr> test` fallback). */
  validatorCommand?: string;
  /** When true, skip `<mgr> audit` (air-gapped CI, offline dev). */
  skipAudit?: boolean;
  /** When true, skip `<mgr> ls --all` (slow on huge trees). */
  skipPeerScan?: boolean;
  /** When true, skip the registry-backed stale-transitive scan. */
  skipStaleScan?: boolean;
  /** Override package manager (mirrors the top-level `--package-manager` flag). */
  manager?: PackageManager | 'auto';
}

/**
 * Public entry point. Runs every enabled check in sequence (checks are cheap enough that
 * serial keeps the log predictable; we don't gain anything by racing them). Never throws —
 * a check that explodes returns `red` with the error as the `message` so downstream renderers
 * still see a complete report.
 */
export async function runDoctor(opts: RunDoctorOptions): Promise<DoctorReport> {
  const { cwd, toolVersion } = opts;
  const checks: DoctorCheck[] = [];

  // 1. Node version gate — runs first because everything downstream assumes a working Node.
  checks.push(await nodeVersionCheck(cwd));

  // 2. Project info is load-bearing for every downstream check. If detection itself errors
  //    we short-circuit and emit a single red check + empty remainder so the report is still
  //    structured output rather than an exception.
  let info: ProjectInfo | undefined;
  try {
    info = await detectProjectInfo(cwd);
  } catch (e) {
    checks.push({
      id: 'manager',
      label: 'Package manager',
      status: 'red',
      message: `Failed to detect project info: ${e instanceof Error ? e.message : String(e)}`,
      hint: 'Ensure this directory contains a readable `package.json`.',
    });
    return finalize(checks, cwd, toolVersion);
  }

  checks.push(managerCheck(info));
  checks.push(await lockfileCheck(cwd, info));
  checks.push(workspaceCoherenceCheck(info));
  checks.push(await policyCheck(cwd));
  checks.push(await preflightValidatorCheck(cwd, info, opts));
  checks.push(await peerDepsCheck(cwd, info, opts));
  checks.push(await auditCheck(cwd, info, opts));
  checks.push(await staleTransitiveCheck(cwd, info, opts));

  return finalize(checks, cwd, toolVersion);
}

function finalize(checks: DoctorCheck[], cwd: string, toolVersion: string): DoctorReport {
  const counts: Record<DoctorStatus, number> = { green: 0, yellow: 0, red: 0 };
  for (const c of checks) counts[c.status]++;
  const overall: DoctorStatus = counts.red > 0 ? 'red' : counts.yellow > 0 ? 'yellow' : 'green';
  return { cwd, toolVersion, checks, overall, counts };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

async function nodeVersionCheck(cwd: string): Promise<DoctorCheck> {
  const current = process.version.replace(/^v/, '');
  try {
    const pkg = (await fs.readJson(path.join(cwd, 'package.json'))) as PackageJson;
    const engines = (pkg as PackageJson & { engines?: { node?: string } }).engines;
    const range = engines?.node;
    if (!range) {
      return {
        id: 'node-version',
        label: 'Node version',
        status: 'green',
        message: `Running Node ${current} (no \`engines.node\` set, so nothing to enforce).`,
      };
    }
    if (semver.satisfies(current, range, { includePrerelease: true })) {
      return {
        id: 'node-version',
        label: 'Node version',
        status: 'green',
        message: `Node ${current} satisfies \`engines.node: ${range}\`.`,
      };
    }
    return {
      id: 'node-version',
      label: 'Node version',
      status: 'red',
      message: `Node ${current} does NOT satisfy \`engines.node: ${range}\`.`,
      hint: `Switch to a compatible Node version (e.g. via \`nvm use\`) before running the upgrade loop. Installing with a mismatched Node will tear down peer-dep resolution in ways that look like CVE-driven failures.`,
      data: { current, required: range },
    };
  } catch {
    return {
      id: 'node-version',
      label: 'Node version',
      status: 'yellow',
      message: `Running Node ${current}; \`package.json\` was not readable.`,
      hint: 'Unable to read `package.json` — the upgrade flow will also fail to read it.',
    };
  }
}

function managerCheck(info: ProjectInfo): DoctorCheck {
  // We have no way of telling "the user set packageManager to pnpm but only package-lock.json
  // exists" without reading both — the detector already resolves this, but we want the doctor
  // to call out the discrepancy explicitly rather than silently preferring one.
  const issues: string[] = [];
  if (info.managerSource === 'default') {
    issues.push('no lockfile + no `packageManager` field detected; falling back to npm');
  }
  const ambiguous = countLockfileKinds(info);
  if (ambiguous > 1) {
    issues.push(
      `${ambiguous} lockfiles present at the project root — pick one and delete the others before upgrading`,
    );
  }
  if (issues.length === 0) {
    return {
      id: 'manager',
      label: 'Package manager',
      status: 'green',
      message: `Detected ${info.manager}${info.managerVersion ? '@' + info.managerVersion : ''} via ${info.managerSource}.`,
      data: {
        manager: info.manager,
        managerVersion: info.managerVersion,
        source: info.managerSource,
      },
    };
  }
  return {
    id: 'manager',
    label: 'Package manager',
    status: 'yellow',
    message: `Resolved ${info.manager}, but: ${issues.join('; ')}.`,
    hint: 'Set `"packageManager": "<mgr>@<version>"` in `package.json` and keep exactly one lockfile committed.',
    data: { issues },
  };
}

/** Count how many of the three lockfile kinds exist alongside the detected one. */
function countLockfileKinds(info: ProjectInfo): number {
  const { cwd } = info;
  let n = 0;
  for (const name of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    if (fs.existsSync(path.join(cwd, name))) n++;
  }
  return n;
}

async function lockfileCheck(cwd: string, info: ProjectInfo): Promise<DoctorCheck> {
  if (!info.lockfile) {
    return {
      id: 'lockfile',
      label: 'Lockfile',
      status: 'yellow',
      message: 'No lockfile on disk.',
      hint: `Run \`${info.manager} install\` once before the upgrade flow so rollbacks have a reference state.`,
    };
  }
  const abs = path.join(cwd, info.lockfile);
  try {
    const raw = await fs.readFile(abs, 'utf8');
    const tree = parseLockfileInstalledVersions(raw, info.manager);
    if (tree.size === 0) {
      return {
        id: 'lockfile',
        label: 'Lockfile',
        status: 'yellow',
        message: `\`${info.lockfile}\` was readable but the parser couldn't extract any installed versions.`,
        hint: 'If this is an npm v1 lockfile (`dependencies`-only shape) consider running `npm install` to upgrade it to v2 (`packages` map), which every downstream check handles more reliably.',
        data: { lockfile: info.lockfile, parsedPackages: 0 },
      };
    }
    return {
      id: 'lockfile',
      label: 'Lockfile',
      status: 'green',
      message: `\`${info.lockfile}\` parsed OK — ${tree.size} packages tracked.`,
      data: { lockfile: info.lockfile, parsedPackages: tree.size },
    };
  } catch (e) {
    return {
      id: 'lockfile',
      label: 'Lockfile',
      status: 'red',
      message: `Failed to read \`${info.lockfile}\`: ${e instanceof Error ? e.message : String(e)}.`,
      hint: 'Delete the lockfile + `node_modules` and reinstall before running the upgrade flow.',
    };
  }
}

function workspaceCoherenceCheck(info: ProjectInfo): DoctorCheck {
  if (!info.hasWorkspaces) {
    return {
      id: 'workspace-coherence',
      label: 'Workspace coherence',
      status: 'green',
      message: 'Single-package project (no workspaces).',
    };
  }
  const missing: string[] = [];
  for (const m of info.workspaceMembers) {
    const pj = path.join(m.dir, 'package.json');
    if (!fs.existsSync(pj)) missing.push(m.name);
  }
  if (missing.length > 0) {
    return {
      id: 'workspace-coherence',
      label: 'Workspace coherence',
      status: 'red',
      message: `${missing.length} workspace member(s) are declared but have no \`package.json\`: ${missing.join(', ')}.`,
      hint: 'Fix the broken workspace globs or drop orphaned members before running the upgrade loop.',
      data: { missing },
    };
  }
  return {
    id: 'workspace-coherence',
    label: 'Workspace coherence',
    status: 'green',
    message: `${info.workspaceMembers.length} workspace member(s) resolved cleanly.`,
    data: { members: info.workspaceMembers.map((m) => m.name) },
  };
}

async function policyCheck(cwd: string): Promise<DoctorCheck> {
  const { policy, present } = await loadPolicy(cwd);
  if (!present && !policy.sourceFile) {
    return {
      id: 'policy',
      label: 'Policy file',
      status: 'green',
      message: 'No `.dep-up-surgeon.policy.{yaml,json}` present — nothing to validate.',
    };
  }
  // `sourceFile` is set even on parse failure (we record the file we attempted); `warnings`
  // distinguishes a successful load from a failed one.
  if (policy.warnings.length > 0) {
    return {
      id: 'policy',
      label: 'Policy file',
      status: 'yellow',
      message: `Loaded \`${policy.sourceFile}\` with ${policy.warnings.length} warning(s).`,
      hint: policy.warnings[0],
      data: { sourceFile: policy.sourceFile, warnings: policy.warnings },
    };
  }
  return {
    id: 'policy',
    label: 'Policy file',
    status: 'green',
    message: `Loaded \`${policy.sourceFile}\` (freeze: ${policy.freeze.length}, maxVersion: ${policy.maxVersion.length}, allowMajorAfter: ${policy.allowMajorAfter.length}).`,
    data: {
      sourceFile: policy.sourceFile,
      counts: {
        freeze: policy.freeze.length,
        maxVersion: policy.maxVersion.length,
        allowMajorAfter: policy.allowMajorAfter.length,
      },
    },
  };
}

async function preflightValidatorCheck(
  cwd: string,
  info: ProjectInfo,
  opts: RunDoctorOptions,
): Promise<DoctorCheck> {
  if (opts.skipValidator) {
    return {
      id: 'preflight-validator',
      label: 'Pre-flight validator',
      status: 'green',
      message: 'Skipped via `--no-validate`.',
    };
  }
  try {
    const pkg = (await fs.readJson(path.join(cwd, 'package.json'))) as PackageJson;
    const vr = await validateProject(cwd, pkg, {
      ...(opts.validatorCommand ? { command: opts.validatorCommand } : {}),
      manager: info.manager,
    });
    if (vr.skipped) {
      return {
        id: 'preflight-validator',
        label: 'Pre-flight validator',
        status: 'green',
        message: 'Skipped (no command configured and no default detected).',
      };
    }
    if (vr.ok) {
      return {
        id: 'preflight-validator',
        label: 'Pre-flight validator',
        status: 'green',
        message: `\`${vr.command ?? '?'}\` passed.`,
        data: { command: vr.command },
      };
    }
    return {
      id: 'preflight-validator',
      label: 'Pre-flight validator',
      status: 'red',
      message: `\`${vr.command ?? '?'}\` exited ${vr.exitCode ?? '?'}.`,
      hint: 'The project is broken BEFORE any upgrade. Fix this first — upgrading on top of a red baseline makes every failure look like a regression.',
      data: {
        command: vr.command,
        exitCode: vr.exitCode,
        lastLines: vr.output ? tailLines(vr.output, 20) : undefined,
      },
    };
  } catch (e) {
    return {
      id: 'preflight-validator',
      label: 'Pre-flight validator',
      status: 'yellow',
      message: `Validator could not run: ${e instanceof Error ? e.message : String(e)}.`,
    };
  }
}

/**
 * Quick `<mgr> ls --all --parseable` probe that doesn't install anything — just reports peer
 * dep / missing dep warnings that are ALREADY there. We scan stderr for npm's canonical
 * warning prefixes; pnpm and yarn spew the same shape in a different style, so we fall back
 * to a "did the command find `ELSPROBLEMS` / `peer dep missing` / `invalid`" text match.
 */
async function peerDepsCheck(
  cwd: string,
  info: ProjectInfo,
  opts: RunDoctorOptions,
): Promise<DoctorCheck> {
  if (opts.skipPeerScan) {
    return {
      id: 'peer-deps',
      label: 'Peer dependencies',
      status: 'green',
      message: 'Skipped via `--skip-peer-scan`.',
    };
  }
  const command = peerScanCommandFor(info.manager);
  if (!command) {
    return {
      id: 'peer-deps',
      label: 'Peer dependencies',
      status: 'green',
      message: `Peer scan not implemented for ${info.manager}; skipping.`,
    };
  }
  try {
    const r = await execa(command.bin, command.args, { cwd, reject: false, all: true });
    const combined = [r.stdout, r.stderr].filter(Boolean).join('\n');
    const warnings = extractPeerWarnings(combined);
    if (warnings.length === 0) {
      return {
        id: 'peer-deps',
        label: 'Peer dependencies',
        status: 'green',
        message: 'No existing peer-dep / missing-dep warnings.',
      };
    }
    const severe = warnings.filter((w) => /invalid|missing/i.test(w)).length;
    return {
      id: 'peer-deps',
      label: 'Peer dependencies',
      status: severe > 0 ? 'red' : 'yellow',
      message: `${warnings.length} peer / missing dep warning${warnings.length === 1 ? '' : 's'} already present${severe > 0 ? ` (${severe} fatal)` : ''}.`,
      hint: 'Resolve these before the upgrade loop — the loop will attribute any new peer failure to the bump, which makes triage harder.',
      data: { warnings: warnings.slice(0, 10), total: warnings.length },
    };
  } catch (e) {
    return {
      id: 'peer-deps',
      label: 'Peer dependencies',
      status: 'yellow',
      message: `Peer scan could not run: ${e instanceof Error ? e.message : String(e)}.`,
    };
  }
}

function peerScanCommandFor(manager: PackageManager): { bin: string; args: string[] } | undefined {
  switch (manager) {
    case 'npm':
      return { bin: 'npm', args: ['ls', '--all', '--parseable'] };
    case 'pnpm':
      // `pnpm why` is too targeted; `pnpm list -r --depth Infinity` works but is slow. We
      // instead rely on `pnpm install --frozen-lockfile --offline` reporting peer warnings in
      // stderr WITHOUT mutating anything — the `--offline --frozen-lockfile` combo prevents
      // both registry hits and lockfile mutations.
      return { bin: 'pnpm', args: ['install', '--frozen-lockfile', '--offline', '--prefer-offline'] };
    case 'yarn':
      // yarn v1: `yarn check` does the job. Berry has no `yarn check`; fall back to `yarn
      // install --immutable --check-cache` which surfaces peer warnings without mutating.
      return { bin: 'yarn', args: ['check'] };
    default:
      return undefined;
  }
}

function extractPeerWarnings(output: string): string[] {
  const lines = output.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    if (/peer dep missing|requires a peer|unmet peer dependency|ELSPROBLEMS|invalid:|missing: /i.test(line)) {
      out.push(line.trim());
    }
  }
  return out;
}

/**
 * `<mgr> audit` dry-run. Reuses `runAudit` so the severity filter, parsing, and exit-code
 * tolerance stay consistent with the main upgrade flow's `--security-only` logic.
 */
async function auditCheck(
  cwd: string,
  info: ProjectInfo,
  opts: RunDoctorOptions,
): Promise<DoctorCheck> {
  if (opts.skipAudit) {
    return {
      id: 'audit',
      label: 'Audit',
      status: 'green',
      message: 'Skipped via `--skip-audit`.',
    };
  }
  try {
    const r = await runAudit({ manager: info.manager, cwd });
    if (r.error) {
      return {
        id: 'audit',
        label: 'Audit',
        status: 'yellow',
        message: `Audit could not run: ${r.error}.`,
        hint: 'Check your network / registry auth. `--skip-audit` silences this for air-gapped CI.',
      };
    }
    const counts = countBySeverity(r.advisories);
    const total = r.advisories.length;
    if (total === 0) {
      return {
        id: 'audit',
        label: 'Audit',
        status: 'green',
        message: 'No open advisories.',
      };
    }
    const status: DoctorStatus = counts.critical > 0 || counts.high > 0 ? 'red' : 'yellow';
    return {
      id: 'audit',
      label: 'Audit',
      status,
      message: `${total} advisor${total === 1 ? 'y' : 'ies'}: critical=${counts.critical}, high=${counts.high}, moderate=${counts.moderate}, low=${counts.low}.`,
      hint:
        status === 'red'
          ? 'Run `dep-up-surgeon --security-only --apply-overrides` to fix direct + transitive CVEs.'
          : 'Run `dep-up-surgeon --security-only` to clean these up on the next pass.',
      data: { total, counts },
    };
  } catch (e) {
    return {
      id: 'audit',
      label: 'Audit',
      status: 'yellow',
      message: `Audit could not run: ${e instanceof Error ? e.message : String(e)}.`,
    };
  }
}

function countBySeverity(advs: SecurityAdvisory[]): Record<'critical' | 'high' | 'moderate' | 'low', number> {
  const out = { critical: 0, high: 0, moderate: 0, low: 0 };
  for (const a of advs) {
    if (a.severity === 'critical') out.critical++;
    else if (a.severity === 'high') out.high++;
    else if (a.severity === 'moderate') out.moderate++;
    else out.low++;
  }
  return out;
}

/**
 * Doctor-variant of the stale scan — same intent as `lockfileFix.ts`'s `scanStaleTransitives`
 * but smaller: capped at 100 packages and 4-way concurrency so doctor stays sub-second on
 * most projects. We don't reuse the lockfileFix helper to avoid exporting a private function
 * whose signature shouldn't be part of the public API just for doctor's sake.
 */
async function scanStaleInline(
  tree: Map<string, Set<string>>,
  cache: RegistryCache,
  limit: number,
): Promise<Array<{ name: string; installed: string[]; latest: string; majorBehind: number; minorBehind: number }>> {
  const ranked = [...tree.entries()]
    .map(([name, versions]) => ({ name, versions: [...versions] }))
    .sort((a, b) => b.versions.length - a.versions.length || a.name.localeCompare(b.name))
    .slice(0, limit);

  const compare = (a: string, b: string): number => {
    try {
      return semver.compare(a, b);
    } catch {
      return a.localeCompare(b);
    }
  };

  const results = await runWithConcurrency(ranked, 4, async (entry) => {
    try {
      const latest = await fetchLatestVersion(entry.name, cache);
      const sorted = [...entry.versions].sort(compare);
      const highest = sorted[sorted.length - 1]!;
      if (!semver.valid(latest) || !semver.valid(highest)) return undefined;
      if (semver.gte(highest, latest)) return undefined;
      const majorDelta = semver.major(latest) - semver.major(highest);
      const minorDelta = semver.minor(latest) - semver.minor(highest);
      if (majorDelta === 0 && minorDelta <= 1) return undefined;
      return {
        name: entry.name,
        installed: sorted,
        latest,
        majorBehind: Math.max(0, majorDelta),
        minorBehind: Math.max(0, minorDelta),
      };
    } catch {
      return undefined;
    }
  });

  const stale = results.filter(
    (r): r is { name: string; installed: string[]; latest: string; majorBehind: number; minorBehind: number } =>
      Boolean(r),
  );
  stale.sort((a, b) => {
    if (a.majorBehind !== b.majorBehind) return b.majorBehind - a.majorBehind;
    if (a.minorBehind !== b.minorBehind) return b.minorBehind - a.minorBehind;
    return a.name.localeCompare(b.name);
  });
  return stale;
}

/**
 * Stale transitive scan — packages more than one minor or a full major behind `latest`. We
 * reuse the same logic shipped with `--fix-lockfile`, but capped harder (100 packages, 4-way
 * concurrency) since doctor should return quickly.
 */
async function staleTransitiveCheck(
  cwd: string,
  info: ProjectInfo,
  opts: RunDoctorOptions,
): Promise<DoctorCheck> {
  if (opts.skipStaleScan) {
    return {
      id: 'stale-transitives',
      label: 'Stale transitives',
      status: 'green',
      message: 'Skipped via `--skip-stale-scan`.',
    };
  }
  if (!info.lockfile) {
    return {
      id: 'stale-transitives',
      label: 'Stale transitives',
      status: 'green',
      message: 'No lockfile — nothing to scan.',
    };
  }
  try {
    const raw = await fs.readFile(path.join(cwd, info.lockfile), 'utf8');
    const tree = parseLockfileInstalledVersions(raw, info.manager);
    if (tree.size === 0) {
      return {
        id: 'stale-transitives',
        label: 'Stale transitives',
        status: 'green',
        message: 'Lockfile parser found no installed versions — skipping scan.',
      };
    }
    const stale = await scanStaleInline(tree, createRegistryCache(), 100);
    if (stale.length === 0) {
      return {
        id: 'stale-transitives',
        label: 'Stale transitives',
        status: 'green',
        message: `Scanned ${Math.min(tree.size, 100)} packages — none more than a minor or major behind.`,
      };
    }
    // Stale is always informational: it never gates a CI build red. Yellow is the right
    // level because an outdated transitive can become a CVE overnight.
    return {
      id: 'stale-transitives',
      label: 'Stale transitives',
      status: 'yellow',
      message: `${stale.length} transitive${stale.length === 1 ? '' : 's'} significantly behind \`latest\`.`,
      hint: 'Run `dep-up-surgeon --fix-lockfile` to dedupe, then consider bumping the parent direct-dep to pull these forward.',
      data: { top: stale.slice(0, 10) },
    };
  } catch (e) {
    return {
      id: 'stale-transitives',
      label: 'Stale transitives',
      status: 'yellow',
      message: `Stale scan could not run: ${e instanceof Error ? e.message : String(e)}.`,
    };
  }
}
