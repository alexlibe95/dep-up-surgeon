/**
 * Parse npm install / npm ci combined stdout+stderr into structured conflicts.
 * Patterns are generic — no package names are hard-coded.
 */

import type { Conflict } from '../types.js';

export type { Conflict } from '../types.js';

function pushUnique(out: Conflict[], c: Conflict): void {
  const key = `${c.depender}|${c.dependency}|${c.requiredRange}|${c.installedVersion ?? ''}|${c.attemptedVersion ?? ''}`;
  if (out.some((x) => `${x.depender}|${x.dependency}|${x.requiredRange}|${x.installedVersion ?? ''}|${x.attemptedVersion ?? ''}` === key)) {
    return;
  }
  out.push(c);
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

/**
 * Split npm output into lines and apply regex extractors.
 */
export function parseConflictsFromNpmOutput(output: string, options?: ParseConflictsOptions): Conflict[] {
  const skip = options?.skipDependencyNames;
  const lines = (output || '').split(/\r?\n/);
  const out: Conflict[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
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
  if (
    !/ERESOLVE|unable to resolve dependency tree|overriding peer dependency/i.test(t)
  ) {
    return [];
  }
  return [
    {
      depender: 'unknown',
      dependency: 'unknown',
      requiredRange: '*',
      rawMessage: t.split(/\r?\n/).find((l) => /ERESOLVE|unable to resolve|overriding peer/i.test(l)) ?? 'ERESOLVE',
    },
  ];
}
