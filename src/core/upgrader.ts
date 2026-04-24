import path from 'node:path';
import fs from 'fs-extra';
import prompts from 'prompts';
import semver from 'semver';
import { appendIgnoreToRc } from '../config/loadConfig.js';
import type {
  Conflict,
  DepSection,
  FailureReason,
  FinalReport,
  InstallDiagnostic,
  ScannedPackage,
  UpgradeRecord,
  ValidationDiagnostic,
} from '../types.js';
import type { PackageJson } from '../types.js';
import { addFailure, addUpgrade, createEmptyReport } from './conflict.js';
import { isRegistryRange, scanProject } from './scanner.js';
import { validateProject, type ValidationOptions, type ValidationResult } from './validator.js';
import { createSpinner, log, type Spinner } from '../utils/logger.js';
import {
  detectEsmCommonJsBlockage,
  fetchAllPublishedVersions,
  fetchLatestVersion,
  fetchVersionPeers,
  runInstall,
  type InstallManager,
  type InstallOptions,
  type InstallResult,
} from '../utils/npm.js';
import { detectProjectInfo, type PackageManager, type ProjectInfo } from './workspaces.js';
import { tailLines } from '../utils/output.js';
import {
  KeyedMutex,
  createRegistryCache,
  runWithConcurrency,
  type RegistryCache,
} from '../utils/concurrency.js';
import {
  classifiedHasPeerLikeFailure,
  dedupeClassifiedConflicts,
  extractClassifiedConflicts,
  shouldRollbackAfterSuccessfulInstall,
  type ClassifiedConflict,
} from './conflictAnalyzer.js';
import { promptGroupConflictChoice } from '../cli/interactive.js';
import { buildLineFallbackOrder } from '../utils/versionFallback.js';
import { buildSingletonGroups } from './groups.js';
import { buildDynamicLinkedGroups } from './dynamicGroups.js';
import type { LinkedGroup } from './groups.js';
import {
  buildDomain,
  describeResolution,
  resolvePeerRanges,
  type CandidateDomain,
  type ResolvedTuple,
  type ResolverInput,
} from './peerResolver.js';
import { tryResolveAdHocPeerConflict } from './peerResolverAdHoc.js';

const BACKUP_FILENAME = 'package.json.dep-up-surgeon.bak';

function classifyInstallOutput(output: string | undefined, opts: UpgradeEngineOptions): ClassifiedConflict[] {
  return extractClassifiedConflicts(output ?? '', { rootPackageName: opts.rootPackageName });
}

export type FallbackStrategy = 'major-lines' | 'minor-lines' | 'none';

export interface UpgradeEngineOptions {
  cwd: string;
  dryRun: boolean;
  interactive: boolean;
  force: boolean;
  jsonOutput: boolean;
  ignore: Set<string>;
  /**
   * When set, only packages whose `name` is in this set are candidates for upgrade. Every other
   * scanned package is treated as if it were in `ignore`. Used by `--security-only` to restrict
   * the plan to audited (vulnerable) packages. `undefined` disables the restriction entirely.
   */
  restrictToNames?: Set<string>;
  /**
   * Optional policy (from `.dep-up-surgeon.policy.{yaml,json}`). Applied during target
   * resolution: freeze entries filter out packages upfront (usually handled at the CLI level
   * by contributing to `ignore`), maxVersion / allowMajorAfter filter the candidate list
   * before the fallback walker runs.
   */
  policy?: import('../config/policy.js').Policy;
  /**
   * `major-lines` (default): after `@latest` fails, try one best version per **major**
   * (fewer installs; good when whole majors flip e.g. ESM-only).
   * `minor-lines`: one best version per **(major.minor)** (finer steps).
   * `none`: only attempt `@latest`.
   */
  fallbackStrategy: FallbackStrategy;
  /**
   * `auto`: linked batches from registry **peer** graph + `.dep-up-surgeonrc` `linkedGroups`.
   * `none`: one package per upgrade step (legacy).
   */
  linkGroups: 'auto' | 'none';
  /** From `.dep-up-surgeonrc` — custom groups applied before built-in rules */
  linkedGroupsConfig?: Array<{ id: string; packages: string[] }>;
  /**
   * Root `package.json` `name` (set automatically in `runUpgradeEngine`). Used to ignore
   * false-positive conflict lines such as `While resolving: <app>@0.0.0`.
   */
  rootPackageName?: string;
  /**
   * Validator override: custom command, or `skip: true` to bypass validation entirely.
   * When omitted, the built-in `npm test` → `npm run build` heuristic is used.
   */
  validate?: ValidationOptions & { source?: 'cli' | 'config' };
  /**
   * Override for the package manager used by `runInstall` and the default validator. When
   * omitted, the manager is auto-detected via `detectProjectInfo` (looks at `packageManager`,
   * lockfiles, and `pnpm-workspace.yaml`).
   */
  packageManager?: PackageManager | 'auto';
  /**
   * When `false` (default), workspace-internal dependencies (names matching a local workspace
   * package) are skipped explicitly. When `true`, they are treated like any other dep — useful
   * when local workspace packages also publish to the registry.
   */
  includeWorkspaceDeps?: boolean;
  /**
   * Pre-resolved project info. When omitted, `runUpgradeEngine` calls `detectProjectInfo`
   * itself; tests/programmatic callers can pass their own.
   */
  projectInfo?: ProjectInfo;
  /**
   * Directory where the package manager (`<mgr> install`) and the validator are executed.
   * Defaults to `cwd`. When mutating a workspace child `package.json`, set this to the workspace
   * **root** so the install resolves the lockfile correctly and the validator sees the entire
   * monorepo.
   */
  installCwd?: string;
  /**
   * Tag applied to every `UpgradeRecord` and `ConflictEntry` produced by this engine call.
   * Used by the multi-target orchestrator (`runUpgradeFlow`) to label rows by workspace member.
   */
  targetLabel?: string;
  /**
   * Skip the pre-flight validator + initial backup (set by the orchestrator when running
   * multiple targets in one flow — pre-flight only makes sense once per workspace root).
   */
  skipPreflight?: boolean;
  /**
   * Workspace install strategy. `'root'` (default) always runs `<mgr> install` from the
   * workspace root — the safest choice and what every package manager supports unconditionally.
   * `'filtered'` rewrites each per-child install to its workspace-scoped form (npm `-w`,
   * pnpm `--filter`) so only the affected member is resolved; on big monorepos this is several
   * times faster. Only effective when the orchestrator also sets `installFilter`.
   */
  installMode?: 'root' | 'filtered';
  /**
   * Workspace member name to scope the install to (e.g. `@org/web`). Set by `runUpgradeFlow`
   * per target when `installMode === 'filtered'` and the target is a workspace child. Yarn
   * silently falls back to a full install (`InstallResult.filtered` will be `false`).
   */
  installFilter?: string;
  /**
   * Shared registry fetch cache. When provided, `pacote.manifest` / `pacote.packument` calls
   * for the same package name are deduplicated across the engine call. The orchestrator
   * creates one cache per `runUpgradeFlow` invocation so all targets benefit, even at
   * `--concurrency 1` (in monorepos the same dep typically appears in many members).
   */
  registryCache?: RegistryCache;
  /**
   * Keyed install mutex. The engine acquires it around every install + post-install
   * validation step, keyed by the install **directory**. Two targets that install into the
   * same directory (shared-lockfile monorepo — the common case) still serialize fully, but
   * targets that install into different directories (isolated-lockfile / nohoist setups) run
   * concurrently. The orchestrator creates one `KeyedMutex` per `runUpgradeFlow` invocation
   * when `--concurrency > 1`. At concurrency 1 the mutex is omitted (zero overhead, same
   * behavior as before).
   */
  installLock?: KeyedMutex;
  /**
   * Hook fired AFTER each successful single OR batch upgrade (after the row has been added to
   * `report.upgraded` but before the next attempt begins). Used by the CLI's git integration
   * to commit per-success or accumulate per-target diffs. The callback runs INSIDE the
   * `installLock` critical section when one is active, so multiple concurrent targets won't
   * race their git operations either.
   *
   * Failures from the callback MUST be swallowed by the callback itself — the engine treats
   * the callback as fire-and-forget. The package.json mutation has already happened and is
   * recorded in the report; downstream side effects (git commits) must never roll back the
   * upgrade.
   */
  onUpgradeApplied?: (event: UpgradeAppliedEvent) => Promise<void>;
  /**
   * When `true` (the default), a linked-group batch that fails with a PEER-type install conflict
   * triggers `src/core/peerResolver.ts` — we fetch each linked package's packument, compute the
   * intersection of peer ranges, and retry the batch with a compatible (possibly slightly
   * downgraded) version tuple. If the resolver can't find one, or the retried install still
   * fails, the batch behaves exactly as before (rollback + `kind: 'peer'` failure row).
   *
   * Set to `false` (via `--no-resolve-peers`) to preserve the pre-resolver behavior —
   * useful when you WANT to know that a peer conflict exists instead of having the tool
   * silently bump things off latest.
   */
  resolvePeers?: boolean;
  /**
   * Override for the install step. When omitted, the engine uses `runInstall` from
   * `utils/npm.ts` which shells out to `<manager> install`. Tests inject a stub so the
   * rollback / peer / validator paths can be exercised without actually installing from
   * the registry. Signature is the same as `runInstall` so switching to a real binary is
   * zero-cost at runtime.
   *
   * Never exposed on the CLI — this is a programmatic hook exclusively.
   */
  installer?: typeof runInstall;
}

/**
 * Payload passed to `onUpgradeApplied`. For single upgrades `records` has length 1; for batched
 * linked-group upgrades it has length N (one per group member). `targetCwd` is the directory
 * whose `package.json` was mutated; `installCwd` is where the lockfile + node_modules live.
 */
export interface UpgradeAppliedEvent {
  records: UpgradeRecord[];
  targetCwd: string;
  installCwd: string;
  manager: PackageManager;
  /** Workspace label tag (`'root'` or member package name). `undefined` for non-workspace runs. */
  workspace?: string;
  /** Linked-group id when this success was a batch; absent for single upgrades. */
  groupId?: string;
}

async function readPackageJson(cwd: string): Promise<PackageJson> {
  return fs.readJson(path.join(cwd, 'package.json'));
}

async function writePackageJson(cwd: string, pkg: PackageJson): Promise<void> {
  await fs.writeJson(path.join(cwd, 'package.json'), pkg, { spaces: 2 });
}

async function backupPackageJson(cwd: string): Promise<void> {
  const src = path.join(cwd, 'package.json');
  const dest = path.join(cwd, BACKUP_FILENAME);
  await fs.copy(src, dest, { overwrite: true });
}

async function restoreBackup(cwd: string): Promise<void> {
  const src = path.join(cwd, BACKUP_FILENAME);
  const dest = path.join(cwd, 'package.json');
  if (await fs.pathExists(src)) {
    await fs.copy(src, dest, { overwrite: true });
  }
}

