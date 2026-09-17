/**
 * Read-only "what is outdated?" report. Uses lockfile installed versions (when available)
 * vs registry `@latest`, so results match reality better than comparing the declared range floor.
 */
import path from 'node:path';
import chalk from 'chalk';
import { detectProjectInfo, type PackageManager } from '../core/workspaces.js';
import { isRegistryRange, scanProject } from '../core/scanner.js';
import { dedupeScannedByName } from '../core/scannedDedup.js';
import { fetchLatestVersion } from '../utils/npm.js';
import { correctLaggingLatest } from '../utils/latestTag.js';
import {
  loadLockfileVersionTree,
  resolveInstalledVersion,
} from '../utils/installedVersion.js';
import { catalogStyleRange, loadCatalogIndex } from '../utils/catalog.js';
import { createRegistryCache, mapWithConcurrency, type RegistryCache } from '../utils/concurrency.js';
import semver from 'semver';

export type OutdatedStatus = 'up-to-date' | 'outdated' | 'ahead' | 'unknown';

export interface OutdatedRow {
  name: string;
  section: string;
  declared: string;
  installed?: string;
  latest?: string;
  /**
   * The registry `latest` dist-tag, present only when it lags behind the installed major. `latest`
   * then holds the newest release of the installed major instead (see `correctLaggingLatest`).
   */
  latestTag?: string;
  status: OutdatedStatus;
  /** Registry lookup failure message when `latest` could not be fetched. */
  error?: string;
}

export interface OutdatedReport {
  cwd: string;
  manager: string;
  rows: OutdatedRow[];
  summary: {
    total: number;
    outdated: number;
    upToDate: number;
    ahead: number;
    unknown: number;
  };
}

export interface RunOutdatedOptions {
  cwd: string;
  packageManager?: 'auto' | PackageManager;
  includePeers?: boolean;
  json?: boolean;
  /** Registry cache to reuse (or pre-seed in tests); a fresh one is created when omitted. */
  registryCache?: RegistryCache;
}

/**
 * Exit-code contract: 2 when no package could be checked (every registry lookup failed),
 * 1 when any package is outdated, 0 otherwise.
 */
export function outdatedExitCode(report: OutdatedReport): number {
  if (report.rows.length > 0 && report.rows.every((r) => r.error)) return 2;
  return report.summary.outdated > 0 ? 1 : 0;
}

export async function runOutdated(opts: RunOutdatedOptions): Promise<OutdatedReport> {
  const info = await detectProjectInfo(
    opts.cwd,
    opts.packageManager && opts.packageManager !== 'auto' ? opts.packageManager : 'auto',
  );
  const scanned = dedupeScannedByName(await scanProject(opts.cwd)).filter((p) => {
    if (!opts.includePeers && p.section === 'peerDependencies') return false;
    return isRegistryRange(p.currentRange);
  });
  const lockfileVersions = await loadLockfileVersionTree(opts.cwd, info.manager);
  const catalog = await loadCatalogIndex(opts.cwd);
  const cache = opts.registryCache ?? createRegistryCache();

  const rows = await mapWithConcurrency(scanned, 8, async (p) => {
    const declared = catalogStyleRange(catalog, p.name, p.currentRange);
    const installed = resolveInstalledVersion({
      name: p.name,
      declaredRange: declared,
      lockfileVersions,
    });
    let latest: string | undefined;
    let latestTag: string | undefined;
    let error: string | undefined;
    try {
      const resolved = await correctLaggingLatest(p.name, installed, await fetchLatestVersion(p.name, cache), cache);
      latest = resolved.latest;
      latestTag = resolved.laggingTag;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    let status: OutdatedStatus = 'unknown';
    if (installed && latest) {
      if (semver.eq(installed, latest)) status = 'up-to-date';
      else if (semver.gt(installed, latest)) status = 'ahead';
      else status = 'outdated';
    }
    const row: OutdatedRow = {
      name: p.name,
      section: p.section,
      declared: p.currentRange,
      status,
    };
    if (installed) row.installed = installed;
    if (latest) row.latest = latest;
    if (latestTag) row.latestTag = latestTag;
    if (error) row.error = error;
    return row;
  });

  rows.sort((a, b) => a.name.localeCompare(b.name));

  const summary = {
    total: rows.length,
    outdated: rows.filter((r) => r.status === 'outdated').length,
    upToDate: rows.filter((r) => r.status === 'up-to-date').length,
    ahead: rows.filter((r) => r.status === 'ahead').length,
    unknown: rows.filter((r) => r.status === 'unknown').length,
  };

  return {
    cwd: path.resolve(opts.cwd),
    manager: info.manager,
    rows,
    summary,
  };
}

export function renderOutdatedHuman(report: OutdatedReport): string {
  const lines: string[] = [];
  lines.push(
    chalk.bold(
      `Outdated check (${report.manager}) — ${report.summary.outdated} outdated / ${report.summary.total} scanned`,
    ),
  );
  if (report.rows.length === 0) {
    lines.push('  (no registry dependencies found)');
    return lines.join('\n');
  }
  const pad = (s: string, n: number) => s.padEnd(n);
  const nameW = Math.min(40, Math.max(4, ...report.rows.map((r) => r.name.length)));
  const verW = 12;
  lines.push(
    `  ${pad('NAME', nameW)}  ${pad('INSTALLED', verW)}  ${pad('LATEST', verW)}  STATUS`,
  );
  for (const r of report.rows) {
    if (r.status === 'up-to-date') continue;
    const statusColor =
      r.status === 'outdated'
        ? chalk.yellow(r.status)
        : r.status === 'ahead'
          ? chalk.cyan(r.status)
          : chalk.dim(r.status);
    const error = r.error ? chalk.dim(`  (${r.error})`) : '';
    const tag = r.latestTag ? chalk.dim(`  (npm "latest" tag: ${r.latestTag})`) : '';
    lines.push(
      `  ${pad(r.name, nameW)}  ${pad(r.installed ?? '?', verW)}  ${pad(r.latest ?? '?', verW)}  ${statusColor}${error}${tag}`,
    );
  }
  if (report.rows.every((r) => r.error)) {
    lines.push(chalk.red('  No package could be checked — every registry lookup failed.'));
  } else if (report.summary.outdated === 0 && report.summary.ahead === 0 && report.summary.unknown === 0) {
    lines.push(chalk.green('  All scanned dependencies are up to date.'));
  }
  return lines.join('\n');
}
