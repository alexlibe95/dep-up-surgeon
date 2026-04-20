/**
 * Human + JSON renderers for `DoctorReport`.
 *
 * The human renderer is intentionally simple: one line per check with a colored status glyph,
 * an indented `hint:` on non-green checks, and a one-line summary footer. No tables, no fancy
 * boxes — the output stays readable when piped to a log aggregator or grepped in CI.
 */
import chalk from 'chalk';
import type { DoctorReport, DoctorStatus, DoctorCheck } from './doctor.js';

/** Single-char badges used both in the human output and in the status summary. */
const BADGES: Record<DoctorStatus, string> = {
  green: '✓',
  yellow: '!',
  red: '✗',
};

function colorFor(status: DoctorStatus): (s: string) => string {
  switch (status) {
    case 'green':
      return chalk.green;
    case 'yellow':
      return chalk.yellow;
    case 'red':
      return chalk.red;
  }
}

/**
 * Render the human-readable report to a plain string. Called by the CLI when NOT in `--json`
 * mode. The renderer is pure — chalk's color codes disappear when `FORCE_COLOR=0` or when
 * the output is piped to a non-TTY, so the same function works for terminals and for CI logs.
 */
export function renderDoctorHuman(report: DoctorReport): string {
  const out: string[] = [];
  out.push(chalk.bold('dep-up-surgeon doctor') + chalk.dim(` (v${report.toolVersion})`));
  out.push(chalk.dim(`  in ${report.cwd}`));
  out.push('');
  for (const check of report.checks) {
    out.push(formatCheckLine(check));
    if (check.hint && check.status !== 'green') {
      out.push(chalk.dim(`     hint: ${check.hint}`));
    }
  }
  out.push('');
  out.push(formatFooter(report));
  return out.join('\n');
}

function formatCheckLine(c: DoctorCheck): string {
  const badge = colorFor(c.status)(BADGES[c.status]);
  const label = chalk.bold(c.label.padEnd(22));
  return `  ${badge}  ${label} ${c.message}`;
}

function formatFooter(report: DoctorReport): string {
  const c = report.counts;
  const parts: string[] = [
    chalk.green(`${c.green} green`),
    chalk.yellow(`${c.yellow} yellow`),
    chalk.red(`${c.red} red`),
  ];
  const summary = colorFor(report.overall)(
    `overall: ${report.overall.toUpperCase()}`,
  );
  return `  ${summary}  (${parts.join(', ')})`;
}

/**
 * Exit-code mapping.
 *
 *   - `green` → `0` (all checks passed)
 *   - `yellow` → `0` normally, `1` when `strict` (so CI pre-checks can gate on warnings)
 *   - `red` → `2`
 *
 * Exit 1 is reserved for "soft" failures (non-red warnings under strict), exit 2 for "hard"
 * failures (at least one red check). This mirrors the convention used by `eslint --strict`
 * and `shellcheck -S warning -s` so downstream CI scripts can reuse existing exit-code
 * handling.
 */
export function doctorExitCode(report: DoctorReport, strict: boolean): number {
  if (report.overall === 'red') return 2;
  if (report.overall === 'yellow' && strict) return 1;
  return 0;
}
