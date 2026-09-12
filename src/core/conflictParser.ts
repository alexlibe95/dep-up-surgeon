/**
 * Parse npm install / npm ci combined stdout+stderr into structured conflicts (plus the peer
 * diagnostics pnpm, yarn classic / berry and bun print).
 * Patterns are generic — no package names are hard-coded.
 */

import type { Conflict } from '../types.js';

export type { Conflict } from '../types.js';

function conflictDedupeKey(c: Pick<Conflict, 'depender' | 'dependency' | 'requiredRange' | 'installedVersion' | 'attemptedVersion'>): string {
  return `${c.depender}|${c.dependency}|${c.requiredRange}|${c.installedVersion ?? ''}|${c.attemptedVersion ?? ''}`;
}

function pushUnique(out: Conflict[], c: Conflict): void {
  const key = conflictDedupeKey(c);
  if (out.some((x) => conflictDedupeKey(x) === key)) {
    return;
  }
  out.push(c);
}

/**
 * Deduplicate parsed conflict rows (e.g. same edge from line + whole-log fallbacks, or
 * repeated npm lines).
 */
export function dedupeConflicts(list: Conflict[]): Conflict[] {
  const out: Conflict[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    const key = conflictDedupeKey(c);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** npm 9/10+ “peer (Optional) <pkg>@"<range>" from <dep>@<ver>” (warn, error, or ERESOLVE). */
const PEER_QUOTED_RANGE_FROM: RegExp =
  /\b(?:peer|peerOptional)\s+((?:@[^/\s]+\/)?[^\s@]+)@"([^"]+)"\s+from\s+((?:@[^/\s]+\/)?[^\s@]+)@([^\s]+)/i;

