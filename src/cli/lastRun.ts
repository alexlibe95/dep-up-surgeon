import { createHash } from 'node:crypto';
import path from 'node:path';
import { execa } from 'execa';
import fs from 'fs-extra';
import { ROOT_LOCKFILE_NAMES } from '../core/workspaces.js';
import type { FinalReport } from '../types.js';
import type { StructuredReport } from './report.js';
import { retryIgnoreKey, splitNamespacedId } from '../utils/ignoreMatch.js';

/**
 * Directory (relative to the workspace root) holding the run report and the pre-run lockfile
 * backups. It sits in `node_modules/.cache` like the Nx / Babel / Vite caches, so a run only leaves
 * dependency changes in `git status`. Deleting `node_modules` (e.g. `npm ci`) deletes it too.
 */
export const LAST_RUN_DIR = path.join('node_modules', '.cache', 'dep-up-surgeon');

/**
 * Report written after every CLI run (unless `--no-persist-report`). Machine-readable input for
 * `undo`, `--retry-failed` and CI dashboards / bots.
 */
export const LAST_RUN_FILENAME = 'last-run.json';

/**
 * Where older versions wrote the report: the workspace root. Still read as a fallback (callers
 * warn, see {@link legacyLastRunWarning}) and deleted, when git doesn't track it, the next time a
 * report is written.
 */
export const LEGACY_LAST_RUN_FILENAME = '.dep-up-surgeon.last-run.json';

export function lastRunReportPath(cwd: string): string {
  return path.join(cwd, LAST_RUN_DIR, LAST_RUN_FILENAME);
}

export interface PersistedLastRun extends StructuredReport {
  /** ISO 8601 timestamp the report was written. */
  finishedAt: string;
  /** dep-up-surgeon version that produced the report. */
  toolVersion: string;
  /** Workspace root the run was anchored at. */
  cwd: string;
  /** True when the run was a `--dry-run` (no `package.json` was mutated). */
  dryRun: boolean;
  /** Root lockfiles the run changed, each with a backup of its pre-run bytes for `undo`. */
  lockfiles?: PersistedLockfile[];
  /**
   * Ignore keys a `--retry-failed` run froze (from the report it resumed). Carried into the next
   * `--retry-failed`, so a chain of retries keeps everything an earlier run settled frozen.
   */
  retryFrozen?: string[];
}

export interface PersistedLockfile {
  /** Lockfile name at the workspace root, e.g. `bun.lock`. */
  file: string;
  /** Backup of the pre-run bytes, relative to the workspace root. */
  backup: string;
  beforeSha256: string;
  afterSha256: string;
}

/** A root lockfile's bytes, captured before the run touches anything. */
export interface LockfileCapture {
  file: string;
  bytes: Buffer;
}

export interface PersistOptions {
  cwd: string;
  toolVersion: string;
  dryRun: boolean;
  /** Root lockfiles read before the run ({@link captureRootLockfiles}). */
  lockfilesBefore?: LockfileCapture[];
  /** `--retry-failed` only: the keys it froze (`computeRetryFailedIgnores(...).added`). */
  retryFrozen?: Iterable<string>;
}

