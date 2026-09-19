/**
 * Splits `-z` output on NUL. Git terminates every record with a NUL (never separates them), so the raw buffer
 * always ends with one trailing NUL when non-empty; that last, always-empty split element is dropped. An empty
 * `raw` (nothing to report) yields an empty array rather than `['']`.
 */
export function splitNul(raw: string): string[] {
  if (raw === '') return [];
  const parts = raw.split('\0');
  if (parts.at(-1) === '') parts.pop();
  return parts;
}
