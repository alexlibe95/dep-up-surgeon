/**
 * Read / write the package-manager-specific "pin a transitive dep to version X" block inside
 * `package.json`. Used by `--security-only --apply-overrides` (flat audit-driven pins) and by
 * the user-facing `--override <selector>` CLI flag (parent-scoped pins).
 *
 * Manager-specific field layouts — we support BOTH the flat form and the parent-scoped /
 * nested form each manager offers:
 *
 *   - **npm (>=8.3.0)**:
 *       Flat:   `{ "overrides": { "<pkg>": "<range>" } }`
 *       Nested: `{ "overrides": { "<parent>": { "<pkg>": "<range>" } } }`
 *               Use `"."` to pin the parent itself.
 *       Ref: https://docs.npmjs.com/cli/v9/configuring-npm/package-json#overrides
 *
 *   - **pnpm**:
 *       Flat:   `{ "pnpm": { "overrides": { "<pkg>": "<range>" } } }`
 *       Chain:  `{ "pnpm": { "overrides": { "<parent>>...>":"<range>", "<a>>b>c": "..." } } }`
 *               pnpm encodes the parent chain directly in the key using `>` as separator.
 *       Ref: https://pnpm.io/package_json#pnpmoverrides
 *
 *   - **yarn (classic + berry)**:
 *       Flat:  `{ "resolutions": { "<pkg>": "<range>" } }`
 *       Chain: `{ "resolutions": { "<parent>/<pkg>": "<range>" } }` — path-style, `/`-separated.
 *       Ref: https://classic.yarnpkg.com/lang/en/docs/selective-version-resolutions/
 *
 * Internal model: every override is a `{ chain: string[], range: string }` pair where `chain`
 * is the parent chain from outermost package down to the pinned package. `chain.length === 1`
 * is the flat case. On write, we translate the chain into the manager-specific encoding above;
 * on read, we reverse the encoding so downstream consumers never worry about the format.
 *
 * Design notes:
 *   - Pure I/O helpers here — no engine integration. The higher-level "apply an override, run
 *     install, roll back on failure" loop lives in the caller (`cli/overrideFlow.ts`).
 *   - `decideOverride` is conservative: it refuses to downgrade an existing override (so a user
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
  /**
   * Parent chain from outermost package down to (but not including) `name`. When omitted or
   * empty, the override is FLAT — written as a top-level key. When non-empty, the override is
   * PARENT-SCOPED: we walk this chain to the matching nested object (npm) or encode it into
   * the key with the manager-specific separator (`>` for pnpm, `/` for yarn).
   *
   * Example: `{ parentChain: ['some-dep'], name: 'foo', range: '1.2.3' }` →
   *   - npm:  `{ "overrides": { "some-dep": { "foo": "1.2.3" } } }`
   *   - pnpm: `{ "pnpm": { "overrides": { "some-dep>foo": "1.2.3" } } }`
   *   - yarn: `{ "resolutions": { "some-dep/foo": "1.2.3" } }`
   */
  parentChain?: string[];
}

/** Structured representation of an override entry after reading it back, chain included. */
export interface OverrideEntryRead extends OverrideEntry {
  /**
   * Full chain from outermost parent down to `name` (always length ≥ 1). Flat entries have
   * `chain = [name]`; parent-scoped entries have `chain = [...parentChain, name]`. Provided so
   * consumers don't need to re-assemble it from `parentChain + name` themselves.
   */
  chain: string[];
}

