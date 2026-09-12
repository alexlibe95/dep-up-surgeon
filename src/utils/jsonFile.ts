import fs from 'fs-extra';

/**
 * Serialize `value` the way `original` was written: npm's indentation rule (the indent of the
 * first line after the opening brace; two spaces for `{}` or a new file; compact for one-line
 * JSON), the same line endings, and a trailing newline only when the original had one.
 * Rewriting a tab / 4-space / CRLF package.json as 2-space LF turns every write into a noisy diff.
 */
export function stringifyJsonLike(original: string, value: unknown): string {
  const isNew = original.trim() === '';
  const indent =
    /^\s*[{[](?:\r?\n)+([ \t]*)/.exec(original)?.[1] ??
    (isNew || /^\s*(?:\{\s*\}|\[\s*\])\s*$/.test(original) ? '  ' : '');
  const text = JSON.stringify(value, null, indent) + (isNew || original.endsWith('\n') ? '\n' : '');
  return original.includes('\r\n') ? text.replace(/\r?\n/g, '\r\n') : text;
}

/** Write JSON to `file` in the existing file's style (2-space, LF, trailing newline when new). */
export async function writeJsonLike(file: string, value: unknown): Promise<void> {
  const original = await fs.readFile(file, 'utf8').catch(() => '');
  await fs.writeFile(file, stringifyJsonLike(original, value), 'utf8');
}