const LINE_PATTERNS: Array<{
  re: RegExp;
  map: (m: RegExpMatchArray) => Omit<Conflict, 'rawMessage'> | null;
}> = [
  // First: npm 10+ / warn “peer <pkg>@"<range>" from <dep>@<ver>” (must win over
  // “Conflicting peer dependency: <pkg>@<ver>” and “While resolving:”, which are
  // low-signal or context-only and would otherwise steal the line in multi-pattern
  // order).
  {
    re: PEER_QUOTED_RANGE_FROM,
    map: (m) => ({
      depender: `${m[3]!}@${m[4]!}`,
      dependency: m[1]!,
      requiredRange: m[2]!,
    }),
  },
  // yarn classic: `warning " > @testing-library/react@16.0.0" has unmet peer dependency "react@^18.0.0".`
  // (`incorrect` when a copy is installed but out of range). The depender is the last `>` hop.
  {
    re: /warning\s+"([^"]*)"\s+has\s+(?:unmet|incorrect)\s+peer dependency\s+"([^"]+)"/i,
    map: (m) => {
      const peer = parsePackageSpec(m[2]!);
      return {
        depender: m[1]!.split('>').pop()!.trim() || 'unknown',
        dependency: peer.name,
        requiredRange: peer.version ?? '*',
      };
    },
  },
  // yarn berry YN0060: `react is listed by your project with version 17.0.2 (p1a2b3), which
  // doesn't satisfy what @testing-library/react requests (^18.0.0).`
  {
    re: /YN0060:.*?((?:@[^/\s]+\/)?[^\s@]+) is listed by your project with version (\S+?)(?: \([^)]*\))?, which doesn't satisfy what ((?:@[^/\s]+\/)?[^\s@]+)(?: and (?:\d+ )?other dependenc(?:y|ies))? requests? \(([^)]+)\)/i,
    map: (m) => ({
      depender: m[3]!,
      dependency: m[1]!,
      requiredRange: m[4]!,
      installedVersion: m[2]!,
    }),
  },
  // yarn berry YN0002: `my-app@workspace:. doesn't provide react (p4c5d6), requested by
  // @testing-library/react.` — no range is printed.
  {
    re: /YN0002:.*? doesn't provide ((?:@[^/\s]+\/)?[^\s@]+)(?: \([^)]*\))?, requested by (\S+?)\.?$/i,
    map: (m) => ({
      depender: m[2]!,
      dependency: m[1]!,
      requiredRange: '*',
    }),
  },
  // yarn berry YN0086: summary pointer for peer issues it doesn't list individually.
  {
    re: /YN0086:/,
    map: () => ({
      depender: 'unknown',
      dependency: 'unknown',
      requiredRange: '*',
    }),
  },
  // bun: `warn: incorrect peer dependency "react@17.0.2"` — only the installed copy is printed.
  {
    re: /warn: incorrect peer dependency "([^"]+)"/i,
    map: (m) => {
      const p = parsePackageSpec(m[1]!);
      if (!p.version) {
        return null;
      }
      return {
        depender: 'unknown',
        dependency: p.name,
        requiredRange: '*',
        installedVersion: p.version,
      };
    },
  },
  // npm peer missing
  {
    re: /requires a peer of\s+([^\s@]+(?:\/[^\s@]+)?@([^\s]+))\s+but none is installed/i,
    map: (m) => ({
      depender: 'unknown',
      dependency: m[1]!.split('@')[0] ?? m[1]!,
      requiredRange: m[2] ?? '',
    }),
  },
  {
    re: /peer\s+([^\s]+)\s+requires\s+([^\s@]+(?:\/[^\s@]+)?@([^\s]+))/i,
    map: (m) => ({
      depender: m[1]!,
      dependency: m[2]!.replace(/@[^@]+$/, ''),
      requiredRange: m[3] ?? '',
    }),
  },
  {
    re: /peer dep(?:endency)?\s+missing:\s+([^\s@]+(?:\/[^\s@]+)?@([^\s]+))/i,
    map: (m) => ({
      depender: 'unknown',
      dependency: m[1]!.split('@')[0] ?? m[1]!,
      requiredRange: m[2] ?? '',
    }),
  },
  {
    re: /peer dep(?:endency)?\s+missing:\s+([^\s@]+(?:\/[^\s@]+)?)\s+@\s*([^\s]+)/i,
    map: (m) => ({
      depender: 'unknown',
      dependency: m[1]!.trim(),
      requiredRange: m[2] ?? '',
    }),
  },
  {
    /** npm prints `incorrect peer dependency: react@18.2.0` (no space before `@`). */
    re: /incorrect peer dependency:\s+(.+)$/i,
    map: (m) => {
      const p = parsePackageSpec(m[1]!.trim());
      if (!p.version) {
        return null;
      }
      return {
        depender: 'unknown',
        dependency: p.name,
        requiredRange: p.version,
        installedVersion: p.version,
      };
    },
  },
  {
    re: /peer dep(?:endency)?\s+not installed:\s+([^\s@]+(?:\/[^\s@]+)?@([^\s]+))/i,
    map: (m) => ({
      depender: 'unknown',
      dependency: m[1]!.split('@')[0] ?? m[1]!,
      requiredRange: m[2] ?? '',
    }),
  },
  {
    /** npm often prints `Could not resolve dependency: foo@1.0.0` without space before `@`. */
    re: /Could not resolve dependency:\s+(.+)$/i,
    map: (m) => {
      const tail = m[1]!.trim();
      if (/^peer\s+/i.test(tail)) {
        return null;
      }
      const p = parsePackageSpec(tail);
      if (!p.version) {
        return null;
      }
      return {
        depender: 'unknown',
        dependency: p.name,
        requiredRange: p.version,
      };
    },
  },
  {
    re: /conflicting peer dependency:\s+(.+)$/i,
    map: (m) => {
      const p = parsePackageSpec(m[1]!.trim());
      if (!p.version) {
        return null;
      }
      return {
        depender: 'unknown',
        dependency: p.name,
        requiredRange: p.version,
        attemptedVersion: p.version,
      };
    },
  },
  {
    re: /Fix the upstream dependency conflict, or retry\s+with\s+--force[^\n]*\n[^\n]*\s+peer\s+([^\s]+)\s+from\s+([^\s@]+(?:\/[^\s@]+)?@([^\s]+))/i,
    map: (m) => ({
      depender: m[1]!,
      dependency: m[2]!.replace(/@[^@]+$/, ''),
      requiredRange: m[3] ?? '',
    }),
  },
  {
    re: /Unsupported engine[:\s]+(?:wanted:\s*\{[^}]*node[^}]*\}\s*)?\(current:\s*\{[^}]*node[^}]*\}\)/i,
    map: () => ({
      depender: 'unknown',
      dependency: 'node',
      requiredRange: '*',
    }),
  },
  {
    re: /EBADENGINE\s+Unsupported engine/i,
    map: () => ({
      depender: 'unknown',
      dependency: 'node',
      requiredRange: '*',
    }),
  },
];

