/**
 * Shared types for dep-up-surgeon.
 */

export interface Conflict {
  depender: string;
  dependency: string;
  requiredRange: string;
  installedVersion?: string;
  attemptedVersion?: string;
  rawMessage: string;
}

export type DepSection =
  | 'dependencies'
  | 'devDependencies'
  | 'peerDependencies'
  | 'optionalDependencies';

export interface ScannedPackage {
  name: string;
  section: DepSection;
  /** Raw range from package.json */
  currentRange: string;
}

export type FailureReason =
  | 'validation'
  | 'validation-script'
  | 'validation-conflicts'
  | 'peer'
  | 'install'
  | 'skipped';

/**
 * Diagnostic about the user-defined / built-in validator command, attached to failures so the
 * user can see *why* a rollback happened without re-running.
 */
export interface ValidationDiagnostic {
  /** Exact command that was executed, e.g. `npm run build` or `tsc -p tsconfig.json --noEmit`. */
  command: string;
  /** Process exit code from the validator (undefined if it never started). */
  exitCode?: number;
  /** Last ~40 lines of stdout/stderr from the validator (already truncated). */
  lastLines?: string;
  /** Where the validator command came from. */
  source?: 'cli' | 'config' | 'package.json:test' | 'package.json:build' | 'none';
}

/**
 * Diagnostic about the install step (`<mgr> install`) executed before validation. Attached to
 * every failure entry so users can read the actual install error without re-running.
 */
export interface InstallDiagnostic {
  /** Exact command that was executed, e.g. `npm install`, `pnpm install`. */
  command: string;
  /** Process exit code from the installer (undefined if it never started). */
  exitCode?: number;
  /** Last ~40 lines of combined stdout/stderr from the installer (already truncated). */
  lastLines?: string;
  /**
   * `true` when the installer process exited 0 but the post-install conflict scan still triggered
   * a rollback (peer warnings, "Conflicting peer dependency", etc.). Useful so consumers can
   * distinguish "install crashed" from "install ok but rolled back due to conflicts".
   */
  ok?: boolean;
}

export interface UpgradeRecord {
  name: string;
  success: boolean;
  from?: string;
  to?: string;
  skipped?: boolean;
  reason?: FailureReason;
  detail?: string;
  forced?: boolean;
  /** True when `to` is not the registry `@latest` because latest failed */
  usedFallback?: boolean;
  /** Registry `latest` dist-tag at time of upgrade (for context when `usedFallback`) */
  requestedLatest?: string;
  /** When set, this row was upgraded with other packages in the same batch */
  linkedGroupId?: string;
  /**
   * Workspace member this row belongs to. `'root'` for the root `package.json`, or a workspace
   * package name (e.g. `'@org/core'`) for a child. Absent when the run targets only the root and
   * no workspace traversal was performed.
   */
  workspace?: string;
}

export interface ConflictEntry {
  name: string;
  reason: FailureReason;
  previousVersion: string;
  attemptedVersion?: string;
  message?: string;
  /** Present when the failure was a linked multi-package upgrade */
  linkedGroupId?: string;
  /** Structured conflicts parsed from npm output when available */
  conflicts?: Conflict[];
  /**
   * Workspace member this failure belongs to. Same semantics as `UpgradeRecord.workspace`.
   */
  workspace?: string;
  /**
   * Diagnostics about the validator command executed for this failure. Populated when the
   * failure category was `validation-script` or `validation-conflicts`.
   */
  validation?: ValidationDiagnostic;
  /**
   * Diagnostics about the install step that triggered (or preceded) this failure. Populated for
   * `install` and `peer` reasons, and also for `validation-script` / `validation-conflicts` so
   * users can correlate the install log with the validator outcome.
   */
  install?: InstallDiagnostic;
}

/**
 * Detected (or overridden) project shape — package manager + workspace topology. Surfaced in
 * `FinalReport.project` so JSON consumers can see what the tool keyed off without re-running
 * detection themselves.
 */
