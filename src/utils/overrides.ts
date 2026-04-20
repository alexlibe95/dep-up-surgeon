/**
 * Read / write the package-manager-specific "pin a transitive dep to version X" block inside
 * `package.json`. Used by `--security-only --apply-overrides` so we can fix CVEs that live in
 * transitive dependencies (the kind a direct bump can't reach).
 *
 * Manager-specific field layouts (MVP — flat name → range; no nested parent-scoped overrides):
 *
 *   - **npm (>=8.3.0)**: `{ "overrides": { "<pkg>": "<range>" } }` — top-level.
 *     Ref: https://docs.npmjs.com/cli/v9/configuring-npm/package-json#overrides
 *   - **pnpm**: `{ "pnpm": { "overrides": { "<pkg>": "<range>" } } }` — nested under `pnpm`.
 *     Ref: https://pnpm.io/package_json#pnpmoverrides
 *   - **yarn (classic + berry)**: `{ "resolutions": { "<pkg>": "<range>" } }` — top-level.
 *     Same field for v1.x and v2+. Berry additionally supports `patches` / `portals` but those
 *     aren't override-shaped, so we ignore them.
 *     Ref: https://classic.yarnpkg.com/lang/en/docs/selective-version-resolutions/
 *
 * Design notes:
 *   - Pure I/O helpers here — no engine integration. The higher-level "apply an override, run
 *     install, roll back on failure" loop lives in the caller (`cli.ts` for now).
 *   - `applyOverride` is conservative: it refuses to downgrade an existing override (so a user
 *     who manually pinned `foo@5.x` never gets auto-bumped to `5.1.x` because audit happens to
 *     suggest it). Upgrades and brand-new entries are always safe.
 *   - Writes preserve the original file's ordering for every untouched key, add the new block
 *     in a stable position (at the end of the object for fresh blocks), and keep 2-space
 *     indentation. We round-trip through `JSON.parse` + `JSON.stringify`, which loses comments;
 *     package.json files almost never have comments (JSON doesn't allow them), so this is fine.
 *   - Every function returns a structured result; nothing here throws on normal malformed
 *     input. Callers surface warnings, not fatal errors.
 */
import fs from 'fs-extra';
import semver from 'semver';
import type { PackageManager } from '../core/workspaces.js';

export type OverrideField = 'overrides' | 'pnpm.overrides' | 'resolutions';

/** Where the override block lives, per package manager. */
export function overrideFieldFor(manager: PackageManager): OverrideField {
  switch (manager) {
    case 'pnpm':
      return 'pnpm.overrides';
    case 'yarn':
      return 'resolutions';
    case 'npm':
    default:
      return 'overrides';
  }
}

export interface OverrideEntry {
  /** Package name (scoped names like `@types/node` supported). */
  name: string;
  /**
   * Version or range to pin to. A plain version (`"1.2.3"`) is legal for all three managers
   * and is the conservative default we use for security overrides — it forces the exact safe
   * version without speculating that a `>=` range would also be safe.
   */
  range: string;
}

export interface ReadOverridesResult {
  /** True when the field was present (may still be empty `{}`). */
  present: boolean;
  /** Field layout: `overrides` (npm), `pnpm.overrides` (pnpm), or `resolutions` (yarn). */
  field: OverrideField;
  /**
   * Flat list of top-level entries. Nested npm/pnpm override shapes (e.g. `{"foo": {"bar": "1"}}`)
   * are surfaced as-is in `nested` so a caller can decide whether to preserve them.
   */
  entries: OverrideEntry[];
  /** Any non-string values we saw — handed back raw for round-trip preservation. */
  nested: Record<string, unknown>;
}

export interface ApplyOverrideResult {
  ok: boolean;
  /** True when the file was rewritten (no-op when the pin already met the required range). */
  written: boolean;
  /** Which field the override landed in. */
  field: OverrideField;
  /** Previous pin, if one already existed. */
  previous?: string;
  /** Final pin after applying. Always present on `ok: true`. */
  applied?: string;
  /** Reason for skipping / failure (e.g. "already at safe version"). */
  reason?: string;
}

/**
 * Read the override block from a given `package.json` object (NOT from disk — caller owns the
 * I/O). Returns a normalized `{ present, entries, nested }` shape that works across managers.
 * Accepts a `pkg` of `unknown` so callers can pass raw JSON.parse output.
 */
