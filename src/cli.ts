#!/usr/bin/env node
import path from 'node:path';
import chalk from 'chalk';
import fs from 'fs-extra';
import { program } from 'commander';
import prompts from 'prompts';
import { appendIgnoreToRc, loadConfig, mergeIgnoreLists } from './config/loadConfig';
import { toJsonReport } from './core/conflict';
import {
  BACKUP_FILENAME,
  restoreInitialFromBackup,
  runUpgradeEngine,
} from './core/upgrader';
import type { FinalReport } from './types';
import { log } from './utils/logger';

async function readSelfVersion(): Promise<string> {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = (await fs.readJson(pkgPath)) as { version?: string };
  return pkg.version ?? '0.0.0';
}

function printHumanReport(report: FinalReport): void {
  log.title('Summary');

  const ok = report.upgraded.filter((r) => r.success && !r.skipped);
  const skipped = report.upgraded.filter((r) => r.skipped);
  if (ok.length) {
    log.info(chalk.bold('Upgraded successfully'));
    for (const r of ok) {
      const forced = r.forced ? ' (forced)' : '';
      const fb =
        r.usedFallback && r.requestedLatest
          ? ` — latest was ${r.requestedLatest}; fallback`
          : '';
      log.success(`${r.name} ${r.from ?? '?'} → ${r.to ?? '?'}${fb}${forced}`);
    }
  }
  if (skipped.length) {
    log.info(chalk.bold('Skipped / no change'));
    for (const r of skipped) {
      log.dim(`  ${r.name}: ${r.detail ?? r.reason ?? 'skipped'}`);
    }
  }
  if (report.failed.length) {
    log.info(chalk.bold('Failed or rolled back'));
    for (const f of report.failed) {
      if (f.reason === 'peer') {
        log.peer(`${f.name} — ${f.message ?? 'peer dependency conflict'}`);
      } else {
        log.error(`${f.name}: ${f.message ?? f.reason}`);
      }
    }
  }
  if (report.ignored.length) {
    log.dim(`Ignored packages: ${report.ignored.join(', ')}`);
  }
}

/**
 * After a run with conflicts, offer to bulk-ignore failed package names.
 */
async function postRunInteractive(cwd: string, report: FinalReport): Promise<void> {
  if (report.failed.length === 0) {
    return;
  }

  log.title('Conflicting dependencies');
  for (const f of report.failed) {
    console.log(`  • ${f.name} (${f.reason}): ${f.message ?? ''}`);
  }

  const res = await prompts([
    {
      type: 'confirm',
      name: 'addAllIgnored',
      message:
        'Failed upgrades were rolled back where possible. Add all failed packages to .dep-up-surgeonrc ignore list?',
      initial: false,
    },
  ]);

  if (res?.addAllIgnored) {
    const names = report.failed.map((f) => f.name);
    await appendIgnoreToRc(cwd, ...names);
    log.warn(`Added ${names.length} package(s) to ignore in .dep-up-surgeonrc`);
  }
}

async function main(): Promise<void> {
  const version = await readSelfVersion();

  program
    .name('dep-up-surgeon')
    .description(
      'Upgrade npm dependencies one-by-one with install + test/build validation and rollback on failure.',
    )
    .version(version)
    .option('--dry-run', 'Show planned upgrades without modifying package.json', false)
    .option('--interactive', 'Prompt when upgrades fail and after conflicts', false)
    .option('--force', 'Keep upgrades even when validation fails; relax peer rollback', false)
    .option('--ignore <pkgs>', 'Comma-separated package names to skip (merged with .dep-up-surgeonrc)')
    .option('--json', 'Print machine-readable report to stdout', false)
    .option(
      '--fallback-strategy <mode>',
      'When @latest fails: minor-lines (try older major.minor release lines) or none (only latest)',
      'minor-lines',
    );

  program.parse(process.argv);
  const opts = program.opts<{
    dryRun?: boolean;
    interactive?: boolean;
    force?: boolean;
    ignore?: string;
    json?: boolean;
    fallbackStrategy?: string;
  }>();

  const cwd = process.cwd();
  const dryRun = Boolean(opts.dryRun);
  const interactive = Boolean(opts.interactive);
  const force = Boolean(opts.force);
  const jsonOutput = Boolean(opts.json);

  const config = await loadConfig(cwd);
  const ignore = mergeIgnoreLists(config.ignore, opts.ignore);

  const fsRaw = String(opts.fallbackStrategy ?? 'minor-lines').toLowerCase();
  const fallbackStrategy =
    fsRaw === 'none' || fsRaw === 'off' || fsRaw === 'latest-only' ? 'none' : 'minor-lines';

  let report: FinalReport | null = null;

  try {
    report = await runUpgradeEngine({
      cwd,
      dryRun,
      interactive,
      force,
      jsonOutput,
      ignore,
      fallbackStrategy,
    });

    if (jsonOutput) {
      console.log(JSON.stringify(toJsonReport(report!), null, 2));
    } else {
      printHumanReport(report!);
    }

    if (interactive && !jsonOutput && report!.failed.length > 0) {
      await postRunInteractive(cwd, report!);
    }

    if (!dryRun) {
      const bak = path.join(cwd, BACKUP_FILENAME);
      if (await fs.pathExists(bak)) {
        await fs.remove(bak);
      }
    }

    const exitCode = force || !report!.failed.length ? 0 : 1;
    process.exitCode = exitCode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!jsonOutput) {
      log.error(`Fatal: ${msg}`);
    } else {
      console.log(JSON.stringify({ error: msg }, null, 2));
    }
    try {
      await restoreInitialFromBackup(cwd);
    } catch {
      /* ignore restore errors */
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
