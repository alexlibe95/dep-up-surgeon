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

export type FailureReason = 'validation' | 'peer' | 'install' | 'skipped';

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