function setRange(
  pkg: PackageJson,
  section: DepSection,
  name: string,
  range: string,
): PackageJson {
  const next = { ...pkg };
  const sectionMap = { ...(next[section] ?? {}) };
  sectionMap[name] = range;
  next[section] = sectionMap;
  return next;
}

async function writeDepRange(
  cwd: string,
  section: DepSection,
  name: string,
  range: string,
): Promise<void> {
  const pkg = await readPackageJson(cwd);
  const next = setRange(pkg, section, name, range);
  await writePackageJson(cwd, next);
}

function conflictKey(c: { depender: string; dependency: string; requiredRange: string; installedVersion?: string; attemptedVersion?: string }): string {
  return `${c.depender}|${c.dependency}|${c.requiredRange}|${c.installedVersion ?? ''}|${c.attemptedVersion ?? ''}`;
}

function pushParsedConflicts(report: FinalReport, classified: ClassifiedConflict[]): void {
  const list = dedupeClassifiedConflicts(classified);
  if (list.length === 0) {
    return;
  }
  if (!report.parsedConflicts) {
    report.parsedConflicts = [];
  }
  const existing = new Set(report.parsedConflicts.map((x) => conflictKey(x)));
  for (const c of list) {
    const k = conflictKey(c);
    if (existing.has(k)) {
      continue;
    }
    existing.add(k);
    report.parsedConflicts.push({
      depender: c.depender,
      dependency: c.dependency,
      requiredRange: c.requiredRange,
      installedVersion: c.installedVersion,
      attemptedVersion: c.attemptedVersion,
      rawMessage: c.rawMessage,
    });
  }
}

function toConflicts(classified: ClassifiedConflict[] | undefined): Conflict[] | undefined {
  if (!classified?.length) {
    return undefined;
  }
  return classified.map((c) => ({
    depender: c.depender,
    dependency: c.dependency,
    requiredRange: c.requiredRange,
    installedVersion: c.installedVersion,
    attemptedVersion: c.attemptedVersion,
    rawMessage: c.rawMessage,
  }));
}

type FailureKind =
  | 'install'
  | 'peer'
  | 'validation' // generic, kept for backwards compat
  | 'validation-script' // build/test script crashed independently of npm install
  | 'validation-conflicts' // npm install logged structured peer/version conflicts post-success
  | 'policy'; // .dep-up-surgeon.policy.{yaml,json} refused every candidate version

interface AttemptResult {
  ok: boolean;
  kind?: FailureKind;
  message?: string;
  /** Stop trying further fallback versions (e.g. ESM vs CommonJS for all newer releases). */
  abortFallbacks?: boolean;
  installOutput?: string;
  classified?: ClassifiedConflict[];
  /** Validator command/exit/last-lines, when this attempt invoked the validator. */
  validation?: ValidationDiagnostic;
  /** Install command/exit/last-lines for the install that triggered (or preceded) this result. */
  install?: InstallDiagnostic;
}

/**
 * When a later step fails, surface that earlier successful bumps were kept and a hint for
 * peer-rollback (install exited 0) so the user can --force to keep proposed ranges.
 */
function appendInstallFailureContext(report: FinalReport, result: AttemptResult): string {
  const hadPriorSuccess = report.upgraded.some((u) => u.success && !u.skipped);
  const keepHint = hadPriorSuccess
    ? 'Upgrades that completed earlier in this run are still in package.json; this step was reverted.'
    : '';
  const forceHint =
    result.kind === 'peer' && result.install?.ok === true
      ? 'Re-run with --force to keep the new version ranges despite peer warnings (the package manager still exited 0).'
      : '';
  return [result.message, keepHint, forceHint]
    .filter((s) => s && s.trim() !== '')
    .join(' ');
}

function toValidationDiagnostic(v: ValidationResult): ValidationDiagnostic {
  return {
    command: v.command,
    exitCode: v.exitCode,
    lastLines: v.output,
    source: v.source,
  };
}

function toInstallDiagnostic(install: InstallResult): InstallDiagnostic {
  return {
    command: install.command,
    exitCode: install.exitCode,
    lastLines: tailLines(install.output),
    ok: install.ok,
  };
}

function indentBlock(text: string, prefix = '    '): string {
  return text
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join('\n');
}

function isWorkspaceInternal(name: string, opts: UpgradeEngineOptions): boolean {
  if (opts.includeWorkspaceDeps) {
    return false;
  }
  return opts.projectInfo?.workspacePackageNames.has(name) ?? false;
}

/**
 * Build the `InstallOptions` for the current engine call. Returns `{ filter }` only when
 * `installMode === 'filtered'` AND a child target is being mutated (`installFilter` is set).
 * Root-target runs always do a full install regardless of mode.
 *
 * Also forwards the per-manager capability bit (`yarnSupportsFocus`) so `installCommand` can
 * pick `yarn workspaces focus <name>` over the classic full-install fallback when the project
 * is on yarn berry with `@yarnpkg/plugin-workspace-tools` available.
 */
function installFilterOptions(opts: UpgradeEngineOptions): InstallOptions {
  if (opts.installMode === 'filtered' && opts.installFilter) {
    return {
      filter: opts.installFilter,
      ...(opts.projectInfo?.yarnSupportsFocus
        ? { yarnSupportsFocus: true }
        : {}),
    };
  }
  return {};
}

/**
 * Run `fn` under the keyed install mutex if one was provided. At concurrency 1 the
 * orchestrator omits the lock entirely → we run inline with zero overhead.
 *
 * The lock key is the **install directory**: `opts.installCwd ?? opts.cwd`. Two calls with
 * the same key serialize (they'd race on the same lockfile / `node_modules`); calls with
 * different keys run concurrently. For a shared-lockfile monorepo every target passes the
 * same `installCwd = rootCwd`, so this collapses back to strict serialization. For an
 * isolated-lockfile monorepo each target passes its own workspace directory as `installCwd`,
 * so installs parallelize automatically.
 */
async function withInstallLock<T>(
  opts: UpgradeEngineOptions,
  fn: () => Promise<T>,
): Promise<T> {
  if (opts.installLock) {
    const key = opts.installCwd ?? opts.cwd;
    return opts.installLock.runExclusive(key, fn);
  }
  return fn();
}

/**
 * Fire `onUpgradeApplied` if the orchestrator wired one up, swallowing every error so a buggy
 * (or unauthorized) git commit can never roll back an upgrade that was already validated.
 */
async function fireUpgradeApplied(
  opts: UpgradeEngineOptions,
  records: UpgradeRecord[],
  targetCwd: string,
  groupId: string | undefined,
): Promise<void> {
  if (!opts.onUpgradeApplied || records.length === 0) {
    return;
  }
  // Run the hook UNDER the install lock too: it inspects + commits the lockfile, which is
  // the same shared resource the install just touched. Without the lock, a concurrent target
  // could start its own install while we're still git-add'ing the previous target's commit.
  await withInstallLock(opts, async () => {
    try {
      await opts.onUpgradeApplied!({
        records,
        targetCwd,
        installCwd: opts.installCwd ?? targetCwd,
        manager: (opts.projectInfo?.manager ?? 'npm') as PackageManager,
        workspace: opts.targetLabel,
        groupId,
      });
    } catch (e) {
      if (!opts.jsonOutput) {
        const msg = e instanceof Error ? e.message : String(e);
        log.warn(`onUpgradeApplied hook threw: ${msg}`);
      }
    }
  });
}

function tagWorkspaceLabels(report: FinalReport, label: string): void {
  for (const row of report.upgraded) {
    if (!row.workspace) {
      row.workspace = label;
    }
  }
  for (const row of report.failed) {
    if (!row.workspace) {
      row.workspace = label;
    }
  }
}

/**
 * Run the validator against the *unchanged* tree. If it already exits non-zero, every per-group
 * rollback during the run will look identical and waste minutes. Surfacing this up-front turns a
 * silent failure mode into an explicit, actionable error.
 */
export interface PreflightCheckResult {
  ok: boolean;
  skipped: boolean;
  command: string;
  exitCode?: number;
  source?: ValidationResult['source'];
  lastLines?: string;
}

export async function preflightValidate(
  cwd: string,
  pkgJson: PackageJson,
  validate: ValidationOptions | undefined,
): Promise<PreflightCheckResult> {
  const v = await validateProject(cwd, pkgJson, validate ?? {});
  return {
    ok: v.ok,
    skipped: Boolean(v.skipped),
    command: v.command,
    exitCode: v.exitCode,
    source: v.source,
    lastLines: v.output,
  };
}

/**
 * Try upgrading one dependency to an exact `targetVersion`, install, validate, optionally rollback.
 */
async function attemptSingleUpgrade(
  cwd: string,
  scanned: ScannedPackage,
  targetVersion: string,
  opts: UpgradeEngineOptions,
): Promise<AttemptResult> {
  // Whole attempt is the critical section: every transition (mutate → install → maybe
  // rollback → validate → maybe rollback) reads/writes the same lockfile + node_modules,
  // so we acquire the lock once and release on completion. Cheap (no contention) at
  // concurrency 1 — `withInstallLock` no-ops without a lock.
  return withInstallLock(opts, () => attemptSingleUpgradeUnlocked(cwd, scanned, targetVersion, opts));
}

