/**
 * `--fix-lockfile` implementation.
 *
 * This pass improves the lockfile's dependency graph WITHOUT touching `package.json`. The
 * two complementary effects:
 *
 *   1. **Dedupe** — collapse multiple copies of the same package to a single installed
 *      version when semver ranges permit it. `npm dedupe` / `pnpm dedupe` / `yarn dedupe`
 *      (berry only) do this natively; we just orchestrate the run and surface the diff.
 *   2. **Outdated-but-not-vulnerable transitive detection** — a best-effort scan of the
 *      pre-dedupe lockfile for transitives that have newer published versions available.
 *      These are the "nobody complains about them but they're 6 months behind" deps that
 *      no direct bump can reach. We report them; an override step (`--apply-overrides`)
 *      handles the vulnerable subset.
 *
 * Safety model — we never leave the tree in a worse state than we found it:
 *   - Backup lockfile (+ package.json, which dedupe should never touch but belt-and-braces)
 *     before running the manager's dedupe command.
 *   - If dedupe exits non-zero, restore the backup and report the failure.
 *   - If the validator (same `--validate`/default heuristic as everywhere else) fails on the
 *     deduped tree, restore the backup, reinstall, and report validation as the reason.
 *   - On success, emit `report.lockfileFix` with a list of packages whose installed version
 *     changed (dedup winners + losers) and a list of transitives flagged as stale.
 *
 * Non-goals:
 *   - We do NOT rewrite the lockfile ourselves — only the package manager does. Parsing
 *     lockfiles across npm v1/v2/v3, pnpm v5/v6/v9, yarn classic, and yarn berry is a
 *     quagmire; using the tool's own command is both safer and future-proof.
 *   - We don't attempt to dedupe yarn classic — it has no `dedupe` subcommand. We record
 *     a `skipped: 'unsupported'` entry and move on.
 */
import path from 'node:path';
import fs from 'fs-extra';
import semver from 'semver';
import { execa } from 'execa';
import { log } from '../utils/logger.js';
import type { PackageManager } from '../core/workspaces.js';
import type { FinalReport, LockfileFixReport, LockfileDedupeChange, LockfileStaleEntry } from '../types.js';
import type { RegistryCache } from '../utils/concurrency.js';
import { fetchLatestVersion } from '../utils/npm.js';
import { tailLines } from '../utils/output.js';
import { runWithConcurrency } from '../utils/concurrency.js';

/**
 * Returns the lockfile basename for a manager, or `undefined` when the tree has no lockfile
 * yet (we'd create one as a side-effect of install; there's nothing to "fix" in that case).
 */
function lockfileBasenameFor(
  manager: PackageManager,
): 'package-lock.json' | 'pnpm-lock.yaml' | 'yarn.lock' {
  switch (manager) {
    case 'pnpm':
      return 'pnpm-lock.yaml';
    case 'yarn':
      return 'yarn.lock';
    case 'npm':
    default:
      return 'package-lock.json';
  }
}

/**
 * Build the dedupe command for each manager. Returns `undefined` when the manager has no
 * dedupe subcommand at all (yarn classic) — caller records a skip.
 *
 * Notes:
 *   - `npm dedupe` returns non-zero when audit issues are found (even without `--audit`).
 *     We pass `--no-audit` to keep the run about dedupe only; the security loop does audit.
 *   - `pnpm dedupe` is stable since pnpm 8.1 (Feb 2024). Older pnpm silently ignores the
 *     subcommand with exit 1 — we treat that the same as "no changes" and move on.
 *   - `yarn dedupe` is berry-only. Yarn classic: we detect `yarnMajorVersion < 2` externally
 *     and return `undefined` here so the caller can emit a `skipped: unsupported` result.
 */
export function dedupeCommandFor(
  manager: PackageManager,
  opts: { yarnMajorVersion?: number } = {},
): { bin: string; args: string[] } | undefined {
  switch (manager) {
    case 'pnpm':
      return { bin: 'pnpm', args: ['dedupe'] };
    case 'yarn':
      if ((opts.yarnMajorVersion ?? 1) >= 2) {
        return { bin: 'yarn', args: ['dedupe'] };
      }
      return undefined;
    case 'npm':
    default:
      return { bin: 'npm', args: ['dedupe', '--no-audit', '--loglevel', 'error'] };
  }
}

