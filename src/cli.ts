#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import chalk from 'chalk';
import fs from 'fs-extra';
import { program } from 'commander';
import prompts from 'prompts';
import {
  appendIgnoreToRc,
  loadConfig,
  mergeIgnoreLists,
  mergeOverrideSources,
  resolveValidateOptions,
} from './config/loadConfig.js';
import { buildStructuredReport, printStructuredCliSummary } from './cli/report.js';
import {
  captureRootLockfiles,
  computeRetryFailedIgnores,
  lastRunReportPath,
  loadLastRunReport,
  persistLastRunReport,
} from './cli/lastRun.js';
import { resolveSummaryDestination, writeSummary, type SummaryFormat } from './cli/summary.js';
import { captureWorktree, restoreSideEffects } from './cli/sideEffects.js';
import { checkoutBranch, getCurrentBranch, type GitCommitMode } from './cli/git.js';
import { createGitFlow, type GitFlowController } from './cli/gitFlow.js';
import {
  BACKUP_FILENAME,
  CATALOG_BACKUP_FILENAME,
  removeCreatedBackups,
  rollbackInFlightAttemptsSync,
  runUpgradeFlow,
  type WorkspaceMode,
} from './core/upgrader.js';
import { initRegistryOptions } from './utils/npmConfig.js';
import type { FinalReport } from './types.js';
import { log, setLogToStderr } from './utils/logger.js';
import {
  filterAdvisoriesBySeverity,
  parseMinSeverity,
  runAudit,
  type AuditResult,
} from './core/audit.js';
import { parsePackageManagerOption, type PackageManager } from './core/workspaces.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function readSelfVersion(): Promise<string> {
  const pkgPath = path.join(__dirname, '..', 'package.json');
  const pkg = (await fs.readJson(pkgPath)) as { version?: string };
  return pkg.version ?? '0.0.0';
}

function tagWs(workspace: string | undefined): string {
  return workspace && workspace !== 'root' ? ` [${workspace}]` : '';
}