async function attemptSingleUpgradeUnlocked(
  cwd: string,
  scanned: ScannedPackage,
  targetVersion: string,
  opts: UpgradeEngineOptions,
): Promise<AttemptResult> {
  const { force, jsonOutput } = opts;
  const manager = (opts.projectInfo?.manager ?? 'npm') as InstallManager;
  const installCwd = opts.installCwd ?? cwd;
  const installOpts = installFilterOptions(opts);
  const previousRange = scanned.currentRange;
  const install$ = opts.installer ?? runInstall;

  // Progress spinner: surfaces which phase is running (install → validate → optional
  // rollback) and how long it's been going. Silenced in JSON mode so machine output stays
  // clean; auto-degrades to plain phase lines in non-TTY environments (CI logs).
  const spinner: Spinner | undefined = jsonOutput
    ? undefined
    : createSpinner(`Installing ${scanned.name}@${targetVersion} with ${manager}...`);

  let pkg = await readPackageJson(cwd);
  pkg = setRange(pkg, scanned.section, scanned.name, targetVersion);
  await writePackageJson(cwd, pkg);

  const install = await install$(installCwd, manager, installOpts);
  const installDiag = toInstallDiagnostic(install);
  const classified = classifyInstallOutput(install.output, opts);
  const peerHit = shouldRollbackAfterSuccessfulInstall(classified, force);

  if (!install.ok) {
    const esm = detectEsmCommonJsBlockage(install.output);
    // Promote ERESOLVE-style failures to `kind: 'peer'` so the resolver (ad-hoc for singles,
    // intersection for batches) gets a chance. npm 10 exits non-zero on ERESOLVE — without
    // this promotion the result was classified as a generic install failure and the resolver
    // was never invoked, even though the classified output already proves it's a peer problem.
    // ESM/CommonJS mismatches are deliberately NOT promoted — the resolver can't pick an
    // older version of Node.js for you.
    const peerLike = !esm && classifiedHasPeerLikeFailure(classified);
    spinner?.update(
      `Rolling back ${scanned.name}: install failed (exit ${install.exitCode ?? '?'})...`,
    );
    await writeDepRange(cwd, scanned.section, scanned.name, previousRange);
    await install$(installCwd, manager, installOpts);
    spinner?.stop();
    return {
      ok: false,
      kind: peerLike ? 'peer' : 'install',
      message: esm
        ? `${install.command} failed (exit ${install.exitCode}): ESM/CommonJS mismatch (e.g. ERR_REQUIRE_ESM). Newer releases may be ESM-only while this project is CommonJS — pin the package, migrate to ESM, or ignore it.`
        : peerLike
          ? `${install.command} failed (exit ${install.exitCode}): peer dependency conflict — the resolver will try to find a compatible tuple`
          : `${install.command} failed (exit ${install.exitCode})`,
      abortFallbacks: esm,
      installOutput: install.output,
      classified,
      install: installDiag,
    };
  }

  if (peerHit && !force) {
    spinner?.update(`Rolling back ${scanned.name}: peer conflict reported by ${manager}...`);
    await writeDepRange(cwd, scanned.section, scanned.name, previousRange);
    await install$(installCwd, manager, installOpts);
    spinner?.stop();
    return {
      ok: false,
      kind: 'peer',
      message: `${manager === 'npm' ? 'npm' : manager} reported peer dependency issues (see install output). Suggestion: keep this package unchanged or resolve peers manually.`,
      installOutput: install.output,
      classified,
      install: installDiag,
    };
  }

  // Validator runs against the install root (where the actual node_modules live), but it reads
  // its `scripts` from the **install root's** package.json, not the per-child one — workspaces
  // typically declare test/build scripts at the root anyway.
  spinner?.update(`Validating ${scanned.name}@${targetVersion}: resolving validator...`);
  const validatorPkg = await readPackageJson(installCwd);
  const validation = await validateProject(installCwd, validatorPkg, {
    ...(opts.validate ?? {}),
    manager,
    onResolved: ({ command }) => {
      spinner?.update(`Validating ${scanned.name}@${targetVersion}: \`${command}\`...`);
    },
  });
  const diag = validation.skipped ? undefined : toValidationDiagnostic(validation);
  if (!validation.ok && !force) {
    spinner?.update(
      `Rolling back ${scanned.name}: \`${validation.command}\` failed (exit ${validation.exitCode ?? '?'})...`,
    );
    await writeDepRange(cwd, scanned.section, scanned.name, previousRange);
    await install$(installCwd, manager, installOpts);
    spinner?.stop();
    return {
      ok: false,
      kind: 'validation-script',
      message: `${validation.command} failed (exit ${validation.exitCode ?? '?'})`,
      validation: diag,
      install: installDiag,
    };
  }

  if (!validation.ok && force) {
    spinner?.stop();
    return {
      ok: true,
      message: `Kept upgrade despite ${validation.command} failure (--force)`,
      validation: diag,
      install: installDiag,
    };
  }

  spinner?.stop();
  return { ok: true, validation: diag, install: installDiag };
}

type Bump = {
  scanned: ScannedPackage;
  targetVersion: string;
  /**
   * Set only when the peer-range intersection resolver replaced `targetVersion` with a
   * compatible one. Preserved through a successful retry so the emitted `UpgradeRecord`
   * can attach a `resolvedPeer` audit trail.
   */
  resolvedFrom?: string;
  /** Human-readable reason string from `describeResolution` (shared across the whole tuple). */
  resolvedReason?: string;
  /** How many candidate tuples the resolver explored. */
  resolvedTuplesExplored?: number;
};

/**
 * Bump several dependencies in one `package.json` write, then one install + validate.
 * Rolls back **all** listed bumps on failure.
 */
async function attemptBatchUpgrade(
  cwd: string,
  bumps: Bump[],
  opts: UpgradeEngineOptions,
): Promise<AttemptResult> {
  return withInstallLock(opts, () => attemptBatchUpgradeUnlocked(cwd, bumps, opts));
}

async function attemptBatchUpgradeUnlocked(
  cwd: string,
  bumps: Bump[],
  opts: UpgradeEngineOptions,
): Promise<AttemptResult> {
  const { force, jsonOutput } = opts;
  const manager = (opts.projectInfo?.manager ?? 'npm') as InstallManager;
  const installCwd = opts.installCwd ?? cwd;
  const installOpts = installFilterOptions(opts);
  const install$ = opts.installer ?? runInstall;
  if (bumps.length === 0) {
    return { ok: true };
  }

  const previous = new Map<string, { section: DepSection; range: string }>();
  for (const { scanned } of bumps) {
    previous.set(scanned.name, { section: scanned.section, range: scanned.currentRange });
  }

  // Compact batch label — first three packages, then "…+N more" if the group is larger. Avoids
  // blowing up the spinner line on big linked groups (e.g. 20-package Nx bundles).
  const batchLabel = (() => {
    const names = bumps.map((b) => `${b.scanned.name}@${b.targetVersion}`);
    if (names.length <= 3) return names.join(', ');
    return `${names.slice(0, 3).join(', ')} …+${names.length - 3} more`;
  })();
  const spinner: Spinner | undefined = jsonOutput
    ? undefined
    : createSpinner(`Installing batch (${bumps.length} pkgs) with ${manager}: ${batchLabel}...`);

  let pkg = await readPackageJson(cwd);
  for (const { scanned, targetVersion } of bumps) {
    pkg = setRange(pkg, scanned.section, scanned.name, targetVersion);
  }
  await writePackageJson(cwd, pkg);

  const install = await install$(installCwd, manager, installOpts);
  const installDiag = toInstallDiagnostic(install);
  const classified = classifyInstallOutput(install.output, opts);
  const peerHit = shouldRollbackAfterSuccessfulInstall(classified, force);

  const rollbackAll = async (): Promise<void> => {
    for (const { scanned } of bumps) {
      const snap = previous.get(scanned.name);
      if (!snap) {
        continue;
      }
      await writeDepRange(cwd, snap.section, scanned.name, snap.range);
    }
    await install$(installCwd, manager, installOpts);
  };

  if (!install.ok) {
    const esm = detectEsmCommonJsBlockage(install.output);
    // Same ERESOLVE → `kind: 'peer'` promotion as the single-upgrade path. Critical for
    // linked-group bumps because npm 10 `ERESOLVE` is the *normal* failure mode for multi-
    // package Angular / Nx / Nuxt bumps where one member's peer range lags a release behind
    // its siblings — the intersection resolver was designed for exactly that case but only
    // fires on `kind: 'peer'`.
    const peerLike = !esm && classifiedHasPeerLikeFailure(classified);
    spinner?.update(
      `Rolling back batch: install failed (exit ${install.exitCode ?? '?'})...`,
    );
    await rollbackAll();
    spinner?.stop();
    return {
      ok: false,
      kind: peerLike ? 'peer' : 'install',
      message: esm
        ? `${install.command} failed (exit ${install.exitCode}): ESM/CommonJS mismatch (e.g. ERR_REQUIRE_ESM). Newer releases may be ESM-only while this project is CommonJS — pin the package, migrate to ESM, or ignore it.`
        : peerLike
          ? `${install.command} failed (exit ${install.exitCode}): peer dependency conflict — the resolver will try to find a compatible tuple`
          : `${install.command} failed (exit ${install.exitCode})`,
      abortFallbacks: esm,
      installOutput: install.output,
      classified,
      install: installDiag,
    };
  }

  if (peerHit && !force) {
    spinner?.update(`Rolling back batch: peer conflict reported by ${manager}...`);
    await rollbackAll();
    spinner?.stop();
    return {
      ok: false,
      kind: 'peer',
      message: `${manager === 'npm' ? 'npm' : manager} reported peer dependency issues (see install output). Suggestion: keep this package unchanged or resolve peers manually.`,
      installOutput: install.output,
      classified,
      install: installDiag,
    };
  }

  spinner?.update(`Validating batch (${bumps.length} pkgs): resolving validator...`);
  const validatorPkg = await readPackageJson(installCwd);
  const validation = await validateProject(installCwd, validatorPkg, {
    ...(opts.validate ?? {}),
    manager,
    onResolved: ({ command }) => {
      spinner?.update(`Validating batch (${bumps.length} pkgs): \`${command}\`...`);
    },
  });
  const diag = validation.skipped ? undefined : toValidationDiagnostic(validation);
  if (!validation.ok && !force) {
    spinner?.update(
      `Rolling back batch: \`${validation.command}\` failed (exit ${validation.exitCode ?? '?'})...`,
    );
    await rollbackAll();
    spinner?.stop();
    return {
      ok: false,
      kind: 'validation-script',
      message: `${validation.command} failed (exit ${validation.exitCode ?? '?'})`,
      validation: diag,
      install: installDiag,
    };
  }

  if (!validation.ok && force) {
    spinner?.stop();
    return {
      ok: true,
      message: `Kept upgrade despite ${validation.command} failure (--force)`,
      validation: diag,
      install: installDiag,
    };
  }

  spinner?.stop();
  return { ok: true, validation: diag, install: installDiag };
}

/**
 * Try `@latest` first, then (optional) walk down semver "release lines"
 * (highest patch per major.minor) until one install+validation succeeds.
 */
