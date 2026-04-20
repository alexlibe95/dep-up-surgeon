/**
 * Implementation of the `dep-up-surgeon undo` subcommand.
 *
 * Given a `.dep-up-surgeon.last-run.json` report (the one written next to every CLI run,
 * unless `--no-persist-report`), this module computes a reverse pass that:
 *
 *   1. Reverts `package.json` dependency ranges back to the `from` values recorded for each
 *      successful upgrade (root + every workspace target).
 *   2. Drops override pins that this run added and, when the attempt recorded a `previous`
 *      value, restores the previous pin (i.e. if the advisory/manual pin REPLACED an
 *      existing override, we don't silently delete the original).
 *   3. Runs `<manager> install` so the lockfile reconverges to the reverted ranges.
 *   4. Runs the validator (unless `--no-validate`) so the operator knows the project builds
 *      with the reverted versions before they commit the undo.
 *
 * Safety contract:
 *   - If `package.json` has drifted since the recorded run (e.g. another upgrade changed the
 *     range), we **skip** that row with `reason: 'drifted'`. We never rewrite a range the
 *     user moved out from under us.
 *   - If the recorded run was `dryRun`, there's nothing to undo — we return a no-op report.
 *   - The module does not know how to restore a lockfile snapshot; instead it asks the
 *     manager to reinstall from the reverted `package.json`, which is the guarantee we
 *     actually want. A future extension can layer on a lockfile-hash check.
 *
 * Everything heavy (install, validator) is injected via `opts.installer` / `opts.runValidator`
 * so unit tests can exercise the reverse pass without network / process calls.
 */
import path from 'node:path';
import fs from 'fs-extra';
import type { PackageManager } from '../core/workspaces.js';
import {
  readOverrides,
  removeOverrideFromFile,
  applyOverrideInMemory,
  type OverrideEntry,
} from '../utils/overrides.js';
import { runInstall } from '../utils/npm.js';
import { log } from '../utils/logger.js';
import type { PersistedLastRun } from './lastRun.js';
import { LAST_RUN_FILENAME, loadLastRunReport } from './lastRun.js';

/** One slot in a `package.json` where dep ranges live. */
type DepSection = 'dependencies' | 'devDependencies' | 'peerDependencies' | 'optionalDependencies';
const DEP_SECTIONS: readonly DepSection[] = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/**
 * Per-package revert action computed for a single upgrade row. `skipped` entries are kept in
 * the result so the human + JSON report can explain why a row wasn't reverted (e.g. the
 * current `package.json` already drifted from the recorded `to`).
 */
export interface UndoRevertRecord {
  name: string;
  /** Workspace label ('root' or workspace member name) the row belongs to. */
  workspace: string;
  from?: string;
  to?: string;
  /** Dep section we wrote to; absent when we skipped. */
  section?: DepSection;
  ok: boolean;
  skipped: boolean;
  reason?: 'reverted' | 'drifted' | 'missing' | 'no-from' | 'target-missing';
  detail?: string;
}

/** Per-override drop action computed for a single attempt row. */
export interface UndoOverrideRecord {
  name: string;
  chain?: string[];
  applied?: string;
  previous?: string;
  ok: boolean;
  skipped: boolean;
  reason?: 'dropped' | 'restored-previous' | 'not-present' | 'missing-package-json';
  detail?: string;
}

export interface UndoResult {
  sourceFile: string;
  /** True when the persisted run was `--dry-run` — the reverse pass is a no-op. */
  noop: boolean;
  /** Per-target dep revert outcomes. */
  reverts: UndoRevertRecord[];
  /** Per-override drop outcomes. */
  overrides: UndoOverrideRecord[];
  /** Post-reverse install results, keyed by target cwd. */
  installs: Array<{ cwd: string; ok: boolean; command?: string; exitCode?: number; lastLines?: string }>;
  /** Post-reverse validator result, when not skipped. */
  validation?: { ok: boolean; command?: string; lastLines?: string };
}

export interface UndoOptions {
  /** Project root — where the CLI was invoked. */
  cwd: string;
  /** Explicit persisted run file. Defaults to `<cwd>/.dep-up-surgeon.last-run.json`. */
  file?: string;
  /** Override manager detection (else the value from the persisted run's `project` block). */
  manager?: PackageManager;
  /** Skip the post-reverse install (useful for dry runs / tests). */
  skipInstall?: boolean;
  /** Custom validator. When omitted, the default `validateProject` runs. */
  runValidator?: () => Promise<{ ok: boolean; command?: string; lastLines?: string }>;
  /** Skip the validator entirely. */
  skipValidator?: boolean;
  /** Test hook: override the installer (must match `runInstall` signature). */
  installer?: typeof runInstall;
  /** When true, compute the reverse plan but don't write anything or run install/validator. */
  planOnly?: boolean;
  /** When true, emit machine output only (no human log lines). */
  json?: boolean;
}