function printHumanReport(report: FinalReport): void {
  log.title('Summary');

  if (report.project) {
    const p = report.project;
    const mgr = `${p.manager}${p.managerVersion ? '@' + p.managerVersion : ''}`;
    const wsTail = p.hasWorkspaces ? `, workspaces: ${p.workspaceMembers.length}` : '';
    log.dim(`Project: ${mgr} (via ${p.managerSource}${wsTail})`);
  }
  if (report.targets && report.targets.length > 1) {
    log.dim(`Targets: ${report.targets.map((t) => t.label).join(', ')}`);
  }

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
      log.success(`${r.name}${tagWs(r.workspace)} ${r.from ?? '?'} → ${r.to ?? '?'}${fb}${forced}`);
    }
  }
  if (skipped.length) {
    log.info(chalk.bold('Skipped / no change'));
    for (const r of skipped) {
      log.dim(`  ${r.name}${tagWs(r.workspace)}: ${r.detail ?? r.reason ?? 'skipped'}`);
    }
  }
  if (report.failed.length) {
    log.info(chalk.bold('Failed or rolled back'));
    for (const f of report.failed) {
      const tag = tagWs(f.workspace);
      if (f.reason === 'peer') {
        log.peer(`${f.name}${tag} — ${f.message ?? 'peer dependency conflict'}`);
      } else if (f.reason === 'validation-script') {
        log.error(
          `${f.name}${tag}: validator script failed — ${f.validation?.command ?? 'unknown'} (exit ${f.validation?.exitCode ?? '?'}).` +
            ' This is NOT a dependency conflict; fix the script or pass --force / --no-validate.',
        );
      } else {
        log.error(`${f.name}${tag}: ${f.message ?? f.reason}`);
      }
      if (f.install) {
        const status = f.install.ok
          ? `${f.install.command} exited 0 (rolled back due to post-install scan)`
          : `${f.install.command} exited ${f.install.exitCode ?? '?'}`;
        log.dim(`  install: ${status}`);
        if (f.install.lastLines) {
          const head = f.install.lastLines.split(/\r?\n/).slice(0, 8).join('\n    ');
          log.dim(`    ${head}`);
        }
      }
    }
  }
  if (report.preflightAborted && report.preflight) {
    log.error(
      `Aborted before upgrades: pre-flight validator \`${report.preflight.command}\` is already failing (exit ${report.preflight.exitCode ?? '?'}).`,
    );
    log.info(
      'Re-run with --validate "<cmd>", --no-validate, or --force after fixing the project build.',
    );
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
    const names = failedPackageNames(report);
    try {
      await appendIgnoreToRc(cwd, ...names);
      log.warn(`Added ${names.length} package(s) to ignore in .dep-up-surgeonrc`);
    } catch (e) {
      // e.g. an rc that doesn't parse: refusing to rewrite it beats destroying the user's config.
      log.error(`Could not update .dep-up-surgeonrc: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/**
 * Real package names behind `report.failed`. A linked-group failure is recorded as
 * `[group:<id>]`, which never matches anything in an ignore list, so expand it to its members.
 */
function failedPackageNames(report: FinalReport): string[] {
  const names = new Set<string>();
  for (const f of report.failed) {
    const groupId = /^\[group:(.+)\]$/.exec(f.name)?.[1];
    if (!groupId) {
      names.add(f.name);
      continue;
    }
    const ids = [f.workspace ? `${f.workspace}::${groupId}` : undefined, groupId, f.linkedGroupId];
    const group = report.groupPlan?.find((g) => ids.includes(g.id));
    for (const member of group?.packages ?? []) {
      names.add(member);
    }
  }
  return [...names];
}

async function main(): Promise<void> {
  const version = await readSelfVersion();

  // `doctor` is a read-only diagnostic subcommand — we dispatch it BEFORE the main commander
  // program is wired up so it doesn't have to inherit the upgrade flow's 70+ options (most
  // of which don't apply to a read-only run). `doctor` has its own small commander program
  // with a focused option set; when it runs, it prints its report and exits directly.
  if (process.argv[2] === 'doctor') {
    const { runDoctorCommand } = await import('./cli/doctorCommand.js');
    await runDoctorCommand(process.argv, version);
    return;
  }

  // `undo` reads the last-run report and reverses the last run (dep ranges +
  // overrides + reinstall + validate). Same early-dispatch pattern as `doctor` so the
  // subcommand doesn't inherit the upgrade flow's 70+ options.
  if (process.argv[2] === 'undo') {
    const { runUndoCommand } = await import('./cli/undoCommand.js');
    await runUndoCommand(process.argv, version);
    return;
  }

  if (process.argv[2] === 'outdated') {
    const { runOutdatedCommand } = await import('./cli/outdatedCommand.js');
    await runOutdatedCommand(process.argv, version);
    return;
  }

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
      '--progress',
      'With --json, still print progress (installs, validation, rollbacks) to stderr; stdout keeps only the JSON report. Parallel --concurrency drops to 1 so the lines stay readable.',
      false,
    )
    .option(
      '--fallback-strategy <mode>',
      'When @latest fails: major-lines (default, one try per major), minor-lines (one per major.minor), or none',
      'major-lines',
    )
    .option(
      '--link-groups <mode>',
      'auto: cluster deps from registry peer/dependency graph (+ @types/* pairing) + custom rc; none: one at a time',
      'auto',
    )
    .option(
      '--validate <cmd>',
      'Override the validator command run after every install (defaults to `npm test` then `npm run build`).',
    )
    .option(
      '--no-validate',
      'Skip the validator entirely (upgrades are kept regardless of test/build outcome). Different from --force, which keeps upgrades only when the validator fails.',
    )
    .option(
      '--package-manager <mgr>',
      'Override detected package manager: auto (default), npm, pnpm, yarn, or bun. `auto` reads `packageManager` field, then lockfile, then falls back to npm.',
      'auto',
    )
    .option(
      '--cwd <path>',
      'Run against this directory instead of the current one. Default is still `process.cwd()`, so scripts that `cd` first are unchanged.',
    )
    .option(
      '--include-workspace-deps',
      'Treat workspace-internal dependencies (names matching a local workspace package) like any other dep. By default they are skipped because their version comes from the local workspace, not the registry.',
      false,
    )
    .option(
      '--include-peers',
      'Also upgrade peerDependencies entries. Default: skip peers (they are a consumer contract; auto-bumping them is usually wrong for libraries).',
      false,
    )
    .option(
      '--pin-exact',
      'Write bare exact versions (1.2.3) into package.json instead of preserving the previous ^ / ~ range style.',
      false,
    )
    .option(
      '--workspaces',
      'Traverse the root package.json AND every workspace member. Install + validation always run from the workspace root so the lockfile and validator see the whole monorepo.',
      false,
    )
    .option(
      '--workspaces-only',
      'Traverse only workspace members; skip the root package.json. Implies --workspaces.',
      false,
    )
    .option(
      '--workspace <names>',
      'Comma-separated workspace member names to traverse (use the package `name` from each child package.json). Pass `root` to also include the root. Example: --workspace "@org/core,@org/web,root".',
    )
    .option(
      '--install-mode <mode>',
      'Workspace install strategy: `root` (default; always install the whole tree from the workspace root — safest) or `filtered` (npm `-w <name>` / pnpm `--filter <name>` per child target). Yarn falls back to a full install with a warning. Only matters with --workspaces / --workspace.',
      'root',
    )
    .option(
      '--concurrency <n>',
      'Maximum number of workspace targets to scan/plan in parallel (1-16; default 1). Higher values overlap registry fetches across targets while a shared mutex keeps installs and validation serialized (the lockfile is shared). In **isolated-lockfile** monorepos (pnpm `shared-workspace-lockfile=false`, or every workspace member shipping its own lockfile) the installs + validation ALSO run in parallel, keyed per workspace directory. Requires --json to keep per-target log lines from interleaving — non-JSON mode silently downgrades to 1 with a warning.',
      '1',
    )
    .option(
      '--no-parallel-installs',
      'Force installs + validation to stay serialized even when an isolated-lockfile monorepo is detected. Useful when debugging a flaky install step (parallel installs mask the ordering) or when a per-workspace postinstall script touches shared state outside the workspace tree.',
    )
    .option(
      '--no-persist-report',
      'Do not write the structured report after the run. By default it is written to node_modules/.cache/dep-up-surgeon/last-run.json (with pre-run lockfile backups) for undo / --retry-failed / CI.',
    )
    .option(
      '--retry-failed',
      `Read the previous run's report (node_modules/.cache/dep-up-surgeon/last-run.json) and only reattempt entries that failed for non-terminal reasons (i.e. NOT 'peer' or 'validation-script'). Successful upgrades + terminal failures from the last run are frozen per workspace (workspace::name) so a result in one member does not skip the same package in another.`,
      false,
    )
    .option(
      '--summary <format>',
      'Write a human-friendly summary of the run as `md` (default) or `html`. Destination: $GITHUB_STEP_SUMMARY if set (appended), otherwise --summary-file <path>, otherwise ./dep-up-surgeon-summary.<ext>.',
    )
    .option(
      '--summary-file <path>',
      'Override the destination for --summary. Wins over $GITHUB_STEP_SUMMARY.',
    )
    .option(
      '--ci',
      'Convenience flag for CI / bot use: disables --interactive, auto-enables --summary md (great with $GITHUB_STEP_SUMMARY), and exits 0 even when individual upgrades fail (only pre-flight failures and fatal errors exit 1) so per-package conflicts surface in the PR description instead of failing the job.',
      false,
    )
    .option(
      '--git-commit',
      'Commit successful upgrades to git as the run progresses. Refuses to start on a dirty tree (override with --git-allow-dirty); only stages package.json + the lockfile (never `git add -A`). Skipped silently in --dry-run.',
      false,
    )
    .option(
      '--git-commit-mode <mode>',
      'How to group commits: `per-success` (default — one commit per upgrade; best for review), `per-target` (one commit per workspace), or `all` (one squashed commit at the end).',
      'per-success',
    )
    .option(
      '--git-commit-prefix <prefix>',
      'String prepended to every commit message (default `"deps: "`). Use e.g. `"chore(deps): "` for Conventional Commits.',
      'deps: ',
    )
    .option(
      '--git-branch <name>',
      'Create + checkout this branch before any commits. If the branch already exists, switches to it. Useful for `--ci` PR workflows.',
    )
    .option(
      '--git-sign',
      'Pass --gpg-sign to every commit. Requires a signing key configured for git.',
      false,
    )
    .option(
      '--git-allow-dirty',
      'Allow --git-commit on a dirty working tree. We still only `git add` files we touched, but YOUR pre-existing dirty files will land in the same commit if you also stage them manually.',
      false,
    )
    .option(
      '--changelog',
      'Fetch changelog excerpts for every successful upgrade (GitHub Releases first, then tarball CHANGELOG.md) and attach them to git commit bodies + the summary report. Default ON when --git-commit or --summary is set; use --no-changelog to skip fetches entirely.',
    )
    .option(
      '--no-changelog',
      'Disable changelog enrichment even when --git-commit / --summary would normally trigger it. Use this in offline / air-gapped CI where GitHub + registry tarball fetches would fail.',
    )
    .option(
      '--security-only',
      'Security-first mode: run `<manager> audit --json` up-front and attempt upgrades ONLY for packages with known advisories. Every upgraded row in the report carries its advisory id, severity, and URL. Useful as a minimal-risk weekly cron that ONLY ships CVE fixes.',
      false,
    )
    .option(
      '--min-severity <level>',
      'Minimum advisory severity to consider under --security-only: one of "low", "moderate", "high", "critical". Lower severities are filtered out. Default: "low" (accept all).',
      'low',
    )
    .option(
      '--blast-radius',
      'Scan project source files to list which files actually import each upgraded package. Attaches the file list to every upgrade record + surfaces it in --summary. Default ON when --summary is active.',
    )
    .option(
      '--no-blast-radius',
      'Disable blast-radius source scanning. Useful in very large monorepos where the scan is slower than the install itself.',
    )
    .option(
      '--resolve-peers',
      'When a linked-group bump (e.g. `react` + `react-dom`) fails with a peer-dependency conflict, attempt to compute a compatible version tuple by intersecting each member\'s peer ranges across the registry packument. If a satisfiable tuple exists and it passes install + validate, the batch succeeds with members possibly downgraded off `latest`. Default: ON.',
    )
    .option(
      '--no-resolve-peers',
      'Disable the peer-range intersection resolver. A linked batch that fails with a peer conflict rolls back exactly like before. Useful when you WANT the failure to surface instead of having the tool silently nudge versions off latest.',
    )
    .option(
      '--apply-overrides',
      'After the main upgrade loop, attempt to fix transitive CVEs that no direct bump could reach by writing a package-manager override (`overrides` for npm, `pnpm.overrides` for pnpm, `resolutions` for yarn) pinning each vulnerable package to its audit-recommended safe version. Runs install + validator after each pin and rolls back the pin on failure. Requires --security-only.',
      false,
    )
    .option(
      '--override-force',
      'Used with --apply-overrides. Overwrite an existing override whose value conflicts with the audit-recommended version. By default we refuse and record a `conflict` reason so the user can reconcile manually.',
      false,
    )
    .option(
      '--override <spec...>',
      'Apply a parent-scoped or flat override pin. Repeatable. Syntax: `<chain>@<range>` where <chain> is one of (a) a bare package name `foo` (flat — pins every occurrence), (b) pnpm-style `parent>child` (pins `child` only when nested under `parent`; chains of any depth are supported), or (c) yarn-style `parent/child` (`/` separator; `@scope/pkg` stays intact as a single segment). The pin is written to the manager-native field (`overrides` nested object for npm, `pnpm.overrides` `>`-keys for pnpm, `resolutions` `/`-keys for yarn) and is run through the same install + validator + rollback cycle as --apply-overrides. Examples: `--override lodash@4.17.21`, `--override "some-dep>foo@1.2.3"`, `--override "@scope/parent>@scope/child@2.0.0"`.',
      (val: string, acc: string[] = []) => acc.concat(val.split(',').map((s) => s.trim()).filter(Boolean)),
      [] as string[],
    )
    .option(
      '--fix-lockfile',
      'Run the package manager\'s native dedupe pass (`npm dedupe` / `pnpm dedupe` / `yarn dedupe`) to collapse redundant transitive copies WITHOUT touching package.json, and scan for transitives more than one minor or a full major behind registry `latest`. The lockfile is backed up before dedupe and restored if the dedupe command OR the post-dedupe validator fails. Yarn classic (v1) has no dedupe subcommand and is recorded as `skipped: "unsupported"`.',
      false,
    )
    .option(
      '--open-pr',
      'Push the branch created by --git-branch and open a GitHub PR using the `gh` CLI (must be installed + authenticated). The PR body is the --summary markdown (falls back to a minimal default). Never fatal: a missing `gh`, an auth failure, or a push reject is recorded in the structured report as `pullRequest.error` without aborting the upgrade run.',
      false,
    )
    .option(
      '--open-pr-title <title>',
      'Override the PR title. Default: a deterministic title derived from the upgrade counts (e.g. "deps: [security] bump 3 packages").',
    )
    .option(
      '--open-pr-draft',
      'Open the PR as a draft. Useful on Fridays or when --force was used so the PR cannot be auto-merged by a queue bot.',
      false,
    )
    .option(
      '--open-pr-base <branch>',
      'Target base branch for the PR. Default: the repo default branch as reported by `gh repo view`.',
    )
    .option(
      '--open-pr-reviewers <users>',
      'Comma-separated usernames to request reviews from. Passed through to `gh pr create --reviewer`.',
    )
    .option(
      '--open-pr-assignees <users>',
      'Comma-separated usernames to assign. Passed through to `gh pr create --assignee`.',
    )
    .addHelpText(
      'after',
      `
Commands:
  doctor [options]     Read-only diagnostic (lockfile, peers, audit, validator)
  undo [options]       Reverse the last recorded run
  outdated [options]   Report direct deps behind registry @latest

Run \`dep-up-surgeon <command> --help\` for command-specific options.
`,
    );

  program.parse(process.argv);
  const opts = program.opts<{
    dryRun?: boolean;
    interactive?: boolean;
    force?: boolean;
    ignore?: string;
    json?: boolean;
    progress?: boolean;
    fallbackStrategy?: string;
    linkGroups?: string;
    validate?: string | boolean;
    packageManager?: string;
    cwd?: string;
    includeWorkspaceDeps?: boolean;
    includePeers?: boolean;
    pinExact?: boolean;
    workspaces?: boolean;
    workspacesOnly?: boolean;
    workspace?: string;
    installMode?: string;
    concurrency?: string;
    parallelInstalls?: boolean; // commander turns `--no-parallel-installs` into `parallelInstalls: false`
    persistReport?: boolean; // commander turns `--no-persist-report` into `persistReport: false`
    retryFailed?: boolean;
    summary?: string;
    summaryFile?: string;
    ci?: boolean;
    gitCommit?: boolean;
    gitCommitMode?: string;
    gitCommitPrefix?: string;
    gitBranch?: string;
    gitSign?: boolean;
    gitAllowDirty?: boolean;
    changelog?: boolean;
    securityOnly?: boolean;
    minSeverity?: string;
    blastRadius?: boolean;
    resolvePeers?: boolean;
    applyOverrides?: boolean;
    overrideForce?: boolean;
    override?: string[];
    fixLockfile?: boolean;
    openPr?: boolean;
    openPrTitle?: string;
    openPrDraft?: boolean;
    openPrBase?: string;
    openPrReviewers?: string;
    openPrAssignees?: string;
  }>();

  const cwd = opts.cwd ? path.resolve(process.cwd(), opts.cwd) : process.cwd();
  const dryRun = Boolean(opts.dryRun);
  const ciMode = Boolean(opts.ci);
  // --ci is a no-prompt convenience for bots: force interactive off so we never block on stdin.
  const interactive = Boolean(opts.interactive) && !ciMode;
  const force = Boolean(opts.force);
  const jsonOutput = Boolean(opts.json);
  if (jsonOutput) {
    // stdout is reserved for the JSON report; warnings, errors and progress go to stderr.
    setLogToStderr(true);
  }
  // Human progress lines (installs, validation, rollbacks). Off with --json unless --progress,
  // which keeps them on stderr for tools that show a live log next to the JSON report.
  const quiet = jsonOutput && !opts.progress;
  // Registry lookups honor the project's / user's .npmrc (mirrors, scoped registries, auth).
  initRegistryOptions(cwd);

  // Ctrl+C / CI cancellation mid-install: put back the half-applied step so package.json and the
  // lockfile agree, then exit with the conventional signal status. Completed upgrades stay.
  const onSignal = (signal: NodeJS.Signals): void => {
    const undone = rollbackInFlightAttemptsSync();
    log.error(
      undone > 0
        ? `Interrupted (${signal}): rolled back the upgrade in progress; upgrades that already finished were kept. Re-run your package manager's install to resync node_modules.`
        : `Interrupted (${signal}).`,
    );
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  // Resolve --summary. Explicit flag wins; otherwise --ci auto-enables md.
  let summaryFormat: SummaryFormat | undefined;
  if (typeof opts.summary === 'string') {
    const v = opts.summary.toLowerCase();
    if (v !== 'md' && v !== 'html') {
      log.error(`--summary: unknown format "${opts.summary}". Use "md" or "html".`);
      process.exitCode = 1;
      return;
    }
    summaryFormat = v;
  } else if (ciMode) {
    summaryFormat = 'md';
  }

  const config = await loadConfig(cwd);
  const ignore = mergeIgnoreLists(config.ignore, opts.ignore);
  for (const w of config.warnings ?? []) {
    log.warn(`rc: ${w}`);
  }
  if ((config.overrides?.length ?? 0) > 0 && !quiet) {
    log.info(
      `rc: loaded ${config.overrides!.length} override pin${config.overrides!.length === 1 ? '' : 's'} from .dep-up-surgeonrc (will run through the same install + validator + rollback cycle as --apply-overrides)`,
    );
  }

  // ---- Load .dep-up-surgeon.policy.{yaml,json} ----
  const { loadPolicy } = await import('./config/policy.js');
  const policyResult = await loadPolicy(cwd);
  const policy = policyResult.policy;
  if (policyResult.present && !quiet) {
    const bits: string[] = [];
    if (policy.freeze.length) bits.push(`${policy.freeze.length} freeze`);
    if (policy.maxVersion.length) bits.push(`${policy.maxVersion.length} maxVersion`);
    if (policy.allowMajorAfter.length) bits.push(`${policy.allowMajorAfter.length} allowMajorAfter`);
    if (policy.requireReviewers) bits.push('requireReviewers');
    if (policy.autoMerge) bits.push('autoMerge');
    log.info(
      `policy: loaded ${path.basename(policy.sourceFile ?? '')} — ${bits.join(', ') || '(no rules)'}`,
    );
  }
  for (const w of policy.warnings) {
    log.warn(`policy: ${w}`);
  }
  // Freeze rules: contribute to the ignore list. Using matchPattern to support `*` wildcards.
  if (policy.freeze.length > 0) {
    // We don't know the full package list yet, so freeze patterns containing `*` are expanded
    // downstream inside the engine (it already sees every scanned name). Plain patterns (no
    // wildcard) can be added to `ignore` directly.
    for (const f of policy.freeze) {
      if (!f.pattern.includes('*')) {
        ignore.add(f.pattern);
      }
    }
  }

  if (opts.retryFailed) {
    const last = await loadLastRunReport(cwd);
    if (!last) {
      log.error(
        `--retry-failed: no previous run found at ${lastRunReportPath(cwd)}. ` +
          'Run dep-up-surgeon at least once first (and don’t pass --no-persist-report).',
      );
      process.exitCode = 1;
      return;
    }
    const retry = computeRetryFailedIgnores(last);
    for (const name of retry.added) {
      ignore.add(name);
    }
    if (!quiet) {
      const ageMs = Date.now() - new Date(last.finishedAt).getTime();
      const ageMin = Math.max(1, Math.round(ageMs / 60000));
      log.info(
        `--retry-failed: loaded last run from ${path.relative(cwd, lastRunReportPath(cwd))} (${ageMin}m ago, dep-up-surgeon ${last.toolVersion})`,
      );
      log.dim(
        `  freezing ${retry.succeededLastRun} previously-upgraded + ${retry.terminalFailuresLastRun} terminal failure(s); retrying ${retry.retryableLastRun.length} non-terminal failure(s): ${retry.retryableLastRun.join(', ') || '(none)'}`,
      );
      if (retry.retryableLastRun.length === 0) {
        log.warn(
          'Nothing left to retry — every previous failure was peer/validation-script. The run will be effectively a no-op.',
        );
      }
    }
  }

  const fsRaw = String(opts.fallbackStrategy ?? 'major-lines').toLowerCase();
  const fallbackStrategy:
    | 'major-lines'
    | 'minor-lines'
    | 'none' =
    fsRaw === 'none' || fsRaw === 'off' || fsRaw === 'latest-only'
      ? 'none'
      : fsRaw === 'minor-lines' || fsRaw === 'minor'
        ? 'minor-lines'
        : 'major-lines';

  const linkRaw = String(opts.linkGroups ?? 'auto').toLowerCase();
  const linkGroups: 'auto' | 'none' =
    linkRaw === 'none' || linkRaw === 'off' || linkRaw === 'false' ? 'none' : 'auto';

  // commander turns `--no-validate` into `validate: false`, and `--validate "<cmd>"` into
  // `validate: "<cmd>"`. When neither is passed it stays `undefined`.
  const cliValidateCmd = typeof opts.validate === 'string' ? opts.validate : undefined;
  const cliNoValidate = opts.validate === false;
  const validate = resolveValidateOptions(config.validate, cliValidateCmd, cliNoValidate);

  const packageManager: 'auto' | PackageManager = parsePackageManagerOption(opts.packageManager);
  const includeWorkspaceDeps = Boolean(opts.includeWorkspaceDeps);
  const includePeers = Boolean(opts.includePeers);
  const pinExact = Boolean(opts.pinExact);

  const installModeRaw = String(opts.installMode ?? 'root').toLowerCase();
  if (installModeRaw !== 'root' && installModeRaw !== 'filtered') {
    log.error(`--install-mode: unknown value "${opts.installMode}". Use "root" or "filtered".`);
    process.exitCode = 1;
    return;
  }
  const installMode = installModeRaw as 'root' | 'filtered';

  const concurrencyRaw = String(opts.concurrency ?? '1');
  const concurrencyNum = Number.parseInt(concurrencyRaw, 10);
  if (!Number.isFinite(concurrencyNum) || concurrencyNum < 1 || concurrencyNum > 16) {
    log.error(
      `--concurrency: expected an integer between 1 and 16, got "${opts.concurrency}".`,
    );
    process.exitCode = 1;
    return;
  }
  const concurrency = concurrencyNum;

  // ---- Git integration setup ----
  const gitEnabled = Boolean(opts.gitCommit);
  const gitModeRaw = String(opts.gitCommitMode ?? 'per-success').toLowerCase();
  if (
    gitEnabled &&
    gitModeRaw !== 'per-success' &&
    gitModeRaw !== 'per-target' &&
    gitModeRaw !== 'all'
  ) {
    log.error(
      `--git-commit-mode: unknown value "${opts.gitCommitMode}". Use "per-success", "per-target", or "all".`,
    );
    process.exitCode = 1;
    return;
  }
  const gitCommitMode = gitModeRaw as GitCommitMode;
  if (
    !gitEnabled &&
    (opts.gitCommitMode !== 'per-success' ||
      opts.gitCommitPrefix !== 'deps: ' ||
      opts.gitBranch ||
      opts.gitSign ||
      opts.gitAllowDirty)
  ) {
    log.warn('git options were passed without --git-commit; they will be ignored.');
  }

  // Changelog enrichment defaults:
  //   - Explicit `--changelog` / `--no-changelog` always wins.
  //   - Otherwise ON whenever `--git-commit` or `--summary` is active (the two consumers that
  //     actually surface changelog content). Pure `--json` runs stay OFF by default — the JSON
  //     consumer can always re-enable explicitly with `--changelog`.
  const includeChangelog =
    typeof opts.changelog === 'boolean'
      ? opts.changelog
      : Boolean(opts.gitCommit) || Boolean(summaryFormat);

  // ---- --security-only: run audit up front (before gitFlow so per-success commits see it) ----
  let auditResult: AuditResult | undefined;
  /** Advisories at or above `--min-severity` (what `--apply-overrides` may act on). */
  let securityAdvisories: AuditResult['advisories'] | undefined;
  let restrictToNames: Set<string> | undefined;
  let preferredTargets: Map<string, string> | undefined;
  let securityAdvisoryMap:
    | Map<string, { severity: 'low' | 'moderate' | 'high' | 'critical'; ids: string[]; url?: string; title?: string }>
    | undefined;
  if (opts.securityOnly) {
    const minSev = parseMinSeverity(opts.minSeverity ?? 'low');
    if (!minSev) {
      log.error(
        `--min-severity: unknown value "${opts.minSeverity}". Use "low", "moderate", "high", or "critical".`,
      );
      process.exitCode = 1;
      return;
    }

    let auditManager: PackageManager = 'npm';
    if (packageManager !== 'auto') {
      auditManager = packageManager;
    } else {
      try {
        const { detectProjectInfo } = await import('./core/workspaces.js');
        const info = await detectProjectInfo(cwd);
        auditManager = info.manager;
      } catch {
        auditManager = 'npm';
      }
    }

    if (!quiet) {
      log.info(`--security-only: running ${auditManager} audit --json (min-severity: ${minSev})`);
    }
    auditResult = await runAudit({ manager: auditManager, cwd });
    if (auditResult.error && auditResult.advisories.length === 0) {
      // A failed audit must not look like a clean one: "no advisories, nothing to do" + exit 0
      // would let a CI security gate pass without anything having been checked.
      const message = `--security-only: ${auditManager} audit failed: ${auditResult.error}`;
      if (jsonOutput) {
        console.log(JSON.stringify({ error: message }, null, 2));
      } else {
        log.error(message);
      }
      process.exitCode = 1;
      return;
    }
    if (auditResult.error) {
      log.warn(`audit: ${auditResult.error}`);
    }
    const filtered = filterAdvisoriesBySeverity(auditResult.advisories, minSev);
    securityAdvisories = filtered;
    restrictToNames = new Set(filtered.map((a) => a.name));
    preferredTargets = new Map();
    for (const a of filtered) {
      if (a.recommendedVersion && typeof a.recommendedVersion === 'string') {
        preferredTargets.set(a.name, a.recommendedVersion);
      }
    }
    securityAdvisoryMap = new Map(
      filtered.map((a) => [
        a.name,
        {
          severity: a.severity,
          ids: a.ids,
          ...(a.url ? { url: a.url } : {}),
          ...(a.title ? { title: a.title } : {}),
        },
      ]),
    );
    if (!quiet) {
      if (restrictToNames.size === 0) {
        log.success(`No advisories at "${minSev}+" severity — nothing to do.`);
      } else {
        log.info(
          `Audit: ${restrictToNames.size} package${restrictToNames.size === 1 ? '' : 's'} with advisories — ${[...restrictToNames].slice(0, 10).join(', ')}${restrictToNames.size > 10 ? ', ...' : ''}`,
        );
      }
    }
  }

  let gitFlow: GitFlowController | undefined;
  if (gitEnabled) {
    const setup = await createGitFlow(
      cwd,
      {
        enabled: true,
        mode: gitCommitMode,
        prefix: typeof opts.gitCommitPrefix === 'string' ? opts.gitCommitPrefix : 'deps: ',
        sign: Boolean(opts.gitSign),
        allowDirty: Boolean(opts.gitAllowDirty),
        includeChangelog,
        securityAdvisories: securityAdvisoryMap,
      },
      quiet,
      dryRun,
    );
    if (!setup.ok) {
      log.error(setup.error);
      process.exitCode = 1;
      return;
    }
    gitFlow = setup.controller;

    // Checkout only after pre-flight succeeds. Doing this first left the user on a newly
    // created branch when the dirty-tree check then aborted, and `--dry-run --git-branch`
    // switched branches despite dry-run promising no mutations.
    if (gitFlow.enabled && typeof opts.gitBranch === 'string' && opts.gitBranch.trim()) {
      try {
        const previous = await checkoutBranch(cwd, opts.gitBranch.trim());
        if (!quiet) {
          log.info(
            `git: switched to branch "${opts.gitBranch}"${previous ? ` (was on "${previous}")` : ''}`,
          );
        }
      } catch (e) {
        log.error(e instanceof Error ? e.message : String(e));
        process.exitCode = 1;
        return;
      }
    }

    if (!quiet && gitFlow.enabled) {
      const branch = (await getCurrentBranch(cwd)) ?? '?';
      log.info(`git: ${gitCommitMode} commits will land on "${branch}"`);
    }
  }

  let workspaceMode: WorkspaceMode = 'root-only';
  if (typeof opts.workspace === 'string' && opts.workspace.trim()) {
    workspaceMode = opts.workspace
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (opts.workspacesOnly) {
    workspaceMode = 'workspaces-only';
  } else if (opts.workspaces) {
    workspaceMode = 'all';
  }

  // Pre-run lockfile bytes, persisted next to the report so `undo` can restore exact versions.
  const lockfilesBefore = dryRun ? [] : await captureRootLockfiles(cwd);
  // Which tracked files were already changed, so only the run's own side effects get restored.
  const worktreeBefore = dryRun ? undefined : await captureWorktree(cwd);
  let report: FinalReport | null = null;

  try {
    report = await runUpgradeFlow({
      cwd,
      dryRun,
      interactive,
      force,
      jsonOutput: quiet,
      ignore,
      fallbackStrategy,
      linkGroups,
      linkedGroupsConfig: config.linkedGroups ?? [],
      validate,
      packageManager,
      includeWorkspaceDeps,
      includePeers,
      pinExact,
      workspaceMode,
      installMode,
      concurrency,
      // commander turns `--no-parallel-installs` into `parallelInstalls: false`; everything
      // else (undefined, true, or the flag absent) means "auto-detect from project info".
      ...(opts.parallelInstalls === false ? { forceSerialInstalls: true } : {}),
      restrictToNames,
      preferredTargets,
      policy,
      // `--no-resolve-peers` sets opts.resolvePeers to false (commander convention);
      // anything else (undefined, true) means "default on" inside the engine.
      resolvePeers: opts.resolvePeers !== false,
      onUpgradeApplied: gitFlow?.onUpgradeApplied,
      onTargetComplete: gitFlow
        ? async (ev) => {
            await gitFlow!.flushAfterTarget(ev.workspace, ev.manager, ev.installCwd);
          }
        : undefined,
    });

    // Final flush for `--git-commit-mode all` (per-target / per-success have already committed).
    if (gitFlow?.enabled && report) {
      const installCwd = cwd;
      const manager = report.project?.manager ?? 'npm';
      await gitFlow.flushAtEnd(manager, installCwd);
    }
    if (gitFlow?.enabled && report) {
      report.commits = gitFlow.commits;
      report.gitCommitMode = gitFlow.mode;
    }

    // Attach policy report (always when a policy file was loaded, even if zero rules fired).
    if (policyResult.present || policy.warnings.length > 0 || policy.sourceFile) {
      const frozen: NonNullable<typeof report.policy>['frozen'] = [];
      const applied: NonNullable<typeof report.policy>['applied'] = [];
      // Walk `report.ignored` to identify which were frozen by policy vs user `ignore`.
      const { matchPattern } = await import('./config/policy.js');
      for (const name of report!.ignored) {
        const hit = policy.freeze.find((f) => matchPattern(f.pattern, name));
        if (hit) {
          const entry: (typeof frozen)[number] = { name, pattern: hit.pattern };
          if (hit.reason) entry.reason = hit.reason;
          frozen.push(entry);
        }
      }
      for (const r of report!.upgraded) {
        if (r.reason === 'policy' && r.detail) {
          const rule = /majors blocked|allowMajorAfter/i.test(r.detail)
            ? ('allowMajorAfter' as const)
            : ('maxVersion' as const);
          applied.push({ name: r.name, rule, detail: r.detail });
        }
      }
      const pr: NonNullable<typeof report.policy> = {
        counts: {
          freeze: policy.freeze.length,
          maxVersion: policy.maxVersion.length,
          allowMajorAfter: policy.allowMajorAfter.length,
        },
        frozen,
        applied,
        warnings: policy.warnings,
      };
      if (policy.sourceFile) {
        pr.sourceFile = path.basename(policy.sourceFile);
      }
      if (policy.requireReviewers) pr.requireReviewers = policy.requireReviewers;
      if (policy.autoMerge) pr.autoMerge = policy.autoMerge;
      report!.policy = pr;
    }

    // Attach security metadata from the up-front audit to every successful upgrade row, so the
    // summary / JSON consumers can show "which CVE this commit closes". We only annotate rows
    // that match the advisory name AND actually upgraded successfully — skipped / failed rows
    // keep their existing shape.
    if (auditResult && report!.upgraded.length > 0) {
      const byName = new Map<string, (typeof auditResult.advisories)[number]>();
      for (const a of auditResult.advisories) byName.set(a.name, a);
      for (const r of report!.upgraded) {
        const adv = byName.get(r.name);
        if (!adv || !r.success || r.skipped) continue;
        r.security = {
          severity: adv.severity,
          ids: adv.ids,
          url: adv.url,
          vulnerableRange: adv.vulnerableRange,
          recommendedVersion: adv.recommendedVersion,
          title: adv.title,
        };
      }
    }

    // ---- Blast radius: scan project source for imports of upgraded packages ----
    // Default ON when --summary is active; explicit --blast-radius / --no-blast-radius wins.
    const includeBlastRadius =
      typeof opts.blastRadius === 'boolean' ? opts.blastRadius : Boolean(summaryFormat);
    if (includeBlastRadius && report!.upgraded.length > 0) {
      try {
        const { computeBlastRadius } = await import('./utils/blastRadius.js');
        const successfulNames = [
          ...new Set(
            report!.upgraded.filter((r) => r.success && !r.skipped).map((r) => r.name),
          ),
        ];
        if (successfulNames.length > 0) {
          const br = await computeBlastRadius({
            cwd,
            packageNames: successfulNames,
          });
          for (const r of report!.upgraded) {
            if (!r.success || r.skipped) continue;
            const hits = br.byPackage.get(r.name);
            if (!hits) continue;
            r.blastRadius = {
              total: hits.total,
              truncated: hits.truncated,
              files: hits.hits.map((h) => h.relativePath),
            };
          }
          if (!quiet) {
            const touched = [...br.byPackage.values()].filter((h) => h.total > 0).length;
            log.dim(
              `blast radius: scanned ${br.filesScanned} source files (${touched}/${successfulNames.length} upgraded packages had direct imports)`,
            );
          }
        }
      } catch {
        // best-effort — scanning errors never abort the run
      }
    }

    // Post-run changelog enrichment for the summary / JSON report. Only happens when the user
    // opted in (default when `--git-commit` or `--summary` is set). Uses a fresh cache; the
    // git-commit path already attached its own excerpts to the commit bodies during the run and
    // records that `.changelog` was populated so we don't double-fetch here.
    if (includeChangelog && !dryRun && report!.upgraded.length > 0) {
      try {
        const { enrichWithChangelogs } = await import('./cli/changelogEnricher.js');
        const { createChangelogCache } = await import('./utils/changelog.js');
        await enrichWithChangelogs(report!.upgraded, {
          cache: createChangelogCache(),
          concurrency: 4,
        });
      } catch {
        // never block the run on enrichment failure
      }
    }

    // --apply-overrides / --override: fix transitive CVEs + user-supplied parent-scoped pins.
    // Runs AFTER enrichments so we have the final `upgraded` list, and BEFORE the summary so
    // the summary writer + JSON consumers see `report.overrides`. `--override` works
    // standalone (no --security-only required); `--apply-overrides` still needs an audit.
    const hasCliOverrides = Array.isArray(opts.override) && opts.override.length > 0;
    const hasRcOverrides = (config.overrides?.length ?? 0) > 0;
    const hasManualOverrides = hasCliOverrides || hasRcOverrides;
    const wantsAdvisoryOverrides = Boolean(opts.applyOverrides);
    if ((wantsAdvisoryOverrides || hasManualOverrides) && !dryRun) {
      // Merge rc-sourced + CLI selectors. The merger dedupes by chain (CLI wins on conflict),
      // normalizes selector strings, and surfaces malformed CLI entries as warnings — but NOT
      // as a fatal error, because we still want the valid rc entries to apply even when the
      // user typo'd one `--override` flag.
      const merged = mergeOverrideSources(config.overrides, opts.override);
      for (const w of merged.warnings) {
        log.warn(w);
      }
      const manualOverrides = merged.entries.map((e) => {
        const spec: { chain: string[]; range: string; source?: string; reason?: string } = {
          chain: e.chain,
          range: e.range,
        };
        if (e.source) spec.source = e.source;
        if (e.reason) spec.reason = e.reason;
        return spec;
      });
      const effectivelyHasManual = manualOverrides.length > 0;

      if (
        wantsAdvisoryOverrides &&
        (!opts.securityOnly || (securityAdvisories?.length ?? 0) === 0) &&
        !effectivelyHasManual
      ) {
        if (!quiet) {
          log.warn(
            '--apply-overrides requires --security-only with at least one audit advisory; skipping.',
          );
        }
      } else {
        try {
          const { runOverrideFlow, collectDirectDepNames } = await import('./cli/overrideFlow.js');
          // Build the direct-dep set across every workspace target so we don't mis-classify a
          // package as transitive when it's actually a direct dep of a workspace member.
          const directDepNames = new Set<string>();
          for (const t of report!.targets ?? [{ cwd, packageJson: path.join(cwd, 'package.json') }]) {
            for (const n of await collectDirectDepNames(t.packageJson)) {
              directDepNames.add(n);
            }
          }
          const upgradedNames = new Set(
            report!.upgraded.filter((r) => r.success && !r.skipped).map((r) => r.name),
          );
          const overrideManager: PackageManager =
            packageManager !== 'auto' ? packageManager : report!.project?.manager ?? 'npm';
          // Only advisories at or above --min-severity: the user filtered the rest out on purpose.
          const advisoriesForFlow = wantsAdvisoryOverrides ? (securityAdvisories ?? []) : [];
          const flowResult = await runOverrideFlow({
            cwd,
            manager: overrideManager,
            advisories: advisoriesForFlow,
            upgradedNames,
            directDepNames,
            overwriteConflicts: Boolean(opts.overrideForce),
            json: quiet,
            manualOverrides,
          });
          if (flowResult.attempts.length > 0) {
            const { overrideFieldFor } = await import('./utils/overrides.js');
            report!.overrides = {
              field: overrideFieldFor(overrideManager),
              attempts: flowResult.attempts,
            };
          }
        } catch (e) {
          if (!quiet) {
            log.warn(
              `overrides: skipped due to error: ${e instanceof Error ? e.message : String(e)}`,
            );
          }
        }
      }
    }

    // --fix-lockfile: dedupe + stale-transitive scan. Runs AFTER the main upgrade loop and
    // overrides pass so we dedupe the FINAL tree. We roll back on any failure, so in the
    // worst case the user ends up with the same lockfile the upgrade loop produced.
    if (opts.fixLockfile && !dryRun) {
      try {
        const { runLockfileFix } = await import('./cli/lockfileFix.js');
        const fixManager: PackageManager =
          packageManager !== 'auto' ? packageManager : report!.project?.manager ?? 'npm';
        const yarnMajorVersion = report!.project?.yarnMajorVersion;
        const fixRes = await runLockfileFix({
          cwd,
          manager: fixManager,
          ...(yarnMajorVersion !== undefined ? { yarnMajorVersion } : {}),
          json: quiet,
          runValidator: async () => {
            if (validate.skip) return { ok: true };
            try {
              const { validateProject } = await import('./core/validator.js');
              const pkg = await fs.readJson(path.join(cwd, 'package.json'));
              const vr = await validateProject(cwd, pkg, {
                ...(validate.command ? { command: validate.command } : {}),
                manager: fixManager,
                ...(validate.source ? { source: validate.source } : {}),
              });
              return {
                ok: vr.ok,
                ...(vr.command ? { command: vr.command } : {}),
                ...(vr.output ? { lastLines: vr.output } : {}),
              };
            } catch (e) {
              // A thrown validator (missing package.json, unexpected crash) must fail the
              // dedupe so we roll the lockfile back — treating it as pass would keep a
              // potentially broken tree.
              return {
                ok: false,
                lastLines: e instanceof Error ? e.message : String(e),
              };
            }
          },
          runInstallAfterRollback: async () => {
            const { runInstall } = await import('./utils/npm.js');
            await runInstall(cwd, fixManager);
          },
        });
        report!.lockfileFix = fixRes.report;
        if (!quiet) {
          const r = fixRes.report;
          if (r.status === 'ok') {
            const mergedOrUpdated = r.dedupeChanges.filter(
              (c) => c.change === 'merged' || c.change === 'updated',
            ).length;
            log.success(
              `--fix-lockfile: ${r.command} succeeded (${mergedOrUpdated} package${
                mergedOrUpdated === 1 ? '' : 's'
              } deduped/updated, ${r.stale.length} stale transitive${r.stale.length === 1 ? '' : 's'} flagged).`,
            );
          } else if (r.status === 'failed') {
            log.warn(
              `--fix-lockfile: ${r.failureKind === 'validation' ? 'validator' : 'dedupe'} failed; lockfile was restored.`,
            );
          } else if (r.status === 'skipped') {
            log.info(
              `--fix-lockfile: skipped (${r.skipReason === 'no-lockfile' ? 'no lockfile on disk' : 'yarn classic has no dedupe subcommand'}).`,
            );
          }
        }
      } catch (e) {
        if (!quiet) {
          log.warn(
            `--fix-lockfile: skipped due to error: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
    }

    // Write the --summary file BEFORE emitting the primary report so we can reuse it as the
    // PR body (when --open-pr is set) and so the JSON consumer sees `pullRequest` reflected in
    // the final structured report.
    let summaryFilePath: string | undefined;
    if (summaryFormat) {
      const intermediateStructured = buildStructuredReport(report!, {
        parsedConflicts: report!.parsedConflicts,
        groups: report!.groupPlan,
      });
      const dest = resolveSummaryDestination({
        format: summaryFormat,
        file: opts.summaryFile,
        cwd,
        toolVersion: version,
      });
      const written = await writeSummary(intermediateStructured, {
        format: summaryFormat,
        file: opts.summaryFile,
        cwd,
        toolVersion: version,
      });
      if (written) {
        summaryFilePath = written;
        if (!quiet) {
          const rel = path.relative(cwd, written) || written;
          log.dim(
            `Wrote ${summaryFormat.toUpperCase()} summary to ${rel}${dest.append ? ' (appended)' : ''}`,
          );
        }
      }
    }

    // --open-pr: push the branch and open a PR using `gh`. Runs only when git commits actually
    // landed on the branch; a dry run, a disabled git flow, or zero commits all skip cleanly.
    // The result is attached to the report so --json / persisted report show it.
    if (opts.openPr) {
      const branch =
        typeof opts.gitBranch === 'string' && opts.gitBranch.trim() ? opts.gitBranch.trim() : undefined;
      const hadCommits = gitFlow?.enabled === true && (report!.commits ?? []).some((c) => c.ok);
      if (!gitFlow?.enabled) {
        if (!quiet) {
          log.warn('--open-pr requires --git-commit; skipping.');
        }
      } else if (!branch) {
        if (!quiet) {
          log.warn('--open-pr requires --git-branch <name>; skipping so we never push to the default branch.');
        }
      } else if (dryRun) {
        if (!quiet) {
          log.warn('--open-pr: skipping in --dry-run (no commits were made).');
        }
      } else if (!hadCommits) {
        if (!quiet) {
          log.dim('--open-pr: no successful commits on the branch — nothing to open a PR for.');
        }
      } else {
        const { openPullRequest, readSummaryAsBody, defaultPrBody } = await import('./cli/openPr.js');
        const body =
          (summaryFormat === 'md' && (await readSummaryAsBody(cwd, summaryFilePath))) ||
          defaultPrBody(report!);
        const prCfg: Parameters<typeof openPullRequest>[0] = { cwd, branch, body };
        if (typeof opts.openPrTitle === 'string' && opts.openPrTitle.trim()) {
          prCfg.title = opts.openPrTitle.trim();
        }
        if (opts.openPrDraft) prCfg.draft = true;
        if (typeof opts.openPrBase === 'string' && opts.openPrBase.trim()) {
          prCfg.base = opts.openPrBase.trim();
        }
        if (typeof opts.openPrReviewers === 'string' && opts.openPrReviewers.trim()) {
          prCfg.reviewers = opts.openPrReviewers.trim();
        }
        if (typeof opts.openPrAssignees === 'string' && opts.openPrAssignees.trim()) {
          prCfg.assignees = opts.openPrAssignees.trim();
        }
        const result = await openPullRequest(prCfg, report!);
        report!.pullRequest = result;
        if (!quiet) {
          if (result.ok) {
            const tag = result.reused ? 'reused existing PR' : 'opened PR';
            log.success(`gh: ${tag}${result.url ? ` ${result.url}` : ''}`);
          } else {
            log.warn(`--open-pr: ${result.error}`);
          }
        }
      }
    }

    // Tracked files the validator or install scripts rewrote (e.g. `next build` → tsconfig.json)
    // go back, so the run only leaves dependency changes behind.
    if (worktreeBefore) {
      const sideEffects = await restoreSideEffects(worktreeBefore);
      if (sideEffects.restored.length > 0) {
        report!.restoredFiles = sideEffects.restored;
        if (!quiet) {
          log.dim(`Restored files the run changed besides dependencies: ${sideEffects.restored.join(', ')}`);
        }
      }
      if (sideEffects.untracked.length > 0 && !quiet) {
        log.warn(`New untracked files appeared during the run (left in place): ${sideEffects.untracked.join(', ')}`);
      }
    }

    const structuredFinal = buildStructuredReport(report!, {
      parsedConflicts: report!.parsedConflicts,
      groups: report!.groupPlan,
    });

    // Emit the primary report (JSON to stdout, or human-friendly to stderr) AFTER all post-run
    // enrichments have run (policy / security / blast-radius / changelog / pull-request). This
    // guarantees every consumer sees the same final structured report.
    if (jsonOutput) {
      console.log(
        JSON.stringify({ ...structuredFinal, ignored: report!.ignored }, null, 2),
      );
    } else {
      printHumanReport(report!);
      if (report!.parsedConflicts?.length) {
        printStructuredCliSummary(structuredFinal);
      }
    }

    if (interactive && !jsonOutput && report!.failed.length > 0) {
      await postRunInteractive(cwd, report!);
    }

    // A dry run never overwrites the record: `undo` / `--retry-failed` must keep seeing the last
    // run that actually changed package.json.
    if (opts.persistReport !== false && !dryRun) {
      const written = await persistLastRunReport(structuredFinal, {
        cwd,
        toolVersion: version,
        dryRun,
        lockfilesBefore,
      });
      if (written && !quiet) {
        log.dim(`Wrote ${path.relative(cwd, written)} for undo / --retry-failed / CI`);
      }
    }

    if (!dryRun) {
      const baks = new Set<string>([
        path.join(cwd, BACKUP_FILENAME),
        path.join(cwd, CATALOG_BACKUP_FILENAME),
      ]);
      for (const t of report?.targets ?? []) {
        baks.add(path.join(t.cwd, BACKUP_FILENAME));
        baks.add(path.join(t.cwd, CATALOG_BACKUP_FILENAME));
      }
      for (const bak of baks) {
        if (await fs.pathExists(bak)) {
          await fs.remove(bak);
        }
      }
      // Catalog backups can live outside every target dir (e.g. a workspaces-only run).
      await removeCreatedBackups();
    }

    const preflightFailed = Boolean(report!.preflightAborted);
    // --ci treats per-package failures as informational so the bot job stays green; only the
    // pre-flight failure (the project itself was broken before any upgrade) still exits 1.
    let exitCode: number;
    if (ciMode) {
      exitCode = preflightFailed ? 1 : 0;
      if (!quiet && report!.failed.length > 0) {
        log.dim(
          `--ci: ${report!.failed.length} per-package failure(s) recorded in the report; exit 0 anyway.`,
        );
      }
    } else {
      exitCode = !force && (report!.failed.length > 0 || preflightFailed) ? 1 : 0;
    }
    process.exitCode = exitCode;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!jsonOutput) {
      log.error(`Fatal: ${msg}`);
    } else {
      console.log(JSON.stringify({ error: msg }, null, 2));
    }
    // Deliberately no restore from the `.bak` files: the engine already put back the step it was
    // in the middle of, and upgrades that completed earlier were validated and match the lockfile.
    // Restoring the run-start package.json (or a stale backup from an older run) desynced the two.
    await removeCreatedBackups().catch(() => undefined);
    if (worktreeBefore) {
      await restoreSideEffects(worktreeBefore).catch(() => undefined);
    }
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
