import path from 'node:path';
import fs from 'fs-extra';
import prompts from 'prompts';
import semver from 'semver';
import { appendIgnoreToRc } from '../config/loadConfig';
import type { DepSection, FailureReason, FinalReport, ScannedPackage, UpgradeRecord } from '../types';
import type { PackageJson } from '../types';
import { addFailure, addUpgrade, createEmptyReport } from './conflict';
import { isRegistryRange, scanProject } from './scanner';
import { validateProject } from './validator';
import { log } from '../utils/logger';
import {
  detectPeerConflictFromOutput,
  fetchAllPublishedVersions,
  fetchLatestVersion,
  runNpmInstall,
} from '../utils/npm';
import { buildMinorLineFallbackOrder } from '../utils/versionFallback';

const BACKUP_FILENAME = 'package.json.dep-up-surgeon.bak';

export type FallbackStrategy = 'minor-lines' | 'none';

export interface UpgradeEngineOptions {
  cwd: string;
  dryRun: boolean;
  interactive: boolean;
  force: boolean;
  jsonOutput: boolean;
  ignore: Set<string>;
  /**
   * `minor-lines`: if `@latest` fails (install/peer/validation), try the next
   * best version per (major.minor) line until one passes or the list ends.
   * `none`: only attempt the published `latest` (legacy behavior).
   */
  fallbackStrategy: FallbackStrategy;
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
    await writeDepRange(cwd, scanned.section, scanned.name, previousRange);
    await runNpmInstall(cwd);
    return {
      ok: false,
      kind: 'install',
      message: `npm install failed (exit ${install.exitCode})`,
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
  if (fallbackStrategy === 'minor-lines') {
    try {
      const all = await fetchAllPublishedVersions(scanned.name);
      candidates = buildMinorLineFallbackOrder(currentSemver, registryLatest, all);
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
      fallbackStrategy === 'minor-lines' &&
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
 * Sequential upgrade engine: one dependency at a time, validate, rollback on failure.
 *
 * TODO: parallel upgrades with dependency graph ordering
 * TODO: monorepo / workspaces
 * TODO: pnpm / yarn
 * TODO: git commit after each successful upgrade
 */
export async function runUpgradeEngine(opts: UpgradeEngineOptions): Promise<FinalReport> {
  const { cwd, dryRun, interactive, force, jsonOutput, ignore } = opts;
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
      continue;
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
      });
      if (!jsonOutput) {
        log.dim(`${scanned.name} already at latest (${latest})`);
      }
      continue;
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
      continue;
    }

    if (!jsonOutput) {
      const fb =
        opts.fallbackStrategy === 'minor-lines'
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

  return report;
}

export async function restoreInitialFromBackup(cwd: string): Promise<void> {
  await restoreBackup(cwd);
}

export { backupPackageJson, BACKUP_FILENAME };
