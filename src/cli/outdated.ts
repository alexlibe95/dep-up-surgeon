/**
 * Read-only "what is outdated?" report. Uses lockfile installed versions (when available)
 * vs registry `@latest`, so results match reality better than comparing the declared range floor.
 */
import path from 'node:path';
import chalk from 'chalk';
import { detectProjectInfo } from '../core/workspaces.js';
import { isRegistryRange, scanProject } from '../core/scanner.js';
import { dedupeScannedByName } from '../core/scannedDedup.js';
import { fetchLatestVersion } from '../utils/npm.js';
import {
  loadLockfileVersionTree,
  resolveInstalledVersion,
} from '../utils/installedVersion.js';
import { createRegistryCache, mapWithConcurrency } from '../utils/concurrency.js';
import semver from 'semver';

export type OutdatedStatus = 'up-to-date' | 'outdated' | 'ahead' | 'unknown';

export interface OutdatedRow {
  name: string;
  section: string;
  declared: string;
  installed?: string;
  latest?: string;
  status: OutdatedStatus;
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
  packageManager?: 'auto' | 'npm' | 'pnpm' | 'yarn';
  includePeers?: boolean;
  json?: boolean;
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
  const cache = createRegistryCache();

  const rows = await mapWithConcurrency(scanned, 8, async (p) => {
    const installed = resolveInstalledVersion({
      name: p.name,
      declaredRange: p.currentRange,
      lockfileVersions,
    });
    let latest: string | undefined;
    try {
      latest = await fetchLatestVersion(p.name, cache);
    } catch {
      latest = undefined;
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
    lines.push(
      `  ${pad(r.name, nameW)}  ${pad(r.installed ?? '?', verW)}  ${pad(r.latest ?? '?', verW)}  ${statusColor}`,
    );
  }
  if (report.summary.outdated === 0 && report.summary.ahead === 0 && report.summary.unknown === 0) {
    lines.push(chalk.green('  All scanned dependencies are up to date.'));
  }
  return lines.join('\n');
}
