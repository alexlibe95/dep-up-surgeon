/**
 * Apply package-manager overrides (`overrides` / `pnpm.overrides` / `resolutions`) for
 * transitive CVEs that the main upgrade loop cannot fix by bumping a direct dependency.
 *
 * Invocation order (in `cli.ts`):
 *
 *   1. `--security-only` runs `<manager> audit --json` → produces `SecurityAdvisory[]`.
 *   2. The normal upgrade loop runs. It only touches direct deps, so any advisory whose
 *      `name` is NOT a direct dependency of any workspace remains unresolved.
 *   3. **This module kicks in** when `--apply-overrides` is set: for every unresolved
 *      advisory with a `recommendedVersion`, it writes a one-line override pinning that
 *      package to the safe version, runs install + validator, and rolls back on failure.
 *
 * Design notes:
 *   - **Sequential by design.** Overrides interact with the lockfile; running two installs
 *     in parallel in the same cwd would clobber each other. We also want the validator to
 *     verify the cumulative state after each pin, so "install after each override" is correct.
 *   - **Rollback on validator failure.** If the install succeeds but the validator fails,
 *     we remove the override we just added AND re-run install, so the working tree is left in
 *     the same shape the user started in. If the rollback install itself fails, we surface
 *     that in the record too and keep going — one broken pin shouldn't strand every other one.
 *   - Never fatal. The returned `OverrideFlowResult` lists every attempt so the JSON consumer
 *     (and the summary writer) can render exactly what happened.
 *   - Uses the existing `runInstall` + validator utilities; this is a thin orchestrator.
 */
import path from 'node:path';
import fs from 'fs-extra';
import type { SecurityAdvisory } from '../core/audit.js';
import type { PackageManager } from '../core/workspaces.js';
import { runInstall, type InstallResult } from '../utils/npm.js';
import { log } from '../utils/logger.js';
import {
  applyOverrideToFile,
  overrideFieldFor,
  removeOverrideFromFile,
  type OverrideField,
  type OverrideEntry,
} from '../utils/overrides.js';

export interface OverrideAttemptRecord {
  name: string;
  severity: 'low' | 'moderate' | 'high' | 'critical';
  ids: string[];
  url?: string;
  title?: string;
  /** The pin we wrote (undefined when we skipped). */
  applied?: string;
  /** The previous pin, if any. */
  previous?: string;
  /**
   * Full parent chain for parent-scoped pins, outermost → leaf. Omitted for flat pins
   * (equivalent to `chain: [name]`). Included in the report so consumers know which exact
   * slot in the overrides block was touched.
   */
  chain?: string[];
  /**
   * How this attempt was triggered. `advisory` = fed in by `--security-only` audit; `manual`
   * = user-supplied via `--override` CLI flag or `.dep-up-surgeonrc` `overrides` policy.
   * Consumers can render the two lists separately (e.g. manual overrides don't map to a CVE).
   */
  source: 'advisory' | 'manual';
  /**
   * Human-readable reason the manual pin exists (e.g. `"CVE-2025-1234"`, `"awaiting upstream
   * PR #123"`). Populated only for pins sourced from the rc policy; CLI-only pins have no
   * reason attached. Rendered verbatim in the JSON report and the markdown summary so
   * reviewers see the "why" next to the "what" without grepping commit messages.
   */
  policyReason?: string;
  /** Field we touched (`overrides` / `pnpm.overrides` / `resolutions`). */
  field: OverrideField;
  /** True when the write, install, AND validator all succeeded. */
  ok: boolean;
  /** True when we skipped without writing (already-safe, no recommended version, etc.). */
  skipped: boolean;
  /** Short reason on skip / failure. */
  reason?: string;
  /** Captured install log tail when the install OR validator failed (for surfacing in report). */
  installLog?: string;
  /** True when a rollback was performed. */
  rolledBack?: boolean;
}

/**
 * User-supplied override pin (from `--override` CLI flag or similar). Unlike advisory-driven
 * pins, these carry an arbitrary parent chain and no CVE metadata. They run through the same
 * write + install + validator + rollback cycle so a manual pin can't wreck the workspace.
 */
export interface ManualOverrideSpec {
  /** Parent chain + leaf, outermost → leaf (`[name]` for flat pins). */
  chain: string[];
  /** Version / range to pin. */
  range: string;
  /** Original user-supplied selector string, for error messages and the report. */
  source?: string;
  /**
   * Optional human-readable reason for the pin. When provided, it's threaded into the
   * attempt record's `policyReason` so the JSON report + summary can render it alongside
   * the pinned package. Used by rc-sourced overrides to surface CVE IDs / vendor guidance.
   */
  reason?: string;
}