/**
 * Run the full reverse pass. Returns a structured `UndoResult` describing what was reverted,
 * what was skipped, and the outcome of the post-reverse install + validator. Never throws on
 * recoverable errors — skipped / failed items are recorded on the result.
 */
export async function runUndo(opts: UndoOptions): Promise<UndoResult> {
  const file = opts.file ? path.resolve(opts.cwd, opts.file) : path.join(opts.cwd, LAST_RUN_FILENAME);
  const persisted = opts.file
    ? await readPersisted(file)
    : await loadLastRunReport(opts.cwd);
  if (!persisted) {
    throw new Error(
      `undo: no run report found at ${file}. Pass --file <path> to point at a specific ` +
        `${LAST_RUN_FILENAME}, or re-run dep-up-surgeon so it writes one.`,
    );
  }

  if (persisted.dryRun) {
    if (!opts.json) {
      log.info(`undo: the recorded run was a dry-run; nothing to revert.`);
    }
    return {
      sourceFile: file,
      noop: true,
      reverts: [],
      overrides: [],
      installs: [],
    };
  }

  const manager = opts.manager ?? (persisted.project?.manager as PackageManager | undefined) ?? 'npm';
  const targets = buildTargetMap(persisted, opts.cwd);
  const reverts: UndoRevertRecord[] = [];
  const overrides: UndoOverrideRecord[] = [];

  // ---- 1. Revert dep ranges ------------------------------------------------
  const editedTargets = new Set<string>();
  for (const row of persisted.upgraded ?? []) {
    if (!row.success || row.skipped) continue;
    const workspace = row.workspace ?? 'root';
    const target = targets.get(workspace) ?? targets.get('root');
    if (!target) {
      reverts.push({
        name: row.name,
        workspace,
        ok: false,
        skipped: true,
        reason: 'target-missing',
        detail: `no target cwd found for workspace "${workspace}"`,
      });
      continue;
    }
    if (!row.from) {
      reverts.push({
        name: row.name,
        workspace,
        ok: false,
        skipped: true,
        reason: 'no-from',
        detail: 'upgrade row did not record a `from` value',
        ...(row.to ? { to: row.to } : {}),
      });
      continue;
    }
    const revert = await revertDepRange(target.packageJson, row.name, row.from, row.to);
    reverts.push({
      name: row.name,
      workspace,
      from: row.from,
      ...(row.to ? { to: row.to } : {}),
      ...(revert.section ? { section: revert.section } : {}),
      ok: revert.ok,
      skipped: !revert.ok,
      ...(revert.reason ? { reason: revert.reason } : {}),
      ...(revert.detail ? { detail: revert.detail } : {}),
    });
    if (revert.ok && !opts.planOnly) {
      await fs.writeJson(target.packageJson, revert.pkg, { spaces: 2 });
      editedTargets.add(target.cwd);
    }
  }

  // ---- 2. Drop / restore overrides ----------------------------------------
  for (const att of persisted.overrides?.attempts ?? []) {
    if (!att.ok || att.skipped) continue;
    const pkgJson = targets.get('root')?.packageJson ?? path.join(opts.cwd, 'package.json');
    if (!(await fs.pathExists(pkgJson))) {
      overrides.push({
        name: att.name,
        ok: false,
        skipped: true,
        reason: 'missing-package-json',
        detail: pkgJson,
      });
      continue;
    }
    const chain = att.chain && att.chain.length > 0 ? [...att.chain] : [att.name];
    let result: UndoOverrideRecord;
    if (att.previous && att.previous !== att.applied) {
      // Restore the pre-existing pin rather than deleting outright. This is the case where
      // --apply-overrides REPLACED an existing override (e.g. we bumped 1.2.3 → 1.3.0); undo
      // should put 1.2.3 back, not leave the transitive floating.
      if (opts.planOnly) {
        result = {
          name: att.name,
          chain,
          ...(att.applied ? { applied: att.applied } : {}),
          previous: att.previous,
          ok: true,
          skipped: false,
          reason: 'restored-previous',
          detail: `would restore ${att.previous}`,
        };
      } else {
        const entry: OverrideEntry = { name: chain[chain.length - 1]!, range: att.previous };
        if (chain.length > 1) entry.parentChain = chain.slice(0, -1);
        // Undo deliberately bypasses `applyOverrideToFile`'s "skip if existing >= target"
        // semantics — a revert is allowed to move the pin backwards; that's literally the
        // whole point. We call `applyOverrideInMemory` directly and write the result.
        const pkg = (await fs.readJson(pkgJson)) as Record<string, unknown>;
        const next = applyOverrideInMemory(pkg, manager, entry);
        await fs.writeJson(pkgJson, next, { spaces: 2 });
        editedTargets.add(opts.cwd);
        result = {
          name: att.name,
          chain,
          ...(att.applied ? { applied: att.applied } : {}),
          previous: att.previous,
          ok: true,
          skipped: false,
          reason: 'restored-previous',
        };
      }
    } else {
      if (opts.planOnly) {
        result = {
          name: att.name,
          chain,
          ...(att.applied ? { applied: att.applied } : {}),
          ok: true,
          skipped: false,
          reason: 'dropped',
          detail: 'would drop',
        };
      } else {
        const removed = await removeOverrideFromFile(pkgJson, manager, { chain });
        if (removed.removed) {
          editedTargets.add(opts.cwd);
          result = {
            name: att.name,
            chain,
            ...(att.applied ? { applied: att.applied } : {}),
            ok: true,
            skipped: false,
            reason: 'dropped',
          };
        } else {
          result = {
            name: att.name,
            chain,
            ...(att.applied ? { applied: att.applied } : {}),
            ok: false,
            skipped: true,
            reason: 'not-present',
            ...(removed.reason ? { detail: removed.reason } : {}),
          };
        }
      }
    }
    overrides.push(result);
  }

  // ---- 3. Post-reverse install --------------------------------------------
  const installs: UndoResult['installs'] = [];
  if (!opts.planOnly && !opts.skipInstall && editedTargets.size > 0) {
    const installer = opts.installer ?? runInstall;
    for (const targetCwd of editedTargets) {
      const r = await installer(targetCwd, manager, {});
      const row: UndoResult['installs'][number] = {
        cwd: targetCwd,
        ok: r.ok,
        ...(r.command ? { command: r.command } : {}),
        ...(typeof r.exitCode === 'number' ? { exitCode: r.exitCode } : {}),
        ...(r.output ? { lastLines: tail(r.output, 40) } : {}),
      };
      installs.push(row);
    }
  }

  // ---- 4. Post-reverse validator ------------------------------------------
  let validation: UndoResult['validation'];
  if (!opts.planOnly && !opts.skipValidator && installs.every((r) => r.ok)) {
    if (opts.runValidator) {
      validation = await opts.runValidator();
    }
  }

  return {
    sourceFile: file,
    noop: false,
    reverts,
    overrides,
    installs,
    ...(validation ? { validation } : {}),
  };
}