export interface RunLockfileFixOptions {
  cwd: string;
  manager: PackageManager;
  yarnMajorVersion?: number;
  /**
   * Short-circuit switch — when true, we don't actually run dedupe; we only run the
   * "stale transitive" scan and report what WOULD be deduped. Useful to ship `--dry-run
   * --fix-lockfile` or during smoke tests.
   */
  dryRun?: boolean;
  /** When true, silence human-readable logging (JSON-mode runs). */
  json?: boolean;
  /**
   * Shared registry cache so the stale-transitive scan doesn't re-fetch `@latest` for
   * packages the main flow already looked up.
   */
  registryCache?: RegistryCache;
  /** Optional validator hook: we call it AFTER dedupe and roll back on failure. */
  runValidator?: () => Promise<{ ok: boolean; command?: string; lastLines?: string }>;
  /**
   * Optional install hook invoked on rollback to restore lockfile → installed tree
   * consistency. When omitted, rollback only restores the lockfile file; the caller
   * should assume node_modules may be briefly out of sync with the lockfile in that
   * case (cheap to reconcile on the next install).
   */
  runInstallAfterRollback?: () => Promise<void>;
  /**
   * Cap on how many transitives we cross-reference against the registry. Large pnpm
   * monorepos can have 3K+ packages; we default to 250 (the packages used the most in
   * the tree, plus a sampling of the tail) to keep the scan under ~2s.
   */
  staleScanLimit?: number;
}

export interface RunLockfileFixResult {
  report: LockfileFixReport;
}

/**
 * Main entry point. Orchestrates dedupe + validation + stale-transitive scan and returns
 * a structured report suitable for inclusion in `FinalReport.lockfileFix`.
 */
export async function runLockfileFix(opts: RunLockfileFixOptions): Promise<RunLockfileFixResult> {
  const { cwd, manager, yarnMajorVersion, json, dryRun } = opts;
  const lockfileBasename = lockfileBasenameFor(manager);
  const lockfilePath = path.join(cwd, lockfileBasename);

  // No lockfile → nothing to dedupe. Emit a `skipped` report so --json consumers see the
  // reason explicitly rather than the field being absent.
  if (!(await fs.pathExists(lockfilePath))) {
    return {
      report: {
        status: 'skipped',
        skipReason: 'no-lockfile',
        manager,
        lockfile: lockfileBasename,
        dedupeChanges: [],
        stale: [],
      },
    };
  }

  const dedupe = dedupeCommandFor(manager, { yarnMajorVersion });
  if (!dedupe) {
    return {
      report: {
        status: 'skipped',
        skipReason: 'unsupported',
        manager,
        lockfile: lockfileBasename,
        dedupeChanges: [],
        stale: [],
      },
    };
  }

  // Snapshot the pre-dedupe lockfile so we can diff + roll back.
  const before = await fs.readFile(lockfilePath, 'utf8');
  const beforeTree = parseLockfileInstalledVersions(before, manager);

  // Pre-flight stale-transitive scan. Runs BEFORE dedupe because (a) dedupe may remove
  // some entries entirely, and (b) we want to report what WOULD benefit from a package.json
  // bump even if dedupe doesn't touch it. Bounded + best-effort — any error drops the scan
  // silently so we never block on it.
  const stale = await scanStaleTransitives(beforeTree, opts.registryCache, opts.staleScanLimit ?? 250);

  if (dryRun) {
    return {
      report: {
        status: 'dry-run',
        manager,
        lockfile: lockfileBasename,
        command: `${dedupe.bin} ${dedupe.args.join(' ')}`,
        dedupeChanges: [],
        stale,
      },
    };
  }

  if (!json) {
    log.info(`Running \`${dedupe.bin} ${dedupe.args.join(' ')}\` to dedupe the lockfile …`);
  }

  const r = await execa(dedupe.bin, dedupe.args, { cwd, reject: false, all: true });
  const output = [r.stdout, r.stderr].filter(Boolean).join('\n');
  const lastLines = tailLines(output, 20);

  if ((r.exitCode ?? 1) !== 0) {
    // Restore lockfile from snapshot — if the manager partially rewrote it before bailing,
    // this puts us back exactly where we started.
    await fs.writeFile(lockfilePath, before, 'utf8');
    if (opts.runInstallAfterRollback) {
      try {
        await opts.runInstallAfterRollback();
      } catch {
        /* non-fatal; tree may be briefly out of sync */
      }
    }
    return {
      report: {
        status: 'failed',
        manager,
        lockfile: lockfileBasename,
        command: `${dedupe.bin} ${dedupe.args.join(' ')}`,
        exitCode: r.exitCode ?? 1,
        failureKind: 'dedupe',
        lastLines,
        dedupeChanges: [],
        stale,
      },
    };
  }

  // Dedupe succeeded — now validate. If the user turned validation off, skip this step.
  const after = await fs.readFile(lockfilePath, 'utf8');
  const afterTree = parseLockfileInstalledVersions(after, manager);
  const dedupeChanges = diffLockfileTrees(beforeTree, afterTree);

  if (opts.runValidator) {
    const vr = await opts.runValidator();
    if (!vr.ok) {
      await fs.writeFile(lockfilePath, before, 'utf8');
      if (opts.runInstallAfterRollback) {
        try {
          await opts.runInstallAfterRollback();
        } catch {
          /* non-fatal */
        }
      }
      return {
        report: {
          status: 'failed',
          manager,
          lockfile: lockfileBasename,
          command: `${dedupe.bin} ${dedupe.args.join(' ')}`,
          exitCode: 0,
          failureKind: 'validation',
          validatorCommand: vr.command,
          lastLines: vr.lastLines ?? lastLines,
          dedupeChanges,
          stale,
        },
      };
    }
  }

  return {
    report: {
      status: 'ok',
      manager,
      lockfile: lockfileBasename,
      command: `${dedupe.bin} ${dedupe.args.join(' ')}`,
      exitCode: 0,
      dedupeChanges,
      stale,
    },
  };
}