export interface OverrideFlowOptions {
  /** Workspace root. Every override write and `runInstall` happens here. */
  cwd: string;
  /** Detected package manager. Determines the override field + install args. */
  manager: PackageManager;
  /** All advisories from the audit. Filtered by `isTransitiveOnly` internally. */
  advisories: SecurityAdvisory[];
  /** Set of package names that have already been upgraded by the direct-dep loop. */
  upgradedNames: Set<string>;
  /** Set of package names present as direct dependencies in any workspace's package.json. */
  directDepNames: Set<string>;
  /**
   * Optional validator runner. Signature matches the engine's own `runValidator` but we keep
   * it injected to avoid a dependency on the full upgrade engine state. Return `{ ok, diag? }`.
   */
  runValidator?: () => Promise<{ ok: boolean; message?: string }>;
  /** When true, overwrite an existing override that conflicts with the target. Default: false. */
  overwriteConflicts?: boolean;
  /** When true, don't actually write / install — just plan and record what would happen. */
  dryRun?: boolean;
  /** True when the CLI is in `--json` mode: suppress human-readable progress log lines. */
  json?: boolean;
  /**
   * User-supplied parent-scoped or flat pins (via `--override` CLI flag). These run AFTER
   * the advisory-driven pins in the same loop so they share the install + validator +
   * rollback machinery. A failure here never touches advisory results.
   */
  manualOverrides?: ManualOverrideSpec[];
  /**
   * Optional install runner override. Kept as an injection point so tests can exercise the
   * write + rollback cycle without actually shelling out.
   */
  installer?: typeof runInstall;
}

export interface OverrideFlowResult {
  /** Every advisory we considered, including skips. */
  attempts: OverrideAttemptRecord[];
}

/**
 * Run the full override flow. Returns a structured result; never throws. The final
 * `package.json` / lockfile state reflects every successful write (rolled-back failures are
 * left in the original state).
 */
export async function runOverrideFlow(opts: OverrideFlowOptions): Promise<OverrideFlowResult> {
  const attempts: OverrideAttemptRecord[] = [];
  const field = overrideFieldFor(opts.manager);
  const pkgJson = path.join(opts.cwd, 'package.json');

  // Only consider advisories whose package is NOT a direct dep AND was NOT already touched by
  // the main upgrade loop. These are the pure-transitive CVEs that overrides exist to fix.
  const targets = opts.advisories.filter(
    (a) =>
      !opts.directDepNames.has(a.name) &&
      !opts.upgradedNames.has(a.name),
  );

  const hasManual = (opts.manualOverrides?.length ?? 0) > 0;
  if (targets.length === 0 && !hasManual) {
    return { attempts };
  }

  if (targets.length > 0 && !opts.json) {
    log.info(
      `--apply-overrides: ${targets.length} transitive advisor${targets.length === 1 ? 'y' : 'ies'} to pin (${targets.map((t) => t.name).slice(0, 5).join(', ')}${targets.length > 5 ? ', ...' : ''})`,
    );
  }

  for (const adv of targets) {
    const rec: OverrideAttemptRecord = {
      name: adv.name,
      severity: adv.severity,
      ids: adv.ids,
      field,
      ok: false,
      skipped: false,
      source: 'advisory',
    };
    if (adv.url) rec.url = adv.url;
    if (adv.title) rec.title = adv.title;

    const target = adv.recommendedVersion;
    if (!target) {
      rec.skipped = true;
      rec.reason = 'audit did not provide a fixed version';
      attempts.push(rec);
      continue;
    }

    await processPin(
      rec,
      { name: adv.name, range: target },
      opts,
      pkgJson,
      `--apply-overrides`,
    );
    attempts.push(rec);
  }

  // Manual --override pins: processed AFTER advisories so any audit-driven pin that clears a
  // path is visible first. Manual pins share the same install + validator + rollback loop.
  if (opts.manualOverrides && opts.manualOverrides.length > 0) {
    if (!opts.json) {
      log.info(
        `--override: ${opts.manualOverrides.length} manual pin${opts.manualOverrides.length === 1 ? '' : 's'} to apply`,
      );
    }
    for (const spec of opts.manualOverrides) {
      if (spec.chain.length === 0) continue;
      const name = spec.chain[spec.chain.length - 1]!;
      const parentChain = spec.chain.slice(0, -1);
      const rec: OverrideAttemptRecord = {
        name,
        severity: 'low',
        ids: [],
        field,
        ok: false,
        skipped: false,
        source: 'manual',
      };
      if (spec.chain.length > 1) rec.chain = [...spec.chain];
      if (spec.source) rec.title = spec.source;
      if (spec.reason) rec.policyReason = spec.reason;
      const entry: OverrideEntry = { name, range: spec.range };
      if (parentChain.length > 0) entry.parentChain = parentChain;
      await processPin(rec, entry, opts, pkgJson, `--override`);
      attempts.push(rec);
    }
  }

  return { attempts };
}