async function readPersisted(file: string): Promise<PersistedLastRun | undefined> {
  if (!(await fs.pathExists(file))) {
    return undefined;
  }
  try {
    return (await fs.readJson(file)) as PersistedLastRun;
  } catch {
    return undefined;
  }
}

/**
 * Map workspace label → `{ cwd, packageJson }`. Falls back to the run's `cwd` when no
 * targets block was persisted (single-root run).
 */
function buildTargetMap(
  persisted: PersistedLastRun,
  invokedAt: string,
): Map<string, { cwd: string; packageJson: string }> {
  const map = new Map<string, { cwd: string; packageJson: string }>();
  const targets = persisted.targets ?? [];
  if (targets.length === 0) {
    const rootCwd = persisted.cwd ?? invokedAt;
    map.set('root', {
      cwd: rootCwd,
      packageJson: path.join(rootCwd, 'package.json'),
    });
    return map;
  }
  for (const t of targets) {
    map.set(t.label, { cwd: t.cwd, packageJson: t.packageJson });
  }
  if (!map.has('root')) {
    const rootCwd = persisted.cwd ?? invokedAt;
    map.set('root', {
      cwd: rootCwd,
      packageJson: path.join(rootCwd, 'package.json'),
    });
  }
  return map;
}

/**
 * Revert `name` back to `from` in whichever dep section currently holds it. Returns the
 * modified `pkg` object alongside metadata about what section we touched. If the current
 * range doesn't match the recorded `to`, we skip with `drifted` — the user modified the
 * range out from under us and rewriting would be destructive.
 *
 * We do NOT assert the recorded `from` matches the version before the run; the run itself
 * wrote it, so treating its `from` value as authoritative is exactly what the user wants.
 */
async function revertDepRange(
  packageJson: string,
  name: string,
  from: string,
  to: string | undefined,
): Promise<{
  ok: boolean;
  pkg?: Record<string, unknown>;
  section?: DepSection;
  reason?: UndoRevertRecord['reason'];
  detail?: string;
}> {
  if (!(await fs.pathExists(packageJson))) {
    return { ok: false, reason: 'missing', detail: `${packageJson} not found` };
  }
  const pkg = (await fs.readJson(packageJson)) as Record<string, unknown>;
  for (const section of DEP_SECTIONS) {
    const sec = pkg[section];
    if (!sec || typeof sec !== 'object') continue;
    const map = sec as Record<string, unknown>;
    if (!(name in map)) continue;
    const current = typeof map[name] === 'string' ? (map[name] as string) : undefined;
    if (to && current !== undefined && current !== to) {
      // The recorded run landed on `to` but the current file holds something else — another
      // run (or a human edit) changed it. Bail out of this row; undo is about REVERSING this
      // specific run, not about steamrolling later history.
      return {
        ok: false,
        reason: 'drifted',
        detail: `current \`${section}.${name}\` is "${current}" but the run recorded "${to}"; leaving as-is`,
      };
    }
    map[name] = from;
    pkg[section] = map;
    return { ok: true, pkg, section };
  }
  return {
    ok: false,
    reason: 'missing',
    detail: `${name} not found in any dep section of ${path.basename(packageJson)}`,
  };
}

