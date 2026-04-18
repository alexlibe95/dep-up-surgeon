/**
 * Glue that turns the engine's `onUpgradeApplied` callback into actual git commits, in any of
 * the three supported modes (`per-success` / `per-target` / `all`).
 *
 * The orchestrator owns the lifecycle:
 *   - `createGitFlow(...)` runs the pre-flight (clean tree? branch?) and returns either an
 *     `enabled: true` controller (with a callback to wire into `runUpgradeFlow`) or a
 *     disabled placeholder so the CLI doesn't have to special-case "git off".
 *   - `controller.onUpgradeApplied` is passed straight through to the engine option of the
 *     same name. In per-success mode it commits inline; in per-target / all it just buffers
 *     UpgradeChange records keyed by workspace.
 *   - `controller.flushAfterTarget(workspace, manager, installCwd)` is called between targets
 *     so per-target mode emits its commit BEFORE the next target's install starts.
 *   - `controller.flushAtEnd(manager, installCwd)` is called once after the whole run for
 *     `all` mode (and also acts as a safety net for per-target).
 *
 * Every commit attempt — successful or not — is appended to `controller.commits`, which the
 * CLI stamps onto the structured report so JSON consumers / CI summaries can see exactly what
 * was committed (and what failed and why).
 */
import path from 'node:path';
import type { PackageManager } from '../core/workspaces.js';
import type { GitCommitRecord } from '../types.js';
import type { UpgradeAppliedEvent } from '../core/upgrader.js';
import { log } from '../utils/logger.js';
import {
  formatAllInOneMessage,
  formatPerSuccessMessage,
  formatPerTargetMessage,
  getUncommittedFiles,
  gitAdd,
  gitCommit,
  isGitRepo,
  lockfileBasenameFor,
  type GitCommitMode,
  type UpgradeChange,
} from './git.js';

export interface GitFlowConfig {
  enabled: boolean;
  mode: GitCommitMode;
  prefix: string;
  sign: boolean;
  allowDirty: boolean;
  branch?: string;
}

export interface GitFlowController {
  enabled: boolean;
  mode?: GitCommitMode;
  /** Engine callback (no-op when disabled). Pass straight to `runUpgradeFlow`. */
  onUpgradeApplied?: (ev: UpgradeAppliedEvent) => Promise<void>;
  /** Call after each target's engine pass (per-target mode commits here). */
  flushAfterTarget(workspace: string, manager: PackageManager, installCwd: string): Promise<void>;
  /** Call once after the whole flow (all mode commits here; safety net for the others). */
  flushAtEnd(manager: PackageManager, installCwd: string): Promise<void>;
  /** Accumulated commit records (for the structured report). */
  commits: GitCommitRecord[];
}

const NOOP_CONTROLLER: GitFlowController = {
  enabled: false,
  commits: [],
  async onUpgradeApplied() {
    /* no-op */
  },
  async flushAfterTarget() {
    /* no-op */
  },
  async flushAtEnd() {
    /* no-op */
  },
};

/**
 * Result of `createGitFlow`. When `ok === false` the CLI prints `error` and aborts before any
 * upgrade work happens — git pre-flight failures are FATAL because they indicate the user
 * misconfigured the run (asked for git but isn't in a repo, dirty tree, etc.) and silently
 * skipping git would surprise them.
 */
export type GitFlowSetupResult =
  | { ok: true; controller: GitFlowController }
  | { ok: false; error: string };

/**
 * Pre-flight + controller construction. `cwd` is the workspace root (where the lockfile and
 * the .git/ are expected to live). Returns a disabled controller when `config.enabled` is
 * false — that lets the CLI use the same wiring path either way.
 */