/**
 * Shared write + install + validate + rollback cycle used for BOTH advisory pins and
 * manual pins. Mutates `rec` in place: callers push it into `attempts` regardless of
 * outcome. Returns nothing — every outcome is captured on `rec`.
 */
async function processPin(
  rec: OverrideAttemptRecord,
  entry: OverrideEntry,
  opts: OverrideFlowOptions,
  pkgJson: string,
  logTag: string,
): Promise<void> {
  const label =
    entry.parentChain && entry.parentChain.length > 0
      ? `${[...entry.parentChain, entry.name].join('>')}`
      : entry.name;

  if (opts.dryRun) {
    rec.skipped = true;
    rec.reason = 'dry-run';
    rec.applied = entry.range;
    return;
  }

  const applied = await applyOverrideToFile({
    packageJsonPath: pkgJson,
    manager: opts.manager,
    entry,
    ...(opts.overwriteConflicts ? { overwriteConflicts: true } : {}),
  });
  if (!applied.ok) {
    rec.skipped = true;
    rec.reason = applied.reason;
    if (applied.previous) rec.previous = applied.previous;
    return;
  }
  if (!applied.written) {
    rec.skipped = true;
    rec.ok = true;
    rec.reason = applied.reason ?? 'already satisfies target';
    if (applied.applied) rec.applied = applied.applied;
    if (applied.previous) rec.previous = applied.previous;
    return;
  }
  rec.applied = applied.applied ?? entry.range;
  if (applied.previous) rec.previous = applied.previous;

  if (!opts.json) {
    log.info(
      `${logTag}: pinning ${label} → ${entry.range} and running ${opts.manager} install`,
    );
  }
  const installer = opts.installer ?? runInstall;
  const install = await installer(opts.cwd, opts.manager, {});
  if (!install.ok) {
    rec.installLog = tailOutput(install);
    const rb = await rollback(pkgJson, opts, entry);
    rec.rolledBack = rb.rolledBack;
    rec.reason = `install failed after override (exit ${install.exitCode})`;
    return;
  }

  if (opts.runValidator) {
    const v = await opts.runValidator();
    if (!v.ok) {
      if (v.message) rec.installLog = v.message;
      const rb = await rollback(pkgJson, opts, entry);
      rec.rolledBack = rb.rolledBack;
      rec.reason = `validator failed after override: ${v.message ?? 'non-zero exit'}`;
      return;
    }
  }

  rec.ok = true;
  if (!opts.json) {
    log.success(`${logTag}: pinned ${label}@${entry.range}`);
  }
}

/**
 * Remove the override we just added and re-run install so the workspace ends up in the same
 * state the user had at the start of the attempt. The entry's parent chain (if any) is
 * threaded through to `removeOverrideFromFile` so we delete the EXACT slot we wrote and
 * never touch an adjacent flat pin or sibling. Install failures during rollback are logged
 * but don't crash the flow — the next override attempt will run whatever state we're in.
 */
async function rollback(
  pkgJson: string,
  opts: OverrideFlowOptions,
  entry: OverrideEntry,
): Promise<{ rolledBack: boolean; reinstallOk: boolean }> {
  const chain = [...(entry.parentChain ?? []), entry.name];
  const label = chain.join('>');
  const removed = await removeOverrideFromFile(pkgJson, opts.manager, { chain });
  if (!removed.ok || !removed.removed) {
    return { rolledBack: false, reinstallOk: false };
  }
  const installer = opts.installer ?? runInstall;
  const reinstall = await installer(opts.cwd, opts.manager, {});
  if (!reinstall.ok && !opts.json) {
    log.warn(
      `rollback: re-install after removing override for ${label} exited ${reinstall.exitCode}; workspace may need manual cleanup.`,
    );
  }
  return { rolledBack: true, reinstallOk: reinstall.ok };
}

/** Last ~20 lines of the install output, for surfacing in the structured report. */
function tailOutput(install: InstallResult): string {
  if (install.output && install.output.trim().length > 0) {
    const lines = install.output.split(/\r?\n/).slice(-20);
    return lines.join('\n');
  }
  return `install failed (exit ${install.exitCode})`;
}

/**
 * Build the set of direct-dependency names from a target's package.json. Used by cli.ts to
 * decide which advisories are transitive-only. Covers `dependencies`, `devDependencies`,
 * `optionalDependencies`, and `peerDependencies`.
 */
export async function collectDirectDepNames(pkgJsonPath: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const raw = await fs.readFile(pkgJsonPath, 'utf8');
    const pkg = JSON.parse(raw) as Record<string, unknown>;
    for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
      const block = pkg[field];
      if (block && typeof block === 'object') {
        for (const name of Object.keys(block as Record<string, unknown>)) {
          out.add(name);
        }
      }
    }
  } catch {
    // best-effort — empty set is a safe default (treats everything as transitive, which will
    // just cause extra no-op override writes, never data loss).
  }
  return out;
}