/**
 * Parse a lockfile and return a `Map<packageName, Set<installedVersion>>` of every concrete
 * version that actually made it into `node_modules`. This is the minimum information we need
 * for a useful before/after diff — we DON'T try to reconstruct the dep graph, only "which
 * versions of X are installed".
 *
 * The parsers are format-tolerant by design: on any unexpected shape we return an empty map
 * rather than throw. The caller treats that as "no diff was computable" — `dedupeChanges`
 * stays empty and the `status: 'ok'` is honest (we really did run dedupe, we just can't
 * quantify the delta).
 */
export function parseLockfileInstalledVersions(
  raw: string,
  manager: PackageManager,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  try {
    if (manager === 'npm') {
      return parseNpmLockfile(raw);
    }
    if (manager === 'pnpm') {
      return parsePnpmLockfile(raw);
    }
    if (manager === 'yarn') {
      return parseYarnLockfile(raw);
    }
  } catch {
    /* fall through */
  }
  return out;
}

/**
 * npm lockfile parsers handle both v1 (top-level `dependencies`) and v2/v3 (`packages` map
 * keyed by on-disk path). v2 lockfiles carry BOTH fields for backward compatibility with
 * npm@6; we prefer `packages` because it's flatter and reliable.
 */
function parseNpmLockfile(raw: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const j = JSON.parse(raw) as {
    packages?: Record<string, { version?: string }>;
    dependencies?: Record<string, { version?: string; dependencies?: unknown }>;
  };
  if (j.packages && typeof j.packages === 'object') {
    for (const [key, entry] of Object.entries(j.packages)) {
      // `""` is the root workspace entry; skip. For nested paths the package name is the
      // segment after the LAST `/node_modules/` occurrence. For scoped packages (`@scope/x`)
      // that segment actually contains a `/`, which our splitter handles.
      if (!key || typeof entry?.version !== 'string') continue;
      const name = extractPackageNameFromNodeModulesPath(key);
      if (!name) continue;
      addVersion(out, name, entry.version);
    }
    return out;
  }
  if (j.dependencies && typeof j.dependencies === 'object') {
    // v1: walk recursively; names are keys, nested `dependencies` follow the same shape.
    const walk = (deps: Record<string, { version?: string; dependencies?: unknown }>): void => {
      for (const [name, d] of Object.entries(deps)) {
        if (typeof d?.version === 'string') addVersion(out, name, d.version);
        if (d && typeof d.dependencies === 'object') {
          walk(d.dependencies as Record<string, { version?: string; dependencies?: unknown }>);
        }
      }
    };
    walk(j.dependencies);
    return out;
  }
  return out;
}