async function upgradeWithReleaseLineFallbacks(
  cwd: string,
  scanned: ScannedPackage,
  currentSemver: string,
  registryLatest: string,
  opts: UpgradeEngineOptions,
): Promise<{
  result: AttemptResult;
  chosenVersion: string | null;
  usedFallback: boolean;
  /** Last concrete version we attempted (for reporting failed upgrades) */
  lastAttemptedVersion: string;
}> {
  const { fallbackStrategy, jsonOutput } = opts;

  let candidates: string[] = [registryLatest];
  if (fallbackStrategy === 'major-lines' || fallbackStrategy === 'minor-lines') {
    try {
      const all = await fetchAllPublishedVersions(scanned.name, opts.registryCache);
      const mode = fallbackStrategy === 'major-lines' ? 'major' : 'minor';
      candidates = buildLineFallbackOrder(currentSemver, registryLatest, all, mode);
    } catch {
      candidates = [registryLatest];
    }
  }

  // Apply policy before the fallback walker so we never install a version the user
  // explicitly blocked. Keeping the candidates in their original order preserves the
  // "try latest first, then walk down" behavior the user expects; we just drop entries.
  if (opts.policy) {
    const { evaluatePolicy } = await import('../config/policy.js');
    const decision = evaluatePolicy(opts.policy, scanned.name);
    if (decision.frozen) {
      if (!jsonOutput) {
        log.dim(`policy: ${scanned.name} is frozen — skipping`);
      }
      return {
        result: { ok: false, kind: 'policy', message: decision.reason ?? 'frozen by policy' },
        chosenVersion: null,
        usedFallback: false,
        lastAttemptedVersion: registryLatest,
      };
    }
    const beforeCount = candidates.length;
    candidates = candidates.filter((v) => {
      if (!semver.valid(v)) return true; // defensive: keep dist-tag or whatever
      if (decision.maxRange && !semver.satisfies(v, decision.maxRange)) return false;
      if (decision.blockedMajorUntil) {
        const currentClean = semver.coerce(currentSemver)?.version;
        if (currentClean && semver.major(v) > semver.major(currentClean)) return false;
      }
      return true;
    });
    if (candidates.length === 0) {
      if (!jsonOutput) {
        log.warn(
          `policy: no candidate versions remain for ${scanned.name} after applying ${decision.reason ?? 'rules'}`,
        );
      }
      return {
        result: {
          ok: false,
          kind: 'policy',
          message: `policy filtered out all ${beforeCount} candidate version(s): ${decision.reason ?? 'see .dep-up-surgeon.policy'}`,
        },
        chosenVersion: null,
        usedFallback: false,
        lastAttemptedVersion: registryLatest,
      };
    }
  }

  if (candidates.length === 0) {
    return {
      result: { ok: false, kind: 'install', message: 'no suitable version candidates' },
      chosenVersion: null,
      usedFallback: false,
      lastAttemptedVersion: registryLatest,
    };
  }

  let last: AttemptResult = { ok: false, kind: 'install', message: 'not attempted' };
  let lastAttemptedVersion = candidates[0]!;
  for (let i = 0; i < candidates.length; i++) {
    const target = candidates[i]!;
    lastAttemptedVersion = target;
    if (
      i > 0 &&
      !jsonOutput &&
      (fallbackStrategy === 'major-lines' || fallbackStrategy === 'minor-lines') &&
      candidates.length > 1
    ) {
      log.warn(
        `Trying older release line: ${scanned.name}@${target} (after ${candidates[i - 1]} failed)`,
      );
    }

    last = await attemptSingleUpgrade(cwd, scanned, target, opts);
    if (last.ok) {
      const usedFallback = target !== registryLatest;
      return { result: last, chosenVersion: target, usedFallback, lastAttemptedVersion: target };
    }
    if (last.abortFallbacks) {
      if (!jsonOutput) {
        log.warn(
          'Stopping further fallback attempts for this package (structural failure — likely same for other versions).',
        );
      }
      break;
    }
  }

  return {
    result: last,
    chosenVersion: null,
    usedFallback: false,
    lastAttemptedVersion,
  };
}

/**
 * Retry a single-package upgrade as a small ad-hoc batch. The batch includes the primary
 * (at whatever version the resolver picked) plus each blocker the resolver wants moved.
 * Blocker sections are discovered from the current `package.json` so we write to the same
 * section they already live in. On failure we roll back every edit — same contract as the
 * linked-group retry.
 *
 * Shape of the returned tuple matches `upgradeWithReleaseLineFallbacks` so the caller can
 * do an in-place reassignment (`{ result, chosenVersion, usedFallback, lastAttemptedVersion }`).
 */
async function retryWithAdHocBumps(
  cwd: string,
  primary: ScannedPackage,
  adHoc: {
    bumps: Array<{ name: string; from: string; to: string; isPrimary: boolean }>;
    reason: string;
  },
  opts: UpgradeEngineOptions,
): Promise<{
  result: AttemptResult;
  chosenVersion: string | null;
  usedFallback: boolean;
  lastAttemptedVersion: string;
}> {
  const pkg = await readPackageJson(cwd);
  // Translate ad-hoc bumps → the engine's `Bump[]` shape. The primary already has a
  // `ScannedPackage`; for each blocker we synthesize a minimal one (section + range are
  // all the batch upgrader needs).
  const bumps: Bump[] = [];
  const primaryBump = adHoc.bumps.find((b) => b.isPrimary);
  if (primaryBump) {
    bumps.push({ scanned: primary, targetVersion: primaryBump.to });
  }
  for (const b of adHoc.bumps) {
    if (b.isPrimary) continue;
    const section = findSectionFor(pkg, b.name);
    if (!section) continue; // shouldn't happen — ad-hoc only picks direct deps
    const scanned: ScannedPackage = {
      name: b.name,
      section,
      currentRange: b.from,
    };
    bumps.push({ scanned, targetVersion: b.to, resolvedFrom: b.from, resolvedReason: adHoc.reason });
  }
  // If we couldn't resolve any section (pathological), bail with the primary alone — that
  // collapses to the original single-install behavior.
  const primaryTarget = primaryBump?.to ?? primary.currentRange;
  if (bumps.length === 0) {
    const fallback: AttemptResult = {
      ok: false,
      kind: 'peer',
      message: 'ad-hoc resolver produced no actionable bumps',
    };
    return {
      result: fallback,
      chosenVersion: null,
      usedFallback: false,
      lastAttemptedVersion: primaryTarget,
    };
  }

  const result = await attemptBatchUpgrade(cwd, bumps, opts);
  return {
    result,
    chosenVersion: result.ok ? primaryTarget : null,
    usedFallback: false,
    lastAttemptedVersion: primaryTarget,
  };
}

/** First dep section that mentions `name`, or `undefined`. */
function findSectionFor(pkg: PackageJson, name: string): DepSection | undefined {
  const sections: DepSection[] = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  for (const section of sections) {
    const block = pkg[section];
    if (block && typeof block[name] === 'string') return section;
  }
  return undefined;
}

async function promptAfterFailure(
  pkgName: string,
  interactive: boolean,
): Promise<'continue' | 'pin' | 'retry'> {
  if (!interactive) {
    return 'continue';
  }
  const res = await prompts({
    type: 'select',
    name: 'action',
    message: `Upgrade failed for "${pkgName}". What next?`,
    choices: [
      { title: 'Continue with other packages', value: 'continue' },
      { title: 'Pin (skip) this package for this run', value: 'pin' },
      { title: 'Retry this upgrade once', value: 'retry' },
    ],
    initial: 0,
  });
  if (!res || typeof res.action !== 'string') {
    return 'continue';
  }
  return res.action as 'continue' | 'pin' | 'retry';
}

function failureReason(kind: FailureKind): FailureReason {
  switch (kind) {
    case 'peer':
      return 'peer';
    case 'validation':
      return 'validation';
    case 'validation-script':
      return 'validation-script';
    case 'validation-conflicts':
      return 'validation-conflicts';
    case 'policy':
      return 'policy';
    default:
      return 'install';
  }
}

/**
 * One dependency: resolve latest, optional release-line fallbacks, report.
 */
