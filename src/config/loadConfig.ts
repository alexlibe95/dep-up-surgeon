import path from 'node:path';
import fs from 'fs-extra';

/**
 * Persisted / policy-style override pin. Mirrors `--override` on the CLI but parsed ahead of
 * time from `.dep-up-surgeonrc`, so teams can commit the full set of parent-scoped pins the
 * repo relies on (with human-readable `reason`s that flow into the run report).
 *
 * Two input shapes are accepted:
 *
 *   - **Structured**: `{ "chain": ["some-dep", "foo"], "range": "1.2.3", "reason": "CVE-…" }`.
 *     `chain` may also be a single-element array for a flat pin, or a bare string for the
 *     1-deep case: `{ "chain": "lodash", "range": "4.17.21" }`.
 *   - **Selector string**: `{ "selector": "some-dep>foo@1.2.3", "reason": "…" }` — same syntax
 *     as the `--override` CLI flag (pnpm `>`-chain, yarn `/`-chain, or flat). When `selector`
 *     embeds `@<range>`, the separate `range` field is optional.
 */
export interface RcOverrideEntry {
  /** Parent chain + leaf, outermost → leaf. `chain: [name]` is the flat case. */
  chain: string[];
  /** Version / range to pin. */
  range: string;
  /**
   * Human-readable reason the pin exists (CVE ID, vendor guidance, "upstream PR #123 pending",
   * etc.). Flows into `report.overrides.attempts[].policyReason` so reviewers never have to
   * grep commit messages to find out why a transitive is pinned.
   */
  reason?: string;
  /**
   * Original selector string, if the user used the string form. Recorded for diagnostics —
   * when we couldn't apply a pin we want to tell the user "the pin from rc line `<raw>`" so
   * they can find and fix it quickly.
   */
  source?: string;
}

export interface DepUpSurgeonRc {
  /** Package names that must never be upgraded */
  ignore?: string[];
  /**
   * Explicit linked upgrade groups (applied before the dynamic registry graph).
   * Packages listed together are bumped in one `package.json` edit + one `npm install`.
   */
  linkedGroups?: Array<{ id: string; packages: string[] }>;
  /**
   * Override the validator command. Accepts either a shell string (run with `shell: true`)
   * or `{ command?: string; skip?: boolean }`. When omitted, defaults are
   * `npm test` → `npm run build` → no-op.
   *
   * Examples:
   *   "validate": "tsc -p tsconfig.json --noEmit"
   *   "validate": { "command": "pnpm -r build" }
   *   "validate": { "skip": true }
   */
  validate?: string | { command?: string; skip?: boolean };
  /**
   * Persistent override pins applied on every run (with `--security-only` or standalone).
   * Merges with CLI `--override` flags — the CLI wins on exact-chain conflicts so ad-hoc
   * overrides always take precedence over the committed policy.
   */
  overrides?: RcOverrideEntry[];
  /** Parse warnings from loading the rc. Populated on malformed sections; never fatal. */
  warnings?: string[];
}

const CONFIG_FILENAME = '.dep-up-surgeonrc';

/**
 * Load `.dep-up-surgeonrc` from the project root (JSON).
 * Missing or invalid files yield an empty config (no throw).
 */
export async function loadConfig(cwd: string): Promise<DepUpSurgeonRc> {
  const file = path.join(cwd, CONFIG_FILENAME);
  if (!(await fs.pathExists(file))) {
    return {};
  }
  try {
    const raw = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(raw) as DepUpSurgeonRc;
    if (!parsed || typeof parsed !== 'object') {
      return {};
    }
    if (parsed.ignore !== undefined && !Array.isArray(parsed.ignore)) {
      return { ...parsed, ignore: [] };
    }
    let linkedGroups = parsed.linkedGroups;
    if (linkedGroups !== undefined) {
      if (!Array.isArray(linkedGroups)) {
        linkedGroups = [];
      } else {
        linkedGroups = linkedGroups
          .filter((g) => g && typeof g === 'object' && typeof (g as { id?: string }).id === 'string')
          .map((g) => ({
            id: String((g as { id: string }).id),
            packages: Array.isArray((g as { packages?: unknown }).packages)
              ? (g as { packages: string[] }).packages.map(String)
              : [],
          }));
      }
    }
    let validate: DepUpSurgeonRc['validate'] = undefined;
    if (typeof parsed.validate === 'string') {
      const trimmed = parsed.validate.trim();
      if (trimmed) {
        validate = trimmed;
      }
    } else if (parsed.validate && typeof parsed.validate === 'object') {
      const v = parsed.validate as { command?: unknown; skip?: unknown };
      const out: { command?: string; skip?: boolean } = {};
      if (typeof v.command === 'string' && v.command.trim()) {
        out.command = v.command.trim();
      }
      if (typeof v.skip === 'boolean') {
        out.skip = v.skip;
      }
      if (out.command || out.skip !== undefined) {
        validate = out;
      }
    }

    const warnings: string[] = [];
    const overrides = normalizeRcOverrides(
      (parsed as { overrides?: unknown }).overrides,
      warnings,
    );

    const out: DepUpSurgeonRc = {
      ignore: parsed.ignore?.map(String) ?? [],
      linkedGroups: linkedGroups ?? [],
      ...(validate !== undefined ? { validate } : {}),
    };
    if (overrides.length > 0) out.overrides = overrides;
    if (warnings.length > 0) out.warnings = warnings;
    return out;
  } catch {
    return {};
  }
}