export interface ReadOverridesResult {
  /** True when the field was present (may still be empty `{}`). */
  present: boolean;
  /** Field layout: `overrides` (npm), `pnpm.overrides` (pnpm), or `resolutions` (yarn). */
  field: OverrideField;
  /**
   * All entries in the block, flat + parent-scoped mixed together. Each has a `chain` array
   * describing where it lives; `chain.length === 1` is the flat case. npm nested objects,
   * pnpm `>`-chains, and yarn `/`-chains are all surfaced uniformly here.
   */
  entries: OverrideEntryRead[];
  /**
   * Anything that didn't fit the string|object pattern we parse (e.g. booleans, arrays, or
   * unknown extensions pnpm added). Handed back raw so callers that REWRITE the block can
   * preserve these entries without knowing what they mean.
   */
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
 * I/O). Returns a normalized `{ present, entries, nested }` shape that works across managers
 * AND flattens all three parent-scoped encodings into a single `chain` array per entry:
 *
 *   - npm nested: `{ "overrides": { "foo": { "bar": "1" } } }`
 *     → entry `{ chain: ['foo', 'bar'], name: 'bar', range: '1', parentChain: ['foo'] }`.
 *     The special key `"."` (npm's "the parent itself" selector) is folded into the chain
 *     too: `{"foo": {".": "2"}}` → chain `['foo']` (pins `foo` when nested under itself).
 *   - pnpm `>`-chain keys: `{ "pnpm": { "overrides": { "foo>bar": "1" } } }`
 *     → entry `{ chain: ['foo', 'bar'], ... }`.
 *   - yarn `/`-chain keys: `{ "resolutions": { "a/b": "1" } }`
 *     → entry `{ chain: ['a', 'b'], ... }`. Scoped names (`@org/foo`) complicate `/` parsing,
 *     so we treat `/` as a separator ONLY after a non-`@` segment. `"@org/foo"` stays one
 *     name; `"@org/foo/child"` splits into `["@org/foo", "child"]`.
 *
 * Accepts a `pkg` of `unknown` so callers can pass raw `JSON.parse` output.
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

  const entries: OverrideEntryRead[] = [];
  const nested: Record<string, unknown> = {};

  for (const [k, v] of Object.entries(block as Record<string, unknown>)) {
    if (typeof v === 'string') {
      // Leaf: a direct `name` OR a chain key for pnpm/yarn.
      const chain = parseChainKey(k, manager);
      pushEntry(entries, chain, v);
    } else if (manager === 'npm' && v && typeof v === 'object' && !Array.isArray(v)) {
      // npm nested object form. Walk it recursively so grandchildren (`foo>bar>baz` in npm
      // parlance = `{ foo: { bar: { baz: "X" } } }`) are flattened into a single chain.
      walkNpmNested([k], v as Record<string, unknown>, entries);
    } else {
      // Anything we don't recognize — keep it so a rewrite doesn't lose data.
      nested[k] = v;
    }
  }

  return { present: true, field, entries, nested };
}

/**
 * Split a pnpm / yarn chain key into its package-name segments. The separator is `>` for pnpm
 * and `/` for yarn — except `/` is ALSO legal inside scoped package names (`@org/pkg`), so we
 * treat `/` as a separator only when the preceding segment doesn't start with `@`.
 */
function parseChainKey(key: string, manager: PackageManager): string[] {
  const trimmed = key.trim();
  if (!trimmed) return [trimmed];
  if (manager === 'pnpm') {
    // pnpm supports an optional `@<version>` suffix on any segment to constrain WHICH version
    // of the parent the override applies to. We strip it for identification purposes — the
    // rest of the pipeline compares by NAME — but keep it verbatim when writing back.
    return trimmed.split('>').map((s) => s.trim()).filter(Boolean);
  }
  if (manager === 'yarn') {
    const parts: string[] = [];
    let buf = '';
    const raw = trimmed;
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i]!;
      if (c === '/' && !buf.startsWith('@')) {
        if (buf) parts.push(buf);
        buf = '';
        continue;
      }
      // Allow ONE `/` after a `@scope` so `@scope/pkg` is kept whole; any SECOND `/` splits.
      if (c === '/' && buf.startsWith('@') && !buf.slice(1).includes('/')) {
        buf += c;
        continue;
      }
      if (c === '/' && buf.startsWith('@')) {
        parts.push(buf);
        buf = '';
        continue;
      }
      buf += c;
    }
    if (buf) parts.push(buf);
    return parts;
  }
  // npm: its flat keys never contain chain markers (nesting uses object form handled above).
  return [trimmed];
}

function pushEntry(entries: OverrideEntryRead[], chain: string[], range: string): void {
  if (chain.length === 0) return;
  const name = chain[chain.length - 1]!;
  const parentChain = chain.slice(0, -1);
  const entry: OverrideEntryRead = { chain: [...chain], name, range };
  if (parentChain.length > 0) entry.parentChain = parentChain;
  entries.push(entry);
}

function walkNpmNested(
  chain: string[],
  obj: Record<string, unknown>,
  out: OverrideEntryRead[],
): void {
  for (const [k, v] of Object.entries(obj)) {
    // npm's special `"."` selector means "pin the parent package itself" (the outermost key of
    // THIS scope). It produces an entry whose name equals the current `chain` tail, not `.`.
    if (k === '.' && typeof v === 'string') {
      pushEntry(out, chain, v);
      continue;
    }
    const nextChain = [...chain, k];
    if (typeof v === 'string') {
      pushEntry(out, nextChain, v);
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      walkNpmNested(nextChain, v as Record<string, unknown>, out);
    }
  }
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

function chainsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/**
 * Walk `block` along `chain`, delete the leaf, and prune now-empty intermediate objects on
 * the way back out. Returns `true` when something was actually removed. Works in-place: the
 * caller should pass a shallow-cloned copy (we own the top level).
 */
function removeChainFromNpmNested(
  block: Record<string, unknown>,
  chain: string[],
): boolean {
  if (chain.length === 0) return false;
  const [head, ...tail] = chain;
  if (!(head! in block)) return false;
  const value = block[head!];

  // Leaf write: chain of length 1. The value MUST be a string for the flat match; if it's a
  // nested object we instead look for a `"."` key inside (npm's self-pin) — that's the only
  // way a length-1 chain can have created a nested shape.
  if (tail.length === 0) {
    if (typeof value === 'string') {
      delete block[head!];
      return true;
    }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const inner = { ...(value as Record<string, unknown>) };
      if ('.' in inner && typeof inner['.'] === 'string') {
        delete inner['.'];
        if (Object.keys(inner).length === 0) {
          delete block[head!];
        } else {
          block[head!] = inner;
        }
        return true;
      }
    }
    return false;
  }

  // Internal node: descend. `value` must be a nested object for the chain to be meaningful.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const child = { ...(value as Record<string, unknown>) };
  const ok = removeChainFromNpmNested(child, tail);
  if (!ok) return false;
  if (Object.keys(child).length === 0) {
    delete block[head!];
  } else {
    block[head!] = child;
  }
  return true;
}