export interface ProjectInfoReport {
  manager: 'npm' | 'pnpm' | 'yarn';
  managerVersion?: string;
  managerSource: 'cli' | 'package.json:packageManager' | 'lockfile' | 'pnpm-workspace' | 'default';
  lockfile?: 'package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock';
  hasWorkspaces: boolean;
  workspaceGlobs: string[];
  workspaceMembers: Array<{ name: string; dir: string }>;
  /**
   * Detected major version of the active yarn binary (only present when manager is yarn AND
   * the project has workspaces). Useful for CI consumers asserting the expected manager flavor.
   */
  yarnMajorVersion?: number;
  /**
   * True when `yarn workspaces focus <name>` is available on the active yarn binary (i.e.
   * yarn berry v2+ AND `@yarnpkg/plugin-workspace-tools` is loaded). Drives whether
   * `--install-mode filtered` produces a focused install or falls back to the root install.
   */
  yarnSupportsFocus?: boolean;
}

export interface FinalReport {
  upgraded: UpgradeRecord[];
  failed: ConflictEntry[];
  /** Packages never touched (ignored from config/CLI) */
  ignored: string[];
  /** Aggregated parsed npm conflicts for this run */
  parsedConflicts?: Conflict[];
  /** Linked upgrade groups used for this run */
  groupPlan?: Array<{ id: string; packages: string[] }>;
  /**
   * Result of the **pre-flight** validator run (against the unchanged tree). Useful so JSON
   * consumers can tell that the project was already broken before any upgrade was attempted.
   */
  preflight?: ValidationDiagnostic & { ok: boolean; skipped: boolean };
  /**
   * Set to `true` when the run aborted early because the pre-flight validator failed and the
   * user did not pass `--force`. In that case `upgraded` and `failed` will be empty.
   */
  preflightAborted?: boolean;
  /**
   * Detected package manager + workspace topology. Workspace-internal deps (i.e. names matching
   * a local workspace package) are skipped automatically and recorded in `upgraded` with
   * `reason: 'skipped'` and `detail: 'workspace-internal dep'`.
   */
  project?: ProjectInfoReport;
  /**
   * Targets that were processed in this run. Always at least one entry. When workspace traversal
   * was disabled this is `[{ label: 'root', cwd, packageJson }]`. With `--workspaces` /
   * `--workspace <name>`, additional entries appear for each child member that was scanned.
   */
  targets?: Array<{
    label: string;
    cwd: string;
    /** Absolute path to the `package.json` that was scanned/mutated for this target. */
    packageJson: string;
  }>;
  /**
   * Workspace install strategy that was actually used for this run. `'root'` (the default) runs
   * a full install at the workspace root after each mutation; `'filtered'` rewrites per-child
   * installs to their workspace-scoped form (`npm install -w …`, `pnpm install --filter …`).
   * Yarn always falls back to `'root'`.
   */
  installMode?: 'root' | 'filtered';
  /**
   * Effective number of workspace targets traversed in parallel. `1` (the default) means
   * strict serial. Higher values mean target scan/plan phases overlapped while installs and
   * validation stayed serialized via a shared mutex. Reflects the **actual** value used, which
   * may be lower than the user-requested `--concurrency` (e.g. when downgraded from non-JSON
   * mode or capped at the target count).
   */
  concurrency?: number;
  /**
   * Git commits that were created during this run (always empty when `--git-commit` was not
   * passed). Each entry records the commit's short SHA, its message, and the repo-root-relative
   * paths that were staged. A commit attempt that failed (signing rejected, pre-commit hook,
   * etc.) is recorded with `ok: false` and `error: '<git stderr>'` so the JSON consumer can
   * surface the problem without us having to abort the whole run.
   */
  commits?: GitCommitRecord[];
  /**
   * Resolved git mode for this run (`undefined` when git integration was disabled). Useful for
   * CI consumers that want to assert the mode they expected was actually used (e.g. when the
   * config file disagrees with the CLI flag).
   */
  gitCommitMode?: 'per-success' | 'per-target' | 'all';
}

export interface GitCommitRecord {
  ok: boolean;
  /** Short SHA (`git rev-parse --short HEAD`). Absent when `ok === false`. */
  sha?: string;
  message: string;
  /** Repo-root-relative paths included in the commit. */
  files: string[];
  /** Git stderr/stdout when the commit failed. */
  error?: string;
  /** Workspace tag when the commit was scoped to a single workspace target. */
  workspace?: string;
  /** Linked-group id when this commit captured a batched group upgrade. */
  groupId?: string;
}

/** Minimal package.json shape used by the tool */
export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}
