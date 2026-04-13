import path from 'node:path';
import fs from 'fs-extra';
import prompts from 'prompts';
import semver from 'semver';
import { appendIgnoreToRc } from '../config/loadConfig.js';
import type { DepSection, FailureReason, FinalReport, ScannedPackage, UpgradeRecord } from '../types.js';
import type { PackageJson } from '../types.js';
import { addFailure, addUpgrade, createEmptyReport } from './conflict.js';
import { isRegistryRange, scanProject } from './scanner.js';
import { validateProject } from './validator.js';
import { log } from '../utils/logger.js';
import {
  detectEsmCommonJsBlockage,
  detectPeerConflictFromOutput,
  fetchAllPublishedVersions,
  fetchLatestVersion,
  runNpmInstall,
} from '../utils/npm.js';
import { buildLineFallbackOrder } from '../utils/versionFallback.js';
import { buildLinkedGroups } from './groups.js';
import type { LinkedGroup } from './groups.js';

const BACKUP_FILENAME = 'package.json.dep-up-surgeon.bak';

export type FallbackStrategy = 'major-lines' | 'minor-lines' | 'none';

export interface UpgradeEngineOptions {
  cwd: string;
  dryRun: boolean;
  interactive: boolean;
  force: boolean;
  jsonOutput: boolean;
  ignore: Set<string>;
  /**
   * `major-lines` (default): after `@latest` fails, try one best version per **major**
   * (fewer installs; good when whole majors flip e.g. ESM-only).
   * `minor-lines`: one best version per **(major.minor)** (finer steps).
   * `none`: only attempt `@latest`.
   */
  fallbackStrategy: FallbackStrategy;
  /**
   * `auto`: built-in linked groups (Expo, React core) + `.dep-up-surgeonrc` `linkedGroups`.
   * `none`: one package per upgrade step (legacy).
   */
  linkGroups: 'auto' | 'none';
  /** From `.dep-up-surgeonrc` — custom groups applied before built-in rules */
  linkedGroupsConfig?: Array<{ id: string; packages: string[] }>;
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

type FailureKind = 'install' | 'peer' | 'validation';

interface AttemptResult {
  ok: boolean;
  kind?: FailureKind;
  message?: string;
  /** Stop trying further fallback versions (e.g. ESM vs CommonJS for all newer releases). */
  abortFallbacks?: boolean;
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
  const { force } = opts;
  const previousRange = scanned.currentRange;

  let pkg = await readPackageJson(cwd);
  pkg = setRange(pkg, scanned.section, scanned.name, targetVersion);
  await writePackageJson(cwd, pkg);

  const install = await runNpmInstall(cwd);
  const peerHit = detectPeerConflictFromOutput(install.output);

  if (!install.ok) {
    const esm = detectEsmCommonJsBlockage(install.output);
    await writeDepRange(cwd, scanned.section, scanned.name, previousRange);
    await runNpmInstall(cwd);
    return {
      ok: false,
      kind: 'install',
      message: esm
        ? `npm install failed (exit ${install.exitCode}): ESM/CommonJS mismatch (e.g. ERR_REQUIRE_ESM). Newer releases may be ESM-only while this project is CommonJS — pin the package, migrate to ESM, or ignore it.`
        : `npm install failed (exit ${install.exitCode})`,
      abortFallbacks: esm,
    };
  }

  if (peerHit && !force) {
    await writeDepRange(cwd, scanned.section, scanned.name, previousRange);
    await runNpmInstall(cwd);
    return {
      ok: false,
      kind: 'peer',
      message:
        'npm reported peer dependency issues (see npm output). Suggestion: keep this package unchanged or resolve peers manually.',
    };
  }

  pkg = await readPackageJson(cwd);
  const validation = await validateProject(cwd, pkg);
  if (!validation.ok && !force) {
    await writeDepRange(cwd, scanned.section, scanned.name, previousRange);
    await runNpmInstall(cwd);
    return {
      ok: false,
      kind: 'validation',
      message: `${validation.command} failed (exit ${validation.exitCode ?? '?'})`,
    };
  }