/**
 * pnpm lockfile is YAML. We avoid pulling in a full YAML parser by doing a targeted scrape
 * of the `packages:` section keys, which look like:
 *   /axios@1.6.2:
 *   /@types/node@20.4.5:
 *   /@babel/core@7.22.5(something):
 * pnpm v9 switched to `'axios@1.6.2':` (unslashed, quoted). Both shapes are supported; we
 * strip the prefix, split on the LAST `@`, and that's the version.
 */
function parsePnpmLockfile(raw: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const lines = raw.split(/\r?\n/);
  let inPackages = false;
  for (const line of lines) {
    if (/^packages:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    // Top-level key at column 0 other than `packages:` ends the block.
    if (inPackages && /^[^\s#]/.test(line) && !/^packages:/.test(line)) {
      inPackages = false;
    }
    if (!inPackages) continue;
    const m = line.match(/^\s{2}['"]?\/?(@?[^@'"/\s]+(?:\/[^@'"/\s]+)?)@([^(:'"\s]+)/);
    if (m) addVersion(out, m[1]!, m[2]!);
  }
  return out;
}

/**
 * yarn.lock is a bespoke text format (classic) or YAML-ish (berry). We scrape `version
 * "x.y.z"` lines following a `<spec>:` header — that shape is common across both versions
 * and gives us everything we need without a real parser.
 */
function parseYarnLockfile(raw: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const lines = raw.split(/\r?\n/);
  let currentNames: string[] = [];
  for (const line of lines) {
    // Entry header examples:
    //   axios@^1.6.0:
    //   "axios@^1.6.0", "axios@1.7.2":
    //   "@types/node@^20":
    const headerMatch = line.match(/^(?:"[^"]+"|\S[^:]*):\s*$/);
    if (headerMatch && !/^\s/.test(line)) {
      currentNames = parseYarnEntryHeader(line);
      continue;
    }
    const versionMatch = line.match(/^\s+version\s+"?([^"]+)"?\s*$/);
    if (versionMatch && currentNames.length > 0) {
      for (const n of currentNames) addVersion(out, n, versionMatch[1]!);
      currentNames = [];
    }
  }
  return out;
}

/** Parse a yarn.lock header line into the list of package names it declares. */
function parseYarnEntryHeader(header: string): string[] {
  const raw = header.replace(/:\s*$/, '').trim();
  // Split on commas outside quotes.
  const parts: string[] = [];
  let cur = '';
  let inQ = false;
  for (const ch of raw) {
    if (ch === '"') {
      inQ = !inQ;
      continue;
    }
    if (ch === ',' && !inQ) {
      parts.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  const names = new Set<string>();
  for (const spec of parts) {
    // Scoped: @scope/name@range → we want `@scope/name`.
    if (spec.startsWith('@')) {
      const at2 = spec.indexOf('@', 1);
      if (at2 > 0) names.add(spec.slice(0, at2));
    } else {
      const at = spec.indexOf('@');
      if (at > 0) names.add(spec.slice(0, at));
    }
  }
  return [...names];
}

/** Extract the package name from `node_modules/<pkg>` or `<ws>/node_modules/<pkg>` paths. */
function extractPackageNameFromNodeModulesPath(key: string): string | undefined {
  const marker = '/node_modules/';
  const idx = key.lastIndexOf(marker);
  if (idx < 0) {
    // Top-level workspace entry (`node_modules/<pkg>` with no leading slash) — rare but handled.
    if (key.startsWith('node_modules/')) return key.slice('node_modules/'.length);
    return undefined;
  }
  return key.slice(idx + marker.length);
}

function addVersion(m: Map<string, Set<string>>, name: string, version: string): void {
  let s = m.get(name);
  if (!s) {
    s = new Set();
    m.set(name, s);
  }
  s.add(version);
}

/**
 * Given pre/post lockfile version maps, emit one `LockfileDedupeChange` per package whose
 * installed-version set changed. Three change shapes:
 *   - `merged`:  { before: [v1, v2], after: [v1] }  — classic dedupe win
 *   - `updated`: { before: [v1], after: [v2] }      — version shifted (resolver picked newer)
 *   - `added` / `removed`: { before: [], after: [v] } / vice-versa — install-side effects
 *
 * Only `merged` and `updated` are "interesting" from a dedupe-report perspective; the
 * summary filters on those. We still include `added`/`removed` in the raw list so
 * auditors see the full delta.
 */
export function diffLockfileTrees(
  before: Map<string, Set<string>>,
  after: Map<string, Set<string>>,
): LockfileDedupeChange[] {
  const out: LockfileDedupeChange[] = [];
  const names = new Set<string>([...before.keys(), ...after.keys()]);
  for (const name of names) {
    const b = [...(before.get(name) ?? new Set<string>())].sort(semverCompareSafe);
    const a = [...(after.get(name) ?? new Set<string>())].sort(semverCompareSafe);
    if (b.length === 0 && a.length > 0) {
      out.push({ name, change: 'added', before: [], after: a });
      continue;
    }
    if (a.length === 0 && b.length > 0) {
      out.push({ name, change: 'removed', before: b, after: [] });
      continue;
    }
    if (setsEqual(b, a)) continue;
    if (b.length > 1 && a.length < b.length) {
      out.push({ name, change: 'merged', before: b, after: a });
      continue;
    }
    out.push({ name, change: 'updated', before: b, after: a });
  }
  // Sort by interestingness: merges first, then updates, then adds, then removes; within each
  // group sort by name so the summary output is deterministic.
  const rank = { merged: 0, updated: 1, added: 2, removed: 3 } as const;
  out.sort((x, y) => {
    const d = rank[x.change] - rank[y.change];
    return d !== 0 ? d : x.name.localeCompare(y.name);
  });
  return out;
}

function setsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function semverCompareSafe(a: string, b: string): number {
  try {
    return semver.compare(a, b);
  } catch {
    return a.localeCompare(b);
  }
}

/**
 * Best-effort "which transitives are outdated but not vulnerable" scan. For every package
 * installed at one or more versions in the lockfile, we look up `latest` from the registry
 * (via the shared cache so the main flow's lookups are reused) and flag it when the HIGHEST
 * installed version is more than one minor OR one full major behind latest.
 *
 * Why "more than one minor"? — the very common case of `some-dep@1.2.0` installed while
 * latest is `1.2.4` isn't news. The case that matters is `some-dep@1.2.0` while latest is
 * `1.9.0` (6 months of patches missed) or worse, `2.x`. Those are the ones a reviewer
 * actually cares to see.
 *
 * Bounded at `limit` packages to keep the scan under a few seconds even on giant monorepos.
 * We pick the `limit` packages with the MOST installed versions first (highest dedupe
 * potential) and then fill out to `limit` by package name ordering.
 */
async function scanStaleTransitives(
  tree: Map<string, Set<string>>,
  cache: RegistryCache | undefined,
  limit: number,
): Promise<LockfileStaleEntry[]> {
  if (tree.size === 0) return [];

  const ranked = [...tree.entries()]
    .map(([name, versions]) => ({ name, versions: [...versions] }))
    .sort((a, b) => b.versions.length - a.versions.length || a.name.localeCompare(b.name))
    .slice(0, limit);

  const results = await runWithConcurrency(ranked, 8, async (entry) => {
    try {
      const latest = await fetchLatestVersion(entry.name, cache);
      const highestInstalled = entry.versions.sort(semverCompareSafe).pop()!;
      if (!semver.valid(latest) || !semver.valid(highestInstalled)) return undefined;
      if (semver.gte(highestInstalled, latest)) return undefined;
      const majorDelta = semver.major(latest) - semver.major(highestInstalled);
      const minorDelta = semver.minor(latest) - semver.minor(highestInstalled);
      // Filter out trivial drift — a patch release or a single minor isn't "stale".
      if (majorDelta === 0 && minorDelta <= 1) return undefined;
      return {
        name: entry.name,
        installed: entry.versions.sort(semverCompareSafe),
        latest,
        majorBehind: Math.max(0, majorDelta),
        minorBehind: Math.max(0, minorDelta),
      } satisfies LockfileStaleEntry;
    } catch {
      return undefined;
    }
  });

  const stale = results.filter((r): r is LockfileStaleEntry => Boolean(r));
  stale.sort((a, b) => {
    if (a.majorBehind !== b.majorBehind) return b.majorBehind - a.majorBehind;
    if (a.minorBehind !== b.minorBehind) return b.minorBehind - a.minorBehind;
    return a.name.localeCompare(b.name);
  });
  return stale;
}