export function readOverrides(
  pkg: unknown,
  manager: PackageManager,
): ReadOverridesResult {
  const field = overrideFieldFor(manager);
  const empty: ReadOverridesResult = { present: false, field, entries: [], nested: {} };
  if (!pkg || typeof pkg !== 'object') return empty;
  const obj = pkg as Record<string, unknown>;

  let block: unknown;
  if (field === 'pnpm.overrides') {
    const pnpm = obj.pnpm;
    if (!pnpm || typeof pnpm !== 'object') return empty;
    block = (pnpm as Record<string, unknown>).overrides;
  } else {
    block = obj[field];
  }

  if (!block || typeof block !== 'object' || Array.isArray(block)) return empty;

  const entries: OverrideEntry[] = [];
  const nested: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
    if (typeof v === 'string') {
      entries.push({ name: k, range: v });
    } else {
      nested[k] = v;
    }
  }
  return { present: true, field, entries, nested };
}

/**
 * Decide whether an override change is needed. Returns:
 *   - `{ action: 'skip', reason }` when the existing pin already satisfies the target range
 *     (don't downgrade / don't churn the file).
 *   - `{ action: 'write', previous, applied }` when the existing pin is missing or lower than
 *     the target (safe to apply).
 *   - `{ action: 'conflict', previous, target }` when the existing pin is a range that does
 *     NOT satisfy the required safe version (e.g. user pinned `<1.0.0` but we need `>=2.0.0`).
 *     Callers must decide whether to overwrite or bail.
 */
export type OverrideDecision =
  | { action: 'skip'; reason: string; previous: string }
  | { action: 'write'; previous?: string; applied: string }
  | { action: 'conflict'; previous: string; target: string };

export function decideOverride(
  existing: string | undefined,
  target: string,
): OverrideDecision {
  const cleanTarget = target.trim();
  if (!cleanTarget) {
    return { action: 'skip', reason: 'empty target', previous: existing ?? '' };
  }
  if (!existing) {
    return { action: 'write', applied: cleanTarget };
  }
  const prev = existing.trim();
  // Fast path: identical pin. Honor it verbatim; never rewrite the same bytes.
  if (prev === cleanTarget) {
    return { action: 'skip', reason: 'already pinned to target', previous: prev };
  }
  // semver helpers throw on garbage input (e.g. a user-typed "abc"), so wrap every call. If
  // EITHER side doesn't parse, we can't compare safely → genuine conflict that requires
  // explicit user approval.
  const targetVersion = safeTargetVersion(cleanTarget);
  const prevMin = safeMinVersion(prev);

  if (targetVersion && safeSatisfies(targetVersion, prev)) {
    return { action: 'skip', reason: 'existing override already satisfies target', previous: prev };
  }
  if (prevMin && targetVersion) {
    if (semver.gte(prevMin, targetVersion)) {
      return { action: 'skip', reason: 'existing override is >= target', previous: prev };
    }
    return { action: 'write', previous: prev, applied: cleanTarget };
  }
  return { action: 'conflict', previous: prev, target: cleanTarget };
}

/** Best-effort concrete version from a target string; returns undefined on unparseable input. */
function safeTargetVersion(s: string): string | undefined {
  try {
    const clean = semver.clean(s);
    if (clean) return clean;
    const min = semver.minVersion(s);
    return min?.version;
  } catch {
    return undefined;
  }
}

function safeMinVersion(s: string): string | undefined {
  try {
    return semver.minVersion(s)?.version;
  } catch {
    return undefined;
  }
}

function safeSatisfies(version: string, range: string): boolean {
  try {
    return semver.satisfies(version, range, { includePrerelease: true });
  } catch {
    return false;
  }
}

/**
 * In-memory write: return a new `package.json` object with the override applied. Does NOT
 * touch disk — caller serializes + writes. Preserves ordering for existing keys and inserts
 * the field at a stable position when it's new.
 */
export function applyOverrideInMemory(
  pkg: Record<string, unknown>,
  manager: PackageManager,
  entry: OverrideEntry,
): Record<string, unknown> {
  const field = overrideFieldFor(manager);
  const next = { ...pkg };

  if (field === 'pnpm.overrides') {
    const pnpmBlock =
      pkg.pnpm && typeof pkg.pnpm === 'object'
        ? { ...(pkg.pnpm as Record<string, unknown>) }
        : {};
    const overrides =
      pnpmBlock.overrides && typeof pnpmBlock.overrides === 'object'
        ? { ...(pnpmBlock.overrides as Record<string, unknown>) }
        : {};
    overrides[entry.name] = entry.range;
    pnpmBlock.overrides = overrides;
    next.pnpm = pnpmBlock;
    return next;
  }

  const current = pkg[field];
  const block =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};
  block[entry.name] = entry.range;
  next[field] = block;
  return next;
}

export interface ApplyOverrideToFileOptions {
  packageJsonPath: string;
  manager: PackageManager;
  entry: OverrideEntry;
  /**
   * When true, an existing pin that does NOT satisfy the target range gets overwritten; the
   * caller has explicitly accepted that risk. When false (default), a conflict results in
   * `{ ok: false, reason: 'conflict' }` and the file is untouched.
   */
  overwriteConflicts?: boolean;
}

