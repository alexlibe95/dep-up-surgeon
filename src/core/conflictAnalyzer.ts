import type { Conflict } from '../types.js';
import { parseConflictsFromNpmOutput, parseEresolveFallback } from './conflictParser.js';

export type ConflictCategory =
  | 'peerDependencyMismatch'
  | 'versionOutOfRange'
  | 'missingDependency'
  | 'incompatibleEngine'
  | 'unresolvedTree';

export interface ClassifiedConflict extends Conflict {
  category: ConflictCategory;
}

/**
 * Heuristic classification from raw npm text + structured fields.
 */
export function classifyConflict(c: Conflict): ConflictCategory {
  const raw = `${c.rawMessage} ${c.requiredRange}`.toLowerCase();
  if (/ebadengine|unsupported engine|engine node/i.test(raw) || c.dependency === 'node') {
    return 'incompatibleEngine';
  }
  if (/eresolve|unable to resolve dependency tree|dependency tree.*not.*found/i.test(raw)) {
    return 'unresolvedTree';
  }
  if (/not installed|missing|unmet peer|none is installed/i.test(raw)) {
    return 'missingDependency';
  }
  if (/incorrect peer|conflicting peer|peer dep/i.test(raw)) {
    return 'peerDependencyMismatch';
  }
  if (/could not resolve|invalid|does not satisfy|not compatible/i.test(raw)) {
    return 'versionOutOfRange';
  }
  return 'peerDependencyMismatch';
}

export function analyzeConflicts(conflicts: Conflict[]): ClassifiedConflict[] {
  return conflicts.map((c) => ({
    ...c,
    category: classifyConflict(c),
  }));
}

/**
 * Count how often each package name appears as a blocking dependency (generic scoring).
 */
export function scoreBlockingPackages(classified: ClassifiedConflict[]): Map<string, number> {
  const scores = new Map<string, number>();
  const bump = (name: string) => {
    if (!name || name === 'unknown') {
      return;
    }
    scores.set(name, (scores.get(name) ?? 0) + 1);
  };
  for (const c of classified) {
    bump(c.dependency);
    bump(c.depender);
  }
  return new Map([...scores.entries()].sort((a, b) => b[1] - a[1]));
}

export function groupConflictsByCategory(
  classified: ClassifiedConflict[],
): Map<ConflictCategory, ClassifiedConflict[]> {
  const m = new Map<ConflictCategory, ClassifiedConflict[]>();
  for (const c of classified) {
    let list = m.get(c.category);
    if (!list) {
      list = [];
      m.set(c.category, list);
    }
    list.push(c);
  }
  return m;
}

/**
 * Merge line-based parses with ERESOLVE fallback (dedupe by raw line).
 */
export function mergeParsedConflicts(output: string): Conflict[] {
  const a = parseConflictsFromNpmOutput(output);
  const b = parseEresolveFallback(output);
  const keys = new Set(a.map((x) => x.rawMessage));
  return [...a, ...b.filter((x) => !keys.has(x.rawMessage))];
}

export function extractClassifiedConflicts(output: string): ClassifiedConflict[] {
  return analyzeConflicts(mergeParsedConflicts(output));
}

/**
 * After a **successful** `npm install`, roll back if structured conflicts were detected (unless --force).
 * Uses parsed output instead of broad regex-only heuristics.
 */
export function shouldRollbackAfterSuccessfulInstall(
  classified: ClassifiedConflict[],
  force: boolean,
): boolean {
  if (force || classified.length === 0) {
    return false;
  }
  return true;
}
