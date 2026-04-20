import chalk from 'chalk';
import type {
  Conflict,
  GitCommitRecord,
  PolicyReport,
  ProjectInfoReport,
  ValidationDiagnostic,
} from '../types.js';
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
  /** Result of the unchanged-tree validator run (when not skipped). */
  preflight?: ValidationDiagnostic & { ok: boolean; skipped: boolean };
  /** True when the run aborted before any upgrade because pre-flight failed. */
  preflightAborted?: boolean;
  /** Detected package manager + workspace topology. */
  project?: ProjectInfoReport;
  /** Targets that were processed in this run (root and/or workspace members). */
  targets?: Array<{ label: string; cwd: string; packageJson: string }>;
  /** Packages that were skipped via the ignore list (CLI flag or `.dep-up-surgeonrc`). */
  ignored?: string[];
  /** Workspace install strategy used for this run (`'root'` or `'filtered'`). */
  installMode?: 'root' | 'filtered';
  /** Effective number of targets traversed in parallel (`1` = serial). */
  concurrency?: number;
  /** True when installs + validation ran concurrently per-workspace (isolated-lockfile monorepo). */
  parallelInstalls?: boolean;
  /**
   * Git commits created during the run (only present when `--git-commit` was set). Failed
   * commit attempts are also recorded here with `ok: false` so CI can surface the reason
   * without us having to fail the whole run.
   */
  commits?: GitCommitRecord[];
  /** Resolved git commit grouping mode (only present when `--git-commit` was set). */
  gitCommitMode?: 'per-success' | 'per-target' | 'all';
  /** Policy engine decisions (only present when `.dep-up-surgeon.policy.{yaml,json}` was found). */
  policy?: PolicyReport;
  /** Result of the `--apply-overrides` step (only present when the flag was passed). */
  overrides?: FinalReport['overrides'];
  /** Result of the `--open-pr` step (only present when the flag was passed). */
  pullRequest?: FinalReport['pullRequest'];
  /** Result of the `--fix-lockfile` step (only present when the flag was passed). */
  lockfileFix?: FinalReport['lockfileFix'];
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
    ...(report.preflight ? { preflight: report.preflight } : {}),
    ...(report.preflightAborted ? { preflightAborted: true } : {}),
    ...(report.project ? { project: report.project } : {}),
    ...(report.targets ? { targets: report.targets } : {}),
    ...(report.ignored?.length ? { ignored: report.ignored } : {}),
    ...(report.installMode ? { installMode: report.installMode } : {}),
    ...(report.concurrency && report.concurrency > 1 ? { concurrency: report.concurrency } : {}),
    ...(report.parallelInstalls ? { parallelInstalls: true } : {}),
    ...(report.commits && report.commits.length > 0 ? { commits: report.commits } : {}),
    ...(report.gitCommitMode ? { gitCommitMode: report.gitCommitMode } : {}),
    ...(report.policy ? { policy: report.policy } : {}),
    ...(report.overrides ? { overrides: report.overrides } : {}),
    ...(report.pullRequest ? { pullRequest: report.pullRequest } : {}),
    ...(report.lockfileFix ? { lockfileFix: report.lockfileFix } : {}),
  };
}

export function printStructuredCliSummary(structured: StructuredReport): void {
  log.title('Structured summary');

  if (structured.project) {
    const p = structured.project;
    const mgr = `${p.manager}${p.managerVersion ? '@' + p.managerVersion : ''}`;
    log.dim(
      `  project: ${mgr} via ${p.managerSource}` +
        (p.lockfile ? `, lockfile=${p.lockfile}` : '') +
        (p.hasWorkspaces ? `, workspaces=${p.workspaceMembers.length}` : ''),
    );
  }
  if (structured.targets && structured.targets.length > 1) {
    log.dim(`  targets: ${structured.targets.map((t) => t.label).join(', ')}`);
  }
  if (structured.parallelInstalls) {
    log.dim(`  parallel installs: per-workspace (isolated-lockfile monorepo)`);
  }

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
      const tag = u.reason === 'validation-script' ? ' (validator script error)' : '';
      const ws = u.workspace && u.workspace !== 'root' ? ` [${u.workspace}]` : '';
      log.error(`${u.name}${ws}${tag}: ${u.message ?? u.reason}`);
      if (u.install) {
        const status = u.install.ok
          ? `${u.install.command} exited 0 (rolled back due to post-install scan)`
          : `${u.install.command} exited ${u.install.exitCode ?? '?'}`;
        log.dim(`    install: ${status}`);
        if (u.install.lastLines) {
          const head = u.install.lastLines.split(/\r?\n/).slice(0, 6).join('\n    ');
          log.dim(`    ${head}`);
        }
      }
      if (u.validation?.lastLines) {
        const head = u.validation.lastLines.split(/\r?\n/).slice(0, 6).join('\n    ');
        log.dim(`    validator: ${u.validation.command}`);
        log.dim(`    ${head}`);
      }
    }
  }

  if (structured.preflight && !structured.preflight.ok) {
    log.info(chalk.bold('Pre-flight'));
    log.error(
      `Validator already failing on the unchanged tree: \`${structured.preflight.command}\` (exit ${structured.preflight.exitCode ?? '?'})`,
    );
  }
}