  if (!validation.ok && force) {
    return {
      ok: true,
      message: `Kept upgrade despite ${validation.command} failure (--force)`,
    };
  }

  return { ok: true };
}

type Bump = { scanned: ScannedPackage; targetVersion: string };

/**
 * Bump several dependencies in one `package.json` write, then one install + validate.
 * Rolls back **all** listed bumps on failure.
 */
async function attemptBatchUpgrade(
  cwd: string,
  bumps: Bump[],
  opts: UpgradeEngineOptions,
): Promise<AttemptResult> {
  const { force } = opts;
  if (bumps.length === 0) {
    return { ok: true };
  }

  const previous = new Map<string, { section: DepSection; range: string }>();
  for (const { scanned } of bumps) {
    previous.set(scanned.name, { section: scanned.section, range: scanned.currentRange });
  }

  let pkg = await readPackageJson(cwd);
  for (const { scanned, targetVersion } of bumps) {
    pkg = setRange(pkg, scanned.section, scanned.name, targetVersion);
  }
  await writePackageJson(cwd, pkg);

  const install = await runNpmInstall(cwd);
  const peerHit = detectPeerConflictFromOutput(install.output);

  const rollbackAll = async (): Promise<void> => {
    for (const { scanned } of bumps) {
      const snap = previous.get(scanned.name);
      if (!snap) {
        continue;
      }
      await writeDepRange(cwd, snap.section, scanned.name, snap.range);
    }
    await runNpmInstall(cwd);
  };

  if (!install.ok) {
    const esm = detectEsmCommonJsBlockage(install.output);
    await rollbackAll();
    return {
      ok: false,
      kind: 'install',
      message: esm
        ? `npm install failed (exit ${install.exitCode}): ESM/CommonJS mismatch (e.g. ERR_REQUIRE_ESM). Newer releases may be ESM-only while this project is CommonJS — pin the package, migrate to ESM, or ignore it.`
        : `npm install failed (exit ${install.exitCode})`,
      abortFallbacks: esm,
    };
  }

  if (peerHit && !force) {
    await rollbackAll();
    return {
      ok: false,
      kind: 'peer',
      message:
        'npm reported peer dependency issues (see npm output). Suggestion: keep this package unchanged or resolve peers manually.',
    };
  }

  pkg = await readPackageJson(cwd);
  const validation = await validateProject(cwd, pkg);
  if (!validation.ok && !force) {
    await rollbackAll();
    return {
      ok: false,
      kind: 'validation',
      message: `${validation.command} failed (exit ${validation.exitCode ?? '?'})`,
    };
  }

  if (!validation.ok && force) {
    return {
      ok: true,
      message: `Kept upgrade despite ${validation.command} failure (--force)`,
    };
  }

  return { ok: true };
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
      const all = await fetchAllPublishedVersions(scanned.name);
      const mode = fallbackStrategy === 'major-lines' ? 'major' : 'minor';
      candidates = buildLineFallbackOrder(currentSemver, registryLatest, all, mode);
    } catch {
      candidates = [registryLatest];
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
  if (kind === 'peer') {
    return 'peer';
  }
  if (kind === 'validation') {
    return 'validation';
  }
  return 'install';
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
    latest = await fetchLatestVersion(scanned.name);
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
  } else {
    const kind = result.kind ?? 'install';
    addFailure(report, {
      name: scanned.name,
      reason: failureReason(kind),
      previousVersion: scanned.currentRange,
      attemptedVersion: lastAttemptedVersion,
      message: result.message,
    });
    if (!jsonOutput) {
      if (kind === 'peer') {
        log.peer(`${scanned.name} — ${result.message ?? 'peer conflict'}`);
      } else {
        log.error(`skipped: ${scanned.name} (${result.message ?? kind})`);
      }
    }
  }
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
      latest = await fetchLatestVersion(scanned.name);
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