/** Pre-run lockfile backup next to the report, relative to the workspace root. */
export function lockfileBackupName(file: string): string {
  return path.join(LAST_RUN_DIR, `last-run.${file}`);
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Read every root lockfile before the run, so `undo` can put the exact bytes back. */
export async function captureRootLockfiles(cwd: string): Promise<LockfileCapture[]> {
  const captures: LockfileCapture[] = [];
  for (const file of ROOT_LOCKFILE_NAMES) {
    const bytes = await fs.readFile(path.join(cwd, file)).catch(() => null);
    if (bytes) {
      captures.push({ file, bytes });
    }
  }
  return captures;
}

/**
 * Write the structured report to `<cwd>/node_modules/.cache/dep-up-surgeon/last-run.json`. Failures are swallowed
 * (best-effort): a missing report file should never break the actual upgrade run.
 */
export async function persistLastRunReport(
  structured: StructuredReport,
  opts: PersistOptions,
): Promise<string | undefined> {
  // A pre-flight abort changed nothing. Writing it would overwrite the record of the last run that
  // did change package.json, leaving `undo` / `--retry-failed` unable to reach it.
  if (structured.preflightAborted) {
    return undefined;
  }
  const file = lastRunReportPath(opts.cwd);
  try {
    await fs.ensureDir(path.dirname(file));
    // Keeps git away from the run state even where `node_modules` itself isn't ignored.
    const ignore = path.join(path.dirname(file), '.gitignore');
    if (!(await fs.pathExists(ignore))) {
      await fs.writeFile(ignore, '*\n', 'utf8');
    }
  } catch {
    return undefined;
  }
  const lockfiles = await backUpChangedLockfiles(opts);
  const retryFrozen = [...(opts.retryFrozen ?? [])];
  const payload: PersistedLastRun = {
    ...structured,
    finishedAt: new Date().toISOString(),
    toolVersion: opts.toolVersion,
    cwd: opts.cwd,
    dryRun: opts.dryRun,
    ...(lockfiles.length > 0 ? { lockfiles } : {}),
    ...(retryFrozen.length > 0 ? { retryFrozen } : {}),
  };
  try {
    await fs.writeFile(file, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch {
    return undefined;
  }
  // The root report would otherwise keep being the fallback once the cache is wiped (`npm ci`),
  // letting `undo` replay a run far older than this one.
  await removeLegacyRunState(opts.cwd);
  return file;
}

/**
 * Delete the run state older versions kept in the project root (the report and any
 * `.dep-up-surgeon.last-run.<lockfile>` backups), unless git tracks the file. Best-effort.
 */
async function removeLegacyRunState(cwd: string): Promise<void> {
  const names = [
    LEGACY_LAST_RUN_FILENAME,
    ...ROOT_LOCKFILE_NAMES.map((lock) => `.dep-up-surgeon.last-run.${lock}`),
  ];
  for (const name of names) {
    const file = path.join(cwd, name);
    if (!(await fs.pathExists(file)) || (await maybeTrackedByGit(cwd, name))) {
      continue;
    }
    await fs.remove(file).catch(() => undefined);
  }
}

/** False only when git says the file is untracked, or `cwd` isn't a git repo at all. */
async function maybeTrackedByGit(cwd: string, name: string): Promise<boolean> {
  const r = await execa('git', ['ls-files', '--error-unmatch', '--', name], { cwd, reject: false });
  if (r.exitCode === 1) return false;
  if (r.exitCode === 128 && /not a git repository/i.test(String(r.stderr))) return false;
  // Tracked (exit 0), or git missing / failing: keep the file.
  return true;
}

/**
 * Write the pre-run bytes of every lockfile the run changed. Reinstalling from the reverted
 * package.json can't undo those on its own: `^16.3.1` still allows the `16.3.5` the run
 * installed. A lockfile the run left alone gets no backup (and loses a stale one from an older run).
 */
async function backUpChangedLockfiles(opts: PersistOptions): Promise<PersistedLockfile[]> {
  const lockfiles: PersistedLockfile[] = [];
  for (const before of opts.lockfilesBefore ?? []) {
    const backup = lockfileBackupName(before.file);
    const backupPath = path.join(opts.cwd, backup);
    const after = await fs.readFile(path.join(opts.cwd, before.file)).catch(() => null);
    try {
      if (!after || after.equals(before.bytes)) {
        await fs.remove(backupPath);
        continue;
      }
      await fs.writeFile(backupPath, before.bytes);
    } catch {
      continue;
    }
    lockfiles.push({
      file: before.file,
      backup,
      beforeSha256: sha256(before.bytes),
      afterSha256: sha256(after),
    });
  }
  return lockfiles;
}

/** A run report together with where it was read from. */
export interface LoadedLastRun {
  report: PersistedLastRun;
  /** Absolute path of the file that was read. */
  file: string;
  /**
   * True when the cache report was missing and an older version's project-root report
   * ({@link LEGACY_LAST_RUN_FILENAME}) was read instead. Callers should print
   * {@link legacyLastRunWarning}: that file can be months older than the last run.
   */
  legacy: boolean;
}

/**
 * Find the run report: `node_modules/.cache/dep-up-surgeon/last-run.json`, else the legacy root
 * report. `undefined` when neither exists, or the first one found doesn't parse.
 */
export async function findLastRunReport(cwd: string): Promise<LoadedLastRun | undefined> {
  const candidates = [
    { file: lastRunReportPath(cwd), legacy: false },
    { file: path.join(cwd, LEGACY_LAST_RUN_FILENAME), legacy: true },
  ];
  for (const { file, legacy } of candidates) {
    if (!(await fs.pathExists(file))) {
      continue;
    }
    try {
      return { report: (await fs.readJson(file)) as PersistedLastRun, file, legacy };
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export async function loadLastRunReport(cwd: string): Promise<PersistedLastRun | undefined> {
  return (await findLastRunReport(cwd))?.report;
}

/** Warning for a report read from the legacy root location; `undefined` for any other report. */
export function legacyLastRunWarning(loaded: LoadedLastRun): string | undefined {
  if (!loaded.legacy) {
    return undefined;
  }
  const { finishedAt, toolVersion } = loaded.report;
  return (
    `${path.join(LAST_RUN_DIR, LAST_RUN_FILENAME)} is missing, so ${loaded.file} is used instead: ` +
    `a report an older dep-up-surgeon wrote (finished ${finishedAt ?? 'at an unknown time'}, ` +
    `dep-up-surgeon ${toolVersion ?? 'unknown'}). It may describe a much older run than your last one; ` +
    'delete it if it does.'
  );
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
  /** Keys the last run (itself a `--retry-failed`) had frozen, carried over into `added`. */
  carriedOver: number;
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
 *
 * When the last run was itself a `--retry-failed`, the keys it froze (`retryFrozen`) stay
 * frozen: they are absent from its rows, so they would otherwise be attempted again.
 */
export function computeRetryFailedIgnores(last: PersistedLastRun): RetryComputation {
  const added = new Set<string>(Array.isArray(last.retryFrozen) ? last.retryFrozen.map(String) : []);
  const carriedOver = added.size;
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

  return { added, succeededLastRun, terminalFailuresLastRun, retryableLastRun, carriedOver };
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
