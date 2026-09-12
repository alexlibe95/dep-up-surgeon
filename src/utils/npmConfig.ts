/**
 * Registry settings from npm config for dep-up-surgeon's own registry lookups. pacote does not
 * read `.npmrc` by itself, so without this every lookup hit registry.npmjs.org anonymously:
 * private `@scope:registry` packages 404'd and corporate mirrors were bypassed.
 *
 * Only the keys that affect fetching are forwarded, in npm's precedence order
 * (global < user < project < `npm_config_*` env): `registry`, `@scope:registry`, nerf-darted
 * per-registry auth (`//host/:_authToken`, …), TLS (`strict-ssl`, `ca`, `cafile`) and proxies.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type RegistryOptions = Record<string, unknown>;

let current: RegistryOptions | undefined;

/** Parse `.npmrc` text: `key = value` lines, `;` / `#` comments, quoted values, `${ENV}` refs. */
export function parseNpmrc(
  text: string,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) {
      continue;
    }
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    out[expandEnv(line.slice(0, eq).trim(), env)] = expandEnv(value, env);
  }
  return out;
}

/** npm's `${NAME}` expansion: `${NAME?}` becomes empty when unset, a plain unset ref stays literal. */
function expandEnv(s: string, env: NodeJS.ProcessEnv): string {
  return s.replace(/\$\{([^${}?]+)(\?)?\}/g, (match, name: string, optional?: string) => {
    const v = env[name];
    if (v !== undefined) {
      return v;
    }
    return optional ? '' : match;
  });
}

function readNpmrc(file: string, env: NodeJS.ProcessEnv): Record<string, string> {
  try {
    return parseNpmrc(fs.readFileSync(file, 'utf8'), env);
  } catch {
    return {};
  }
}

/** `npm_config_*` env vars → config keys, normalized the way npm does (`strict_ssl` → `strict-ssl`). */
function envConfig(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (!value || !/^npm_config_/i.test(name)) {
      continue;
    }
    const key = name.slice('npm_config_'.length);
    out[key.startsWith('//') ? key : key.replace(/(?!^)_/g, '-').toLowerCase()] = value;
  }
  return out;
}

function toFetchOptions(cfg: Record<string, string>): RegistryOptions {
  const out: RegistryOptions = {};
  for (const [key, value] of Object.entries(cfg)) {
    // npm-registry-fetch reads these verbatim: the default and scoped registries, and every
    // nerf-darted per-registry credential (`//npm.corp.example/:_authToken`).
    if (key === 'registry' || /^@[^:]+:registry$/.test(key) || key.startsWith('//')) {
      out[key] = value;
    }
  }
  if (cfg['strict-ssl'] !== undefined) {
    out.strictSSL = cfg['strict-ssl'] !== 'false';
  }
  if (cfg.ca) {
    out.ca = cfg.ca;
  } else if (cfg.cafile) {
    try {
      out.ca = fs.readFileSync(cfg.cafile, 'utf8');
    } catch {
      // An unreadable cafile falls back to the default CA store instead of failing every lookup.
    }
  }
  if (cfg['https-proxy']) {
    out.httpsProxy = cfg['https-proxy'];
  }
  if (cfg.proxy) {
    out.proxy = cfg.proxy;
  }
  if (cfg.noproxy) {
    out.noProxy = cfg.noproxy;
  }
  return out;
}

/**
 * Resolve fetch options for the project at `cwd` and make them what `registryOptions()` returns.
 * The CLI calls this once with the resolved `--cwd`.
 */
export function initRegistryOptions(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): RegistryOptions {
  const globalrc =
    env.npm_config_globalconfig ??
    env.NPM_CONFIG_GLOBALCONFIG ??
    path.resolve(path.dirname(process.execPath), '..', 'etc', 'npmrc');
  const userrc =
    env.npm_config_userconfig ?? env.NPM_CONFIG_USERCONFIG ?? path.join(os.homedir(), '.npmrc');
  current = toFetchOptions({
    ...readNpmrc(globalrc, env),
    ...readNpmrc(userrc, env),
    ...readNpmrc(path.join(cwd, '.npmrc'), env),
    ...envConfig(env),
  });
  return current;
}

/** Options to spread into every pacote call (loaded from `process.cwd()` on first use). */
export function registryOptions(): RegistryOptions {
  return current ?? initRegistryOptions(process.cwd());
}