export async function createGitFlow(
  cwd: string,
  config: GitFlowConfig,
  jsonOutput: boolean,
  dryRun: boolean,
): Promise<GitFlowSetupResult> {
  if (!config.enabled) {
    return { ok: true, controller: NOOP_CONTROLLER };
  }

  if (dryRun) {
    if (!jsonOutput) {
      log.warn('--dry-run: skipping --git-commit (no upgrades will actually happen).');
    }
    return { ok: true, controller: NOOP_CONTROLLER };
  }

  if (!(await isGitRepo(cwd))) {
    return {
      ok: false,
      error: `--git-commit was set but ${cwd} is not inside a git working tree. Run inside a git repo or drop the flag.`,
    };
  }

  if (!config.allowDirty) {
    const dirty = await getUncommittedFiles(cwd);
    if (dirty.length > 0) {
      const sample = dirty.slice(0, 5).join(', ');
      const more = dirty.length > 5 ? ` (+${dirty.length - 5} more)` : '';
      return {
        ok: false,
        error:
          `--git-commit refused: working tree is dirty (${dirty.length} file${dirty.length === 1 ? '' : 's'}: ${sample}${more}). ` +
          'Commit or stash your changes first, or pass --git-allow-dirty to bypass (we still only stage files we touched).',
      };
    }
  }

  const prefix = config.prefix;
  const sign = config.sign;
  const mode = config.mode;

  // Per-workspace buffer of changes that have been applied but not yet committed. Keys are
  // workspace labels ('root' or member name). Used by per-target (flushed each target) and
  // 'all' (flushed once at the end).
  const buffered = new Map<string, UpgradeChange[]>();
  const commits: GitCommitRecord[] = [];

  const stageFilesForTarget = (
    targetCwd: string,
    installCwd: string,
    manager: PackageManager,
  ): string[] => {
    return [
      path.join(targetCwd, 'package.json'),
      path.join(installCwd, lockfileBasenameFor(manager)),
    ];
  };

  const recordCommit = async (
    cwdForGit: string,
    files: string[],
    message: string,
    workspace: string | undefined,
    groupId: string | undefined,
  ): Promise<void> => {
    let staged: string[] = [];
    try {
      staged = await gitAdd({ cwd: cwdForGit, sign }, files);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const rec: GitCommitRecord = { ok: false, message, files: [], error: msg };
      if (workspace) rec.workspace = workspace;
      if (groupId) rec.groupId = groupId;
      commits.push(rec);
      if (!jsonOutput) {
        log.warn(`git: failed to stage files for "${firstLine(message)}" — ${msg}`);
      }
      return;
    }

    const result = await gitCommit({ cwd: cwdForGit, sign }, message, staged);
    const record: GitCommitRecord = {
      ok: result.ok,
      sha: result.sha,
      message: result.message,
      files: result.files,
      error: result.error,
    };
    if (workspace) record.workspace = workspace;
    if (groupId) record.groupId = groupId;
    commits.push(record);

    if (!jsonOutput) {
      if (result.ok && result.sha) {
        log.success(`git: ${result.sha} ${firstLine(result.message)}`);
      } else if (!result.ok) {
        log.warn(`git: commit refused — ${result.error ?? 'unknown error'}`);
      }
    }
  };

  const onUpgradeApplied = async (ev: UpgradeAppliedEvent): Promise<void> => {
    const ws = ev.workspace ?? 'root';
    const changes: UpgradeChange[] = ev.records.map((r) => ({
      name: r.name,
      from: r.from ?? '?',
      to: r.to ?? '?',
      workspace: ws,
      groupId: ev.groupId,
    }));

    if (mode === 'per-success') {
      const message = formatPerSuccessMessage(prefix, changes);
      const files = stageFilesForTarget(ev.targetCwd, ev.installCwd, ev.manager);
      await recordCommit(ev.installCwd, files, message, ws, ev.groupId);
      return;
    }

    // per-target / all: buffer for later flush.
    const list = buffered.get(ws) ?? [];
    list.push(...changes);
    buffered.set(ws, list);
  };

  const flushAfterTarget = async (
    workspace: string,
    manager: PackageManager,
    installCwd: string,
  ): Promise<void> => {
    if (mode !== 'per-target') return;
    const list = buffered.get(workspace);
    if (!list || list.length === 0) return;
    buffered.delete(workspace);

    const message = formatPerTargetMessage(prefix, workspace, list);
    // For per-target the targetCwd MAY equal installCwd (root) or be a child workspace dir.
    // We use the FIRST change's `workspace` to find the right package.json — but the engine
    // already gave us `installCwd`. The per-child package.json is at the child's cwd, which
    // we don't have here directly. The engine's events ARE accumulated per workspace, so
    // we know exactly one targetCwd applied per buffer entry. We re-derive from the buffer's
    // associated targetCwd by capturing it on flush.
    //
    // Simpler approach: stage `installCwd/<member-package-relative>/package.json` if member,
    // else `installCwd/package.json`. The orchestrator will tell us the cwd.
    //
    // But we don't have the per-target cwd here. Add a per-workspace cwd map.
    const cwdsForTarget = bufferedCwds.get(workspace) ?? [installCwd];
    bufferedCwds.delete(workspace);
    const files = new Set<string>();
    for (const tcwd of cwdsForTarget) {
      files.add(path.join(tcwd, 'package.json'));
    }
    files.add(path.join(installCwd, lockfileBasenameFor(manager)));
    await recordCommit(installCwd, [...files], message, workspace, undefined);
  };

  const flushAtEnd = async (manager: PackageManager, installCwd: string): Promise<void> => {
    if (mode !== 'all') {
      // For per-target flushAtEnd is a no-op (each target already committed), and per-success
      // also leaves nothing buffered.
      return;
    }
    const allChanges: UpgradeChange[] = [];
    const cwds = new Set<string>();
    for (const [, list] of buffered) {
      allChanges.push(...list);
    }
    for (const [, dirs] of bufferedCwds) {
      for (const d of dirs) cwds.add(d);
    }
    buffered.clear();
    bufferedCwds.clear();
    if (allChanges.length === 0) return;

    const message = formatAllInOneMessage(prefix, allChanges);
    const files = new Set<string>();
    for (const c of cwds) files.add(path.join(c, 'package.json'));
    files.add(path.join(installCwd, lockfileBasenameFor(manager)));
    await recordCommit(installCwd, [...files], message, undefined, undefined);
  };

  // Track the targetCwd seen for each workspace so per-target / all know which package.json
  // files to stage. (A workspace label always maps to one and only one targetCwd within a run.)
  const bufferedCwds = new Map<string, Set<string>>();
  const wrappedOnApplied = async (ev: UpgradeAppliedEvent): Promise<void> => {
    if (mode !== 'per-success') {
      const ws = ev.workspace ?? 'root';
      const set = bufferedCwds.get(ws) ?? new Set<string>();
      set.add(ev.targetCwd);
      bufferedCwds.set(ws, set);
    }
    await onUpgradeApplied(ev);
  };

  return {
    ok: true,
    controller: {
      enabled: true,
      mode,
      onUpgradeApplied: wrappedOnApplied,
      flushAfterTarget,
      flushAtEnd,
      commits,
    },
  };
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}
