/**
 * "Blast radius": best-effort scan of project source files to list which files actually import
 * (or `require`) a given package. Surfaced in the summary + JSON report so reviewers can see
 * "this bump of `axios` touches 3 source files", not just the abstract version change.
 *
 * Design notes:
 *   - Plain regex over text, NOT a real AST. Cheap, streaming, and survives experimental syntax
 *     that any AST parser would choke on. False positives are possible (import strings inside
 *     comments) but the signal-to-noise ratio is very high in practice.
 *   - Results are FILES with a hit, not exact line numbers — a clickable file list is what
 *     reviewers want. We also expose a `total` count so a monorepo with 500 hits doesn't blow
 *     up the markdown.
 *   - We intentionally skip `node_modules`, `dist`, `build`, `.git`, `coverage`, `.next`,
 *     `.turbo`, `.vercel` — anything that is a build artifact or another tool's cache. Users
 *     who need to scan inside those can pass an empty `skipDirs` (programmatic use only).
 *   - Scans are capped: at most `MAX_FILES` files per package, at most `MAX_BYTES` per file,
 *     and the whole pass runs with `concurrency` I/O workers. Tuned for interactive CLI usage,
 *     not for indexing huge repos.
 */
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import fs from 'fs-extra';

/**
 * Per-package cap on the absolute number of files we *list* in the result. The underlying scan
 * still counts beyond the cap into `total`, so the summary can say "used in 200+ files".
 */
export const DEFAULT_MAX_FILES = 20;

/** Hard cap on bytes read per file to protect against absurd source bundles. */
const MAX_BYTES = 1024 * 1024;

/** Directories never descended into. */
const DEFAULT_SKIP_DIRS = new Set<string>([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.next',
  '.turbo',
  '.vercel',
  '.cache',
  '.parcel-cache',
  'out',
  '.output',
]);

/** Extensions we actually scan. Everything else is skipped outright. */
const DEFAULT_EXTENSIONS = new Set<string>([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
  '.vue',
  '.svelte',
  '.astro',
]);

export interface BlastRadiusHit {
  /** Absolute path to the file that imported the package. */
  file: string;
  /** Source-root-relative path (preferred for display). */
  relativePath: string;
  /** Total match count within the file (dedupe-safe upper bound for sorting). */
  matches: number;
}

export interface BlastRadiusResult {
  /** Per-package list of hits, capped to `maxFiles`. */
  byPackage: Map<string, { total: number; truncated: boolean; hits: BlastRadiusHit[] }>;
  /** Diagnostic: files scanned (after extension filter). */
  filesScanned: number;
  /** Diagnostic: bytes read (after `MAX_BYTES` cap). */
  bytesRead: number;
}

export interface ComputeBlastRadiusOptions {
  /** Workspace root. All scanning descends from here. */
  cwd: string;
  /** Package names to look for. Anything else is ignored. */
  packageNames: readonly string[];
  /** File extensions to scan (default: the common JS/TS family). */
  extensions?: Set<string>;
  /** Directory basenames to skip (default: see `DEFAULT_SKIP_DIRS`). */
  skipDirs?: Set<string>;
  /** Max files listed per package (the `total` count keeps going past this cap). */
  maxFiles?: number;
  /** Parallel file readers. Default 8, capped at 32. */
  concurrency?: number;
}

/**
 * Public entry point. Walks the tree, reads each source file once, and scans it for ALL
 * requested packages in a single pass (much cheaper than one regex per package). Returns a
 * map keyed by package name.
 */
