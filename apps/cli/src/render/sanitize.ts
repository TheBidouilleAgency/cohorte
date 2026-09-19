/** Escape terminal control bytes for human-facing output. JSON is never passed here. */
export function sanitizeHuman(value: string): string {
  let result = '';
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '\n' || char === '\t' || (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f))) {
      result += char;
    } else {
      result += `\\x${code.toString(16).padStart(2, '0').toUpperCase()}`;
    }
  }
  return result;
}
