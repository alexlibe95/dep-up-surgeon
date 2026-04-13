import chalk from 'chalk';
import type { Conflict } from '../types.js';
import type { ConflictEntry, FinalReport, UpgradeRecord } from '../types.js';
import { log } from '../utils/logger.js';

/**
 * Structured machine report (JSON-friendly).
 */
export interface StructuredReport {
  upgraded: UpgradeRecord[];
  skipped: UpgradeRecord[];
  failed: ConflictEntry[];
  conflicts: Conflict[];
  unresolved: ConflictEntry[];
  groups: Array<{ id: string; packages: string[] }>;
}

export function buildStructuredReport(
  report: FinalReport,
  options: {
    parsedConflicts?: Conflict[];
    groups?: Array<{ id: string; packages: string[] }>;
  } = {},
): StructuredReport {
  const upgraded = report.upgraded.filter((r) => r.success && !r.skipped);
  const skipped = report.upgraded.filter((r) => r.skipped);
  const failed = report.failed;
  const conflicts = options.parsedConflicts ?? [];
  const unresolved = failed;
  const groups = options.groups ?? [];

  return {
    upgraded,
    skipped,
    failed,
    conflicts,
    unresolved,
    groups,
  };
}

export function printStructuredCliSummary(structured: StructuredReport): void {
  log.title('Structured summary');

  if (structured.groups.length) {
    log.info(chalk.bold('Groups'));
    for (const g of structured.groups) {
      log.dim(`  [${g.id}]: ${g.packages.join(', ')}`);
    }
  }

  if (structured.conflicts.length) {
    log.info(chalk.bold('Parsed conflicts (from npm output)'));
    for (const c of structured.conflicts.slice(0, 20)) {
      log.dim(`  ${c.dependency} ← ${c.depender} (need ${c.requiredRange})`);
    }
    if (structured.conflicts.length > 20) {
      log.dim(`  … ${structured.conflicts.length - 20} more`);
    }
  }

  if (structured.unresolved.length) {
    log.info(chalk.bold('Unresolved'));
    for (const u of structured.unresolved) {
      log.error(`${u.name}: ${u.message ?? u.reason}`);
    }
  }
}
