/**
 * Shared types for dep-up-surgeon.
 */

export type DepSection = 'dependencies' | 'devDependencies';

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
}

export interface ConflictEntry {
  name: string;
  reason: FailureReason;
  previousVersion: string;
  attemptedVersion?: string;
  message?: string;
}

export interface FinalReport {
  upgraded: UpgradeRecord[];
  failed: ConflictEntry[];
  /** Packages never touched (ignored from config/CLI) */
  ignored: string[];
}

/** Minimal package.json shape used by the tool */
export interface PackageJson {
  name?: string;
  version?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
