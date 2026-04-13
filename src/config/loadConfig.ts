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
    return {
      ignore: parsed.ignore?.map(String) ?? [],
      linkedGroups: linkedGroups ?? [],
    };
  } catch {
    return {};
  }
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
