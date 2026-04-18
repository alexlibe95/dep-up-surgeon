import path from 'node:path';
import fs from 'fs-extra';

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

    return {
      ignore: parsed.ignore?.map(String) ?? [],
      linkedGroups: linkedGroups ?? [],
      ...(validate !== undefined ? { validate } : {}),
    };
  } catch {
    return {};
  }
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