/**
 * Extract scoped or unscoped package name from a specifier like "@scope/foo@1.2.3".
 */
export function parsePackageSpec(spec: string): { name: string; version?: string } {
  const t = spec.trim();
  const at = t.lastIndexOf('@');
  if (t.startsWith('@') && at > 0) {
    const name = t.slice(0, at);
    const version = t.slice(at + 1);
    return { name, version: version || undefined };
  }
  if (at > 0) {
    return { name: t.slice(0, at), version: t.slice(at + 1) };
  }
  return { name: t };
}

export interface ParseConflictsOptions {
  /**
   * Skip conflicts whose `dependency` field matches (e.g. root `package.json` `name`) when
   * npm’s generic patterns attach the root app name to a line.
   */
  skipDependencyNames?: Set<string>;
}

function shouldSkipDep(name: string, skip?: Set<string>): boolean {
  if (!skip || !name || name === 'unknown') {
    return false;
  }
  return skip.has(name);
}

/** SGR color codes (pnpm / yarn colorize under FORCE_COLOR); they split tokens the patterns need. */
const ANSI_SGR = /\u001b\[[0-9;]*m/g;

/** pnpm peer-issue tree parent row (archy): `├─┬ @testing-library/react 16.0.0`. */
const PNPM_TREE_PARENT = /[├└]─┬ (\S+) (\S+)\s*$/;

/**
 * pnpm 8+ peer-issue rows: `└── ✕ unmet peer react@"^18.0.0": found 17.0.2` and
 * `├── ✕ missing peer react-dom@^18.0.0` (range quoted only when it has spaces or is `*`).
 */
const PNPM_PEER_ISSUE =
  /(?:[├└]── )?✕ (unmet|missing) peer ((?:@[^/\s]+\/)?[^\s@]+)@(?:"([^"]+)"|(\S+?))(?:: found (\S+)(?: in \S+)?)?\s*$/;

/**
 * One line of a pnpm peer-issue tree. An issue's depender is its enclosing `┬ <name> <version>`
 * node: archy puts a child's `├──` / `└──` in the same column as the parent's `┬`, so `parents`
 * is keyed by that column. Returns `null` for parent rows, the conflict for issue rows, and
 * `undefined` for anything else.
 */
function parsePnpmTreeLine(
  line: string,
  parents: Map<number, string>,
): Omit<Conflict, 'rawMessage'> | null | undefined {
  const parent = PNPM_TREE_PARENT.exec(line);
  if (parent) {
    const col = parent.index + 2;
    for (const c of [...parents.keys()]) {
      if (c >= col) {
        parents.delete(c);
      }
    }
    parents.set(col, `${parent[1]!}@${parent[2]!}`);
    return null;
  }
  const issue = PNPM_PEER_ISSUE.exec(line);
  if (!issue) {
    if (!/[│├└]/.test(line)) {
      parents.clear();
    }
    return undefined;
  }
  let depender = 'unknown';
  if (line[issue.index] === '├' || line[issue.index] === '└') {
    let best = -1;
    for (const c of parents.keys()) {
      if (c <= issue.index && c > best) {
        best = c;
      }
    }
    depender = parents.get(best) ?? 'unknown';
  }
  return {
    depender,
    dependency: issue[2]!,
    requiredRange: issue[3] ?? issue[4]!,
    ...(issue[1] === 'unmet' && issue[5] ? { installedVersion: issue[5] } : {}),
  };
}

