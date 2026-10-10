/**
 * Keep every other root lockfile in step with package.json after an upgrade run.
 *
 * Upgrades install with one manager and only rewrite its lockfile. Another manager's lockfile
 * (`package-lock.json` next to `bun.lock`, ...) would keep the old ranges while CI or a host may
 * still install from it — Netlify, for one, runs `npm install` when it finds `package-lock.json`,
 * so every deploy re-resolves whatever no longer matches package.json. Each such lockfile is
 * re-resolved by its own manager in lockfile-only mode: node_modules is not touched and no
 * install scripts run. A failed command puts the lockfile back exactly as it was.
 */
import path from 'node:path';
import fs from 'fs-extra';
import { execa } from 'execa';
import { describeRootLockfiles, probeYarnCapabilities, type PackageManager } from '../core/workspaces.js';
import type { LockfileSyncEntry } from '../types.js';
import { tailLines } from '../utils/output.js';

type SyncLockfile = LockfileSyncEntry['lockfile'];

const OWNER: Record<SyncLockfile, PackageManager> = {
  'package-lock.json': 'npm',
  'npm-shrinkwrap.json': 'npm',
  'pnpm-lock.yaml': 'pnpm',
  'yarn.lock': 'yarn',
  'bun.lock': 'bun',
  'bun.lockb': 'bun',
};

export interface SyncCommand {
  bin: string;
  args: string[];
  env?: Record<string, string>;
}

export interface SyncRunResult {
  exitCode: number;
  output: string;
  /** The binary isn't on PATH. */
  missingBinary?: boolean;
}

/** Runs one sync command; injectable so tests don't need every package manager installed. */
export type SyncRunner = (command: SyncCommand, cwd: string) => Promise<SyncRunResult>;

/**
 * The lockfile-only install that rewrites lockfiles of `manager`, or undefined when it has none:
 * Yarn classic and Yarn 2 (`--mode=update-lockfile` arrived in Yarn 3).
 */
export function lockfileSyncCommand(
  manager: PackageManager,
  yarnMajorVersion?: number,
): SyncCommand | undefined {
  switch (manager) {
    case 'npm':
      return {
        bin: 'npm',
        args: ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'],
      };
    case 'pnpm':
      // `CI` makes pnpm default to --frozen-lockfile, which refuses exactly this update.
      return { bin: 'pnpm', args: ['install', '--lockfile-only', '--ignore-scripts', '--no-frozen-lockfile'] };
    case 'bun':
      return { bin: 'bun', args: ['install', '--lockfile-only', '--ignore-scripts'] };
    case 'yarn':
      return yarnMajorVersion !== undefined && yarnMajorVersion >= 3
        ? {
            bin: 'yarn',
            args: ['install', '--mode=update-lockfile'],
            env: { YARN_ENABLE_IMMUTABLE_INSTALLS: 'false' },
          }
        : undefined;
  }
}

const runCommand: SyncRunner = async (command, cwd) => {
  const r = await execa(command.bin, command.args, {
    cwd,
    reject: false,
    all: true,
    ...(command.env ? { env: command.env } : {}),
  });
  return {
    exitCode: r.exitCode ?? 1,
    output: r.all ?? '',
    ...((r as { code?: string }).code === 'ENOENT' ? { missingBinary: true } : {}),
  };
};

export interface SyncStaleLockfilesOptions {
  /** Workspace root (where the root lockfiles live). */
  cwd: string;
  /** The manager the run installed with; its own lockfiles are already up to date. */
  manager: PackageManager;
  dryRun?: boolean;
  run?: SyncRunner;
  /** Yarn major, when already known; probed only when a yarn.lock needs syncing. */
  yarnMajorVersion?: number;
}

/**
 * Re-resolve every root lockfile that installing with `manager` doesn't rewrite. One command per
 * manager (npm writes `npm-shrinkwrap.json` instead of `package-lock.json` when both exist), one
 * report entry per lockfile. Returns `[]` when the project has only `manager`'s lockfiles.
 */
export async function syncStaleLockfiles(opts: SyncStaleLockfilesOptions): Promise<LockfileSyncEntry[]> {
  const { cwd, manager, dryRun } = opts;
  const run = opts.run ?? runCommand;
  const stale = describeRootLockfiles(cwd, manager).stale as SyncLockfile[];
  const byManager = new Map<PackageManager, SyncLockfile[]>();
  for (const file of stale) {
    const owner = OWNER[file];
    byManager.set(owner, [...(byManager.get(owner) ?? []), file]);
  }

  const entries: LockfileSyncEntry[] = [];
  for (const [owner, files] of byManager) {
    let yarnMajor = opts.yarnMajorVersion;
    if (owner === 'yarn' && yarnMajor === undefined) {
      yarnMajor = (await probeYarnCapabilities(cwd, { probeFocus: false })).major;
    }
    const command = lockfileSyncCommand(owner, yarnMajor);
    if (!command) {
      entries.push(...files.map((lockfile) => ({ lockfile, manager: owner, status: 'skipped' as const, skipReason: 'unsupported' as const })));
      continue;
    }
    const label = `${command.bin} ${command.args.join(' ')}`;
    if (dryRun) {
      entries.push(...files.map((lockfile) => ({ lockfile, manager: owner, status: 'dry-run' as const, command: label })));
      continue;
    }

    const before = new Map<SyncLockfile, Buffer>();
    for (const file of files) {
      before.set(file, await fs.readFile(path.join(cwd, file)));
    }
    const result = await run(command, cwd);
    if (result.missingBinary || result.exitCode !== 0) {
      // A manager can write part of a lockfile before failing; leave the file as the run found it.
      for (const [file, bytes] of before) {
        await fs.writeFile(path.join(cwd, file), bytes);
      }
      const lastLines = tailLines(result.output);
      entries.push(
        ...files.map((lockfile) =>
          result.missingBinary
            ? { lockfile, manager: owner, status: 'skipped' as const, skipReason: 'missing-binary' as const, command: label }
            : {
                lockfile,
                manager: owner,
                status: 'failed' as const,
                command: label,
                exitCode: result.exitCode,
                ...(lastLines ? { lastLines } : {}),
              },
        ),
      );
      continue;
    }
    for (const file of files) {
      const after = await fs.readFile(path.join(cwd, file)).catch(() => null);
      const changed = !after || !after.equals(before.get(file)!);
      entries.push({ lockfile: file, manager: owner, status: changed ? 'updated' : 'unchanged', command: label });
    }
  }
  return entries;
}

/** One line per entry for the console and the summaries. */
export function describeLockfileSync(entry: LockfileSyncEntry): string {
  switch (entry.status) {
    case 'updated':
      return `\`${entry.lockfile}\` updated with \`${entry.command}\`.`;
    case 'unchanged':
      return `\`${entry.lockfile}\` already matched package.json (\`${entry.command}\`).`;
    case 'dry-run':
      return `\`${entry.lockfile}\` would be updated with \`${entry.command}\`.`;
    case 'failed':
      return `\`${entry.lockfile}\` not updated: \`${entry.command}\` exited ${entry.exitCode}; the file was left as it was.`;
    case 'skipped':
      return entry.skipReason === 'missing-binary'
        ? `\`${entry.lockfile}\` not updated: \`${entry.manager}\` isn't installed.`
        : `\`${entry.lockfile}\` not updated: Yarn classic / Yarn 2 can't update a lockfile without installing.`;
  }
}