async function runSinglePackageUpgrade(
  cwd: string,
  scanned: ScannedPackage,
  opts: UpgradeEngineOptions,
  report: FinalReport,
  ignore: Set<string>,
): Promise<void> {
  const { dryRun, interactive, jsonOutput } = opts;

  if (isWorkspaceInternal(scanned.name, opts)) {
    addUpgrade(report, {
      name: scanned.name,
      success: true,
      skipped: true,
      reason: 'skipped',
      detail: 'workspace-internal dep (resolved from local workspace package)',
    });
    if (!jsonOutput) {
      log.dim(`Skipped ${scanned.name} (workspace-internal dep)`);
    }
    return;
  }

  if (!isRegistryRange(scanned.currentRange)) {
    addUpgrade(report, {
      name: scanned.name,
      success: true,
      skipped: true,
      reason: 'skipped',
      detail: 'non-registry or non-semver range (workspace/link/git)',
    });
    if (!jsonOutput) {
      log.dim(`Skipped ${scanned.name} (non-registry range)`);
    }
    return;
  }

  let latest: string;
  try {
    latest = await fetchLatestVersion(scanned.name, opts.registryCache);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    addFailure(report, {
      name: scanned.name,
      reason: 'install',
      previousVersion: scanned.currentRange,
      message: `Could not fetch latest from registry: ${msg}`,
    });
    if (!jsonOutput) {
      log.error(`Could not resolve latest for ${scanned.name}: ${msg}`);
    }
    return;
  }

  const cur = semver.coerce(scanned.currentRange);
  if (!cur) {
    addUpgrade(report, {
      name: scanned.name,
      success: true,
      skipped: true,
      reason: 'skipped',
      detail: 'could not parse current version',
    });
    return;
  }

  if (semver.eq(cur.version, latest)) {
    addUpgrade(report, {
      name: scanned.name,
      success: true,
      skipped: true,
      from: cur.version,
      to: latest,
      reason: 'skipped',
      detail: 'already latest',
    });
    if (!jsonOutput) {
      log.dim(`${scanned.name} already at latest (${latest})`);
    }
    return;
  }

  if (dryRun) {
    addUpgrade(report, {
      name: scanned.name,
      success: true,
      skipped: true,
      from: cur.version,
      to: latest,
      reason: 'skipped',
      detail: 'dry-run',
    });
    if (!jsonOutput) {
      log.info(`[dry-run] ${scanned.name}: ${cur.version} → ${latest}`);
    }
    return;
  }

  if (!jsonOutput) {
    const fb =
      opts.fallbackStrategy === 'major-lines' || opts.fallbackStrategy === 'minor-lines'
        ? ' (may try older release lines if latest fails)'
        : '';
    log.info(`Upgrading ${scanned.name}: ${cur.version} → latest ${latest}${fb} …`);
  }

  let {
    result,
    chosenVersion,
    usedFallback,
    lastAttemptedVersion,
  } = await upgradeWithReleaseLineFallbacks(cwd, scanned, cur.version, latest, opts);

  // Ad-hoc peer-range resolver for **non-linked** single-package bumps. The resolver in
  // `peerResolver.ts` traditionally only fires for linked groups — a single bump that
  // failed with a peer conflict was rolled back unconditionally. We now try the same
  // intersection logic on a synthesized ad-hoc group (primary + direct-dep blockers from
  // the parsed conflict output). Guarded by:
  //   - `--no-resolve-peers`: user opted out.
  //   - `--force`: user already said "barrel through", no point asking the resolver.
  //   - Result kind !== 'peer': only peer conflicts are in-scope for this resolver.
  // Success path writes the resolved bumps as a small batch + runs one more install.
  let adHocResolved:
    | { bumps: Array<{ name: string; from: string; to: string; isPrimary: boolean }>; reason: string; tuplesExplored: number; method: ResolvedTuple['method'] }
    | undefined;
  if (!result.ok && result.kind === 'peer' && opts.resolvePeers !== false && !opts.force) {
    const classified = result.classified ?? classifyInstallOutput(result.installOutput, opts);
    if (classified.length > 0) {
      try {
        const pkg = await readPackageJson(cwd);
        const adHoc = await tryResolveAdHocPeerConflict({
          primary: scanned,
          primaryTarget: lastAttemptedVersion,
          classified,
          pkg,
          ...(opts.registryCache ? { registryCache: opts.registryCache } : {}),
        });
        if (adHoc) {
          adHocResolved = adHoc;
          if (!jsonOutput) {
            const label = adHoc.bumps
              .map((b) => `${b.name}@${b.to}${b.isPrimary ? '' : ' (blocker)'}`)
              .join(', ');
            log.info(
              `Ad-hoc peer-range resolver found a compatible tuple for ${scanned.name}; retrying with ${label}`,
            );
          }
          const retry = await retryWithAdHocBumps(cwd, scanned, adHoc, opts);
          result = retry.result;
          chosenVersion = retry.chosenVersion;
          usedFallback = retry.usedFallback;
          lastAttemptedVersion = retry.lastAttemptedVersion;
        } else if (!jsonOutput) {
          log.dim(`Ad-hoc peer-range resolver could not find a compatible tuple for ${scanned.name}`);
        }
      } catch (e) {
        // The ad-hoc resolver is a best-effort shortcut — any unexpected failure (registry
        // down, malformed packument, filesystem hiccup) falls back to the existing "mark
        // failed" path. We swallow-and-log rather than propagate so one flaky package can't
        // take out the whole run.
        if (!jsonOutput) {
          const msg = e instanceof Error ? e.message : String(e);
          log.dim(`Ad-hoc peer-range resolver skipped for ${scanned.name}: ${msg}`);
        }
      }
    }
  }

  if (!result.ok && interactive) {
    const action = await promptAfterFailure(scanned.name, true);
    if (action === 'pin') {
      ignore.add(scanned.name);
      try {
        await appendIgnoreToRc(cwd, scanned.name);
      } catch {
        /* ignore rc write errors */
      }
      if (!jsonOutput) {
        log.warn(`Pinned ${scanned.name} (added to .dep-up-surgeonrc ignore list)`);
      }
    } else if (action === 'retry') {
      if (!jsonOutput) {
        log.warn(`Retrying ${scanned.name} …`);
      }
      ({
        result,
        chosenVersion,
        usedFallback,
        lastAttemptedVersion,
      } = await upgradeWithReleaseLineFallbacks(cwd, scanned, cur.version, latest, opts));
    }
  }

  if (result.ok) {
    const to = chosenVersion ?? latest;
    const row: UpgradeRecord = {
      name: scanned.name,
      success: true,
      from: cur.version,
      to,
      requestedLatest: latest,
      usedFallback,
    };
    if (result.message?.includes('--force')) {
      row.forced = true;
      row.detail = result.message;
    } else if (usedFallback) {
      row.detail = `latest (${latest}) failed; kept highest working in older release lines`;
    }
    // Ad-hoc peer-range resolver succeeded — attach the audit trail and emit companion
    // rows for each blocker that moved. The primary row carries `resolvedPeer` so the
    // summary/JSON know this upgrade rode the ad-hoc path; blocker rows are tagged with
    // the same reason but keyed by `resolvedPeerBlocker` semantics (success + detail).
    if (adHocResolved) {
      const primaryBump = adHocResolved.bumps.find((b) => b.isPrimary);
      if (primaryBump) {
        row.to = primaryBump.to;
        if (primaryBump.to !== latest) {
          row.resolvedPeer = {
            originalTarget: latest,
            reason: adHocResolved.reason,
            tuplesExplored: adHocResolved.tuplesExplored,
          };
        }
        row.detail = `ad-hoc peer-range intersection [${adHocResolved.method}] — primary ${scanned.name}: ${latest} → ${primaryBump.to}`;
      }
      for (const b of adHocResolved.bumps) {
        if (b.isPrimary) continue;
        addUpgrade(report, {
          name: b.name,
          success: true,
          from: b.from,
          to: b.to,
          detail: `ad-hoc peer-range blocker for ${scanned.name}: ${b.from} → ${b.to}`,
          resolvedPeer: {
            originalTarget: b.from,
            reason: adHocResolved.reason,
            tuplesExplored: adHocResolved.tuplesExplored,
          },
        });
      }
    }
    addUpgrade(report, row);
    if (!jsonOutput) {
      if (usedFallback) {
        log.success(
          `upgraded: ${scanned.name} → ${to} (latest ${latest} failed; fallback succeeded)`,
        );
      } else {
        log.success(`upgraded: ${scanned.name} → ${to}`);
      }
    }
    await fireUpgradeApplied(opts, [row], cwd, undefined);
  } else {
    const kind = result.kind ?? 'install';
    // Policy refusal is a deliberate choice, not a failure — record it as a skip so retry-failed
    // doesn't loop and so summary tables show it under "ignored" instead of "failed".
    if (kind === 'policy') {
      addUpgrade(report, {
        name: scanned.name,
        success: true,
        skipped: true,
        from: cur.version,
        reason: 'policy',
        detail: result.message,
      });
      if (!jsonOutput) {
        log.dim(`policy-skipped: ${scanned.name} — ${result.message ?? 'refused by policy'}`);
      }
      return;
    }
    const classified = result.classified ?? classifyInstallOutput(result.installOutput, opts);
    pushParsedConflicts(report, classified);
    const fullFailureMessage = appendInstallFailureContext(report, result);
    addFailure(report, {
      name: scanned.name,
      reason: failureReason(kind),
      previousVersion: scanned.currentRange,
      attemptedVersion: lastAttemptedVersion,
      message: fullFailureMessage,
      conflicts: toConflicts(classified),
      validation: result.validation,
      install: result.install,
    });
    if (!jsonOutput) {
      if (kind === 'peer') {
        log.peer(`${scanned.name} — ${fullFailureMessage || 'peer conflict'}`);
        if (result.install?.lastLines) {
          log.dim(indentBlock(result.install.lastLines, '    '));
        }
      } else if (kind === 'validation-script') {
        log.error(
          `skipped: ${scanned.name} — validator (${result.validation?.command ?? 'unknown'}) failed; this is not a dependency conflict`,
        );
        if (result.validation?.lastLines) {
          log.dim(indentBlock(result.validation.lastLines, '    '));
        }
      } else {
        log.error(`skipped: ${scanned.name} (${result.message ?? kind})`);
        if (result.install?.lastLines) {
          log.dim(indentBlock(result.install.lastLines, '    '));
        }
      }
    }
  }
}

/**
 * Build a map of "what version range is this external (non-linked) dependency currently pinned
 * to in the workspace package.json" — used as input to the peer resolver so it can check whether
 * a candidate's peer on an OUT-OF-GROUP package (e.g. `next`, `typescript`) would break.
 *
 * We read from the SAME `package.json` the engine is about to mutate; whatever's pinned there
 * is the closest thing we have to ground truth without running `npm ls`. `peerDependencies`
 * and `optionalDependencies` are included because they can still ship an installed version.
 */
async function collectExternalInstalledRanges(
  cwd: string,
  excludeNames: Set<string>,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let pkg: PackageJson;
  try {
    pkg = await readPackageJson(cwd);
  } catch {
    return out;
  }
  const sections: DepSection[] = [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ];
  for (const section of sections) {
    const block = pkg[section];
    if (!block) continue;
    for (const [name, range] of Object.entries(block)) {
      if (excludeNames.has(name)) continue;
      if (typeof range !== 'string') continue;
      if (!out.has(name)) out.set(name, range);
    }
  }
  return out;
}

/**
 * Try to find a peer-compatible version tuple for a linked batch that just failed with a
 * peer conflict. Returns `undefined` when:
 *   - The registry packument couldn't be fetched for any member (we'd be guessing).
 *   - Any member's candidate domain is empty after filtering.
 *   - The resolver explored its budget without finding a satisfiable tuple.
 *
 * Fetches + resolver calls are scoped to one batch — cheap (packuments are `RegistryCache`-
 * shared so subsequent groups / workspace members reuse them).
 */
async function tryResolvePeerIntersection(
  cwd: string,
  bumps: Bump[],
  opts: UpgradeEngineOptions,
): Promise<ResolvedTuple | undefined> {
  if (bumps.length < 2) return undefined;
  const inputs: ResolverInput[] = bumps.map((b) => ({
    name: b.scanned.name,
    currentRange: b.scanned.currentRange,
    requestedTarget: b.targetVersion,
  }));

  const domains: CandidateDomain[] = [];
  for (const inp of inputs) {
    const peerMap = await fetchVersionPeers(inp.name, opts.registryCache);
    if (peerMap.size === 0) return undefined;
    const domain = buildDomain(inp, peerMap);
    if (domain.versions.length === 0) return undefined;
    domains.push(domain);
  }

  const memberNames = new Set(inputs.map((i) => i.name));
  const externalInstalled = await collectExternalInstalledRanges(cwd, memberNames);
  const requested = new Map(inputs.map((i) => [i.name, i.requestedTarget]));

  return resolvePeerRanges(domains, requested, { externalInstalled });
}

/**
 * Linked group: bump all to registry `@latest` in one shot (no per-package fallback ladder).
 * TODO: peer-graph / `expo install`-style alignment for Expo SDK
 */