/**
 * Split install output (npm, plus pnpm / yarn / bun peer diagnostics) into lines and apply
 * regex extractors.
 */
export function parseConflictsFromNpmOutput(output: string, options?: ParseConflictsOptions): Conflict[] {
  const skip = options?.skipDependencyNames;
  const lines = (output || '').replace(ANSI_SGR, '').split(/\r?\n/);
  const out: Conflict[] = [];
  const pnpmParents = new Map<number, string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      pnpmParents.clear();
      continue;
    }
    const pnpmIssue = parsePnpmTreeLine(line, pnpmParents);
    if (pnpmIssue !== undefined) {
      if (pnpmIssue && !shouldSkipDep(pnpmIssue.dependency, skip)) {
        pushUnique(out, { ...pnpmIssue, rawMessage: trimmed });
      }
      continue;
    }
    for (const { re, map } of LINE_PATTERNS) {
      const m = trimmed.match(re);
      if (!m) {
        continue;
      }
      const partial = map(m);
      if (!partial) {
        continue;
      }
      let dependency = partial.dependency;
      if (dependency.includes('@')) {
        const p = parsePackageSpec(dependency);
        dependency = p.name;
      }
      if (shouldSkipDep(dependency, skip)) {
        break;
      }
      pushUnique(out, {
        ...partial,
        dependency,
        rawMessage: trimmed,
      });
      break;
    }
  }

  return out;
}

/**
 * Fallback when no structured lines matched but npm clearly failed resolution.
 *
 * We first try to extract the npm 10+ indented `peer <pkg>@"<range>" from <dep>@<ver>` blocks
 * (the same pattern the per-line parser scans for) — this is worth doing at the whole-output
 * level too, because some wrappers (pnpm, yarn-via-corepack) reformat npm's output and the
 * per-line scanner can miss them. Only when nothing structured matches do we emit the
 * catch-all `unknown ← unknown` marker so downstream consumers still see "something peer-ish
 * went wrong" instead of an empty list.
 */
export function parseEresolveFallback(output: string): Conflict[] {
  const t = output || '';
  const out: Conflict[] = [];
  const globalPeer = new RegExp(PEER_QUOTED_RANGE_FROM.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = globalPeer.exec(t)) !== null) {
    const dependency = match[1]!;
    const range = match[2]!;
    const dependerName = match[3]!;
    const dependerVer = match[4]!;
    pushUnique(out, {
      depender: `${dependerName}@${dependerVer}`,
      dependency,
      requiredRange: range,
      rawMessage: match[0]!,
    });
  }
  if (out.length > 0) {
    return out;
  }
  // pnpm strict mode: its issue tree (parsed line by line) is the structured part; the marker
  // only stands in when the log was cut before the tree.
  const pnpmStrictWithoutTree =
    /ERR_PNPM_PEER_DEP_ISSUES/.test(t) && !/✕ (?:unmet|missing) peer/.test(t);
  if (
    !pnpmStrictWithoutTree &&
    !/ERESOLVE|unable to resolve dependency tree|overriding peer dependency/i.test(t)
  ) {
    return [];
  }
  return [
    {
      depender: 'unknown',
      dependency: 'unknown',
      requiredRange: '*',
      rawMessage:
        t.split(/\r?\n/).find((l) => /ERESOLVE|unable to resolve|overriding peer|ERR_PNPM_PEER_DEP_ISSUES/i.test(l)) ??
        'ERESOLVE',
    },
  ];
}