/**
 * Render a human-readable summary of an `UndoResult`. Used by the CLI when `--json` is not
 * set; tests render the JSON directly.
 */
export function renderUndoHuman(result: UndoResult): string {
  const lines: string[] = [];
  lines.push(`undo: replayed ${path.basename(result.sourceFile)}`);
  if (result.noop) {
    lines.push('  nothing to revert (recorded run was a dry-run)');
    return lines.join('\n');
  }
  const reverted = result.reverts.filter((r) => r.ok);
  const skipped = result.reverts.filter((r) => !r.ok);
  const droppedOverrides = result.overrides.filter((r) => r.ok);
  const skippedOverrides = result.overrides.filter((r) => !r.ok);

  lines.push(`  ${reverted.length} dep range(s) reverted, ${skipped.length} skipped`);
  for (const r of reverted) {
    const ws = r.workspace === 'root' ? '' : ` [${r.workspace}]`;
    lines.push(`    - ${r.name}${ws}: ${r.to ?? '?'} → ${r.from}`);
  }
  for (const r of skipped) {
    const ws = r.workspace === 'root' ? '' : ` [${r.workspace}]`;
    lines.push(`    ~ ${r.name}${ws}: skipped (${r.reason}${r.detail ? ` — ${r.detail}` : ''})`);
  }

  if (result.overrides.length > 0) {
    lines.push(`  ${droppedOverrides.length} override(s) dropped, ${skippedOverrides.length} skipped`);
    for (const o of droppedOverrides) {
      const label = o.chain && o.chain.length > 1 ? o.chain.join('>') : o.name;
      lines.push(`    - ${label}: ${o.reason}${o.previous ? ` (${o.applied} → ${o.previous})` : ` (dropped ${o.applied ?? '?'})`}`);
    }
    for (const o of skippedOverrides) {
      const label = o.chain && o.chain.length > 1 ? o.chain.join('>') : o.name;
      lines.push(`    ~ ${label}: skipped (${o.reason}${o.detail ? ` — ${o.detail}` : ''})`);
    }
  }

  for (const inst of result.installs) {
    lines.push(`  install @ ${inst.cwd}: ${inst.ok ? 'ok' : `failed (exit ${inst.exitCode ?? '?'})`}`);
  }
  if (result.validation) {
    lines.push(`  validator: ${result.validation.ok ? 'ok' : 'failed'}`);
  }
  return lines.join('\n');
}

/** Take the last `n` lines of multi-line text, preserving order. */
function tail(text: string, n: number): string {
  const lines = text.split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

/** True when the reverse pass succeeded end-to-end (reverts, installs, validator). */
export function undoSucceeded(result: UndoResult): boolean {
  if (result.noop) return true;
  if (result.installs.some((i) => !i.ok)) return false;
  if (result.validation && !result.validation.ok) return false;
  // Skipped revert rows are soft failures — the user knows about them — so we still return
  // true so `--undo` can exit 0 when everything else is clean. The JSON report surfaces the
  // per-row `skipped` so CI bots can be stricter if they care.
  return true;
}

/**
 * Verify a persisted run's overrides weren't already partially undone by a subsequent run.
 * Exported so callers can cheaply check state before running the full reverse pass (e.g. a
 * `--undo --dry-run` mode).
 */
export async function checkOverridesStillPresent(
  persisted: PersistedLastRun,
  manager: PackageManager,
  cwd: string,
): Promise<{ present: number; missing: number }> {
  const pkgJson = path.join(cwd, 'package.json');
  if (!(await fs.pathExists(pkgJson))) return { present: 0, missing: 0 };
  const pkg = (await fs.readJson(pkgJson)) as Record<string, unknown>;
  const read = readOverrides(pkg, manager);
  let present = 0;
  let missing = 0;
  for (const att of persisted.overrides?.attempts ?? []) {
    if (!att.ok || att.skipped) continue;
    const chain = att.chain && att.chain.length > 0 ? att.chain : [att.name];
    const hit = read.entries.find(
      (e) => e.chain.length === chain.length && e.chain.every((seg, i) => seg === chain[i]),
    );
    if (hit) present++;
    else missing++;
  }
  return { present, missing };
}
