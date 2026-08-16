import path from 'node:path';
import fs from 'fs-extra';
import type { FinalReport } from '../types.js';
import type { StructuredReport } from './report.js';
import { retryIgnoreKey, splitNamespacedId } from '../utils/ignoreMatch.js';

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
  /**
   * Keys that should be **added** to the ignore set on the retry run.
   * Workspace-tagged rows use `workspace::name`; rows from root-only / older reports stay
   * bare package names (which still freeze the name in every workspace).
   */
  added: Set<string>;
  /** Stats for human/JSON logs. */
  succeededLastRun: number;
  terminalFailuresLastRun: number;
  retryableLastRun: string[];
}

interface GroupIndexEntry {
  packages: string[];
  workspace?: string;
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
 * Keys are **per workspace** (`workspace::name`) when the last-run row recorded a workspace
 * label. A success or terminal failure in `@org/web` therefore does not freeze the same
 * package name in `@org/api`. Bare `--ignore` / rc entries are unaffected — they remain
 * global. Rows without `workspace` (root-only runs, older reports) still emit a bare name.
 *
 * Group failures (`name === '[group:<id>]'`) are expanded to the group's member packages via
 * the persisted `groups` field, so freezing a group correctly freezes every package in it
 * — scoped to the workspace that owned the group when that can be recovered.
 */
export function computeRetryFailedIgnores(last: PersistedLastRun): RetryComputation {
  const added = new Set<string>();
  let succeededLastRun = 0;
  let terminalFailuresLastRun = 0;
  const retryableLastRun: string[] = [];

  for (const row of last.upgraded) {
    if (row.success && !row.skipped && row.name) {
      added.add(retryIgnoreKey(row.workspace, row.name));
      succeededLastRun++;
    }
  }

  const { byId, byBareId } = indexPersistedGroups(last.groups ?? []);

  for (const f of last.failed ?? []) {
    const groupRef = extractGroupRef(f.name);
    if (TERMINAL_RETRY_REASONS.has(f.reason)) {
      if (groupRef) {
        const resolved = resolveGroupMembers(groupRef, f.workspace, f.linkedGroupId, byId, byBareId);
        if (resolved.length > 0) {
          for (const entry of resolved) {
            const ws = f.workspace ?? entry.workspace;
            for (const m of entry.packages) {
              added.add(retryIgnoreKey(ws, m));
            }
          }
        } else if (f.name) {
          added.add(retryIgnoreKey(f.workspace, f.name));
        }
      } else if (f.name) {
        added.add(retryIgnoreKey(f.workspace, f.name));
      }
      terminalFailuresLastRun++;
    } else {
      // Retryable. Don't ignore — let it run again. Just remember its label for logs.
      retryableLastRun.push(f.name);
    }
  }

  return { added, succeededLastRun, terminalFailuresLastRun, retryableLastRun };
}

function indexPersistedGroups(
  groups: Array<{ id: string; packages: string[] }>,
): { byId: Map<string, GroupIndexEntry>; byBareId: Map<string, GroupIndexEntry[]> } {
  const byId = new Map<string, GroupIndexEntry>();
  const byBareId = new Map<string, GroupIndexEntry[]>();
  for (const g of groups) {
    const { workspace, bare } = splitNamespacedId(g.id);
    const entry: GroupIndexEntry = { packages: g.packages, workspace };
    byId.set(g.id, entry);
    const list = byBareId.get(bare) ?? [];
    list.push(entry);
    byBareId.set(bare, list);
  }
  return { byId, byBareId };
}

function extractGroupRef(name: string): string | undefined {
  const m = /^\[group:(.+)\]$/.exec(name);
  return m?.[1];
}

function resolveGroupMembers(
  groupRef: string,
  failureWorkspace: string | undefined,
  linkedGroupId: string | undefined,
  byId: Map<string, GroupIndexEntry>,
  byBareId: Map<string, GroupIndexEntry[]>,
): GroupIndexEntry[] {
  if (failureWorkspace) {
    const namespaced = byId.get(`${failureWorkspace}::${groupRef}`);
    if (namespaced) {
      return [namespaced];
    }
  }
  if (linkedGroupId) {
    const byLinked = byId.get(linkedGroupId);
    if (byLinked) {
      return [byLinked];
    }
  }
  const exact = byId.get(groupRef);
  if (exact) {
    return [exact];
  }
  return byBareId.get(groupRef) ?? [];
}