/**
 * Parse the `overrides` section of an rc file into a `RcOverrideEntry[]`. Accepts the two
 * shapes documented on `RcOverrideEntry` and records (does not throw on) malformed entries so
 * a single typo in one override line doesn't kill the whole upgrade run.
 *
 * Duplicate chains are kept in array order — the later entry wins, matching the CLI semantic
 * where a repeated `--override` overwrites the first value. We leave that dedupe to the
 * merger so this function stays cheap and pure.
 */
export function normalizeRcOverrides(raw: unknown, warnings: string[]): RcOverrideEntry[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push('rc `overrides` must be an array; ignoring');
    return [];
  }
  const out: RcOverrideEntry[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const norm = normalizeRcOverrideEntry(entry, i, warnings);
    if (norm) out.push(norm);
  }
  return out;
}

function normalizeRcOverrideEntry(
  entry: unknown,
  index: number,
  warnings: string[],
): RcOverrideEntry | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    warnings.push(`rc overrides[${index}] must be an object`);
    return undefined;
  }
  const obj = entry as Record<string, unknown>;

  let chain: string[] | undefined;
  let range: string | undefined;

  // Structured form: explicit chain + range.
  if (obj.chain !== undefined) {
    if (typeof obj.chain === 'string') {
      chain = [obj.chain.trim()].filter(Boolean);
    } else if (Array.isArray(obj.chain)) {
      chain = obj.chain
        .filter((seg): seg is string => typeof seg === 'string')
        .map((seg) => seg.trim())
        .filter(Boolean);
    } else {
      warnings.push(`rc overrides[${index}].chain must be a string or array of strings`);
      return undefined;
    }
  }

  // Selector form: may include the range after `@`, otherwise defer to the `range` field.
  const selector = typeof obj.selector === 'string' ? obj.selector.trim() : undefined;
  if (selector) {
    // We can't import `parseOverrideSelector` here (circular boundary: overrides.ts lives
    // under utils/ which depends on workspaces.ts, and pulling it into config would widen the
    // config module's graph). Inline a minimal split: `>` wins, then `/` with scoped-name
    // awareness. This matches what `parseOverrideSelector` does for the shapes we accept.
    const parsed = parseSelectorInline(selector);
    if (!parsed) {
      warnings.push(`rc overrides[${index}].selector "${selector}" is malformed`);
      return undefined;
    }
    if (!chain) chain = parsed.chain;
    if (!range && parsed.range) range = parsed.range;
  }

  if (typeof obj.range === 'string' && obj.range.trim()) {
    range = obj.range.trim();
  } else if (typeof obj.version === 'string' && obj.version.trim()) {
    range = obj.version.trim();
  }

  if (!chain || chain.length === 0) {
    warnings.push(`rc overrides[${index}]: missing or empty \`chain\`/\`selector\``);
    return undefined;
  }
  if (!range) {
    warnings.push(`rc overrides[${index}]: missing \`range\` (and no \`@<range>\` in selector)`);
    return undefined;
  }

  const out: RcOverrideEntry = { chain, range };
  if (typeof obj.reason === 'string' && obj.reason.trim()) {
    out.reason = obj.reason.trim();
  }
  if (selector) out.source = selector;
  return out;
}

/**
 * Minimal copy of `parseOverrideSelector` kept local to this module so the config layer
 * doesn't depend on `src/utils/overrides.ts`. Supports the same three forms as the CLI:
 *   - `foo@1.2.3`
 *   - `parent>child@1.2.3` (pnpm style, any depth)
 *   - `parent/child@1.2.3` (yarn style, scoped-name aware)
 */