async function runLinkedGroupUpgrade(
  cwd: string,
  group: LinkedGroup,
  members: ScannedPackage[],
  opts: UpgradeEngineOptions,
  report: FinalReport,
  ignore: Set<string>,
): Promise<void> {
  const { dryRun, interactive, jsonOutput } = opts;
  const gid = group.id;

  const bumps: Bump[] = [];
  const skippedNonRegistry: ScannedPackage[] = [];

  for (const scanned of members) {
    if (isWorkspaceInternal(scanned.name, opts)) {
      addUpgrade(report, {
        name: scanned.name,
        success: true,
        skipped: true,
        reason: 'skipped',
        detail: 'workspace-internal dep (resolved from local workspace package)',
        linkedGroupId: gid,
      });
      if (!jsonOutput) {
        log.dim(`Skipped ${scanned.name} in group [${gid}] (workspace-internal dep)`);
      }
      continue;
    }
    if (!isRegistryRange(scanned.currentRange)) {
      skippedNonRegistry.push(scanned);
      addUpgrade(report, {
        name: scanned.name,
        success: true,
        skipped: true,
        reason: 'skipped',
        detail: 'non-registry or non-semver range (workspace/link/git)',
        linkedGroupId: gid,
      });
      if (!jsonOutput) {
        log.dim(`Skipped ${scanned.name} in group [${gid}] (non-registry range)`);
      }
      continue;
    }

    let latest: string;
    try {
      latest = await fetchLatestVersion(scanned.name, opts.registryCache);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      addFailure(report, {
        name: scanned.name,
        reason: 'install',
        previousVersion: scanned.currentRange,
        message: `Could not fetch latest from registry: ${msg}`,
        linkedGroupId: gid,
      });
      if (!jsonOutput) {
        log.error(`Could not resolve latest for ${scanned.name}: ${msg}`);
      }
      continue;
    }

    const cur = semver.coerce(scanned.currentRange);
    if (!cur) {
      addUpgrade(report, {
        name: scanned.name,
        success: true,
        skipped: true,
        reason: 'skipped',
        detail: 'could not parse current version',
        linkedGroupId: gid,
      });
      continue;
    }

    if (semver.eq(cur.version, latest)) {
      addUpgrade(report, {
        name: scanned.name,
        success: true,
        skipped: true,
        from: cur.version,
        to: latest,
        reason: 'skipped',
        detail: 'already latest',
        linkedGroupId: gid,
      });
      if (!jsonOutput) {
        log.dim(`${scanned.name} already at latest (${latest})`);
      }
      continue;
    }

    bumps.push({ scanned, targetVersion: latest });
  }

  if (bumps.length === 0) {
    return;
  }

  if (dryRun) {
    for (const b of bumps) {
      const cur = semver.coerce(b.scanned.currentRange);
      addUpgrade(report, {
        name: b.scanned.name,
        success: true,
        skipped: true,
        from: cur?.version,
        to: b.targetVersion,
        reason: 'skipped',
        detail: 'dry-run (linked group)',
        linkedGroupId: gid,
      });
      if (!jsonOutput) {
        log.info(`[dry-run] [${gid}] ${b.scanned.name}: ${cur?.version ?? '?'} → ${b.targetVersion}`);
      }
    }
    return;
  }

  if (!jsonOutput) {
    log.info(
      `Linked group [${gid}]: ${bumps.map((b) => `${b.scanned.name} → ${b.targetVersion}`).join('; ')} …`,
    );
  }

  const maxAttempts = interactive ? 8 : 3;
  let result: AttemptResult = { ok: false, kind: 'install', message: 'not started' };
  let forceAttempt = opts.force;
  let attempt = 0;
  let peerResolverTried = false;

  while (attempt < maxAttempts) {
    attempt++;
    const batchOpts: UpgradeEngineOptions = { ...opts, force: forceAttempt };
    result = await attemptBatchUpgrade(cwd, bumps, batchOpts);
    if (result.ok) {
      break;
    }
    const classified = result.classified ?? classifyInstallOutput(result.installOutput, opts);

    // Peer-range intersection resolver — only on the first peer-kind failure for this batch.
    // We intentionally skip the resolver when `--force` is already active (user asked to barrel
    // through peer conflicts), when the user explicitly opted out with `--no-resolve-peers`,
    // or after we've already tried it once (avoid infinite retry loops).
    if (
      !peerResolverTried &&
      result.kind === 'peer' &&
      opts.resolvePeers !== false &&
      !forceAttempt
    ) {
      peerResolverTried = true;
      const resolved = await tryResolvePeerIntersection(cwd, bumps, opts);
      if (resolved) {
        let mutated = false;
        const reason = describeResolution(
          resolved,
          bumps.map((b) => ({
            name: b.scanned.name,
            currentRange: b.scanned.currentRange,
            requestedTarget: b.targetVersion,
          })),
        );
        for (const b of bumps) {
          const nextVer = resolved.versions.get(b.scanned.name);
          if (!nextVer) continue;
          if (nextVer !== b.targetVersion) {
            b.resolvedFrom = b.targetVersion;
            b.targetVersion = nextVer;
            mutated = true;
          }
          b.resolvedReason = reason;
          b.resolvedTuplesExplored = resolved.tuplesExplored;
        }
        if (mutated) {
          if (!jsonOutput) {
            log.info(
              `Peer-range resolver found a compatible tuple for [${gid}]; retrying with ` +
                bumps.map((b) => `${b.scanned.name}@${b.targetVersion}`).join(', '),
            );
          }
          continue;
        }
        // Resolver returned the SAME tuple we already tried — no point re-running. Clear the
        // reason breadcrumbs so success rows don't claim a resolver intervention that never
        // happened.
        for (const b of bumps) {
          b.resolvedReason = undefined;
          b.resolvedTuplesExplored = undefined;
        }
      } else if (!jsonOutput) {
        log.dim(`Peer-range resolver could not find a compatible tuple for [${gid}]`);
      }
    }

    if (!interactive) {
      break;
    }
    const choice = await promptGroupConflictChoice({
      groupId: gid,
      packageSummary: bumps.map((b) => b.scanned.name).join(', '),
      classified,
    });
    if (choice === 'retry' && attempt < maxAttempts) {
      if (!jsonOutput) {
        log.warn(`Retrying linked group [${gid}] (attempt ${attempt + 1}/${maxAttempts}) …`);
      }
      continue;
    }
    if (choice === 'force') {
      forceAttempt = true;
      continue;
    }
    if (choice === 'freeze_all') {
      for (const n of group.names) {
        ignore.add(n);
      }
      try {
        await appendIgnoreToRc(cwd, ...group.names);
      } catch {
        /* ignore */
      }
      if (!jsonOutput) {
        log.warn(`Pinned linked group [${gid}] (added to .dep-up-surgeonrc ignore list)`);
      }
      pushParsedConflicts(report, classified);
      return;
    }
    break;
  }

  if (!result.ok) {
    const classified = result.classified ?? classifyInstallOutput(result.installOutput, opts);
    pushParsedConflicts(report, classified);
  }

  if (result.ok) {
    const groupRows: UpgradeRecord[] = [];
    for (const b of bumps) {
      const cur = semver.coerce(b.scanned.currentRange);
      const row: UpgradeRecord = {
        name: b.scanned.name,
        success: true,
        from: cur?.version,
        to: b.targetVersion,
        // `requestedLatest` should still reflect what the user ASKED for (registry latest),
        // even when the peer resolver nudged us to a slightly older version. That way the
        // summary can render "requested 19.0.0, got 18.3.1 (peer-range intersection)".
        requestedLatest: b.resolvedFrom ?? b.targetVersion,
        linkedGroupId: gid,
      };
      if (b.resolvedFrom) {
        row.resolvedPeer = {
          originalTarget: b.resolvedFrom,
          reason: b.resolvedReason ?? 'peer-range intersection',
          tuplesExplored: b.resolvedTuplesExplored ?? 0,
        };
      }
      if (result.message?.includes('--force')) {
        row.forced = true;
        row.detail = result.message;
      } else if (b.resolvedFrom) {
        row.detail = `upgraded with linked group [${gid}] (peer-range intersection: ${b.resolvedFrom} → ${b.targetVersion})`;
      } else {
        row.detail = `upgraded with linked group [${gid}] (single install + validate)`;
      }
      addUpgrade(report, row);
      groupRows.push(row);
      if (!jsonOutput) {
        const suffix = b.resolvedFrom ? ` [peer-resolved from ${b.resolvedFrom}]` : '';
        log.success(`upgraded: ${b.scanned.name} → ${b.targetVersion} (group ${gid})${suffix}`);
      }
    }
    await fireUpgradeApplied(opts, groupRows, cwd, gid);
  } else {
    const kind = result.kind ?? 'install';
    const prev = bumps.map((b) => `${b.scanned.name}@${b.scanned.currentRange}`).join(', ');
    const att = bumps.map((b) => `${b.scanned.name}@${b.targetVersion}`).join(', ');
    const fullGroupFailureMessage = appendInstallFailureContext(report, result);
    addFailure(report, {
      name: `[group:${gid}]`,
      reason: failureReason(kind),
      previousVersion: prev,
      attemptedVersion: att,
      message: fullGroupFailureMessage,
      linkedGroupId: gid,
      conflicts: toConflicts(result.classified ?? classifyInstallOutput(result.installOutput, opts)),
      validation: result.validation,
      install: result.install,
    });
    if (!jsonOutput) {
      if (kind === 'peer') {
        log.peer(`group [${gid}] — ${fullGroupFailureMessage || 'peer conflict'}`);
        if (result.install?.lastLines) {
          log.dim(indentBlock(result.install.lastLines, '    '));
        }
      } else if (kind === 'validation-script') {
        log.error(
          `skipped linked group [${gid}] — validator (${result.validation?.command ?? 'unknown'}) failed; this is not a dependency conflict`,
        );
        if (result.validation?.lastLines) {
          log.dim(indentBlock(result.validation.lastLines, '    '));
        }
      } else {
        log.error(`skipped linked group [${gid}] (${result.message ?? kind})`);
        if (result.install?.lastLines) {
          log.dim(indentBlock(result.install.lastLines, '    '));
        }
      }
    }
  }
}

/**
 * Sequential upgrade engine: validate, rollback on failure.
 * With `linkGroups: auto`, packages are clustered from registry peer/dependency graphs
 * (and custom rc groups) so related deps bump together.
 *
 * Operates on a **single** `package.json` at `cwd`. Install + validation happen at
 * `installCwd ?? cwd` so the same engine can be reused for workspace child packages by setting
 * `cwd` to the child dir and `installCwd` to the workspace root. The orchestrator
 * (`runUpgradeFlow`) handles target selection, pre-flight, and aggregation.
 *
 * TODO: parallel upgrades with dependency graph ordering
 * TODO: git commit after each successful upgrade
 * TODO: expo install–style version alignment for Expo SDK
 */