  let result = await attemptBatchUpgrade(cwd, bumps, opts);
  const label = `[${gid}] ${group.names.join(', ')}`;

  if (!result.ok && interactive) {
    const action = await promptAfterFailure(label, true);
    if (action === 'pin') {
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
    } else if (action === 'retry') {
      if (!jsonOutput) {
        log.warn(`Retrying linked group [${gid}] …`);
      }
      result = await attemptBatchUpgrade(cwd, bumps, opts);
    }
  }

  if (result.ok) {
    for (const b of bumps) {
      const cur = semver.coerce(b.scanned.currentRange);
      const row: UpgradeRecord = {
        name: b.scanned.name,
        success: true,
        from: cur?.version,
        to: b.targetVersion,
        requestedLatest: b.targetVersion,
        linkedGroupId: gid,
      };
      if (result.message?.includes('--force')) {
        row.forced = true;
        row.detail = result.message;
      } else {
        row.detail = `upgraded with linked group [${gid}] (single install + validate)`;
      }
      addUpgrade(report, row);
      if (!jsonOutput) {
        log.success(`upgraded: ${b.scanned.name} → ${b.targetVersion} (group ${gid})`);
      }
    }
  } else {
    const kind = result.kind ?? 'install';
    const prev = bumps.map((b) => `${b.scanned.name}@${b.scanned.currentRange}`).join(', ');
    const att = bumps.map((b) => `${b.scanned.name}@${b.targetVersion}`).join(', ');
    addFailure(report, {
      name: `[group:${gid}]`,
      reason: failureReason(kind),
      previousVersion: prev,
      attemptedVersion: att,
      message: result.message,
      linkedGroupId: gid,
    });
    if (!jsonOutput) {
      if (kind === 'peer') {
        log.peer(`group [${gid}] — ${result.message ?? 'peer conflict'}`);
      } else {
        log.error(`skipped linked group [${gid}] (${result.message ?? kind})`);
      }
    }
  }
}

/**
 * Sequential upgrade engine: validate, rollback on failure.
 * With `linkGroups: auto`, Expo / React-core (and custom rc groups) bump together.
 *
 * TODO: parallel upgrades with dependency graph ordering
 * TODO: monorepo / workspaces
 * TODO: pnpm / yarn
 * TODO: git commit after each successful upgrade
 * TODO: expo install–style version alignment for Expo SDK
 */
export async function runUpgradeEngine(opts: UpgradeEngineOptions): Promise<FinalReport> {
  const { cwd, dryRun, interactive, jsonOutput, ignore } = opts;
  const report = createEmptyReport();

  const packages = await scanProject(cwd);
  if (!dryRun) {
    await backupPackageJson(cwd);
  }

  for (const scanned of packages) {
    if (ignore.has(scanned.name)) {
      report.ignored.push(scanned.name);
      if (!jsonOutput) {
        log.dim(`Skipping ignored package: ${scanned.name}`);
      }
    }
  }

  const groups = buildLinkedGroups(
    packages,
    ignore,
    opts.linkGroups === 'auto' ? 'auto' : 'none',
    opts.linkedGroupsConfig,
  );

  for (const group of groups) {
    const fresh = await scanProject(cwd);
    const byName = new Map(fresh.map((p) => [p.name, p]));
    const members = group.names.map((n) => byName.get(n)).filter(Boolean) as ScannedPackage[];
    const active = members.filter((m) => !ignore.has(m.name));
    if (active.length === 0) {
      continue;
    }

    if (active.length === 1) {
      await runSinglePackageUpgrade(cwd, active[0]!, opts, report, ignore);
    } else {
      await runLinkedGroupUpgrade(cwd, group, active, opts, report, ignore);
    }
  }

  return report;
}

export async function restoreInitialFromBackup(cwd: string): Promise<void> {
  await restoreBackup(cwd);
}

export { backupPackageJson, BACKUP_FILENAME };
