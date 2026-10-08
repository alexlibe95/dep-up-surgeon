import prompts from 'prompts';
import type { ClassifiedConflict } from '../core/conflictAnalyzer.js';

let cancelled = false;

/**
 * `prompts` option: Ctrl+C at a prompt stops the run like it does everywhere else. prompts puts
 * stdin in raw mode, so the keypress never becomes a SIGINT, and a cancelled prompt used to read
 * as "continue". Raising the signal runs the CLI's rollback-and-exit handler.
 */
export const stopRunOnCancel = {
  onCancel: (): boolean => {
    cancelled = true;
    process.kill(process.pid, 'SIGINT');
    return false;
  },
};

/** After a cancelled prompt, wait for the SIGINT handler to exit instead of carrying on. */
export async function haltIfCancelled(): Promise<void> {
  if (cancelled) {
    await new Promise<never>(() => undefined);
  }
}

export type GroupConflictChoice = 'skip_group' | 'force' | 'retry' | 'freeze_all';

/**
 * When a linked group upgrade fails, offer resolution paths (generic — no framework names).
 */
export async function promptGroupConflictChoice(opts: {
  groupId: string;
  packageSummary: string;
  classified: ClassifiedConflict[];
}): Promise<GroupConflictChoice> {
  const { groupId, packageSummary, classified } = opts;

  if (classified.length > 0) {
    console.log(`\nConflicts detected for group [${groupId}] (${packageSummary}):\n`);
    for (const c of classified.slice(0, 12)) {
      console.log(
        `  • ${c.category}: ${c.dependency} — required ${c.requiredRange}${c.installedVersion ? ` (seen ${c.installedVersion})` : ''}`,
      );
    }
    if (classified.length > 12) {
      console.log(`  … and ${classified.length - 12} more`);
    }
  }

  const res = await prompts(
    {
      type: 'select',
      name: 'choice',
      message: `How do you want to proceed for [${groupId}]?`,
      choices: [
        { title: 'Skip this entire group for this run', value: 'skip_group' as const },
        { title: 'Retry the same upgrade once (same targets)', value: 'retry' as const },
        { title: 'Force: keep versions despite npm conflicts (--force semantics)', value: 'force' as const },
        { title: 'Freeze: add all packages in this group to ignore list', value: 'freeze_all' as const },
      ],
      initial: 0,
    },
    stopRunOnCancel,
  );
  await haltIfCancelled();

  if (!res || typeof res.choice !== 'string') {
    return 'skip_group';
  }
  return res.choice as GroupConflictChoice;
}

/**
 * Per-package conflict triage (optional finer control).
 */
export async function promptPerPackageFreeze(opts: {
  packageNames: string[];
}): Promise<Set<string>> {
  const frozen = new Set<string>();
  const { packageNames } = opts;
  if (packageNames.length === 0) {
    return frozen;
  }

  const res = await prompts(
    {
      type: 'multiselect',
      name: 'pick',
      message: 'Select packages to freeze (skip upgrades) for this run:',
      choices: packageNames.map((name) => ({ title: name, value: name })),
      hint: '- Space to select. Enter to confirm',
    },
    stopRunOnCancel,
  );
  await haltIfCancelled();

  if (res?.pick && Array.isArray(res.pick)) {
    for (const n of res.pick) {
      if (typeof n === 'string') {
        frozen.add(n);
      }
    }
  }
  return frozen;
}

/**
 * Apply-to-all: reuse first choice for remaining failures.
 */
export async function promptApplyConflictChoiceToAll(): Promise<boolean> {
  const res = await prompts(
    {
      type: 'confirm',
      name: 'all',
      message: 'Use the same choice for all remaining failed groups?',
      initial: false,
    },
    stopRunOnCancel,
  );
  await haltIfCancelled();
  return Boolean(res?.all);
}
