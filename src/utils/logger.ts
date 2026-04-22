import chalk from 'chalk';

/** Human-facing log helpers (skip when --json). */
export const log = {
  info(msg: string): void {
    console.log(msg);
  },
  dim(msg: string): void {
    console.log(chalk.dim(msg));
  },
  success(msg: string): void {
    console.log(chalk.green('✔'), msg);
  },
  warn(msg: string): void {
    console.log(chalk.yellow('⚠'), msg);
  },
  error(msg: string): void {
    console.log(chalk.red('✖'), msg);
  },
  peer(msg: string): void {
    console.log(chalk.magenta('⚠ peer conflict:'), msg);
  },
  title(msg: string): void {
    console.log(chalk.bold.cyan(`\n${msg}\n`));
  },
};

/**
 * Interactive status indicator used around long-running steps (pre-flight validation,
 * install, test/build scripts, rollbacks) so the user sees the current phase and an
 * elapsed-seconds counter instead of a silent terminal.
 *
 * Behavior by environment:
 *   - TTY + enabled: animated braille spinner on a single line, live elapsed timer,
 *     cleared and replaced by a final `✔/✖/ℹ` line on settle.
 *   - Non-TTY or `enabled: false` (CI, `--json`, piped output): falls back to plain
 *     `› phase ...` lines on `update()` and a final summary line on settle. No ANSI
 *     escapes, no carriage returns — safe for log aggregators.
 */
export interface Spinner {
  /** Replace the current phase text (e.g. `"Installing foo@1.2.3..."` → `"Validating npm test..."`). */
  update(text: string): void;
  /** Settle with a green checkmark. `text` defaults to the current phase. */
  succeed(text?: string): void;
  /** Settle with a red cross. `text` defaults to the current phase. */
  fail(text?: string): void;
  /** Settle with a blue info glyph. `text` defaults to the current phase. */
  info(text?: string): void;
  /** Stop without emitting a settle line. Optional trailing dim note. */
  stop(note?: string): void;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

function defaultEnabled(): boolean {
  return Boolean(process.stdout.isTTY);
}

function formatElapsed(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (seconds < 1) return '';
  if (seconds < 60) return ` (${seconds}s)`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return ` (${m}m${s.toString().padStart(2, '0')}s)`;
}

/**
 * Start a spinner. When `enabled` is false (or omitted and stdout is not a TTY) the
 * returned object prints plain progress lines instead of animating — so CI logs keep
 * a record of every phase without ANSI noise.
 */
export function createSpinner(initial: string, options?: { enabled?: boolean }): Spinner {
  const enabled = options?.enabled ?? defaultEnabled();
  const startedAt = Date.now();
  let currentText = initial;
  let frameIdx = 0;
  let interval: NodeJS.Timeout | undefined;
  let settled = false;

  const writeFrame = (): void => {
    const frame = SPINNER_FRAMES[frameIdx]!;
    frameIdx = (frameIdx + 1) % SPINNER_FRAMES.length;
    const line = `${chalk.cyan(frame)} ${currentText}${chalk.dim(formatElapsed(startedAt))}`;
    process.stdout.write(`\r\x1b[2K${line}`);
  };

  const clearLine = (): void => {
    process.stdout.write('\r\x1b[2K');
  };

  if (enabled) {
    writeFrame();
    interval = setInterval(writeFrame, SPINNER_INTERVAL_MS);
    interval.unref?.();
  } else {
    console.log(chalk.dim('›'), initial);
  }

  const stopAnimation = (): void => {
    if (interval) {
      clearInterval(interval);
      interval = undefined;
    }
    if (enabled) {
      clearLine();
    }
  };

  const finalLine = (glyph: string, text: string): void => {
    const elapsed = formatElapsed(startedAt);
    console.log(`${glyph} ${text}${chalk.dim(elapsed)}`);
  };

  return {
    update(text: string): void {
      if (settled) return;
      currentText = text;
      if (enabled) {
        writeFrame();
      } else {
        console.log(chalk.dim('›'), text);
      }
    },
    succeed(text?: string): void {
      if (settled) return;
      settled = true;
      stopAnimation();
      finalLine(chalk.green('✔'), text ?? currentText);
    },
    fail(text?: string): void {
      if (settled) return;
      settled = true;
      stopAnimation();
      finalLine(chalk.red('✖'), text ?? currentText);
    },
    info(text?: string): void {
      if (settled) return;
      settled = true;
      stopAnimation();
      finalLine(chalk.blue('ℹ'), text ?? currentText);
    },
    stop(note?: string): void {
      if (settled) return;
      settled = true;
      stopAnimation();
      if (note) {
        console.log(chalk.dim('·'), note);
      }
    },
  };
}