function parseSelectorInline(spec: string): { chain: string[]; range?: string } | undefined {
  const trimmed = spec.trim();
  if (!trimmed) return undefined;
  let chainPart = trimmed;
  let range: string | undefined;
  const atIdx = (() => {
    for (let i = trimmed.length - 1; i > 0; i--) {
      if (trimmed[i] !== '@') continue;
      const prev = trimmed[i - 1];
      if (prev === '/' || prev === '>') continue;
      return i;
    }
    return -1;
  })();
  if (atIdx !== -1) {
    chainPart = trimmed.slice(0, atIdx);
    range = trimmed.slice(atIdx + 1).trim();
    if (!range) return undefined;
  }
  let chain: string[];
  if (chainPart.includes('>')) {
    chain = chainPart.split('>').map((s) => s.trim()).filter(Boolean);
  } else if (chainPart.includes('/')) {
    // Scoped-name aware split on `/`.
    const parts: string[] = [];
    let buf = '';
    for (let i = 0; i < chainPart.length; i++) {
      const c = chainPart[i]!;
      if (c === '/' && !buf.startsWith('@')) {
        if (buf) parts.push(buf);
        buf = '';
        continue;
      }
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
    chain = parts;
  } else {
    chain = [chainPart];
  }
  if (chain.length === 0) return undefined;
  const result: { chain: string[]; range?: string } = { chain };
  if (range) result.range = range;
  return result;
}

/**
 * Resolve the effective validator settings combining CLI flags with `.dep-up-surgeonrc.validate`.
 * CLI flags always win over the rc file.
 */
export function resolveValidateOptions(
  configValidate: DepUpSurgeonRc['validate'],
  cliValidateCmd: string | undefined,
  cliNoValidate: boolean,
): { command?: string; skip?: boolean; source?: 'cli' | 'config' } {
  if (cliNoValidate) {
    return { skip: true, source: 'cli' };
  }
  if (typeof cliValidateCmd === 'string' && cliValidateCmd.trim()) {
    return { command: cliValidateCmd.trim(), source: 'cli' };
  }
  if (typeof configValidate === 'string') {
    return { command: configValidate, source: 'config' };
  }
  if (configValidate && typeof configValidate === 'object') {
    if (configValidate.skip) {
      return { skip: true, source: 'config' };
    }
    if (configValidate.command) {
      return { command: configValidate.command, source: 'config' };
    }
  }
  return {};
}

/**
 * Merge rc-defined overrides with CLI `--override` selectors. CLI entries always win on an
 * exact-chain conflict (the user's one-off intent overrides the committed policy), but both
 * lists are preserved for unique chains. Later rc entries also win over earlier rc entries
 * with the same chain — same rule the CLI uses when `--override` is passed twice.
 *
 * Returns `{ entries, warnings }`. `warnings` is non-empty when we dropped a CLI selector
 * because of a parse error; the caller can log these at the same level as `rc.warnings` so
 * the user sees a single coherent diagnostics block.
 */
export function mergeOverrideSources(
  rcOverrides: RcOverrideEntry[] | undefined,
  cliSelectors: readonly string[] | undefined,
): { entries: RcOverrideEntry[]; warnings: string[] } {
  const warnings: string[] = [];
  const byKey = new Map<string, RcOverrideEntry>();

  for (const e of rcOverrides ?? []) {
    byKey.set(chainKey(e.chain), e);
  }
  for (const raw of cliSelectors ?? []) {
    const parsed = parseSelectorInline(raw);
    if (!parsed || !parsed.range) {
      warnings.push(
        `--override "${raw}" is malformed (expected "<chain>@<range>"; skipping this CLI entry — committed rc overrides still apply)`,
      );
      continue;
    }
    const entry: RcOverrideEntry = { chain: parsed.chain, range: parsed.range, source: raw };
    byKey.set(chainKey(entry.chain), entry);
  }

  return { entries: [...byKey.values()], warnings };
}

function chainKey(chain: string[]): string {
  // Use a delimiter that cannot appear in a valid npm package name so chains collide only
  // when they are structurally identical. `\u0000` fits the bill — npm names forbid control
  // characters, and even if one sneaked in, a collision here is a no-op (last-write-wins).
  return chain.join('\u0000');
}

/**
 * Merge CLI `--ignore` (comma-separated) with config ignore list.
 */
export function mergeIgnoreLists(
  configIgnore: string[] | undefined,
  cliIgnoreCsv: string | undefined,
): Set<string> {
  const set = new Set<string>();
  for (const name of configIgnore ?? []) {
    set.add(name.trim());
  }
  if (cliIgnoreCsv?.trim()) {
    for (const part of cliIgnoreCsv.split(',')) {
      const n = part.trim();
      if (n) {
        set.add(n);
      }
    }
  }
  return set;
}

/**
 * Append package names to `.dep-up-surgeonrc` ignore list (creates or merges file).
 */
export async function appendIgnoreToRc(cwd: string, ...packageNames: string[]): Promise<void> {
  const rcPath = path.join(cwd, CONFIG_FILENAME);
  let data: DepUpSurgeonRc = {};
  if (await fs.pathExists(rcPath)) {
    try {
      data = (await fs.readJson(rcPath)) as DepUpSurgeonRc;
    } catch {
      data = {};
    }
  }
  const ignore = new Set(data.ignore ?? []);
  for (const name of packageNames) {
    ignore.add(name);
  }
  data.ignore = [...ignore].sort();
  await fs.writeJson(rcPath, data, { spaces: 2 });
}
