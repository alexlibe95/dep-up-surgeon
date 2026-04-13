import type { ConflictEntry, FinalReport, UpgradeRecord } from '../types';

export function createEmptyReport(): FinalReport {
  return { upgraded: [], failed: [], ignored: [] };
}

export function addUpgrade(report: FinalReport, row: UpgradeRecord): void {
  report.upgraded.push(row);
}

export function addFailure(report: FinalReport, row: ConflictEntry): void {
  report.failed.push(row);
}

/**
 * Merge machine-readable sections for `--json` output.
 */
export function toJsonReport(report: FinalReport): Record<string, unknown> {
  return {
    upgraded: report.upgraded,
    failed: report.failed,
    ignored: report.ignored,
  };
}
