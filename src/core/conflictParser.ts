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

const LINE_PATTERNS: Array<{
  re: RegExp;
  map: (m: RegExpMatchArray) => Omit<Conflict, 'rawMessage'> | null;
}> = [
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
    re: /incorrect peer dependency:\s+([^\s@]+(?:\/[^\s@]+)?)\s+@\s*([^\s]+)/i,
    map: (m) => ({
      depender: 'unknown',
      dependency: m[1]!.trim(),
      requiredRange: m[2] ?? '',
      installedVersion: m[2],
    }),
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
    re: /Could not resolve dependency:\s+([^\s@]+(?:\/[^\s@]+)?)\s+@\s*([^\s]+)/i,
    map: (m) => ({
      depender: 'unknown',
      dependency: m[1]!.trim(),
      requiredRange: m[2] ?? '',
    }),
  },
  {
    re: /conflicting peer dependency:\s+([^\s@]+(?:\/[^\s@]+)?)\s+@\s*([^\s]+)/i,
    map: (m) => ({
      depender: 'unknown',
      dependency: m[1]!.trim(),
      requiredRange: m[2] ?? '',
      attemptedVersion: m[2],
    }),
  },
  {
    re: /While resolving:\s+([^\s@]+(?:\/[^\s@]+)?)@([^\s]+)/i,
    map: (m) => ({
      depender: 'unknown',
      dependency: m[1]!.trim(),
      requiredRange: m[2] ?? '',
      attemptedVersion: m[2],
    }),
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
   * Skip conflicts whose dependency field matches (e.g. root `package.json` `name`).
   * npm often prints `While resolving: <app>@0.0.0` which is not a registry package conflict.
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
 */
export function parseEresolveFallback(output: string): Conflict[] {
  const t = output || '';
  if (!/ERESOLVE|unable to resolve dependency tree/i.test(t)) {
    return [];
  }
  return [
    {
      depender: 'unknown',
      dependency: 'unknown',
      requiredRange: '*',
      rawMessage: t.split(/\r?\n/).find((l) => /ERESOLVE|unable to resolve/i.test(l)) ?? 'ERESOLVE',
    },
  ];
}
