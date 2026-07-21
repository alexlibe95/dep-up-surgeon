/**
 * Preserve caret/tilde/exact range style when rewriting a dependency version in package.json.
 * Most projects use `^x.y.z`; writing a bare `x.y.z` after every successful upgrade surprises
 * teams and creates noisy diffs. Complex ranges (`>=1 <3`, `1.x || 2.x`) fall back to an
 * exact pin — rewriting them automatically would be guesswork.
 */

export type RangeStyle = 'caret' | 'tilde' | 'exact' | 'other';

/**
 * Detect how the user expressed the previous range.
 *   - `^1.2.3` / `^1.2` → caret
 *   - `~1.2.3` → tilde
 *   - `1.2.3` (bare semver) → exact
 *   - everything else → other
 */
export function detectRangeStyle(range: string): RangeStyle {
  const t = range.trim();
  if (!t) return 'other';
  if (/^\^\s*\d/.test(t)) return 'caret';
  if (/^~\s*\d/.test(t)) return 'tilde';
  // Bare semver (optional v prefix, optional prerelease/build).
  if (/^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(t)) return 'exact';
  return 'other';
}

/**
 * Rewrite `targetVersion` using the detected style from `previousRange`.
 * For `other` styles we pin exact — safer than inventing a new range expression.
 */
export function formatUpgradeRange(previousRange: string, targetVersion: string): string {
  const clean = targetVersion.trim().replace(/^v/, '');
  const style = detectRangeStyle(previousRange);
  switch (style) {
    case 'caret':
      return `^${clean}`;
    case 'tilde':
      return `~${clean}`;
    case 'exact':
      return clean;
    case 'other':
    default:
      return clean;
  }
}
