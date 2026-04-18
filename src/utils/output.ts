/**
 * Default tail length for command output captured into diagnostics. Keep this small enough to
 * fit comfortably in a CI log block, but large enough to include the actual error footer that
 * npm / pnpm / yarn print after a failure (usually 10–25 lines).
 */
export const DEFAULT_OUTPUT_TAIL_LINES = 40;

/**
 * Return the last `n` lines of `output`, or `undefined` if there is nothing to keep. Trailing
 * empty lines are preserved so the output matches what the user would see in the terminal.
 */
export function tailLines(output: string | undefined, n = DEFAULT_OUTPUT_TAIL_LINES): string | undefined {
  if (!output) {
    return undefined;
  }
  const lines = output.split(/\r?\n/);
  if (lines.length <= n) {
    return output;
  }
  return lines.slice(-n).join('\n');
}