/**
 * Disk-level convenience: read the package.json, compute the decision, write the new pin when
 * appropriate, and return a structured result. The file is read + written with 2-space JSON.
 */
export async function applyOverrideToFile(
  opts: ApplyOverrideToFileOptions,
): Promise<ApplyOverrideResult> {
  const field = overrideFieldFor(opts.manager);
  let raw: string;
  try {
    raw = await fs.readFile(opts.packageJsonPath, 'utf8');
  } catch (e) {
    return {
      ok: false,
      written: false,
      field,
      reason: `read failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  let pkg: Record<string, unknown>;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, written: false, field, reason: 'package.json is not an object' };
    }
    pkg = parsed as Record<string, unknown>;
  } catch (e) {
    return {
      ok: false,
      written: false,
      field,
      reason: `parse failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Read existing pin so we can decide skip / write / conflict.
  const read = readOverrides(pkg, opts.manager);
  const existing = read.entries.find((e) => e.name === opts.entry.name);
  const decision = decideOverride(existing?.range, opts.entry.range);

  if (decision.action === 'skip') {
    return {
      ok: true,
      written: false,
      field,
      previous: decision.previous,
      applied: decision.previous,
      reason: decision.reason,
    };
  }

  if (decision.action === 'conflict' && !opts.overwriteConflicts) {
    return {
      ok: false,
      written: false,
      field,
      previous: decision.previous,
      reason: `existing override "${decision.previous}" conflicts with target "${decision.target}"; pass --override-force to overwrite`,
    };
  }

  const next = applyOverrideInMemory(pkg, opts.manager, opts.entry);
  // Re-read the existing newline so our rewrite doesn't flip LF <> CRLF on Windows checkouts.
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = raw.endsWith('\n') || raw.endsWith('\r\n') ? eol : '';
  const serialized = JSON.stringify(next, null, 2) + trailingNewline;
  const normalized = eol === '\r\n' ? serialized.replace(/\n/g, '\r\n') : serialized;
  try {
    await fs.writeFile(opts.packageJsonPath, normalized, 'utf8');
  } catch (e) {
    return {
      ok: false,
      written: false,
      field,
      previous: existing?.range,
      reason: `write failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const result: ApplyOverrideResult = {
    ok: true,
    written: true,
    field,
    applied: opts.entry.range,
  };
  if (existing?.range) result.previous = existing.range;
  return result;
}

/**
 * Inverse of `applyOverrideToFile` — delete a single override entry. Used by the rollback
 * path when the install + validator fails AFTER we added a pin.
 */
export async function removeOverrideFromFile(
  packageJsonPath: string,
  manager: PackageManager,
  name: string,
): Promise<{ ok: boolean; removed: boolean; reason?: string }> {
  let raw: string;
  try {
    raw = await fs.readFile(packageJsonPath, 'utf8');
  } catch (e) {
    return { ok: false, removed: false, reason: `read failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(raw) as Record<string, unknown>;
  } catch (e) {
    return { ok: false, removed: false, reason: `parse failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  const field = overrideFieldFor(manager);
  let removed = false;
  if (field === 'pnpm.overrides') {
    const pnpm = pkg.pnpm;
    if (pnpm && typeof pnpm === 'object') {
      const pnpmObj = { ...(pnpm as Record<string, unknown>) };
      const overrides = pnpmObj.overrides;
      if (overrides && typeof overrides === 'object' && name in (overrides as Record<string, unknown>)) {
        const next = { ...(overrides as Record<string, unknown>) };
        delete next[name];
        if (Object.keys(next).length === 0) {
          delete pnpmObj.overrides;
          if (Object.keys(pnpmObj).length === 0) {
            delete pkg.pnpm;
          } else {
            pkg.pnpm = pnpmObj;
          }
        } else {
          pnpmObj.overrides = next;
          pkg.pnpm = pnpmObj;
        }
        removed = true;
      }
    }
  } else {
    const block = pkg[field];
    if (block && typeof block === 'object' && name in (block as Record<string, unknown>)) {
      const next = { ...(block as Record<string, unknown>) };
      delete next[name];
      if (Object.keys(next).length === 0) {
        delete pkg[field];
      } else {
        pkg[field] = next;
      }
      removed = true;
    }
  }

  if (!removed) {
    return { ok: true, removed: false };
  }

  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  const trailingNewline = raw.endsWith('\n') || raw.endsWith('\r\n') ? eol : '';
  const serialized = JSON.stringify(pkg, null, 2) + trailingNewline;
  const normalized = eol === '\r\n' ? serialized.replace(/\n/g, '\r\n') : serialized;
  try {
    await fs.writeFile(packageJsonPath, normalized, 'utf8');
  } catch (e) {
    return { ok: false, removed: false, reason: `write failed: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, removed: true };
}