export async function runUpgradeEngine(opts: UpgradeEngineOptions): Promise<FinalReport> {
  const { cwd, dryRun, jsonOutput, ignore, force } = opts;
  const installCwd = opts.installCwd ?? cwd;
  const report = createEmptyReport();

  const projectInfo =
    opts.projectInfo ?? (await detectProjectInfo(installCwd, opts.packageManager ?? 'auto'));
  report.project = {
    manager: projectInfo.manager,
    managerVersion: projectInfo.managerVersion,
    managerSource: projectInfo.managerSource,
    lockfile: projectInfo.lockfile,
    hasWorkspaces: projectInfo.hasWorkspaces,
    workspaceGlobs: projectInfo.workspaceGlobs,
    workspaceMembers: projectInfo.workspaceMembers.map((m) => ({ name: m.name, dir: m.dir })),
    ...(projectInfo.yarnMajorVersion !== undefined
      ? { yarnMajorVersion: projectInfo.yarnMajorVersion }
      : {}),
    ...(projectInfo.yarnSupportsFocus !== undefined
      ? { yarnSupportsFocus: projectInfo.yarnSupportsFocus }
      : {}),
    ...(projectInfo.isolatedLockfiles
      ? {
          isolatedLockfiles: true,
          ...(projectInfo.isolatedLockfilesSource
            ? { isolatedLockfilesSource: projectInfo.isolatedLockfilesSource }
            : {}),
        }
      : {}),
  };

  if (!jsonOutput && !opts.skipPreflight) {
    const mgrLabel = `${projectInfo.manager}${projectInfo.managerVersion ? '@' + projectInfo.managerVersion : ''}`;
    const wsLabel = projectInfo.hasWorkspaces
      ? ` (workspaces: ${projectInfo.workspaceMembers.length} member${projectInfo.workspaceMembers.length === 1 ? '' : 's'})`
      : '';
    log.dim(`Detected package manager: ${mgrLabel} via ${projectInfo.managerSource}${wsLabel}`);
  }

  const packages = await scanProject(cwd);

  const restrictToNames = opts.restrictToNames;
  const policyFreezeWildcards = (opts.policy?.freeze ?? []).filter((f) => f.pattern.includes('*'));
  for (const scanned of packages) {
    if (ignore.has(scanned.name)) {
      report.ignored.push(scanned.name);
      if (!jsonOutput) {
        log.dim(`Skipping ignored package: ${scanned.name}`);
      }
      continue;
    }
    // Expand wildcard freeze patterns (e.g. `@types/*`) against the scanned names. Literal
    // patterns have already been absorbed into `ignore` at the CLI level.
    if (policyFreezeWildcards.length > 0) {
      const { matchPattern } = await import('../config/policy.js');
      const match = policyFreezeWildcards.find((f) => matchPattern(f.pattern, scanned.name));
      if (match) {
        ignore.add(scanned.name);
        report.ignored.push(scanned.name);
        if (!jsonOutput) {
          const why = match.reason ? ` — ${match.reason}` : '';
          log.dim(`policy-frozen: ${scanned.name} (matches ${match.pattern})${why}`);
        }
        continue;
      }
    }
    // --security-only: every non-audited package is treated as ignored. We also push the name
    // into `ignore` so downstream code (group planner, batch execution) skips it uniformly
    // without having to learn about the restriction set.
    if (restrictToNames && !restrictToNames.has(scanned.name)) {
      ignore.add(scanned.name);
      report.ignored.push(scanned.name);
    }
  }

  const pkgJson = await readPackageJson(cwd);
  const engineOpts: UpgradeEngineOptions = {
    ...opts,
    rootPackageName: typeof pkgJson.name === 'string' ? pkgJson.name : undefined,
    projectInfo,
    installCwd,
  };

  if (!dryRun && !opts.skipPreflight) {
    // Pre-flight runs against the install root (where node_modules + the validator live), not
    // necessarily the per-target package.json that's about to be mutated.
    const installRootPkg = await readPackageJson(installCwd);
    const preflightSpinner = jsonOutput
      ? undefined
      : createSpinner('Pre-flight: verifying current tree is healthy before any upgrade...');
    const pre = await preflightValidate(installCwd, installRootPkg, {
      ...(engineOpts.validate ?? {}),
      manager: projectInfo.manager,
      onResolved: ({ command }) => {
        preflightSpinner?.update(`Pre-flight: running \`${command}\` on unchanged tree...`);
      },
    });
    if (pre.skipped) {
      preflightSpinner?.stop('Pre-flight: no validator available (skipped)');
    } else if (pre.ok) {
      preflightSpinner?.succeed(`Pre-flight ok: \`${pre.command}\``);
    } else {
      preflightSpinner?.fail(
        `Pre-flight failed: \`${pre.command}\` exited ${pre.exitCode ?? '?'}`,
      );
    }
    if (!pre.skipped) {
      report.preflight = {
        ok: pre.ok,
        skipped: pre.skipped,
        command: pre.command,
        exitCode: pre.exitCode,
        lastLines: pre.lastLines,
        source: pre.source,
      };
      if (!pre.ok) {
        if (!jsonOutput) {
          log.warn(
            'Every per-group rollback would look identical because the validator is already broken before any upgrade.',
          );
          if (pre.lastLines) {
            log.dim(indentBlock(pre.lastLines, '    '));
          }
          log.info(
            'Fix the validator command or pass --no-validate / --validate "<cmd>" / --force to proceed anyway.',
          );
        }
        if (!force) {
          report.preflightAborted = true;
          return report;
        }
      }
    }
  }

  if (!dryRun) {
    await backupPackageJson(cwd);
  }

  const groups =
    engineOpts.linkGroups === 'auto'
      ? await buildDynamicLinkedGroups(
          pkgJson,
          packages,
          ignore,
          engineOpts.linkedGroupsConfig,
          jsonOutput,
        )
      : buildSingletonGroups(packages, ignore);

  report.groupPlan = groups.map((g) => ({ id: g.id, packages: [...g.names] }));

  for (const group of groups) {
    const fresh = await scanProject(cwd);
    const byName = new Map(fresh.map((p) => [p.name, p]));
    const members = group.names.map((n) => byName.get(n)).filter(Boolean) as ScannedPackage[];
    const active = members.filter((m) => !ignore.has(m.name));
    if (active.length === 0) {
      continue;
    }

    if (active.length === 1) {
      await runSinglePackageUpgrade(cwd, active[0]!, engineOpts, report, ignore);
    } else {
      await runLinkedGroupUpgrade(cwd, group, active, engineOpts, report, ignore);
    }
  }

  if (opts.targetLabel) {
    tagWorkspaceLabels(report, opts.targetLabel);
  }

  return report;
}

export async function restoreInitialFromBackup(cwd: string): Promise<void> {
  await restoreBackup(cwd);
}

export { backupPackageJson, BACKUP_FILENAME };

/**
 * Workspace traversal mode for `runUpgradeFlow`.
 *
 *   - `'root-only'` (default): mutate only the root `package.json`.
 *   - `'all'`: mutate the root and **every** workspace member's `package.json`.
 *   - `'workspaces-only'`: mutate every workspace member but **not** the root.
 *   - `string[]`: mutate only the workspace members whose `package.json` `name` is in the list
 *     (root is included if `'root'` appears in the list).
 */
export type WorkspaceMode = 'root-only' | 'all' | 'workspaces-only' | string[];

export interface UpgradeFlowOptions
  extends Omit<
    UpgradeEngineOptions,
    | 'cwd'
    | 'installCwd'
    | 'targetLabel'
    | 'skipPreflight'
    | 'installFilter'
    | 'installLock'
    | 'onUpgradeApplied'
  > {
  /** Workspace root (where the lockfile and the `workspaces` field live). */
  cwd: string;
  /** Which `package.json` files to traverse. Defaults to `'root-only'`. */
  workspaceMode?: WorkspaceMode;
  /**
   * Engine `onUpgradeApplied` hook. The CLI installs one for git integration so each
   * successful upgrade can be committed in real time (per-success mode) or accumulated for
   * a per-target / per-run squashed commit. The orchestrator forwards it verbatim to every
   * spawned engine call; ordering is naturally serialized by the install lock.
   */
  onUpgradeApplied?: UpgradeEngineOptions['onUpgradeApplied'];
  /**
   * Hook fired after each per-target `runUpgradeEngine` returns (success OR failure). Used by
   * the git integration's `per-target` mode to flush its buffered commits BEFORE the next
   * target's install starts. The orchestrator awaits the hook serially so even with
   * `--concurrency > 1` multiple `onTargetComplete` calls do not interleave.
   */
  onTargetComplete?: (event: TargetCompleteEvent) => Promise<void>;
  /**
   * Maximum number of workspace targets to traverse in parallel. Default `1` (serial — exact
   * pre-existing behavior). Higher values run target **scan + plan** phases concurrently while
   * a shared mutex serializes lockfile-touching operations (install + validate). Net effect:
   * registry / network IO is overlapped across targets, but lockfile mutations stay strictly
   * serial. Capped at `MAX_CONCURRENCY` (16) to avoid registry rate-limiting and runaway open
   * sockets.
   *
   * In **non-JSON** human mode this is silently downgraded to `1` (parallel logging would
   * interleave per-target output unreadably). Pass `--json` or `--ci` to use values > 1.
   */
  concurrency?: number;
  /**
   * Force installs + validation to stay serialized even when `ProjectInfo.isolatedLockfiles`
   * is true. By default the orchestrator parallelizes installs across workspaces in isolated-
   * lockfile setups (`pnpm shared-workspace-lockfile=false` or every member has its own
   * lockfile on disk); setting this to `true` pins the old serialized behavior. Useful when
   * a postinstall script in one workspace touches shared state outside the workspace tree
   * (npm scripts, generated files, etc.) and can't tolerate concurrent peers.
   */
  forceSerialInstalls?: boolean;
}

export interface TargetCompleteEvent {
  /** Workspace label (`'root'` or member package name). */
  workspace: string;
  /** Absolute path to the target's package.json directory. */
  targetCwd: string;
  /** Workspace root (where the lockfile lives). */
  installCwd: string;
  manager: PackageManager;
  /** Engine's per-target report (already merged into the aggregate by the orchestrator). */
  report: FinalReport;
}

const MAX_CONCURRENCY = 16;

interface ResolvedTarget {
  label: string;
  cwd: string;
  packageJson: string;
}

function resolveTargets(rootCwd: string, projectInfo: ProjectInfo, mode: WorkspaceMode): ResolvedTarget[] {
  const root: ResolvedTarget = {
    label: 'root',
    cwd: rootCwd,
    packageJson: path.join(rootCwd, 'package.json'),
  };
  const members: ResolvedTarget[] = projectInfo.workspaceMembers.map((m) => ({
    label: m.name,
    cwd: m.dir,
    packageJson: path.join(m.dir, 'package.json'),
  }));

  if (mode === 'root-only') {
    return [root];
  }
  if (mode === 'all') {
    return [root, ...members];
  }
  if (mode === 'workspaces-only') {
    return members;
  }

  // explicit list of names
  const want = new Set(mode);
  const out: ResolvedTarget[] = [];
  if (want.has('root')) {
    out.push(root);
    want.delete('root');
  }
  for (const m of members) {
    if (want.has(m.label)) {
      out.push(m);
      want.delete(m.label);
    }
  }
  if (want.size > 0) {
    const missing = [...want].join(', ');
    throw new Error(
      `--workspace: unknown workspace member(s): ${missing}. Known members: ${members.map((m) => m.label).join(', ') || '(none)'}`,
    );
  }
  return out;
}

/**
 * Multi-target orchestrator. Detects project info once, runs pre-flight once at the install
 * root, then invokes `runUpgradeEngine` per target with `installCwd` pinned to the workspace
 * root so installs and validation always exercise the **whole** monorepo. Aggregates results
 * into a single `FinalReport`.
 */
