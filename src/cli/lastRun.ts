import path from 'node:path';
import fs from 'fs-extra';
import type { FinalReport } from '../types.js';
import type { StructuredReport } from './report.js';

/**
 * Filename written next to the workspace root after every CLI run (unless `--no-persist-report`).
 * Designed to be machine-readable input for `--retry-failed` and for CI dashboards / bots.
 */
export const LAST_RUN_FILENAME = '.dep-up-surgeon.last-run.json';

export interface PersistedLastRun extends StructuredReport {
  /** ISO 8601 timestamp the report was written. */
  finishedAt: string;
  /** dep-up-surgeon version that produced the report. */
  toolVersion: string;
  /** Workspace root the run was anchored at. */
  cwd: string;
  /** True when the run was a `--dry-run` (no `package.json` was mutated). */
  dryRun: boolean;
}

export interface PersistOptions {
  cwd: string;
  toolVersion: string;
  dryRun: boolean;
}

/**
 * Write the structured report to `<cwd>/.dep-up-surgeon.last-run.json`. Failures are swallowed
 * (best-effort): a missing report file should never break the actual upgrade run.
 */
export async function persistLastRunReport(
  structured: StructuredReport,
  opts: PersistOptions,
): Promise<string | undefined> {
  const file = path.join(opts.cwd, LAST_RUN_FILENAME);
  const payload: PersistedLastRun = {
    ...structured,
    finishedAt: new Date().toISOString(),
    toolVersion: opts.toolVersion,
    cwd: opts.cwd,
    dryRun: opts.dryRun,
  };
  try {
    await fs.writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    return file;
  } catch {
    return undefined;
  }
}

export async function loadLastRunReport(cwd: string): Promise<PersistedLastRun | undefined> {
  const file = path.join(cwd, LAST_RUN_FILENAME);
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
 * Failure reasons that `--retry-failed` treats as **terminal** — i.e. retrying is unlikely to
 * help because the cause is not transient and not driven by other dependency moves we might
 * make this run.
 *
 *   - `peer`: an actual peer dependency conflict; bumping the same package alone almost always
 *     produces the same conflict.
 *   - `validation-script`: the project's own test/build script crashed, not a dep conflict;
 *     re-running it without fixing the script will hit the same crash.
 */
export const TERMINAL_RETRY_REASONS = new Set(['peer', 'validation-script']);

export interface RetryComputation {
  /** Names that should be **added** to the ignore set on the retry run. */
  added: Set<string>;
  /** Stats for human/JSON logs. */
  succeededLastRun: number;
  terminalFailuresLastRun: number;
  retryableLastRun: string[];
}

/**
 * Build the auto-ignore set for `--retry-failed` from a previous run's report.
 *
 * The new run will reattempt only entries that **failed for a non-terminal reason** (`install`,
 * `validation-conflicts`, `versions`, `unknown`, …) — typically the cases where another
 * dependency move during the same run could unblock them. Successful upgrades are skipped (no
 * point re-doing work) and terminal failures (peer / validation-script) are skipped (re-running
 * won't help without a code change).
 *
 * Group failures (`name === '[group:<id>]'`) are expanded to the group's member packages via
 * the persisted `groups` field, so freezing a group correctly freezes every package in it.
 */
export function computeRetryFailedIgnores(last: PersistedLastRun): RetryComputation {
  const added = new Set<string>();
  let succeededLastRun = 0;
  let terminalFailuresLastRun = 0;
  const retryableLastRun: string[] = [];

  for (const row of last.upgraded) {
    if (row.success && !row.skipped && row.name) {
      added.add(row.name);
      succeededLastRun++;
    }
  }

  const groupsByLabel = new Map<string, string[]>();
  for (const g of last.groups ?? []) {
    groupsByLabel.set(g.id, g.packages);
    // group ids may be namespaced as `<workspace>::<id>` when traversing multiple targets;
    // also map the bare id so `[group:<id>]` keys still resolve.
    const colon = g.id.indexOf('::');
    if (colon >= 0) {
      groupsByLabel.set(g.id.slice(colon + 2), g.packages);
    }
  }

  for (const f of last.failed ?? []) {
    const groupMembers = extractGroupMembers(f.name, groupsByLabel);
    if (TERMINAL_RETRY_REASONS.has(f.reason)) {
      if (groupMembers) {
        for (const m of groupMembers) {
          added.add(m);
        }
      } else if (f.name) {
        added.add(f.name);
      }
      terminalFailuresLastRun++;
    } else {
      // Retryable. Don't ignore — let it run again. Just remember its label for logs.
      retryableLastRun.push(f.name);
    }
  }

  return { added, succeededLastRun, terminalFailuresLastRun, retryableLastRun };
}

function extractGroupMembers(
  name: string,
  groupsByLabel: Map<string, string[]>,
): string[] | undefined {
  const m = /^\[group:(.+)\]$/.exec(name);
  if (!m) {
    return undefined;
  }
  return groupsByLabel.get(m[1]!);
}
