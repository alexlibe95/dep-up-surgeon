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
  | 'policy'
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
  /**
   * Optional changelog excerpt for the `from → to` transition, populated when `--changelog` is
   * active (default when `--git-commit` or `--summary` is set). Sourced from GitHub Releases
   * when we can resolve the repo URL from the published manifest, otherwise from `CHANGELOG.md`
   * extracted from the package tarball. Never present when the fetch failed / was disabled.
   */
  changelog?: {
    source: 'github-release' | 'changelog.md';
    url?: string;
    body: string;
    /**
     * Non-empty when `scanForBreakingChanges` matched BREAKING markers inside `body`. Used by
     * the summary + PR body to render a prominent warning and by downstream CI bots that want
     * to auto-require reviews on breaking bumps. Never affects the engine — the upgrade still
     * goes through; this is pure reviewer signal.
     */
    breaking?: {
      hasBreaking: boolean;
      matchedLines: string[];
      reasons: string[];
    };
  };
  /**
   * Optional security metadata attached by `--security-only` mode. When set, this upgrade was
   * chosen because the installed version has a known vulnerability per `<manager> audit`.
   */
  security?: {
    severity: 'low' | 'moderate' | 'high' | 'critical';
    /** Whichever of `CVE-...` / `GHSA-...` / advisory URL the manager returned. */
    ids: string[];
    /** First non-empty advisory URL we could find (GitHub Advisory or npm advisory). */
    url?: string;
    /** Semver range of versions known to be vulnerable (e.g. `"<1.2.3"`). */
    vulnerableRange?: string;
    /** First safe version per the audit data (may differ from the registry `latest`). */
    recommendedVersion?: string;
    /** Short human-readable title (usually the advisory's own title). */
    title?: string;
  };
  /**
   * Optional "blast radius" information — a best-effort list of project source files that
   * import this package directly. Populated by `src/utils/blastRadius.ts` when `--blast-radius`
   * (the default when `--summary` is active) is on. `files` is the first N paths found and
   * `total` counts every match even beyond that cap.
   */
  blastRadius?: {
    total: number;
    truncated: boolean;
    files: string[];
  };
  /**
   * Optional peer-range intersection resolver breadcrumb. Populated ONLY when a linked-group
   * bump originally failed with a peer conflict, the resolver (`src/core/peerResolver.ts`)
   * found a satisfiable version tuple, and the retried batch install + validation PASSED.
   *
   * `originalTarget` is the version the engine first tried (usually registry `latest`);
   * `to` on the parent record holds the finally-installed version. When `originalTarget ===
   * to` the row is not technically "downgraded" — that package just went along for the ride
   * while another group member was nudged off latest.
   *
   * The field is reviewer signal only; it never changes engine control flow. Summary,
   * commit body, and JSON all render it so humans can see why a package isn't at latest.
   */
  resolvedPeer?: {
    originalTarget: string;
    reason: string;
    tuplesExplored: number;
  };
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
  /**
   * Summary of which policy rules fired during this run. Populated when a
   * `.dep-up-surgeon.policy.{yaml,json}` file is present, regardless of whether any rule
   * actually matched. Empty arrays are OK and mean the file was valid but didn't apply.
   */
  policy?: PolicyReport;
  /**
   * Result of the post-run `--open-pr` attempt. Present only when `--git-commit --git-branch
   * --open-pr` was passed and the branch had at least one commit to push. The provider-specific
   * CLI (`gh` for GitHub today; `glab` for GitLab is a future extension) runs after all
   * commits have landed and its outcome is recorded here — never fatal, so a missing `gh`
   * binary or a `gh auth` failure degrades to `{ ok: false, error: '...' }` instead of
   * aborting the upgrade run the user has already paid for.
   */
  /**
   * Result of the `--apply-overrides` post-run step. Every advisory we considered is recorded
   * here — including skips (already-safe pins) and rollbacks — so JSON consumers can render
   * the full decision trail. Empty / undefined means the step was disabled.
   */
  overrides?: {
    /** Which field we wrote to: `overrides`, `pnpm.overrides`, or `resolutions`. */
    field: 'overrides' | 'pnpm.overrides' | 'resolutions';
    /** Ordered list of per-advisory attempts. */
    attempts: Array<{
      name: string;
      severity: 'low' | 'moderate' | 'high' | 'critical';
      ids: string[];
      url?: string;
      title?: string;
      applied?: string;
      previous?: string;
      ok: boolean;
      skipped: boolean;
      reason?: string;
      installLog?: string;
      rolledBack?: boolean;
    }>;
  };
  pullRequest?: {
    ok: boolean;
    provider: 'github' | 'gitlab';
    /** Repo-relative slug as reported by the provider CLI (e.g. `owner/repo`). */
    repo?: string;
    /** Resolved PR number when creation succeeded. */
    number?: number;
    /** PR URL when creation succeeded. */
    url?: string;
    /** Source branch we pushed + opened the PR from. */
    branch?: string;
    /** Target base branch (usually `main` / `master`; resolved via `gh repo view`). */
    base?: string;
    /** True when `--open-pr-draft` was set or the provider defaulted to draft. */
    draft?: boolean;
    /** When the PR already existed for this branch, we reuse it and flip this to true. */
    reused?: boolean;
    /** Human-readable error when `ok === false`. */
    error?: string;
  };
  /**
   * Result of the `--fix-lockfile` pass (only present when the flag was passed). See
   * `src/cli/lockfileFix.ts` for the orchestration semantics.
   */
  lockfileFix?: LockfileFixReport;
}