/**
 * In-memory write: return a new `package.json` object with the override applied. Does NOT
 * touch disk — caller serializes + writes. Preserves ordering for existing keys and inserts
 * the field at a stable position when it's new.
 *
 * When `entry.parentChain` is non-empty the write is **parent-scoped**:
 *   - npm writes a nested object (`{parent: {child: "X"}}`), creating intermediate levels as
 *     needed and preserving sibling keys at every level.
 *   - pnpm writes a flat `"parent>child"` key (pnpm's native chain encoding).
 *   - yarn writes a flat `"parent/child"` key. Scoped names are kept intact thanks to the
 *     chain being an array rather than a pre-encoded string.
 */
export function applyOverrideInMemory(
  pkg: Record<string, unknown>,
  manager: PackageManager,
  entry: OverrideEntry,
): Record<string, unknown> {
  const field = overrideFieldFor(manager);
  const next = { ...pkg };
  const chain = [...(entry.parentChain ?? []), entry.name];
  if (chain.length === 0) return next; // degenerate — nothing to write

  if (field === 'pnpm.overrides') {
    const pnpmBlock =
      pkg.pnpm && typeof pkg.pnpm === 'object'
        ? { ...(pkg.pnpm as Record<string, unknown>) }
        : {};
    const overrides =
      pnpmBlock.overrides && typeof pnpmBlock.overrides === 'object'
        ? { ...(pnpmBlock.overrides as Record<string, unknown>) }
        : {};
    overrides[encodeChainKey(chain, 'pnpm')] = entry.range;
    pnpmBlock.overrides = overrides;
    next.pnpm = pnpmBlock;
    return next;
  }

  if (field === 'resolutions') {
    const current = pkg[field];
    const block =
      current && typeof current === 'object' && !Array.isArray(current)
        ? { ...(current as Record<string, unknown>) }
        : {};
    block[encodeChainKey(chain, 'yarn')] = entry.range;
    next[field] = block;
    return next;
  }

  // npm nested-object form. For flat overrides (chain.length === 1) we still write to the top
  // level; otherwise we descend, cloning every intermediate level so we don't mutate the
  // input object.
  const current = pkg[field];
  const rootBlock =
    current && typeof current === 'object' && !Array.isArray(current)
      ? { ...(current as Record<string, unknown>) }
      : {};

  if (chain.length === 1) {
    rootBlock[chain[0]!] = entry.range;
    next[field] = rootBlock;
    return next;
  }

  // Descend into `rootBlock[parent[0]] = {...}`, merging with whatever's already there. If an
  // existing entry at the parent is a STRING (flat pin), npm's spec promotes it under `"."`
  // before we nest — that preserves the existing pin AND adds the scoped child.
  let cursor: Record<string, unknown> = rootBlock;
  for (let i = 0; i < chain.length - 1; i++) {
    const seg = chain[i]!;
    const existing = cursor[seg];
    if (typeof existing === 'string') {
      cursor[seg] = { '.': existing };
    } else if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      cursor[seg] = {};
    } else {
      cursor[seg] = { ...(existing as Record<string, unknown>) };
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[chain[chain.length - 1]!] = entry.range;
  next[field] = rootBlock;
  return next;
}

/**
 * Encode a `chain: string[]` into the single-string key pnpm / yarn store in their flat
 * overrides map. pnpm uses `>`; yarn uses `/`. Scoped names are preserved verbatim inside
 * each segment since we only join WITH the separator — we never touch the segment contents.
 */
export function encodeChainKey(chain: string[], manager: 'pnpm' | 'yarn'): string {
  const sep = manager === 'pnpm' ? '>' : '/';
  return chain.join(sep);
}

/**
 * Parse a user-facing selector string into a `chain + range` pair.
 *
 * Accepts BOTH the pnpm-style `parent>child@1.2.3` AND the yarn-style `parent/child@1.2.3`
 * form (after accounting for scoped-name slashes). When neither separator is present the
 * selector is treated as a flat override. The trailing `@<range>` is optional — callers that
 * know the range separately (e.g. audit-derived pins) can pass just the chain.
 *
 * Returns `undefined` when the selector is malformed (empty, dangling `@`, trailing separator).
 */
export function parseOverrideSelector(
  spec: string,
): { chain: string[]; range?: string } | undefined {
  const trimmed = spec.trim();
  if (!trimmed) return undefined;

  // Split off the `@<range>` suffix. Scoped names start with `@`, so we look for the LAST `@`
  // that has a separator-free tail (version / range) after it. Missing `@` is OK — caller
  // supplies the range elsewhere.
  let chainPart = trimmed;
  let range: string | undefined;
  const atIdx = findRangeAt(trimmed);
  if (atIdx !== -1) {
    chainPart = trimmed.slice(0, atIdx);
    range = trimmed.slice(atIdx + 1).trim();
    if (!range) return undefined;
  }

  // Chain separator detection: `>` wins if present (pnpm style is unambiguous); else `/`
  // (yarn style, scoped-name-aware). Plain names fall through as `[chainPart]`.
  let chain: string[];
  if (chainPart.includes('>')) {
    chain = chainPart.split('>').map((s) => s.trim()).filter(Boolean);
  } else {
    chain = parseChainKey(chainPart, 'yarn');
  }
  if (chain.length === 0) return undefined;

  const result: { chain: string[]; range?: string } = { chain };
  if (range) result.range = range;
  return result;
}

/**
 * Locate the `@` that separates the chain from the version suffix. Scoped names contain `@`
 * in front so we skip leading `@`s; the version `@` is always the LAST `@` in the string and
 * must be followed by at least one non-space character.
 */
function findRangeAt(s: string): number {
  // Walk backwards. The range `@` is the first `@` we encounter that is NOT immediately after
  // a chain separator (`/` or `>`) and is NOT at position 0 (scoped package prefix).
  for (let i = s.length - 1; i > 0; i--) {
    if (s[i] !== '@') continue;
    const prev = s[i - 1];
    if (prev === '/' || prev === '>') continue; // scoped name inside chain segment
    return i;
  }
  return -1;
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

  // Read existing pin so we can decide skip / write / conflict. Match on the EXACT chain,
  // not just the name — a flat `foo` pin and a parent-scoped `bar>foo` pin are separate
  // entries and don't interact (both can coexist; overwriting one must never touch the other).
  const read = readOverrides(pkg, opts.manager);
  const wantChain = [...(opts.entry.parentChain ?? []), opts.entry.name];
  const existing = read.entries.find((e) => chainsEqual(e.chain, wantChain));
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
 *
 * `target` can be a bare package name (drops the flat top-level entry, legacy API) or a
 * structured `{ chain: string[] }` selector (drops a parent-scoped entry matching the exact
 * chain). When a parent-scoped write was adjacent to a sibling-writing flat pin, we leave the
 * sibling intact; same-level empty objects are pruned recursively so the file shrinks back to
 * what existed before the write.
 */
export async function removeOverrideFromFile(
  packageJsonPath: string,
  manager: PackageManager,
  target: string | { chain: string[] },
): Promise<{ ok: boolean; removed: boolean; reason?: string }> {
  const chain =
    typeof target === 'string' ? [target] : [...target.chain];
  if (chain.length === 0) {
    return { ok: true, removed: false };
  }

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
      if (overrides && typeof overrides === 'object') {
        const next = { ...(overrides as Record<string, unknown>) };
        const key = encodeChainKey(chain, 'pnpm');
        if (key in next) {
          delete next[key];
          removed = true;
        }
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
      }
    }
  } else if (field === 'resolutions') {
    const block = pkg[field];
    if (block && typeof block === 'object') {
      const next = { ...(block as Record<string, unknown>) };
      const key = encodeChainKey(chain, 'yarn');
      if (key in next) {
        delete next[key];
        removed = true;
      }
      if (Object.keys(next).length === 0) {
        delete pkg[field];
      } else {
        pkg[field] = next;
      }
    }
  } else {
    // npm: flat OR nested object path.
    const block = pkg[field];
    if (block && typeof block === 'object' && !Array.isArray(block)) {
      const nextRoot = { ...(block as Record<string, unknown>) };
      removed = removeChainFromNpmNested(nextRoot, chain);
      if (Object.keys(nextRoot).length === 0) {
        delete pkg[field];
      } else {
        pkg[field] = nextRoot;
      }
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
