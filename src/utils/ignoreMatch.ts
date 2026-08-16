/**
 * Ignore-list matching for `--ignore` / rc / policy (global package names) and `--retry-failed`
 * (workspace-scoped `workspace::name` keys).
 *
 * User-authored ignore entries stay bare names and apply in every workspace. Retry auto-ignores
 * are keyed as `workspace::name` so a success or terminal failure in `@org/web` does not freeze
 * the same package in `@org/api` on the next run.
 */

export const IGNORE_SCOPE_SEP = '::';

export function scopedIgnoreKey(workspace: string, name: string): string {
  return `${workspace}${IGNORE_SCOPE_SEP}${name}`;
}

/** Persist / look up a retry ignore key. Missing workspace (root-only / old reports) stays bare. */
export function retryIgnoreKey(workspace: string | undefined, name: string): string {
  return workspace ? scopedIgnoreKey(workspace, name) : name;
}

/**
 * Split a namespaced id (`@org/web::lint-stack`) into workspace + bare id. Ids without `::`
 * (root-only group plans) return the whole string as `bare`.
 */
export function splitNamespacedId(id: string): { workspace?: string; bare: string } {
  const idx = id.indexOf(IGNORE_SCOPE_SEP);
  if (idx <= 0) {
    return { bare: id };
  }
  return { workspace: id.slice(0, idx), bare: id.slice(idx + IGNORE_SCOPE_SEP.length) };
}

/**
 * Copy `ignore` and, for the current target, promote matching `label::name` keys to bare
 * `name` so existing `ignore.has(scanned.name)` checks keep working. The original set is never
 * mutated — each workspace target gets its own copy so a freeze in one member cannot leak.
 */
export function materializeIgnoreForTarget(
  ignore: ReadonlySet<string>,
  targetLabel?: string,
): Set<string> {
  const out = new Set(ignore);
  if (!targetLabel) {
    return out;
  }
  const prefix = `${targetLabel}${IGNORE_SCOPE_SEP}`;
  for (const key of ignore) {
    if (key.startsWith(prefix)) {
      out.add(key.slice(prefix.length));
    }
  }
  return out;
}