export async function runUpgradeFlow(opts: UpgradeFlowOptions): Promise<FinalReport> {
  const { cwd: rootCwd, dryRun, jsonOutput, force } = opts;
  const mode: WorkspaceMode = opts.workspaceMode ?? 'root-only';

  const projectInfo =
    opts.projectInfo ?? (await detectProjectInfo(rootCwd, opts.packageManager ?? 'auto'));

  const targets = resolveTargets(rootCwd, projectInfo, mode);

  if (!jsonOutput) {
    const mgrLabel = `${projectInfo.manager}${projectInfo.managerVersion ? '@' + projectInfo.managerVersion : ''}`;
    const wsLabel = projectInfo.hasWorkspaces
      ? ` (workspaces: ${projectInfo.workspaceMembers.length} member${projectInfo.workspaceMembers.length === 1 ? '' : 's'})`
      : '';
    log.dim(`Detected package manager: ${mgrLabel} via ${projectInfo.managerSource}${wsLabel}`);
    if (mode !== 'root-only') {
      log.info(
        `Workspace traversal: ${targets.length} target(s) → ${targets.map((t) => t.label).join(', ')}`,
      );
    }
  }

  // Pre-flight runs ONCE at the workspace root. Per-target runs then skip it.
  let aggregate: FinalReport = createEmptyReport();
  aggregate.targets = targets.map((t) => ({ label: t.label, cwd: t.cwd, packageJson: t.packageJson }));
  aggregate.installMode = opts.installMode ?? 'root';
  aggregate.project = {
    manager: projectInfo.manager,
    managerVersion: projectInfo.managerVersion,
    managerSource: projectInfo.managerSource,
    lockfile: projectInfo.lockfile,
    hasWorkspaces: projectInfo.hasWorkspaces,
    workspaceGlobs: projectInfo.workspaceGlobs,
    workspaceMembers: projectInfo.workspaceMembers.map((m) => ({ name: m.name, dir: m.dir })),
    ...(projectInfo.yarnMajorVersion !== undefined
      ? { yarnMajorVersion: projectInfo.yarnMajorVersion }
      : {}),
    ...(projectInfo.yarnSupportsFocus !== undefined
      ? { yarnSupportsFocus: projectInfo.yarnSupportsFocus }
      : {}),
    ...(projectInfo.isolatedLockfiles
      ? {
          isolatedLockfiles: true,
          ...(projectInfo.isolatedLockfilesSource
            ? { isolatedLockfilesSource: projectInfo.isolatedLockfilesSource }
            : {}),
        }
      : {}),
  };

  if (!dryRun) {
    const installRootPkg = await readPackageJson(rootCwd);
    const preflightSpinner = jsonOutput
      ? undefined
      : createSpinner('Pre-flight: verifying current tree is healthy before any upgrade...');
    const pre = await preflightValidate(rootCwd, installRootPkg, {
      ...(opts.validate ?? {}),
      manager: projectInfo.manager,
      onResolved: ({ command }) => {
        preflightSpinner?.update(`Pre-flight: running \`${command}\` on unchanged tree...`);
      },
    });
    if (pre.skipped) {
      preflightSpinner?.stop('Pre-flight: no validator available (skipped)');
    } else if (pre.ok) {
      preflightSpinner?.succeed(`Pre-flight ok: \`${pre.command}\``);
    } else {
      preflightSpinner?.fail(
        `Pre-flight failed: \`${pre.command}\` exited ${pre.exitCode ?? '?'}`,
      );
    }
    if (!pre.skipped) {
      aggregate.preflight = {
        ok: pre.ok,
        skipped: pre.skipped,
        command: pre.command,
        exitCode: pre.exitCode,
        lastLines: pre.lastLines,
        source: pre.source,
      };
      if (!pre.ok && !force) {
        if (!jsonOutput) {
          if (pre.lastLines) {
            log.dim(indentBlock(pre.lastLines, '    '));
          }
          log.info(
            'Fix the validator command or pass --no-validate / --validate "<cmd>" / --force to proceed anyway.',
          );
        }
        aggregate.preflightAborted = true;
        return aggregate;
      }
    }
  }

  // Only prefix group ids with the target label when traversing more than one target. In the
  // common single-target ("root-only") case we keep ids identical to the legacy single-engine
  // shape so existing JSON consumers / fixture assertions stay stable.
  const namespaceGroups = targets.length > 1;

  // Yarn-specific user feedback for `--install-mode filtered`:
  //   - berry + plugin → use `yarn workspaces focus <name>` (great), inform once.
  //   - berry without plugin → fall back to root install, point at the plugin install hint.
  //   - classic (v1) → no `workspaces focus` exists, fall back to root install with version hint.
  // We deliberately log only once per run (not per target) so monorepos with many members don't
  // produce a wall of identical warnings.
  if (
    opts.installMode === 'filtered' &&
    projectInfo.manager === 'yarn' &&
    !jsonOutput &&
    targets.some((t) => t.cwd !== rootCwd)
  ) {
    const major = projectInfo.yarnMajorVersion;
    if (projectInfo.yarnSupportsFocus) {
      log.info(
        `--install-mode filtered: using \`yarn workspaces focus <name>\` (yarn ${major ?? 'berry'} + @yarnpkg/plugin-workspace-tools).`,
      );
    } else if (major !== undefined && major < 2) {
      log.warn(
        `--install-mode filtered: yarn ${major}.x (classic) has no \`workspaces focus\` command. Falling back to a full root install for child targets — upgrade to yarn berry (v2+) for filtered installs.`,
      );
    } else {
      log.warn(
        '--install-mode filtered: `yarn workspaces focus` is unavailable (install `@yarnpkg/plugin-workspace-tools` with `yarn plugin import workspace-tools`). Falling back to a full root install for child targets.',
      );
    }
  }

  // Resolve effective concurrency. Cap at the target count (no point spawning more workers than
  // work) and at MAX_CONCURRENCY (registry rate-limit safety). Downgrade to 1 in non-JSON mode
  // so per-target log lines don't interleave into illegibility — humans still get serial output;
  // CI / scripts can opt into parallelism by adding --json or --ci.
  const requested = Math.max(1, Math.floor(opts.concurrency ?? 1));
  let effectiveConcurrency = Math.min(requested, targets.length, MAX_CONCURRENCY);
  if (effectiveConcurrency > 1 && !jsonOutput) {
    log.warn(
      `--concurrency ${requested}: parallel target traversal interleaves human-mode log output; downgrading to 1. Add --json (or --ci) to enable parallelism.`,
    );
    effectiveConcurrency = 1;
  }
  aggregate.concurrency = effectiveConcurrency;

  // Shared resources for the parallel run. The cache is created unconditionally — even at
  // concurrency 1 it deduplicates fetches across targets (typical monorepo: same dep in many
  // workspaces). The lock is created when we actually run > 1 in flight OR when a per-upgrade
  // hook is wired (the hook may itself touch shared state — git index, lockfile, etc. — and
  // benefits from the same serialization guarantees the install path gets). When neither
  // applies, `withInstallLock` no-ops at zero overhead.
  // Reuse a caller-supplied cache when provided (programmatic tests rely on pre-seeded entries
  // so the upgrade flow never touches the real registry). Production CLI callers always omit it
  // and get a fresh one per run.
  const registryCache = opts.registryCache ?? createRegistryCache();
  const installLock =
    effectiveConcurrency > 1 || opts.onUpgradeApplied ? new KeyedMutex() : undefined;

  // Isolated-lockfile monorepos (pnpm `shared-workspace-lockfile=false`, or every workspace
  // member shipping its own lockfile) can install IN PARALLEL — different workspaces touch
  // different lockfiles. `detectProjectInfo` sets `isolatedLockfiles` when it can prove this
  // is safe. When true, `installCwd` becomes the target's own dir (not `rootCwd`), the keyed
  // mutex gives each target its own lock, and the `installFilter` is dropped (running a
  // manager-scoped install at the workspace dir is the simpler + more correct path).
  const parallelInstalls =
    Boolean(projectInfo.isolatedLockfiles) &&
    effectiveConcurrency > 1 &&
    !opts.forceSerialInstalls;
  aggregate.parallelInstalls = parallelInstalls;

  if (effectiveConcurrency > 1 && !jsonOutput) {
    if (parallelInstalls) {
      log.dim(
        `Parallel traversal: up to ${effectiveConcurrency} targets concurrently — isolated lockfiles detected (${projectInfo.isolatedLockfilesSource}), installs run in parallel per workspace.`,
      );
    } else {
      log.dim(
        `Parallel traversal: scan/plan up to ${effectiveConcurrency} targets concurrently; install + validate stay serialized (shared root lockfile).`,
      );
    }
  }

  const buildEngineOpts = (target: { label: string; cwd: string; packageJson: string }) => ({
    ...opts,
    cwd: target.cwd,
    // In parallel-install mode each target installs into its OWN directory; otherwise we
    // install at the root as before. Either way, `withInstallLock` keys off this value, so
    // serialization lines up with lockfile boundaries.
    installCwd: parallelInstalls && target.cwd !== rootCwd ? target.cwd : rootCwd,
    projectInfo,
    targetLabel: namespaceGroups ? target.label : undefined,
    skipPreflight: true,
    // Filter only applies when (a) user opted into filtered mode, (b) we're mutating a
    // workspace child (root targets always need a full install — nothing to filter), and
    // (c) we're NOT in parallel-install mode (there the install already runs at the
    // workspace dir, so the filter is redundant and can confuse pnpm/yarn).
    installFilter:
      opts.installMode === 'filtered' && target.cwd !== rootCwd && !parallelInstalls
        ? target.label
        : undefined,
    registryCache,
    installLock,
    onUpgradeApplied: opts.onUpgradeApplied,
  });

  // Helper that runs a single target's engine, fires `onTargetComplete` (used by the git
  // integration's per-target flush), and returns the sub-report. Centralized so both the
  // serial and parallel branches use identical semantics.
  const runOneTarget = async (target: ResolvedTarget): Promise<FinalReport> => {
    const subReport = await runUpgradeEngine(buildEngineOpts(target));
    if (opts.onTargetComplete) {
      try {
        await opts.onTargetComplete({
          workspace: target.label,
          targetCwd: target.cwd,
          installCwd: rootCwd,
          manager: projectInfo.manager,
          report: subReport,
        });
      } catch (e) {
        if (!jsonOutput) {
          const msg = e instanceof Error ? e.message : String(e);
          log.warn(`onTargetComplete hook threw for ${target.label}: ${msg}`);
        }
      }
    }
    return subReport;
  };

  if (effectiveConcurrency === 1) {
    // Serial path — exact pre-existing behavior. Header logs print before each target.
    for (const target of targets) {
      if (!jsonOutput && namespaceGroups) {
        log.title(`Target: ${target.label}`);
      }
      const subReport = await runOneTarget(target);
      aggregate = mergeSubReport(aggregate, subReport, target.label, namespaceGroups);
    }
    return aggregate;
  }

  // Parallel path — spawn up to `effectiveConcurrency` engines at once. We deliberately merge
  // results in **input order** (not completion order) so the aggregated report is deterministic
  // for snapshot-style assertions and CI diffs. JSON-mode is the gate for this path so we don't
  // worry about interleaved human logs.
  const subReports = await runWithConcurrency(targets, effectiveConcurrency, async (target) => {
    return runOneTarget(target);
  });
  for (let i = 0; i < targets.length; i++) {
    aggregate = mergeSubReport(aggregate, subReports[i], targets[i].label, namespaceGroups);
  }
  return aggregate;
}

function mergeSubReport(
  into: FinalReport,
  sub: FinalReport,
  label: string,
  namespaceGroups: boolean,
): FinalReport {
  into.upgraded.push(...sub.upgraded);
  into.failed.push(...sub.failed);
  for (const name of sub.ignored) {
    if (!into.ignored.includes(name)) {
      into.ignored.push(name);
    }
  }
  if (sub.parsedConflicts?.length) {
    into.parsedConflicts = into.parsedConflicts ?? [];
    into.parsedConflicts.push(...sub.parsedConflicts);
  }
  if (sub.groupPlan?.length) {
    into.groupPlan = into.groupPlan ?? [];
    for (const g of sub.groupPlan) {
      into.groupPlan.push({
        id: namespaceGroups ? `${label}::${g.id}` : g.id,
        packages: [...g.packages],
      });
    }
  }
  return into;
}