export async function computeBlastRadius(
  opts: ComputeBlastRadiusOptions,
): Promise<BlastRadiusResult> {
  const extensions = opts.extensions ?? DEFAULT_EXTENSIONS;
  const skipDirs = opts.skipDirs ?? DEFAULT_SKIP_DIRS;
  const maxFiles = Math.max(1, Math.floor(opts.maxFiles ?? DEFAULT_MAX_FILES));
  const concurrency = Math.min(Math.max(1, Math.floor(opts.concurrency ?? 8)), 32);
  const packageNames = [...new Set(opts.packageNames)].filter(Boolean);

  const byPackage = new Map<string, { total: number; truncated: boolean; hits: BlastRadiusHit[] }>();
  if (packageNames.length === 0) {
    return { byPackage, filesScanned: 0, bytesRead: 0 };
  }
  for (const name of packageNames) {
    byPackage.set(name, { total: 0, truncated: false, hits: [] });
  }

  // Pre-compile one regex per package name. Each regex matches:
  //   - from '<pkg>'            (ES import + re-export)
  //   - from "<pkg>"            (double quotes)
  //   - require('<pkg>')        (CommonJS)
  //   - import('<pkg>')         (dynamic import)
  //   - from '<pkg>/sub'        (subpath imports — we still consider it a hit on `<pkg>`)
  //   - from "<pkg>/sub/leaf"
  const perPkgRegex = new Map<string, RegExp>();
  for (const name of packageNames) {
    const esc = escapeRegex(name);
    // Capture group around `<pkg>` + optional subpath. `(?![\w-])` ensures that scanning for
    // `react` doesn't match `react-dom`, and scanning for `@types/node` doesn't match
    // `@types/node-ipc`. Does NOT anchor to start-of-line: we want matches inside any position.
    const re = new RegExp(
      `(?:from|require|import)\\s*\\(?\\s*["']${esc}(?:/[^"']*)?["']`,
      'g',
    );
    perPkgRegex.set(name, re);
  }

  const files: string[] = [];
  await walk(opts.cwd, skipDirs, extensions, files);

  let filesScanned = 0;
  let bytesRead = 0;

  // Tiny hand-rolled concurrency pool to avoid pulling in yet another dep just for this.
  let idx = 0;
  const worker = async (): Promise<void> => {
    while (idx < files.length) {
      const i = idx++;
      const file = files[i]!;
      filesScanned++;
      let content = '';
      try {
        const stat = await fs.stat(file);
        if (stat.size > MAX_BYTES) {
          const fh = await fsp.open(file, 'r');
          try {
            const buf = Buffer.alloc(MAX_BYTES);
            const { bytesRead: n } = await fh.read(buf, 0, MAX_BYTES, 0);
            content = buf.subarray(0, n).toString('utf8');
          } finally {
            await fh.close();
          }
        } else {
          content = await fs.readFile(file, 'utf8');
        }
        bytesRead += content.length;
      } catch {
        continue;
      }

      // Cheap filter: if neither "from" nor "require" nor "import" appears at all in the file,
      // skip the per-package regex loop entirely. Surprisingly common for binary-ish files
      // masquerading as .js (e.g. minified worker bundles) and TS declarations.
      if (!/(?:from|require|import)/.test(content)) {
        continue;
      }

      for (const [name, re] of perPkgRegex) {
        re.lastIndex = 0;
        let count = 0;
        while (re.exec(content) !== null) {
          count++;
          if (count > 10) break; // cap matches per file; 10 is plenty for sorting
        }
        if (count === 0) continue;
        const rec = byPackage.get(name)!;
        rec.total++;
        if (rec.hits.length < maxFiles) {
          rec.hits.push({
            file,
            relativePath: path.relative(opts.cwd, file) || path.basename(file),
            matches: count,
          });
        } else {
          rec.truncated = true;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Stable-sort each package's hits by match count desc, then relative path asc.
  for (const rec of byPackage.values()) {
    rec.hits.sort((a, b) => b.matches - a.matches || a.relativePath.localeCompare(b.relativePath));
  }

  return { byPackage, filesScanned, bytesRead };
}

async function walk(
  dir: string,
  skipDirs: Set<string>,
  extensions: Set<string>,
  out: string[],
): Promise<void> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean }>;
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as unknown as typeof entries;
  } catch {
    return;
  }
  for (const ent of entries) {
    const name = ent.name;
    if (name.startsWith('.') && skipDirs.has(name)) {
      continue;
    }
    const abs = path.join(dir, name);
    if (ent.isDirectory()) {
      if (skipDirs.has(name)) continue;
      await walk(abs, skipDirs, extensions, out);
    } else if (ent.isFile()) {
      const ext = path.extname(name).toLowerCase();
      if (extensions.has(ext)) {
        out.push(abs);
      }
    }
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
