/**
 * Generic retry wrapper (e.g. npm install loops) with a maximum attempt cap.
 */

export interface RetryResult<T> {
  ok: boolean;
  value?: T;
  lastOutput: string;
  attempts: number;
}

export async function runWithRetry<T>(
  maxAttempts: number,
  operation: (attemptIndex: number) => Promise<{ ok: boolean; value: T; output: string }>,
): Promise<RetryResult<T>> {
  const cap = Math.max(1, Math.floor(maxAttempts));
  let lastOutput = '';
  for (let attempt = 1; attempt <= cap; attempt++) {
    const r = await operation(attempt);
    lastOutput = r.output;
    if (r.ok) {
      return { ok: true, value: r.value, lastOutput, attempts: attempt };
    }
  }
  return { ok: false, lastOutput, attempts: cap };
}