/**
 * Per-package diff entry emitted by `diffLockfileTrees`. `before` / `after` are the sorted
 * (oldest → newest) lists of concrete versions installed before / after the dedupe command.
 */
export interface LockfileDedupeChange {
  name: string;
  change: 'merged' | 'updated' | 'added' | 'removed';
  before: string[];
  after: string[];
}

/**
 * Per-package entry emitted by the stale-transitive scan. Only packages whose HIGHEST
 * installed version is more than one minor OR one full major behind `latest` are included.
 */
export interface LockfileStaleEntry {
  name: string;
  installed: string[];
  latest: string;
  majorBehind: number;
  minorBehind: number;
}

/**
 * Full result of the `--fix-lockfile` pass. `status: 'skipped'` means we didn't run dedupe
 * (e.g. no lockfile, yarn classic has no dedupe command); `status: 'failed'` means dedupe
 * or the post-dedupe validator failed and the lockfile was restored from backup; `status:
 * 'ok'` means dedupe ran clean and the validator was happy with the result.
 */
export interface LockfileFixReport {
  status: 'ok' | 'failed' | 'skipped' | 'dry-run';
  manager: 'npm' | 'pnpm' | 'yarn';
  lockfile: 'package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock';
  /** Present when `status !== 'skipped'`. */
  command?: string;
  /** Exit code from the dedupe command (0 for ok, non-zero for failed dedupe). */
  exitCode?: number;
  /** Populated when `status === 'failed'` so consumers can branch on the cause. */
  failureKind?: 'dedupe' | 'validation';
  /** Validator command that rejected the deduped tree (when `failureKind === 'validation'`). */
  validatorCommand?: string;
  /** Last N lines of the dedupe or validator output — for the `--summary` diagnostic panel. */
  lastLines?: string;
  /** Reason the pass was skipped. Only present when `status === 'skipped'`. */
  skipReason?: 'no-lockfile' | 'unsupported';
  /** Per-package diff of the lockfile's concrete versions before vs after dedupe. */
  dedupeChanges: LockfileDedupeChange[];
  /**
   * Transitives whose highest installed version is well behind registry `latest`. Purely
   * informational — this pass does NOT act on them (that's what `--security-only` +
   * `--apply-overrides` does for the vulnerable subset).
   */
  stale: LockfileStaleEntry[];
}

export interface PolicyReport {
  /** Basename of the loaded file (e.g. `.dep-up-surgeon.policy.yaml`). Absent when no file. */
  sourceFile?: string;
  /** Number of each rule kind that was loaded from the file. */
  counts: {
    freeze: number;
    maxVersion: number;
    allowMajorAfter: number;
  };
  /** Packages that were filtered out by `freeze` (by exact match OR wildcard). */
  frozen: { name: string; pattern: string; reason?: string }[];
  /** Packages whose target was capped / whose majors were blocked this run. */
  applied: { name: string; rule: 'maxVersion' | 'allowMajorAfter'; detail: string }[];
  /** `requireReviewers` as loaded — purely metadata for downstream PR senders. */
  requireReviewers?: Partial<Record<'major' | 'minor' | 'patch', number>>;
  /** `autoMerge` as loaded — purely metadata for downstream PR senders. */
  autoMerge?: {
    major?: boolean;
    minor?: boolean;
    patch?: boolean;
    include?: string[];
  };
  /** Non-fatal parse warnings collected while loading the policy file. */
  warnings: string[];
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
